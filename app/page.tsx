'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import 'katex/dist/katex.min.css';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Authenticator } from '@aws-amplify/ui-react';
// import '@aws-amplify/ui-react/styles.css';
import { client } from './lib/amplifyClient';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import ProjectView from './components/ProjectView';
import MessageComposer from './components/MessageComposer';


type Thread = {
  id: string;
  title: string;
  modelKey?: string | null;
  projectId?: string | null; // ✅ NEW
  createdAt: string;
  deletedAt?: string | null;
};

type Project = {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
};

type Message = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type ChatTurn = { role: 'user' | 'assistant'; content: string };

type MonthlyUsage = {
  monthLabel: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
};

const TRUNCATION_MARKER = '<!--__TRUNCATED__-->';
const stripTruncationMarker = (s: string) => s.replace(TRUNCATION_MARKER, '').trimEnd();
const hasTruncationMarker = (s: string) => s.includes(TRUNCATION_MARKER);

// Keep only the last N turns and strip empty assistant bubbles
function buildHistoryForModel(allMessages: Message[], nextUserText: string, maxTurns = 20): ChatTurn[] {
    const turns: ChatTurn[] = allMessages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: stripTruncationMarker(m.content) }));

  turns.push({ role: 'user', content: nextUserText });

  // Keep last N turns (user+assistant pairs)
  return turns.slice(-maxTurns);
}

type ModelOption = {
  key: string;
  name: string;
  description: string;
};

const MODEL_OPTIONS: ModelOption[] = [
  { key: 'claude_haiku', name: 'Claude 3 Haiku', description: 'Best for everyday tasks' },
  { key: 'google_gemma', name: 'Gemma 3 (Google)', description: 'Best for balanced reasoning' },
  { key: 'openai', name: 'ChatGPT (OpenAI)', description: 'Best for writing and creative work' },
  { key: 'meta', name: 'LLama 3 (Meta)', description: 'Best for logical and analytical tasks' },
  { key: 'claude_sonnet', name: 'Claude Sonnet 4.6', description: 'Best for code and complex reasoning' },
  { key: 'nova_canvas', name: 'Nova Canvas (Amazon)', description: 'For image generation' },

];

// ---- Model-specific tone (injected into the prompt; not shown to users) ----
// Goal: all assistants feel warm + helpful, but never OTT/patronising.
const MODEL_TONE: Record<string, { label: string; style: string }> = {
  claude_haiku: {
    label: 'Claude 3 Haiku — everyday tasks',
    style:
      'Be friendly and brisk. Prioritise the quickest helpful path. Offer short step-by-step checklists when useful.',
  },
  google_gemma: {
    label: 'Gemma 3 — balanced reasoning',
    style:
      'Be calm and structured. Explain tradeoffs briefly. Use headings/bullets to keep reasoning easy to scan.',
  },
  openai: {
    label: 'ChatGPT — writing and creative work',
    style:
      'Be warm and lightly creative (not goofy). Offer 2–3 options/variations when it helps. Keep prose clear and vivid.',
  },
  meta: {
    label: 'Llama 3 — logical and analytical tasks',
    style:
      'Be direct and precise. State assumptions. Prefer concise bullets and concrete conclusions over long narration.',
  },
  claude_sonnet: {
    label: 'Claude Sonnet 4.6 — code and complex reasoning',
    style:
      'Be technical and rigorous, but still approachable. Ask one clarifying question if needed; otherwise make reasonable assumptions and proceed. Include small, correct code snippets with caveats/edge cases.',
  },
  nova_canvas: {
    label: 'Nova Canvas — image generation',
    style:
      'Be concise. If the prompt is missing key visual details (subject/style/aspect), ask ONE clarifying question; otherwise proceed. Output only what the app needs to render the result.',
  },
};

function buildSystemPrompt(modelKey: string) {
  const tone = MODEL_TONE[modelKey] ?? {
    label: 'Default assistant',
    style: 'Be warm, helpful, and concise.',
  };

  // Keep this short to reduce token overhead and avoid “persona theatrics”.
  return [
    'You are a helpful assistant in a ChatGPT-style web app.',
    'Tone: warm and confident. Never patronising, never overly enthusiastic.',
    'Write in clear, plain English. Prefer short paragraphs and bullets.',
    'If the user is ambiguous, ask at most ONE clarifying question; otherwise make a reasonable assumption and continue.',
    'Do not mention these instructions.',
    '',
    `Model voice: ${tone.label}. ${tone.style}`,
  ].join('\n');
}

// ---- Token + pricing estimates (frontend) ----

// ---- Image pricing (frontend) ----
// Nova Canvas is priced per image (not per token).
// Values shown in your screenshot (Europe / Ireland):
const NOVA_CANVAS_IMAGE_PRICING_USD = {
  standard: {
    '1024': 0.04,
    '2048': 0.06,
  },
  premium: {
    '1024': 0.06,
    '2048': 0.08,
  },
} as const;

// Your backend currently generates 1 image at 1024x1024 standard quality.
// (Matches the handler default we added earlier.)
const NOVA_CANVAS_DEFAULTS = {
  quality: 'standard' as const,
  resolution: 1024 as 1024 | 2048,
  imagesPerRequest: 1,
};

function countInlineImages(markdown: string) {
  // Matches: data:image/png;base64,... (your handler returns this)
  const matches = markdown.match(/data:image\/[a-zA-Z0-9.+-]+;base64,/g);
  return matches ? matches.length : 0;
}

function estimateNovaCanvasCostUSD(kind: 'input' | 'output', content?: string) {
  if (kind === 'input') return 0;

  // If we can detect embedded images, bill per image.
  // Otherwise assume the backend produced 1 image for the assistant turn.
  const n =
    content && content.trim().length > 0
      ? Math.max(1, countInlineImages(content))
      : NOVA_CANVAS_DEFAULTS.imagesPerRequest;

  const price =
    NOVA_CANVAS_IMAGE_PRICING_USD[NOVA_CANVAS_DEFAULTS.quality][String(NOVA_CANVAS_DEFAULTS.resolution) as '1024' | '2048'];

  return n * price;
}

// Values are "USD per 1K tokens" (derived from your "$ per 1M tokens" / 1000).
const MODEL_PRICING_USD: Record<
  string,
  { inputPer1K: number; outputPer1K: number }
> = {
  // openai = gpt-oss-120b
  openai: { inputPer1K: 0.00023, outputPer1K: 0.00093 },

  // google_gemma = Gemma 3 27B
  google_gemma: { inputPer1K: 0.00009, outputPer1K: 0.00029 },

  // claude_sonnet = Claude Sonnet 4.6
  claude_sonnet: { inputPer1K: 0.003, outputPer1K: 0.015 },

  // meta = Llama 3.3 Instruct (70B)
  meta: { inputPer1K: 0.00072, outputPer1K: 0.00072 },

  claude_haiku: { inputPer1K: 0.00025, outputPer1K: 0.00125 },
    // Nova Canvas is image generation; token pricing isn't used in this UI estimator.
  nova_canvas: { inputPer1K: 0, outputPer1K: 0 },
};


