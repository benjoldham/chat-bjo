'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

type Thread = {
  id: string;
  title: string;
  createdAt: string;
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
  { key: 'openai', name: 'Open AI', description: 'Best for general questions' },
  { key: 'claude_haiku', name: 'Claude Haiku 3.5', description: 'Best for coding' },
  { key: 'meta', name: 'Meta', description: 'Best open weight' },
];

// ---- Token + pricing estimates (frontend) ----
// NOTE: Update these numbers to match YOUR Bedrock price assumptions.
// Values are "GBP per 1K tokens".
const MODEL_PRICING_GBP: Record<
  string,
  { inputPer1K: number; outputPer1K: number }
> = {
  // DUMMY PLACEHOLDERS — replace with your real pricing
  openai: { inputPer1K: 0.002, outputPer1K: 0.006 },
  claude_haiku: { inputPer1K: 0.0005, outputPer1K: 0.0025 },
  meta: { inputPer1K: 0.0007, outputPer1K: 0.0020 },
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
    modelKey === 'meta' ? 4.1 :
    4.0;

  // Add a tiny overhead to better match typical prompt formatting
  const base = Math.ceil(chars / divisor);
  const overhead = 6;

  return base + overhead;
}

function formatGBP(amount: number) {
  // Keep it readable for tiny numbers
  if (amount === 0) return '£0.00';
  if (amount < 0.01) return `£${amount.toFixed(4)}`;
  return `£${amount.toFixed(2)}`;
}

