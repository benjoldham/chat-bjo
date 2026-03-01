'use client';

import React from 'react';

type Message = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export default function MessageList(props: {
  scrollRef: React.RefObject<HTMLDivElement>;
  bottomRef: React.RefObject<HTMLDivElement>;
  isSwitchingThread: boolean;

  messages: Message[];
  messageElsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;

  effectiveModelKey: string;

  copiedMessageId: string | null;
  copyMessageToClipboard: (text: string, id: string) => void;

  animatingAssistantId: string | null;

  stripTruncationMarker: (s: string) => string;
  hasTruncationMarker: (s: string) => boolean;

  estimateInputTokens: (text: string, modelKey: string) => number;
  estimateTokens: (text: string, modelKey: string) => number;
  estimateCostUSD: (tokens: number, modelKey: string, kind: 'input' | 'output') => number;

  formatUSD: (amount: number) => string;
  formatMsgTime: (iso: string) => string;

  sendMessage: (overrideText?: string) => void;

  TypingIndicator: React.ComponentType;
  AnimatedMarkdownMessage: React.ComponentType<{
    id: string;
    text: string;
    onCopy: (code: string) => void;
    isActive: boolean;
    getScrollContainer: () => HTMLDivElement | null;
    getMessageEl: (id: string) => HTMLDivElement | null;
  }>;

  getScrollContainer: () => HTMLDivElement | null;
  getMessageEl: (id: string) => HTMLDivElement | null;
}) {
  const {
    scrollRef,
    bottomRef,
    isSwitchingThread,
    messages,
    messageElsRef,
    effectiveModelKey,
    copiedMessageId,
    copyMessageToClipboard,
    animatingAssistantId,
    stripTruncationMarker,
    hasTruncationMarker,
    estimateInputTokens,
    estimateTokens,
    estimateCostUSD,
    formatUSD,
    formatMsgTime,
    sendMessage,
    TypingIndicator,
    AnimatedMarkdownMessage,
    getScrollContainer,
    getMessageEl,
  } = props;

  return (
    <div
      ref={scrollRef}
      className={[
        'relative flex-1 overflow-y-auto px-4 py-6 md:px-8 transition-opacity pb-40 duration-200 ease-out',
        isSwitchingThread ? 'opacity-40' : 'opacity-100',
      ].join(' ')}
    >
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.length === 0 ? (
          <div className="text-sm text-zinc-500">Start a new chat by typing below.</div>
        ) : (
          messages.map((m, idx) => (
            <div
              key={m.id}
              className="w-full"
              ref={(el) => {
                if (!el) {
                  messageElsRef.current.delete(m.id);
                  return;
                }
                messageElsRef.current.set(m.id, el);
              }}
            >
              {m.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="max-w-[85%] group inline-flex flex-col items-end">
                    <div className="whitespace-pre-wrap inline-block w-fit max-w-full rounded-2xl px-4 py-3 text-md leading-relaxed text-zinc-900 bg-bubble">
                      {m.content}
                    </div>

                    {!m.id.startsWith('typing-') && (
                      <div className="h-7 mt-1 flex w-full justify-end items-center gap-2 transition opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
                        <span className="py-1 text-xs text-zinc-400 select-none text-right break-words" title="Approx. tokens and estimated input cost">
                          {(() => {
                            const t = estimateInputTokens(stripTruncationMarker(m.content), effectiveModelKey);
                            const c = estimateCostUSD(t, effectiveModelKey, 'input');
                            return `${t.toLocaleString()} tok • ${formatUSD(c)} • ${formatMsgTime(m.createdAt)}`;
                          })()}
                        </span>

                        <button
                          type="button"
                          onClick={() => copyMessageToClipboard(stripTruncationMarker(m.content), m.id)}
                          className="rounded-md px-1 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                          aria-label="Copy message"
                          title="Copy"
                        >
                          {copiedMessageId === m.id ? ('Copied') : ( <img src="/icons/copy-right.svg" alt="Copy" className="h-5 w-5"/>)}
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
                    <div className="px-1 py-3 text-md leading-relaxed text-zinc-900">
                      {m.id.startsWith('typing-') ? (
                        <TypingIndicator />
                      ) : (
                        <AnimatedMarkdownMessage
                          id={m.id}
                          text={stripTruncationMarker(m.content)}
                          onCopy={(code) => copyMessageToClipboard(code, `${m.id}-code`)}
                          isActive={m.id === animatingAssistantId}
                          getScrollContainer={getScrollContainer}
                          getMessageEl={getMessageEl}
                        />
                      )}
                    </div>

                    {!m.id.startsWith('typing-') && (
                      <div className="mt-1 flex justify-start items-center gap-2 transition opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => copyMessageToClipboard(stripTruncationMarker(m.content), m.id)}
                          className="rounded-md px-1 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
                          aria-label="Copy message"
                          title="Copy"
                        >
                          {copiedMessageId === m.id ? ('Copied') : ( <img src="/icons/copy-left.svg" alt="Copy" className="h-5 w-5"/>)}
                        </button>

                        <span className="py-1 text-xs text-zinc-400 select-none" title="Approx. tokens and estimated input cost">
                          {(() => {
                            const t = estimateTokens(stripTruncationMarker(m.content), effectiveModelKey);
                            const c = estimateCostUSD(t, effectiveModelKey, 'output');
                            return `${formatMsgTime(m.createdAt)} • ${t.toLocaleString()} tok • ${formatUSD(c)}`;
                          })()}
                        </span>

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
              )}
            </div>
          ))
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}