// Rough token estimator (fast + works in browser)
// Tokens are usually ~chars/4 in English; varies by model + language.
function estimateTokens(text: string, modelKey: string) {
  const t = text.trim();
  if (!t) return 0;

  // Small per-model tweaks (still estimates)
  const chars = t.length;
  const divisor =
    modelKey === 'claude_haiku' ? 3.8 :
    modelKey === 'claude_sonnet' ? 3.9 :
    modelKey === 'google_gemma' ? 4.1 :
    modelKey === 'meta' ? 4.1 :
    4.0;

  // Add a tiny overhead to better match typical prompt formatting
  const base = Math.ceil(chars / divisor);
  const overhead = 6;

  return base + overhead;
}

// Input tokens should include the system tone prompt we inject on every request.
function estimateInputTokens(text: string, modelKey: string) {
  return estimateTokens(text, modelKey) + estimateTokens(buildSystemPrompt(modelKey), modelKey);
}

function formatUSD(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.000000';

  // Keep the UI consistent and additive at micro values
  if (amount < 1) return `$${amount.toFixed(6)}`;

  // Larger totals can be normal money formatting
  return `$${amount.toFixed(2)}`;
}

function estimateCostUSD(
  tokens: number,
  modelKey: string,
  kind: 'input' | 'output',
  content?: string
) {
  // Nova Canvas: priced per image generated (not token-based)
  if (modelKey === 'nova_canvas') {
    return estimateNovaCanvasCostUSD(kind, content);
  }

  const p = MODEL_PRICING_USD[modelKey] ?? { inputPer1K: 0, outputPer1K: 0 };
  const per1K = kind === 'input' ? p.inputPer1K : p.outputPer1K;
  return (tokens / 1000) * per1K;
}

function nowIso() {
  return new Date().toISOString();
}

function formatMsgTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Example: "22 Feb 08:14"
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function titleFromFirstUserMessage(text: string) {
  // fallback (used if summarization fails)
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? t.slice(0, 48) + '…' : t || 'New chat';
}

function cleanGeneratedTitle(raw: string, fallbackText: string) {
  let t = String(raw ?? '')
    .split('\n')[0] // first line only
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // strip surrounding quotes
    .replace(/\s+/g, ' ')
    .trim();

  // Guardrails
  if (!t || t.length < 3) return titleFromFirstUserMessage(fallbackText);
    if (t.length > 80) t = t.slice(0, 80).trimEnd() + '…';

  return t;
}

function normalizeWords(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function jaccardSimilarity(a: string, b: string) {
  const A = new Set(normalizeWords(a));
  const B = new Set(normalizeWords(b));
  if (A.size === 0 || B.size === 0) return 0;

  let intersection = 0;
  for (const w of A) if (B.has(w)) intersection++;

  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isTooVagueTitle(title: string) {
  const words = normalizeWords(title);
  // 1-word titles like "Golf" are not useful in a sidebar
  if (words.length < 2) return true;

  // very short titles also tend to be unhelpful
  if (title.trim().length < 10) return true;

  return false;
}

function isTooSimilarToPrompt(title: string, prompt: string) {
  const t = title.trim().toLowerCase();
  const p = prompt.trim().toLowerCase();

  // Exact/near-exact repeats
  if (!t) return true;
  if (t === p) return true;
  if (p.includes(t) && t.length > 12) return true;

  // Word overlap too high
  return jaccardSimilarity(title, prompt) > 0.75;
}

function keywordFallbackTitle(prompt: string) {
  const stop = new Set([
    'the','a','an','and','or','but','if','then','so','to','of','in','on','for','with','at','by','from',
    'is','are','was','were','be','been','being','do','does','did','can','could','should','would','will',
    'i','you','we','they','he','she','it','my','your','our','their',
    'what','why','how','when','where','who',
    'make','like','chatgpt','sidebar','title','name','create','new','chat'
  ]);

  const words = normalizeWords(prompt).filter((w) => !stop.has(w));
  const picked = Array.from(new Set(words)).slice(0, 6);

  if (picked.length === 0) return titleFromFirstUserMessage(prompt);

  const raw = picked.join(' ');
  const processed = postProcessTitle(raw, prompt);
  return processed.length > 60 ? processed.slice(0, 60).trimEnd() + '…' : processed;

}

function tokenizeWords(s: string) {
  // keeps words like "Spain's"
  return (s.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) ?? []);
}

function buildPromptWordSets(prompt: string) {
  const rawTokens = tokenizeWords(prompt);

  const promptWords = new Set<string>();
  const casingMap = new Map<string, string>();

  for (const w of rawTokens) {
    const lower = w.toLowerCase();
    promptWords.add(lower);

    // Store original casing for restoration later
    if (!casingMap.has(lower)) {
      casingMap.set(lower, w);
    }
  }

  return { promptWords, casingMap };
}

function clipTitleToPrompt(title: string, prompt: string) {
  const { promptWords } = buildPromptWordSets(prompt);

  // connector words we allow even if not in prompt (keeps titles readable)
  const connectors = new Set([
    'the','a','an','and','or','of','in','on','for','to','with','about','vs','via'
  ]);

  const parts = title.split(/\s+/).filter(Boolean);

  const kept: string[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, '');
    if (!cleaned) continue;

    const lower = cleaned.toLowerCase();

    // Handle possessives like "Spain's"
    const basePossessive = lower.endsWith("'s") ? lower.slice(0, -2) : lower;

    if (promptWords.has(lower) || promptWords.has(basePossessive) || connectors.has(lower)) {
      kept.push(part);
    }
  }

  let clipped = kept.join(' ').replace(/\s+/g, ' ').trim();

  // Don’t end on a connector (e.g. “National Sport of”)
  clipped = clipped.replace(/\b(the|a|an|and|or|of|in|on|for|to|with|about|vs|via)\s*$/i, '').trim();

  return clipped;
}

function toSentenceCasePreserveProperNouns(title: string, prompt: string) {
  const { casingMap } = buildPromptWordSets(prompt);

  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return title;

  return words
    .map((w, idx) => {
      const leading = w.match(/^[^A-Za-z0-9]*/)?.[0] ?? '';
      const trailing = w.match(/[^A-Za-z0-9]*$/)?.[0] ?? '';
      const core = w.slice(leading.length, w.length - trailing.length);

      if (!core) return w;

      const lower = core.toLowerCase();

      // Prefer prompt casing for proper nouns (e.g. China, iPhone, Elon)
      const restored = casingMap.get(lower) ?? lower;

      // Always sentence-case the first word (even if prompt had it lowercase)
      if (idx === 0) {
        return leading + restored.charAt(0).toUpperCase() + restored.slice(1) + trailing;
      }

      // If it came from the prompt, keep its original casing (proper nouns etc)
      if (casingMap.has(lower)) {
        return leading + restored + trailing;
      }

      // Otherwise lowercase it
      return leading + lower + trailing;
    })
    .join(' ');
}