function nowIso() {
  return new Date().toISOString();
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
          h1: ({ children }) => <h1 className="mt-6 mb-3 text-2xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-5 mb-2 text-xl font-semibold">{children}</h2>,
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
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [isSwitchingThread, setIsSwitchingThread] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState<string>('claude_haiku');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [threadModelKeys, setThreadModelKeys] = useState<Record<string, string>>({});
  const modelMenuRef = useRef<HTMLDivElement | null>(null);

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

  const selectedModel = useMemo(
    () => MODEL_OPTIONS.find((m) => m.key === effectiveModelKey) ?? MODEL_OPTIONS[0],
    [effectiveModelKey]
  );

  const pricing = MODEL_PRICING_GBP[effectiveModelKey] ?? { inputPer1K: 0, outputPer1K: 0 };

  const estimatedInputTokens = useMemo(
    () => estimateTokens(input, effectiveModelKey),
    [input, effectiveModelKey]
  );

  const estimatedInputCostGBP = useMemo(
    () => (estimatedInputTokens / 1000) * pricing.inputPer1K,
    [estimatedInputTokens, pricing.inputPer1K]
  );

  // Lock the model once there is at least one user message in the active thread
  const isModelLocked = useMemo(() => {
    if (!activeThreadId) return false;
    if (threadModelKeys[activeThreadId]) return true;
    return messages.some((m) => m.role === 'user');
  }, [activeThreadId, threadModelKeys, messages]);


  const bottomRef = useRef<HTMLDivElement | null>(null);

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


  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

    useEffect(() => {
    if (!activeThreadId) return;
    const saved = localStorage.getItem(`threadModel:${activeThreadId}`);
    if (saved && saved !== threadModelKeys[activeThreadId]) {
      setThreadModelKeys((prev) => ({ ...prev, [activeThreadId]: saved }));
    }
  }, [activeThreadId, threadModelKeys]);

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

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, query]);

  async function loadThreads() {
    const res = await client.models.ChatThread.list({
      // newest first (best-effort; if sort not supported, we’ll sort locally)
    });

    const items = (res.data ?? []).map((t: any) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      deletedAt: t.deletedAt ?? null,
    })) as Thread[];


    const visible = items.filter((t) => !t.deletedAt);

    visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    setThreads(visible);

    if (!activeThreadId && visible[0]) setActiveThreadId(visible[0].id);
  }

  async function loadMessages(threadId: string) {
    const res = await client.models.ChatMessage.list({
      filter: { threadId: { eq: threadId } },
    });

    const items = (res.data ?? []).map((m: any) => ({
      id: m.id,
      threadId: m.threadId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })) as Message[];

    items.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    setMessages(items);
  }

    async function newChat() {
      setActiveThreadId(null);
      setMessages([]);
      setInput('');

      // Mobile UX: close the sidebar so the chat view is visible
      if (window.innerWidth < 768) setSidebarOpen(false);
    }

  useEffect(() => {
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      // Start fade/loading state immediately on click
      setIsSwitchingThread(true);

      if (activeThreadId) {
        await loadMessages(activeThreadId);
      } else {
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

  async function sendMessage(overrideText?: string) {
  const text = String(overrideText ?? input ?? '').trim();
    if (!text || sending) return;

    setSending(true);
    setInput('');
    requestAnimationFrame(() => resizeTextarea());

    let threadId = activeThreadId;

    // Create thread on first message
    if (!threadId) {
      const createThread = await client.models.ChatThread.create({
        title: 'New chat',
        createdAt: nowIso(),
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

      // Lock model for this thread after first message (store locally)
      setThreadModelKeys((prev) => ({ ...prev, [threadId!]: selectedModelKey }));
      localStorage.setItem(`threadModel:${threadId!}`, selectedModelKey);

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
    const userMsg = await client.models.ChatMessage.create({
      threadId,
      role: 'user',
      content: text,
      createdAt: nowIso(),
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
        createdAt: nowIso(),
      },
    ]);

    // Add a temporary "thinking" assistant bubble immediately
    const typingId = `typing-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: typingId,
        threadId,
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      },
    ]);

    let assistantText = '';
    try {
      const history = JSON.stringify(buildHistoryForModel(messages, text, 20));

      const chatRes: any = await client.queries.chat({
        prompt: text,
        modelKey: effectiveModelKey,
        history,
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

    await client.models.ChatMessage.create({
      threadId,
      role: 'assistant',
      content: assistantText,
      createdAt: nowIso(),
    });

    // Remove the temporary typing bubble
    setMessages((prev) => prev.filter((m) => m.id !== typingId));

    // Reload messages to keep consistent ordering/ids
    await loadMessages(threadId);

    setSending(false);
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="h-dvh w-full bg-white text-zinc-900">
      <div className="flex h-full">
        {/* Sidebar */}
        <aside
          className={[
            // Base
            'h-full bg-secondary overflow-hidden',

            // Mobile: drawer overlay
            'fixed inset-y-0 left-0 z-50 w-72 transition-transform duration-200',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
            'border-r border-zinc-200',

            // Desktop (md+): in-layout sidebar that pushes content (your current behavior)
            'md:static md:z-auto md:translate-x-0 md:transition-all md:duration-200',
            sidebarOpen ? 'md:w-72 md:border-r md:border-zinc-200' : 'md:w-0 md:border-r-0',
          ].join(' ')}
        >
          <div className={sidebarOpen ? 'flex h-full flex-col gap-8' : 'hidden'}>
            <div className="flex items-center justify-between py-3 px-5 h-14 border-b border-zinc-200">
              <div className="text-lg font-regular text-primary tracking-tighter">ChatBot</div>
              <button onClick={() => setSidebarOpen(false)} className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-200" aria-label="Collapse sidebar">
                ◀
              </button>
            </div>

            <div id="getStarted" className="flex flex-col p-2.5 gap-2">

              <div className="text-sm px-2.5 font-regular text-secondary tracking-tighter">Get started</div>

              <ul className="space-y-1">
                <li className="mb-0">
                  <button
                    onClick={newChat}
                    className="w-full rounded-lg px-2.5 py-2  text-sm font-regular text-primary text-left tracking-tighter button sidebar transition"
                  >
                    New chat
                  </button>
                </li>

                <li className="">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search chat"
                    className="w-full rounded-lg px-2.5 py-2 text-sm font-regular tracking-tighter text-primary text-left outline-none focus:border-zinc-400"
                  />
                </li>
              </ul>

            </div>

            <div id="chatHistory" className="flex flex-col flex-1 overflow-y-auto px-2 pb-2 gap-2">
              <div className="text-sm font-regular text-secondary tracking-tighter px-2.5">Your chats</div>
              {filteredThreads.length === 0 ? (
                <div className="px-2.5 py-3 text-sm text-primary">No chats yet.</div>
              ) : (
                <ul className="space-y-1">
                                    {filteredThreads.map((t) => (
                    <li key={t.id}>
                      <div
                        className={[
                          'group relative flex items-center rounded-lg transition',
                          activeThreadId === t.id ? 'item-active' : 'item-hover',
                        ].join(' ')}
                      >
                        <button
                          onClick={() => {
                            setActiveThreadId(t.id);

                            // Close the sidebar on mobile so the chat is visible
                            if (window.innerWidth < 768) setSidebarOpen(false);
                          }}
                          className="w-full rounded-lg px-2.5 py-2 pr-10 text-left text-sm tracking-tighter text-primary transition button sidebar truncate whitespace-nowrap overflow-hidden text-ellipsis">
                            {t.title}
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            softDeleteChat(t.id);
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-sm text-zinc-500 opacity-0 transition hover:bg-zinc-200 group-hover:opacity-100"
                          aria-label="Delete chat"
                          title="Delete chat"
                        >
                          🗑
                        </button>


                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-zinc-200 p-3">
              <button
                onClick={onSignOut}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile backdrop when sidebar is open */}
        {sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-40 bg-black/30 md:hidden"
            aria-label="Close sidebar"
          />
        )}

        {/* Main */}
        <main className="relative flex h-full flex-1 flex-col">
          {/* Top bar (mobile sidebar toggle) */}
          <div className="flex items-center gap-2 border-b border-zinc-200 p-2 md:p-3 h-14">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-md px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
                aria-label="Open sidebar"
              >
                ☰
              </button>
            )}
              {/* Model selector */}
              <div className="relative" ref={modelMenuRef}>
                <button
                  type="button"
                  disabled={isModelLocked}
                  onClick={() => { if (isModelLocked) return; setModelMenuOpen((v) => !v); }}
                  className="mb-0 inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-900 hover:bg-zinc-50 disabled:opacity-60 disabled:cursor-not-allowed"
                  aria-expanded={modelMenuOpen}
                >
                  <span className="font-medium">{selectedModel.name}</span>
                  <span className="text-zinc-500">∨</span>
                </button>

                {modelMenuOpen && !isModelLocked && (
                  <div className="absolute left-0 top-11 w-80 rounded-2xl border border-zinc-200 bg-white shadow-lg p-2 z-20">
                    {MODEL_OPTIONS.map((opt) => {
                      const active = opt.key === selectedModelKey;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => {
                            setSelectedModelKey(opt.key);
                            setModelMenuOpen(false);
                          }}
                          className={[
                            'w-full rounded-xl px-3 py-2 text-left hover:bg-zinc-50 transition',
                            active ? 'bg-zinc-100' : '',
                          ].join(' ')}
                        >
                          <div className="text-base text-zinc-900">{opt.name}</div>
                          <div className="text-sm text-zinc-500">{opt.description}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              
          </div>

          {/* Messages */}
            <div
              className={[
                "relative flex-1 overflow-y-auto px-4 py-6 md:px-8 transition-opacity pb-40 duration-200 ease-out",
                isSwitchingThread ? "opacity-40" : "opacity-100",
              ].join(" ")}
            >
            <div className="mx-auto max-w-3xl space-y-4">

              {messages.length === 0 ? (
                <div className="text-sm text-zinc-500">
                  Start a new chat by typing below.
                </div>
              ) : (
                messages.map((m, idx) => (
                                    <div key={m.id} className="w-full">
                    {m.role === 'user' ? (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] group">
                          <div className="whitespace-pre-wrap rounded-2xl px-4 py-3 text-md leading-relaxed text-zinc-900 bg-bubble">
                            {m.content}
                          </div>

                          {/* Actions (user) */}
                          {!m.id.startsWith('typing-') && (
                            <div className="mt-1 flex justify-end gap-1 transition opacity-100 lg:opacity-0 lg:group-hover:opacity-100">

                              <button
                                type="button"
                                onClick={() => copyMessageToClipboard(stripTruncationMarker(m.content), m.id)}
                                className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                aria-label="Copy message"
                                title="Copy"
                              >
                                {copiedMessageId === m.id ? 'Copied' : 'Copy'}
                              </button>

                              {m.role === 'assistant' &&
                                idx === messages.length - 1 &&
                                hasTruncationMarker(m.content) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      sendMessage(
                                        'Continue from where you left off. Start exactly with the next line. Do not repeat earlier text.'
                                      )
                                    }
                                    className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                    aria-label="Continue"
                                    title="Continue"
                                  >
                                    Continue
                                  </button>
                                )}

                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] group">

                          <div className="px-4 py-3 text-md leading-relaxed text-zinc-900">
                            {m.id.startsWith('typing-') ? (
                              <TypingIndicator />
                            ) : (
                            <MarkdownMessage
                              text={stripTruncationMarker(m.content)}
                              onCopy={(code) => copyMessageToClipboard(code, `${m.id}-code`)}
                            />
                            )}
                          </div>

                          {/* Actions (assistant) */}
                          {!m.id.startsWith('typing-') && (
                            <div className="mt-1 flex justify-start gap-1">
                              <button
                                type="button"
                                onClick={() => copyMessageToClipboard(stripTruncationMarker(m.content), m.id)}
                                className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                aria-label="Copy message"
                                title="Copy"
                              >
                                {copiedMessageId === m.id ? 'Copied' : 'Copy'}
                              </button>

                              {m.role === 'assistant' && idx === messages.length - 1 && hasTruncationMarker(m.content) && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    sendMessage(
                                      'Continue from where you left off. Start exactly with the next line. Do not repeat earlier text.'
                                    )
                                  }
                                  className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                  aria-label="Continue"
                                  title="Continue"
                                >
                                  Continue
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}

              <div ref={bottomRef} />

            </div>
          </div>

          {/* Composer */}
          <div className="absolute bottom-0 left-0 right-0 z-30 p-4 md:p-6 gradient-gradual">
            <div className="mx-auto max-w-3xl">
              <div className="relative">
                <div className="relative flex">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={(e) => {
                      onComposerKeyDown(e);
                      requestAnimationFrame(() => resizeTextarea());
                    }}
                    placeholder="Message"
                    rows={1}
                    className="w-full resize-none rounded-4xl border border-zinc-200 bg-white background-primary px-6 py-[18px] pr-20 text-base text-primary leading-relaxed outline-none focus:border-zinc-400 max-h-[400px] overflow-y-auto"
                  />
                  <button
                    onClick={() => sendMessage()}
                    disabled={sending || !input.trim()}
                    className="absolute right-2 bottom-2 h-12 px-4 rounded-full bg-zinc-900 text-base font-medium text-white flex items-center justify-center disabled:opacity-40"
                  >
                    {sending ? <TypingIndicator /> : 'Send'}
                  </button>
                </div>

                {/* Token + cost estimate */}
                <div className="mt-2 flex items-center justify-between px-2 text-xs text-zinc-500">
                  <span>
                    Est. {estimatedInputTokens.toLocaleString()} tokens
                    <span className="ml-2 text-zinc-400">
                      ({selectedModel.name}{isModelLocked ? '' : ''})
                    </span>
                  </span>
                  <span>≈ {formatGBP(estimatedInputCostGBP)} input</span>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
