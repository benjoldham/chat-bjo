'use client';

import { useEffect, useMemo, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { client } from './lib/amplifyClient';

type Thread = {
  id: string;
  title: string;
  createdAt: string;
};

type Message = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function titleFromFirstUserMessage(text: string) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? t.slice(0, 48) + '…' : t || 'New chat';
}

export default function Home() {
  return (
    <Authenticator>
      {({ signOut }) => <ChatApp onSignOut={signOut} />}
    </Authenticator>
  );
}

function ChatApp({ onSignOut }: { onSignOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

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
    })) as Thread[];

    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    setThreads(items);

    if (!activeThreadId && items[0]) setActiveThreadId(items[0].id);
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
  }

  useEffect(() => {
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeThreadId) loadMessages(activeThreadId);
    else setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput('');

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

    let assistantText = '';
    try {
      const chatRes: any = await client.queries.chat({ prompt: text });

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
            'h-full border-r border-zinc-200 bg-zinc-50 transition-all duration-200',
            sidebarOpen ? 'w-72' : 'w-0',
          ].join(' ')}
        >
          <div className={sidebarOpen ? 'flex h-full flex-col' : 'hidden'}>
            <div className="flex items-center justify-between p-3">
              <div className="text-sm font-semibold text-zinc-700">Your chats</div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-200"
                aria-label="Collapse sidebar"
              >
                ◀
              </button>
            </div>

            <div className="px-3 pb-2">
              <button
                onClick={newChat}
                className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                New chat
              </button>
            </div>

            <div className="px-3 pb-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chat"
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {filteredThreads.length === 0 ? (
                <div className="px-2 py-3 text-sm text-zinc-500">No chats yet.</div>
              ) : (
                <ul className="space-y-1">
                  {filteredThreads.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => setActiveThreadId(t.id)}
                        className={[
                          'w-full rounded-lg px-3 py-2 text-left text-sm',
                          activeThreadId === t.id
                            ? 'bg-zinc-200 text-zinc-900'
                            : 'text-zinc-700 hover:bg-zinc-100',
                        ].join(' ')}
                      >
                        {t.title}
                      </button>
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

        {/* Main */}
        <main className="flex h-full flex-1 flex-col">
          {/* Top bar (mobile sidebar toggle) */}
          <div className="flex items-center gap-2 border-b border-zinc-200 p-2 md:p-3">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-md px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
                aria-label="Open sidebar"
              >
                ☰
              </button>
            )}
            <div className="text-sm text-zinc-600">
              {activeThreadId ? 'Chat' : 'New chat'}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
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
                        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-200 px-4 py-3 text-sm leading-relaxed text-zinc-900">
                          {m.content}
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed text-zinc-900">
                          {m.content}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Composer */}
          <div className="border-t border-zinc-200 bg-white px-4 py-4 md:px-8">
            <div className="mx-auto max-w-3xl">
              <div className="relative">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder="Message"
                  rows={1}
                  className="w-full resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-3 pr-16 text-sm leading-relaxed outline-none focus:border-zinc-400"
                  style={{ maxHeight: 400 }}
                />
                <button
                  onClick={sendMessage}
                  disabled={sending || !input.trim()}
                  className="absolute bottom-2 right-2 rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Send
                </button>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Enter to send • Shift+Enter for a new line
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