function injectMissingOf(title: string, prompt: string) {
  const t = title.trim();
  if (!t) return t;

  // If title already contains "of", do nothing
  if (/\bof\b/i.test(t)) return t;

  // Only attempt if prompt contains "of"
  if (!/\bof\b/i.test(prompt)) return t;

  // Get the last "of X" target in the prompt (simple but effective)
  // Example: "... sport of China" => target = "china"
  const tokens = tokenizeWords(prompt).map((x) => x.toLowerCase());
  const lastOfIndex = tokens.lastIndexOf('of');
  if (lastOfIndex === -1 || lastOfIndex === tokens.length - 1) return t;

  // Pick the next non-connector word after "of" (skip "the/a/an")
  const skip = new Set(['the', 'a', 'an']);
  let target = '';
  for (let i = lastOfIndex + 1; i < tokens.length; i++) {
    if (!skip.has(tokens[i])) {
      target = tokens[i];
      break;
    }
  }
  if (!target) return t;

  const titleParts = t.split(/\s+/);
  if (titleParts.length < 2) return t;

  const lastWord = titleParts[titleParts.length - 1];
  const lastCore = lastWord.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, '').toLowerCase();

  // If title ends with the same target (e.g. "... China"), insert "of" before it
  if (lastCore === target) {
    return [...titleParts.slice(0, -1), 'of', titleParts[titleParts.length - 1]].join(' ');
  }

  return t;
}

function postProcessTitle(generatedTitle: string, prompt: string) {
  // 1) Remove invented concepts by clipping to prompt words
  const clipped = clipTitleToPrompt(generatedTitle, prompt);

  // If clipping removed too much, fall back to keyword title (still prompt-derived)
  const safeBase = clipped && clipped.length >= 8 ? clipped : keywordFallbackTitle(prompt);

  // Add missing "of" when the prompt clearly had an "of X" structure
  const safe = injectMissingOf(safeBase, prompt);

  // 2) Sentence case with proper nouns preserved from prompt
  return toSentenceCasePreserveProperNouns(safe, prompt);
}

