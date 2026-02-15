'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

// Keep only the last N turns and strip empty assistant bubbles
function buildHistoryForModel(allMessages: Message[], nextUserText: string, maxTurns = 20): ChatTurn[] {
  const turns: ChatTurn[] = allMessages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));

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
  { key: 'deepseek', name: 'Deepseek', description: 'Best for other stuff' },
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
  deepseek: { inputPer1K: 0.0008, outputPer1K: 0.002 },
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
    modelKey === 'deepseek' ? 4.2 :
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
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? t.slice(0, 48) + '…' : t || 'New chat';
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput('');
    requestAnimationFrame(() => resizeTextarea());

    let threadId = activeThreadId;

    // Create thread on first message
    if (!threadId) {
      const createThread = await client.models.ChatThread.create({
        title: titleFromFirstUserMessage(text),
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

      assistantText =
        chatRes?.data?.text ??
        chatRes?.data ??
        'Sorry — no response.';
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
                          className="w-full rounded-lg px-2.5 py-2 pr-10 text-left text-sm tracking-tighter text-primary transition button sidebar">
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
                messages.map((m) => (
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
                                onClick={() => copyMessageToClipboard(m.content, m.id)}
                                className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                aria-label="Copy message"
                                title="Copy"
                              >
                                {copiedMessageId === m.id ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] group">
                          <div className="whitespace-pre-wrap px-4 py-3 text-md leading-relaxed text-zinc-900">
                            {m.id.startsWith('typing-') ? <TypingIndicator /> : m.content}
                          </div>

                          {/* Actions (assistant) */}
                          {!m.id.startsWith('typing-') && (
                           <div className="mt-1 flex justify-start gap-1">
                              <button
                                type="button"
                                onClick={() => copyMessageToClipboard(m.content, m.id)}
                                className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                                aria-label="Copy message"
                                title="Copy"
                              >
                                {copiedMessageId === m.id ? 'Copied' : 'Copy'}
                              </button>
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
          <div className="absolute bottom-0 left-0 right-0 z-30 p-4 md:p-6">
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
                    onClick={sendMessage}
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