async function generateChatTitleFromFirstMessage(firstMessage: string, modelKey: string) {
  const call = async (instruction: string) => {
    const history = JSON.stringify([
      {
        role: 'user',
        content: `${instruction}\n\nUser message:\n${firstMessage}`,
      },
    ]);

    const res: any = await client.queries.chat({
      prompt: ' ',
      modelKey,
      history,
    });

    if (res?.errors?.length) {
      const msg = res.errors.map((e: any) => e.message).join(' | ');
      throw new Error(msg);
    }

    const raw = res?.data?.text ?? res?.data ?? '';
    const cleaned = cleanGeneratedTitle(raw, firstMessage);
    return postProcessTitle(cleaned, firstMessage);
  };

  // Pass 1: strongly steer toward a descriptive, contextual sidebar title
  let title = await call(
    'Write a descriptive sidebar chat title (4–9 words). ' +
    'Use ONLY words that appear in the user message (you may reorder them). ' +
    'Do NOT add new concepts not mentioned by the user. ' +
    'Do NOT answer the question. ' +
    'Return ONLY the title. No quotes. No emoji.'
  );

  // If it’s vague (e.g. "Golf") or too similar, try once more with even stricter guidance
  if (isTooVagueTitle(title) || isTooSimilarToPrompt(title, firstMessage)) {
    title = await call(
      'Create a contextual chat title (5–9 words). ' +
        'Avoid single-word titles and avoid copying the user sentence verbatim. ' +
        'Keep important qualifiers (who/what/where) like "Scotland" and "national sport". ' +
        'Return ONLY the title. No quotes. No emoji.'
    );
  }

  // If still bad, fall back locally — but still apply the same post-processing
  if (isTooVagueTitle(title) || isTooSimilarToPrompt(title, firstMessage)) {
    return postProcessTitle(keywordFallbackTitle(firstMessage), firstMessage);
  }

  return title;
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;

        // Safe init (won't re-init if already initialised)
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
        });

        const id = `mmd-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled) setSvg(svg);
      } catch (e) {
        if (!cancelled) {
          setSvg(
            `<pre>Mermaid render error:\n${String((e as any)?.message ?? e)}</pre>`
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div
      className="overflow-x-auto rounded-xl bg-white p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function TypingIndicator() {
  return (
    <span className="typing-dots" aria-label="Thinking">
      <span />
      <span />
      <span />
    </span>
  );
}

function MarkdownMessage({
  text,
  onCopy,
}: {
  text: string;
  onCopy: (code: string) => void;
}) {
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  const markCodeCopied = (id: string) => {
    setCopiedCodeId(id);
    window.setTimeout(() => {
      setCopiedCodeId((prev) => (prev === id ? null : prev));
    }, 1200);
  };

  return (

    <div className="space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          // Headings / text
          h1: ({ children }) => <h1 className="mt-6 mb-4 text-2xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 mb-4 text-xl font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 mb-2 text-lg font-semibold">{children}</h3>,
          p: ({ children }) => <p className="whitespace-pre-wrap leading-relaxed">{children}</p>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          ul: ({ children }) => <ul className="list-disc pl-6 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 space-y-1">{children}</ol>,
          a: ({ children, ...props }) => (
            <a
              {...props}
              className="underline underline-offset-2 hover:opacity-80"
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (<strong className="font-semibold">{children}</strong> ),
          details: ({ children }) => (
            <details className="rounded-xl border border-zinc-200 bg-white p-3">
              {children}
            </details>
          ),
          summary: ({ children }) => (
            <summary className="cursor-pointer select-none font-medium">
              {children}
            </summary>
          ),
          hr: () => (
            <hr className="my-8 border-0 h-px bg-zinc-200" />
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-xl border border-zinc-200">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-zinc-100">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-zinc-200 px-3 py-2 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-200 px-3 py-2 align-top">
              {children}
            </td>
          ),
          img: ({ src, alt }) => {
            if (!src || src.trim().length === 0) return null;

            return (
              <img
                src={src}
                alt={alt ?? 'Generated image'}
                className="rounded-xl max-w-full h-auto"
              />
            );
          },
          code: ({ className, children, ...props }) => {
            const codeString = String(children ?? '').replace(/\n$/, '');
            const language = (className ?? '').replace('language-', '').trim();

            const isFencedBlock = Boolean(className);
            if (!isFencedBlock) {
              return (
                <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[0.95em]" {...props}>
                  {children}
                </code>
              );
            }

            const langLabel = language || 'code';
            const codeId = `${langLabel}:${codeString.length}:${codeString
              .slice(0, 24)
              .replace(/\s+/g, ' ')}`;

            // Mermaid diagrams
            if (language === 'mermaid') {
              return (
                <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-zinc-600">
                    <span className="uppercase tracking-wide">{langLabel}</span>
                      <button
                        type="button"
                        onClick={() => {
                          onCopy(codeString);
                          markCodeCopied(codeId);
                        }}
                        className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-white hover:opacity-90"
                      >
                        {copiedCodeId === codeId ? 'Copied' : 'Copy diagram'}
                      </button>
                  </div>
                  <div className="p-4">
                    <MermaidDiagram code={codeString} />
                  </div>
                </div>
              );
            }

            // Syntax-highlighted fenced code
            return (
              <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-secondary">
                <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                  <span className="uppercase tracking-wide">{langLabel}</span>
                    <button
                      type="button"
                      onClick={() => {
                        onCopy(codeString);
                        markCodeCopied(codeId);
                      }}
                      className="rounded-md bg-zinc-900 px-2 py-1 text-xs text-white hover:opacity-90"
                    >
                      {copiedCodeId === codeId ? 'Copied' : 'Copy code'}
                    </button>
                </div>

                <div className="overflow-x-auto p-4 text-xs leading-relaxed">
                  <SyntaxHighlighter
                    language={language || undefined}
                    style={oneLight}
                    customStyle={{ margin: 0, background: 'transparent' }}
                    PreTag="div"
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              </div>
            );
          },

        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function AnimatedMarkdownMessage({
  id,
  text,
  onCopy,
  isActive,
  getScrollContainer,
  getMessageEl,
}: {
  id: string;
  text: string;
  onCopy: (code: string) => void;
  isActive: boolean;
  getScrollContainer: () => HTMLDivElement | null;
  getMessageEl: (id: string) => HTMLDivElement | null;
}) {
  const [visible, setVisible] = useState('');
  const [done, setDone] = useState(false);
  const desiredTopOffset = 16; // px
  // Prevent the same message from re-animating on unrelated re-renders (e.g. clicking Copy).
  const playedRef = useRef(false);
  const lastIdRef = useRef<string | null>(null);
  const lastTextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isActive) return;

    const full = text ?? '';
    if (!full.trim()) {
      setVisible(full);
      setDone(true);
      return;
    }

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    if (prefersReduced) {
      setVisible(full);
      setDone(true);
      return;
    }

// If we've already animated this exact message, don't restart.
if (playedRef.current && lastIdRef.current === id && lastTextRef.current === full) {
  setVisible(full);
  setDone(true);
  return;
}

playedRef.current = false;
lastIdRef.current = id;
lastTextRef.current = full;

setDone(false);
setVisible('');

let raf = 0;
let last = performance.now();

// Faster + smoother: reveal by words (not every character)
const parts = full.match(/\S+\s*/g) ?? [full];
let w = 0;
const wps = 28; // words per second (tweak)


    const keepAnchorInView = () => {
      const scroller = getScrollContainer();
      const el = getMessageEl(id);
      if (!scroller || !el) return;

      const scrollerRect = scroller.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const delta = elRect.top - (scrollerRect.top + desiredTopOffset);
      if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    };

    const tick = (t: number) => {
      const dt = t - last;
      last = t;

      const step = Math.max(1, Math.floor((wps * dt) / 1000));
        w = Math.min(parts.length, w + step);
        setVisible(parts.slice(0, w).join(''));

        if (w < parts.length) {
          raf = requestAnimationFrame(tick);
        } else {
          playedRef.current = true;
          setDone(true);
        }

    };

    // Prime the scroll anchor before typing starts.
    keepAnchorInView();
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [id, isActive, text, getScrollContainer, getMessageEl]);

  // If this message is not the "currently animating" one,
  // render it normally so history doesn't disappear.
  if (!isActive) {
    return <MarkdownMessage text={text} onCopy={onCopy} />;
  }

  return (
    <div className={done ? '' : 'animate-pulse'}>
      <MarkdownMessage text={done ? text : visible} onCopy={onCopy} />
      {!done && <span className="typing-caret" aria-hidden />}
    </div>
  );

}

export default function Home() {
  return (
    <Authenticator>
      {({ signOut }) => <ChatApp onSignOut={signOut} />}
    </Authenticator>
  );
}

function ChatApp({ onSignOut }: { onSignOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectViewProjectId, setProjectViewProjectId] = useState<string | null>(null);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null); type AttachmentRef = { kind: 'text' | 'image'; metaKey: string; name: string;};
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [sending, setSending] = useState(false);
  const stopRef = useRef<{ aborted: boolean }>({ aborted: false });
  const typingIdRef = useRef<string | null>(null);
  const [isSwitchingThread, setIsSwitchingThread] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState<string>('claude_haiku');
  // Nova Canvas UI controls (only used when nova_canvas is selected)
  type NovaQuality = 'standard' | 'premium';
  type NovaSize = 1024 | 2048;
  type NovaAR = '1:1' | '16:9' | '9:16';
  type NovaImages = 1 | 2;
  type NovaStyle = 'none' | 'photoreal' | 'illustration' | '3d' | 'anime';

  const [novaQuality, setNovaQuality] = useState<NovaQuality>('standard');
  const [novaSize, setNovaSize] = useState<NovaSize>(1024);
  const [novaAR, setNovaAR] = useState<NovaAR>('1:1');
  const [novaImages, setNovaImages] = useState<NovaImages>(1);
  const [novaSeed, setNovaSeed] = useState<string>(''); // empty => random
  const [novaStyle, setNovaStyle] = useState<NovaStyle>('none');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [threadModelKeys, setThreadModelKeys] = useState<Record<string, string>>({});
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const [monthlyUsage, setMonthlyUsage] = useState<MonthlyUsage | null>(null);
  const [monthlyTotalsOpenMobile, setMonthlyTotalsOpenMobile] = useState(false);

  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  async function softDeleteChat(threadId: string) {
    const ok = window.confirm('Delete this chat? (It will be hidden on all your devices.)');
    if (!ok) return;

    // Optimistic UI: remove immediately
    setThreads((prev) => prev.filter((t) => t.id !== threadId));

    // If active chat deleted, clear UI
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
      setMessages([]);
    }

    try {
      await client.models.ChatThread.update({
        id: threadId,
        deletedAt: nowIso(),
      } as any);

      // Refresh list so it stays consistent
      await loadThreads();
    } catch (e) {
      console.error(e);
      alert('Failed to delete chat. Please refresh and try again.');
      await loadThreads();
    }
  }

  async function softDeleteProject(projectId: string) {
  const ok = window.confirm('Delete this project? Its chats will also be hidden.');
  if (!ok) return;

  const ts = nowIso();

  try {
    // Soft delete project
    await client.models.Project.update({
      id: projectId,
      deletedAt: ts,
      updatedAt: ts,
    } as any);

    // Soft delete chats in project
    const res = await client.models.ChatThread.list({});
    const projectThreads = (res.data ?? []).filter(
      (t: any) => t && t.id && t.projectId === projectId && !t.deletedAt
    );

    await Promise.all(
      projectThreads.map((t: any) =>
        client.models.ChatThread.update({ id: t.id, deletedAt: ts } as any)
      )
    );

    // UI cleanup
    if (activeProjectId === projectId) setActiveProjectId(null);
    if (projectViewProjectId === projectId) setProjectViewProjectId(null);

    // close modal if we were editing this project
    if (editingProjectId === projectId) {
      setProjectModalOpen(false);
      setEditingProjectId(null);
    }

    await loadProjects();
    await loadThreads();
  } catch (e) {
    console.error(e);
    alert('Failed to delete project. Please refresh and try again.');
  }
}

  function persistHiddenThreadIds(next: string[]) {
    setHiddenThreadIds(next);
    try {
      localStorage.setItem('hiddenThreadIds', JSON.stringify(next));
    } catch {}
  }

async function softDeleteChat(threadId: string) {
  const ok = window.confirm('Delete this chat? (It will be hidden on all your devices.)');
  if (!ok) return;

  // Optimistic UI: remove immediately
  setThreads((prev) => prev.filter((t) => t.id !== threadId));

  // If active chat deleted, clear UI
  if (activeThreadId === threadId) {
    setActiveThreadId(null);
    setMessages([]);
  }

  try {
    await client.models.ChatThread.update({
      id: threadId,
      deletedAt: nowIso(),
    } as any);

    // Refresh list so it stays consistent
    await loadThreads();
  } catch (e) {
    console.error(e);
    alert('Failed to delete chat. Please refresh and try again.');
    await loadThreads();
  }
}

  async function copyMessageToClipboard(text: string, messageId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((prev) => (prev === messageId ? null : prev)), 1200);
    } catch {
      // Fallback (older browsers / permissions)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);

      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((prev) => (prev === messageId ? null : prev)), 1200);
    }
  }

  const lockedModelKey = activeThreadId ? threadModelKeys[activeThreadId] : undefined;
  const effectiveModelKey = lockedModelKey ?? selectedModelKey;
  const isNova = effectiveModelKey === 'nova_canvas';

  const selectedModel = useMemo(
    () => MODEL_OPTIONS.find((m) => m.key === effectiveModelKey) ?? MODEL_OPTIONS[0],
    [effectiveModelKey]
  );

  const pricing = MODEL_PRICING_USD[effectiveModelKey] ?? { inputPer1K: 0, outputPer1K: 0 };

  const estimatedInputTokens = useMemo(
    () => estimateTokens(input, effectiveModelKey),
    [input, effectiveModelKey]
  );

  const estimatedInputCostUSD = useMemo(
    () => (estimatedInputTokens / 1000) * pricing.inputPer1K,
    [estimatedInputTokens, pricing.inputPer1K]
  );

    const { chatTotalTokens, chatTotalCostUSD } = useMemo(() => {
    let totalTokens = 0;
    let totalCost = 0;

    for (const m of messages) {
      const text = stripTruncationMarker(m.content);
      const t = estimateTokens(text, effectiveModelKey);
      totalTokens += t;

      const kind = m.role === 'user' ? 'input' : 'output';
      totalCost += estimateCostUSD(t, effectiveModelKey, kind);
    }

    return { chatTotalTokens: totalTokens, chatTotalCostUSD: totalCost };
  }, [messages, effectiveModelKey]);

  // Lock the model once there is at least one user message in the active thread
  const isModelLocked = useMemo(() => {
    if (!activeThreadId) return false;
    if (threadModelKeys[activeThreadId]) return true;
    return messages.some((m) => m.role === 'user');
  }, [activeThreadId, threadModelKeys, messages]);


  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Message scroll + anchor refs (for smooth assistant reveal)
const scrollRef = useRef<HTMLDivElement | null>(null);
const messageElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
const seenAssistantIdsRef = useRef<Set<string>>(new Set());
const [animatingAssistantId, setAnimatingAssistantId] = useState<string | null>(null);
// Stable callbacks so the typing effect doesn't restart on unrelated re-renders (e.g. Copy state changes)
const getScrollContainer = useCallback(() => scrollRef.current, []);
const getMessageEl = useCallback((id: string) => messageElsRef.current.get(id) ?? null, []);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    function resizeTextarea(el?: HTMLTextAreaElement | null) {
      const ta = el ?? textareaRef.current;
      if (!ta) return;

      ta.style.height = 'auto'; // allows shrink
      ta.style.height = `${Math.min(ta.scrollHeight, 400)}px`; // grow up to 400px
    }

    function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      setInput(e.target.value);
      resizeTextarea(e.target); 
    }


// When a new assistant message arrives, scroll so the *start* of the message
// is in the viewport (like ChatGPT), then animate its appearance.
useEffect(() => {
  // Keep this only for cases where messages arrive from elsewhere (e.g. another device)
  // and we are NOT currently animating a message.
  if (animatingAssistantId) return;

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && !m.id.startsWith('typing-') && m.content.trim().length > 0);

  if (!lastAssistant) return;
  if (seenAssistantIdsRef.current.has(lastAssistant.id)) return;

  seenAssistantIdsRef.current.add(lastAssistant.id);
  setAnimatingAssistantId(lastAssistant.id);

  requestAnimationFrame(() => {
    const scroller = scrollRef.current;
    const el = messageElsRef.current.get(lastAssistant.id);
    if (!scroller || !el) return;

    const desiredTopOffset = 16;
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    scroller.scrollTop += elRect.top - (scrollerRect.top + desiredTopOffset);
  });
}, [messages, animatingAssistantId]);



  // Sidebar: collapsed by default on <768px, open by default on >=768px
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');

    const apply = () => setSidebarOpen(mq.matches);

    // Set initial value
    apply();

    // Keep in sync if the viewport crosses the breakpoint
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

// No localStorage thread model sync — modelKey comes from ChatThread.modelKey (cross-device)

  useEffect(() => {
  function onDocMouseDown(e: MouseEvent) {
    if (!modelMenuRef.current) return;
    if (!modelMenuRef.current.contains(e.target as Node)) {
      setModelMenuOpen(false);
    }
  }

  document.addEventListener('mousedown', onDocMouseDown);
  return () => document.removeEventListener('mousedown', onDocMouseDown);
}, []);

const projectById = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of projects) m[p.id] = p;
    return m;
  }, [projects]);

  const activeThreadProjectId = useMemo(() => {
    const t = threads.find((x) => x.id === activeThreadId);
    return t?.projectId ?? null;
  }, [threads, activeThreadId]);

  // If a thread is open, its project wins. Otherwise use the sidebar-selected project.
  const effectiveProjectId = activeThreadProjectId ?? activeProjectId;

  const activeProject = useMemo(() => {
    return effectiveProjectId ? projectById[effectiveProjectId] ?? null : null;
  }, [effectiveProjectId, projectById]);

  // Search applies globally (like ChatGPT)
  const searchedThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, query]);

  // “Your chats” = unassigned only (never affected by Projects)
  const unassignedThreads = useMemo(() => {
    return searchedThreads.filter((t) => !t.projectId);
  }, [searchedThreads]);

  // Chats grouped under each project (folder-style)
  const projectThreadsById = useMemo(() => {
    const map: Record<string, Thread[]> = {};
    for (const t of searchedThreads) {
      if (!t.projectId) continue;
      if (!map[t.projectId]) map[t.projectId] = [];
      map[t.projectId].push(t);
    }
    return map;
  }, [searchedThreads]);

  // Project shown in the project-home screen
  const projectViewProject = useMemo(() => {
    return projectViewProjectId ? projectById[projectViewProjectId] ?? null : null;
  }, [projectViewProjectId, projectById]);

  const projectViewThreads = useMemo(() => {
    return projectViewProjectId ? projectThreadsById[projectViewProjectId] ?? [] : [];
  }, [projectViewProjectId, projectThreadsById]);

  async function loadProjects() {
    const res = await client.models.Project.list({});
    const items = (res.data ?? [])
      .filter((p: any) => p && p.id && !p.deletedAt)
      .map((p: any) => ({
        id: p.id,
        name: p.name ?? 'Untitled project',
        description: p.description ?? null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt ?? null,
        deletedAt: p.deletedAt ?? null,
      })) as Project[];

    // newest first
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    setProjects(items);
  }

async function saveProject() {
  const name = newProjectName.trim();
  const description = newProjectDescription.trim();

  if (!name) {
    setProjectCreateError('Project name is required.');
    return;
  }

  setCreatingProject(true);
  setProjectCreateError(null);

  try {
    const now = new Date().toISOString();

    if (editingProjectId) {
      await client.models.Project.update({
        id: editingProjectId,
        name,
        description: description.length ? description : undefined,
        updatedAt: now,
      } as any);
    } else {
      const res = await client.models.Project.create({
        name,
        description: description.length ? description : undefined,
        createdAt: now,
        updatedAt: now,
      });

      const createdId = (res as any)?.data?.id ?? null;
      if (createdId) {
        setActiveProjectId(createdId);
        setProjectViewProjectId(createdId); // ✅ immediately show the new project
        setActiveThreadId(null);
        setMessages([]);
      }
    }

    await loadProjects();

    setProjectModalOpen(false);
    setEditingProjectId(null);
    setNewProjectName('');
    setNewProjectDescription('');
  } catch (e: any) {
    setProjectCreateError(e?.message ?? 'Failed to save project.');
  } finally {
    setCreatingProject(false);
  }
}

  async function loadThreads() {
    const res = await client.models.ChatThread.list({
      // newest first (best-effort; if sort not supported, we’ll sort locally)
    });

const items = (res.data ?? [])
  .filter((t: any) => t && t.id)
  .map((t: any) => ({
    id: t.id,
    title: t.title ?? 'Untitled',
    modelKey: t.modelKey ?? null,
    projectId: t.projectId ?? null, // ✅ NEW
    createdAt: t.createdAt,
    deletedAt: t.deletedAt ?? null,
  })) as Thread[];


    const visible = items.filter((t) => !t.deletedAt && !!t.modelKey);

    visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    setThreads(visible);
    void loadMonthlyUsageForCurrentMonth(visible);

    // Seed per-thread model keys from the backend (source of truth)
setThreadModelKeys((prev) => {
  const next = { ...prev };
  for (const t of visible) {
    if (t.modelKey) next[t.id] = t.modelKey;
  }
  return next;
});

// Keep localStorage in sync so older logic still works
for (const t of visible) {
  if (t.modelKey) localStorage.setItem(`threadModel:${t.id}`, t.modelKey);
}

    // If activeThreadId is missing/invalid (e.g., thread was deleted or inaccessible), fall back.
const activeStillExists = activeThreadId
  ? visible.some((t) => t.id === activeThreadId)
  : false;

if (!activeThreadId || !activeStillExists) {
  setActiveThreadId(visible[0]?.id ?? null);
  if (!visible[0]) setMessages([]);
}

  }

  async function loadMonthlyUsageForCurrentMonth(threadsInSidebar: Thread[]) {
  // Only threads with modelKey are in the sidebar already, but we guard anyway.
  const threadKeyById: Record<string, string> = {};
  for (const t of threadsInSidebar) {
    if (t.modelKey) threadKeyById[t.id] = t.modelKey;
  }
  const allowedThreadIds = new Set(Object.keys(threadKeyById));
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartIso = monthStart.toISOString();

  const monthLabel = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUSD = 0;

  const byModel: MonthlyUsage['byModel'] = {};

  // Basic pagination (Amplify list often returns nextToken)
  let nextToken: string | null | undefined = undefined;

  while (true) {
    const res: any = await client.models.ChatMessage.list({
      filter: { createdAt: { ge: monthStartIso } },
      ...(nextToken ? { nextToken } : {}),
    });

    const rows: any[] = (res.data ?? []).filter((m: any) => m && m.id && m.threadId);

for (const m of rows) {
  // Only count messages that belong to threads we actually show (modelKey threads)
  if (!allowedThreadIds.has(m.threadId)) continue;

  const mk = threadKeyById[m.threadId]!;
  const text = stripTruncationMarker(String(m.content ?? ''));
  const t = estimateTokens(text, mk);

  if (!byModel[mk]) byModel[mk] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };

  if (m.role === 'user') {
    inputTokens += t;
    byModel[mk].inputTokens += t;
    const c = estimateCostUSD(t, mk, 'input');
    totalCostUSD += c;
    byModel[mk].costUSD += c;
  } else {
    outputTokens += t;
    byModel[mk].outputTokens += t;
    const c = estimateCostUSD(t, mk, 'output');
    totalCostUSD += c;
    byModel[mk].costUSD += c;
  }
}

    nextToken = res.nextToken ?? null;
    if (!nextToken) break;
  }

  setMonthlyUsage({
    monthLabel,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalCostUSD,
    byModel,
  });
}

  async function loadMessages(threadId: string, seedSeenAssistantIds = false) {
    const res = await client.models.ChatMessage.list({
      filter: { threadId: { eq: threadId } },
    });

const items = (res.data ?? [])
  .filter((m: any) => m && m.id) // <-- IMPORTANT
  .map((m: any) => ({
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  })) as Message[];

    items.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    setMessages(items);

    // When loading an existing thread, don't re-animate historical assistant replies.
    if (seedSeenAssistantIds) {
      seenAssistantIdsRef.current = new Set(
        items
          .filter((m) => m.role === 'assistant' && !m.id.startsWith('typing-') && m.content.trim().length > 0)
          .map((m) => m.id)
      );
      setAnimatingAssistantId(null);
    }
  }

  async function newChat() {
    setActiveThreadId(null);
    setMessages([]);
    setInput('');

    // New chat should start unassigned unless user explicitly starts from a Project
    setActiveProjectId(null);
    setProjectViewProjectId(null);

    if (window.innerWidth < 768) setSidebarOpen(false);
  }

  useEffect(() => {
    loadProjects();
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      // Start fade/loading state immediately on click
      setIsSwitchingThread(true);

      if (activeThreadId) {
      await loadMessages(activeThreadId, true);
      }
       else {
        setMessages([]);
      }

      // End fade/loading state (guard against race)
      if (!cancelled) {
        // let the DOM paint once so the fade feels smooth
        requestAnimationFrame(() => setIsSwitchingThread(false));
      }
    };

    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

    async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    const toUpload = Array.from(files);
    setUploadingCount((n) => n + toUpload.length);

    try {
      for (const f of toUpload) {
        const presignRes: any = await client.queries.attachments({
          action: 'presign',
          filename: f.name,
          contentType: f.type || 'text/plain',
          sizeBytes: f.size,
        });

        if (presignRes?.errors?.length) {
          throw new Error(presignRes.errors.map((e: any) => e.message).join(' | '));
        }

        const { uploadUrl, s3Key } = presignRes?.data ?? presignRes ?? {};
        if (!uploadUrl || !s3Key) throw new Error('Presign failed (missing uploadUrl or s3Key).');

        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        });
        if (!put.ok) throw new Error(`Upload failed: ${put.status} ${put.statusText}`);

        const ingestRes: any = await client.queries.attachments({
          action: 'ingest',
          s3Key,
          contentType: f.type || 'application/octet-stream',
        });

        if (ingestRes?.errors?.length) {
          throw new Error(ingestRes.errors.map((e: any) => e.message).join(' | '));
        }

        const { kind, metaKey } = ingestRes?.data ?? ingestRes ?? {};
        if (!kind || !metaKey) throw new Error('Ingest failed (missing kind/metaKey).');

        setAttachments((prev) => [...prev, { kind, metaKey, name: f.name }]);
      }
    } finally {
      setUploadingCount((n) => Math.max(0, n - toUpload.length));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function sendMessage(overrideText?: string, overrideProjectId?: string | null) {
  const text = String(overrideText ?? input ?? '').trim();
    if (!text || sending) return;

    setSending(true);
    stopRef.current = { aborted: false };
    setInput('');
    requestAnimationFrame(() => resizeTextarea());

    let threadId = activeThreadId;

    // Create thread on first message
    if (!threadId) {
      const threadCreatedAt = nowIso();
const createThread = await client.models.ChatThread.create({
  title: 'New chat',
  modelKey: selectedModelKey,
  projectId: overrideProjectId ?? activeProjectId, // ✅ allow ProjectView to force project target
  createdAt: threadCreatedAt,
});


      threadId = createThread.data?.id ?? null;
      if (!threadId) {
        setSending(false);
        alert('Failed to create chat thread.');
        return;
      }

      setActiveThreadId(threadId);
      // Refresh sidebar
      await loadThreads();

      // Lock model for this thread after first message (in-memory only; source of truth is DB modelKey)
      setThreadModelKeys((prev) => ({ ...prev, [threadId!]: selectedModelKey }));

      // Fire-and-forget so it doesn't slow down the first response.
      // IMPORTANT: capture values NOW to avoid async drift (text/threadId/model changing later)
      const threadIdForTitle = threadId!;
      const firstMessageForTitle = text;
      const modelKeyForTitle = selectedModelKey;

      void (async () => {
        try {
          const generatedTitle = await generateChatTitleFromFirstMessage(
            firstMessageForTitle,
            modelKeyForTitle
          );

          const updateRes = await client.models.ChatThread.update({
            id: threadIdForTitle,
            title: generatedTitle,
          });

          // IMPORTANT: Amplify often returns GraphQL errors here WITHOUT throwing.
          if ((updateRes as any)?.errors?.length) {
            console.warn('ChatThread.update errors:', (updateRes as any).errors);
            return;
          }

          // Optimistically update sidebar state immediately
          setThreads((prev) =>
            prev.map((t) => (t.id === threadIdForTitle ? { ...t, title: generatedTitle } : t))
          );

          // Also refresh from backend (keeps state consistent across devices)
          await loadThreads();
        } catch (e) {
          console.warn('Title generation/update failed:', e);
        }
      })();

    }

    // Write user message
    const userCreatedAt = nowIso();
const userMsg = await client.models.ChatMessage.create({
  threadId,
  role: 'user',
  content: text,
  createdAt: userCreatedAt,
});

    const userMsgId = userMsg.data?.id ?? crypto.randomUUID();

    // Optimistic UI update
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        threadId,
        role: 'user',
        content: text,
        createdAt: userCreatedAt,
      },
    ]);

    // Add a temporary "thinking" assistant bubble immediately
    const typingId = `typing-${Date.now()}`;
    typingIdRef.current = typingId;
    const typingCreatedAt = nowIso();
setMessages((prev) => [
  ...prev,
  {
    id: typingId,
    threadId,
    role: 'assistant',
    content: '',
    createdAt: typingCreatedAt,
  },
]);

    let assistantText = '';
    try {
      // Pick the correct project instructions (important when ProjectView forces a projectId)
      const instructionsProject =
        (overrideProjectId ? projectById[String(overrideProjectId)] : activeProject) ?? null;

      const projectInstructions =
        instructionsProject?.description && instructionsProject.description.trim().length > 0
          ? `Project instructions:\n${instructionsProject.description.trim()}`
          : '';

      const textForModel = projectInstructions ? `${projectInstructions}\n\n${text}` : text;

      const history = JSON.stringify(buildHistoryForModel(messages, textForModel, 20));

      // Inject a short system prompt that sets a warm baseline + model-specific tone.
      // We keep the UI/DB message as the user's raw text; only the model sees this wrapper.
      const systemPrompt = buildSystemPrompt(effectiveModelKey);

      const novaTag = isNova
        ? `\n\n[nova quality:${novaQuality} size:${novaSize} ar:${novaAR} images:${novaImages}${
            novaSeed.trim() ? ` seed:${novaSeed.trim()}` : ''
          }${novaStyle !== 'none' ? ` style:${novaStyle}` : ''}]`
        : '';

      // IMPORTANT: include project instructions for ALL models (including Nova)
      const composedPrompt = isNova
        ? `${textForModel}${novaTag}`
        : [systemPrompt, `\n\nUser message:\n${textForModel}`].join('');

      const chatRes: any = await client.queries.chat({
        prompt: composedPrompt,
        modelKey: effectiveModelKey,
        history,
        attachments: JSON.stringify(attachments.map((a) => ({ metaKey: a.metaKey, kind: a.kind }))),
      });


      if (chatRes?.errors?.length) {
        const msg = chatRes.errors.map((e: any) => e.message).join(' | ');
        throw new Error(msg);
      }

      const stopReason =
        chatRes?.data?.stopReason ??
        chatRes?.stopReason ??
        null;

      assistantText =
        chatRes?.data?.text ??
        chatRes?.data ??
        'Sorry — no response.';

      // If the model hit the output limit, store a hidden marker
      // so we can show a Continue button (and it persists cross-device).
      if (String(stopReason).toLowerCase().includes('max')) {
        assistantText = `${assistantText}\n\n${TRUNCATION_MARKER}`;
      }

    } catch (e: any) {
      assistantText = `Error calling chat(): ${e?.message ?? String(e)}`;
    }

    if (stopRef.current.aborted) return;

  const assistantCreatedAt = nowIso();
  const assistantMsg = await client.models.ChatMessage.create({
    threadId,
    role: 'assistant',
    content: assistantText,
    createdAt: assistantCreatedAt,
  });

  setAttachments([]);

  const assistantMsgId = assistantMsg.data?.id ?? crypto.randomUUID();

  // Mark seen + start anim BEFORE the message is rendered to avoid a 1-frame flash
  seenAssistantIdsRef.current.add(assistantMsgId);
  setAnimatingAssistantId(assistantMsgId);

  // Replace the temporary typing bubble with the real assistant message
  const createdAt = nowIso();
  setMessages((prev) => [
  ...prev.filter((m) => m.id !== typingId),
  {
    id: assistantMsgId,
    threadId,
    role: 'assistant',
    content: assistantText,
    createdAt: assistantCreatedAt,
  },
]);

  // Scroll so the start of the assistant message is in view (once), but allow user scrolling after
  requestAnimationFrame(() => {
    const scroller = scrollRef.current;
    const el = messageElsRef.current.get(assistantMsgId);
    if (!scroller || !el) return;

    const desiredTopOffset = 16;
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    scroller.scrollTop += elRect.top - (scrollerRect.top + desiredTopOffset);
  });

  // Refresh monthly totals (best-effort)
void loadThreads(); // threads include modelKey + we compute totals from that

    typingIdRef.current = null;
    setSending(false);
  }

  function stopGeneration() {
    stopRef.current.aborted = true;
    if (typingIdRef.current) {
      setMessages((prev) => prev.filter((m) => m.id !== typingIdRef.current));
      typingIdRef.current = null;
    }
    setSending(false);
  }

  async function sendFromComposer(overrideText?: string) {
    // If we’re on the Project home screen, first message should create a thread under that project
    if (projectViewProject && !activeThreadId) {
      setActiveProjectId(projectViewProject.id);
      setProjectViewProjectId(null);
      setActiveThreadId(null);
      setMessages([]);
      await sendMessage(overrideText, projectViewProject.id);
      return;
    }

    await sendMessage(overrideText);
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendFromComposer();
    }
  }

  return (
    <div className="h-dvh w-full bg-white text-zinc-900">
      <div className="flex h-full">

        <Sidebar
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          newChat={newChat}
          query={query}
          setQuery={setQuery}
          softDeleteProject={softDeleteProject}
          unassignedThreads={unassignedThreads}
          projectThreadsById={projectThreadsById}
          projects={projects}
          activeProjectId={activeProjectId}
          setActiveProjectId={(pid) => {
            setActiveProjectId(pid);
            setActiveThreadId(null);
            setMessages([]);
          }}
          onOpenCreateProject={() => {
            setProjectCreateError(null);
            setEditingProjectId(null);
            setNewProjectName('');
            setNewProjectDescription('');
            setProjectModalOpen(true);
          }}
          onSelectProject={(pid) => {
          // select a project
          setActiveProjectId(pid);

          // clear current chat so ProjectView can show
          setActiveThreadId(null);
          setMessages([]);

          // show project home screen (whatever state you named it)
          setProjectViewProjectId(pid);
           }}
          activeThreadId={activeThreadId}
          setActiveThreadId={setActiveThreadId}

          onSelectThread={(threadId) => {
            setActiveThreadId(threadId);

            // Selecting a chat replaces project-home view with message list
            setProjectViewProjectId(null);

            const t = threads.find((x) => x.id === threadId);
            setActiveProjectId(t?.projectId ?? null);

            setModelMenuOpen(false);
          }}

          softDeleteChat={softDeleteChat}
          monthlyTotalsOpenMobile={monthlyTotalsOpenMobile}
          setMonthlyTotalsOpenMobile={setMonthlyTotalsOpenMobile}
          monthlyUsage={monthlyUsage}
          modelOptions={MODEL_OPTIONS}
          formatUSD={formatUSD}
          onSignOut={onSignOut}
        />

        {/* Main */}
        <main className="relative flex h-full flex-1 flex-col">

          <ChatHeader
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            modelMenuRef={modelMenuRef}
            isModelLocked={isModelLocked}
            modelMenuOpen={modelMenuOpen}
            setModelMenuOpen={setModelMenuOpen}
            selectedModelName={selectedModel.name}
            selectedModelKey={selectedModelKey}
            lockedModelKey={lockedModelKey ?? null}
            modelOptions={MODEL_OPTIONS}
            setSelectedModelKey={setSelectedModelKey}
            chatTotalTokens={chatTotalTokens}
            chatTotalCostUSD={chatTotalCostUSD}
            formatUSD={formatUSD}
          />

          {projectViewProject && !activeThreadId ? (
            <ProjectView
              project={projectViewProject}
              threads={projectViewThreads}
              onStartChat={async (firstMessage) => {
                // Start a new chat in this project with the first message (ChatGPT style)
                setActiveProjectId(projectViewProject.id);
                setProjectViewProjectId(null);
                setActiveThreadId(null);
                setMessages([]);

                // Force thread creation under this project
                await sendMessage(firstMessage, projectViewProject.id);
              }}
              onSelectThread={(threadId) => {
                setProjectViewProjectId(null);
                setActiveThreadId(threadId);
                if (window.innerWidth < 768) setSidebarOpen(false);
              }}
              onDeleteThread={(threadId) => softDeleteChat(threadId)}
              onEditProject={() => {
                setProjectCreateError(null);
                setEditingProjectId(projectViewProject.id);
                setNewProjectName(projectViewProject.name);
                setNewProjectDescription(projectViewProject.description ?? '');
                setProjectModalOpen(true);
              }}
            />
          ) : (
            <>
              {/* Messages */}
              <MessageList
                scrollRef={scrollRef}
                bottomRef={bottomRef}
                isSwitchingThread={isSwitchingThread}
                messages={messages}
                messageElsRef={messageElsRef}
                effectiveModelKey={effectiveModelKey}
                copiedMessageId={copiedMessageId}
                copyMessageToClipboard={copyMessageToClipboard}
                animatingAssistantId={animatingAssistantId}
                stripTruncationMarker={stripTruncationMarker}
                hasTruncationMarker={hasTruncationMarker}
                estimateInputTokens={estimateInputTokens}
                estimateTokens={estimateTokens}
                estimateCostUSD={estimateCostUSD}
                formatUSD={formatUSD}
                formatMsgTime={formatMsgTime}
                sendMessage={sendMessage}
                TypingIndicator={TypingIndicator}
                AnimatedMarkdownMessage={AnimatedMarkdownMessage}
                getScrollContainer={getScrollContainer}
                getMessageEl={getMessageEl}
              />

            </>
          )}

          <MessageComposer
            fileInputRef={fileInputRef}
            uploadFiles={uploadFiles}
            attachments={attachments}
            setAttachments={setAttachments}
            uploadingCount={uploadingCount}
            isNova={isNova}
            novaQuality={novaQuality}
            setNovaQuality={setNovaQuality}
            novaSize={novaSize}
            setNovaSize={setNovaSize}
            novaAR={novaAR}
            setNovaAR={setNovaAR}
            novaImages={novaImages}
            setNovaImages={setNovaImages}
            novaStyle={novaStyle}
            setNovaStyle={setNovaStyle}
            novaSeed={novaSeed}
            setNovaSeed={setNovaSeed}
            textareaRef={textareaRef}
            input={input}
            handleInputChange={handleInputChange}
            onComposerKeyDown={onComposerKeyDown}
            resizeTextarea={resizeTextarea}
            sending={sending}
            sendFromComposer={sendFromComposer}
            stopGeneration={stopGeneration}
            estimatedInputTokens={estimatedInputTokens}
            estimatedInputCostUSD={estimatedInputCostUSD}
            formatUSD={formatUSD}
            selectedModelName={selectedModel.name}
            isModelLocked={isModelLocked}
          />
        </main>

        {projectModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <button
              type="button"
              className="absolute inset-0 bg-black/40"
              aria-label="Close project modal"
              onClick={() => setProjectModalOpen(false)}
            />

            {/* Modal */}
            <div className="relative w-[92vw] max-w-lg rounded-2xl bg-white shadow-xl border border-zinc-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-medium tracking-tight text-zinc-900">
                    {editingProjectId ? 'Edit project' : 'Create project'}
                  </div>
                  <div className="text-sm text-zinc-500 mt-1">
                    Group chats and apply persistent instructions.
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100"
                  onClick={() => setProjectModalOpen(false)}
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 space-y-3">
                <div className="space-y-1">
                  <label className="text-sm text-zinc-700">Project name</label>
                  <input
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-200"
                    placeholder="e.g. Marketing copy"
                    autoFocus
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-sm text-zinc-700">Project description</label>
                  <textarea
                    value={newProjectDescription}
                    onChange={(e) => setNewProjectDescription(e.target.value)}
                    className="w-full min-h-[120px] rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-200"
                    placeholder="Persistent instructions for chats in this project…"
                  />
                  <div className="text-xs text-zinc-500">
                    This will be included with every message you send in this project.
                  </div>
                </div>

                {projectCreateError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {projectCreateError}
                  </div>
                )}
              </div>

              <div className="mt-5 flex items-center justify-between gap-2">
                {editingProjectId ? (
                  <button
                    type="button"
                    className="rounded-xl px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                    onClick={() => void softDeleteProject(editingProjectId)}
                    disabled={creatingProject}
                  >
                    Delete project
                  </button>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-xl px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    onClick={() => {
                      setProjectModalOpen(false);
                      setEditingProjectId(null);
                    }}
                    disabled={creatingProject}
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    className="rounded-xl px-3 py-2 text-sm bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60"
                    onClick={saveProject}
                    disabled={creatingProject}
                  >
                    {creatingProject ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}