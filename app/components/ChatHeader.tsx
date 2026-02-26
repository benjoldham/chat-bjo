'use client';

import React from 'react';

type ModelOption = {
  key: string;
  name: string;
  description: string;
};

const MODEL_ICON: Record<string, { src: string; alt: string }> = {
  openai: { src: '/icons/models/open-ai.svg', alt: 'OpenAI' },
  claude_haiku: { src: '/icons/models/claude.svg', alt: 'Anthropic' },
  claude_sonnet: { src: '/icons/models/claude.svg', alt: 'Anthropic' },
  google_gemma: { src: '/icons/models/google.svg', alt: 'Google' },
  meta: { src: '/icons/models/meta.svg', alt: 'Meta' },
};

function getModelIcon(key: string) {
  return MODEL_ICON[key] ?? { src: '/icons/models/default.svg', alt: 'Model' };
}

export default function ChatHeader(props: {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;

  modelMenuRef: React.RefObject<HTMLDivElement>;
  isModelLocked: boolean;
  modelMenuOpen: boolean;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;

  selectedModelName: string;
  selectedModelKey: string;

  // ✅ NEW: model key for the currently active (historic) thread, if any
  lockedModelKey: string | null;

  modelOptions: ModelOption[];
  setSelectedModelKey: (key: string) => void;

  chatTotalTokens: number;
  chatTotalCostUSD: number;
  formatUSD: (amount: number) => string;
}) {

  const {
    sidebarOpen,
    setSidebarOpen,
    modelMenuRef,
    isModelLocked,
    modelMenuOpen,
    setModelMenuOpen,
    selectedModelName,
    selectedModelKey,
    lockedModelKey,
    modelOptions,
    setSelectedModelKey,
    chatTotalTokens,
    chatTotalCostUSD,
    formatUSD,
  } = props;

  // ✅ Use the thread's locked model when viewing a historic chat
  const effectiveModelKey = isModelLocked && lockedModelKey ? lockedModelKey : selectedModelKey;

  // ✅ Derive the label from the effective key so icon+name stay aligned
  const effectiveModelName =
    modelOptions.find((m) => m.key === effectiveModelKey)?.name ?? selectedModelName;

  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 p-2 md:p-3 h-14">
      {!sidebarOpen && (
        <button onClick={() => setSidebarOpen(true)} className="rounded-md px-1 py-1 text-sm text-zinc-700 hover:bg-zinc-100" aria-label="Open sidebar">
          <img src="/icons/sidebar.svg"  alt="Toggle sidebar"  className="h-5 w-5" />
        </button>
      )}

      {/* Model selector */}
      <div className="relative" ref={modelMenuRef}>
            <button
            type="button"
            disabled={isModelLocked}
            onClick={() => {
                if (isModelLocked) return;
                setModelMenuOpen((v) => !v);
            }}
            className="mb-0 inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-900 hover:bg-zinc-50 disabled:opacity-60 disabled:cursor-not-allowed"
            aria-expanded={modelMenuOpen}
            >
            {(() => {
                const icon = getModelIcon(effectiveModelKey);
                return (
                <img
                    src={icon.src}
                    alt={icon.alt}
                    className="h-5 w-5 shrink-0"
                />
                );
            })()}

            <span className="font-medium">{effectiveModelName}</span>
            <span className="text-zinc-500"> <img src="/icons/chevron.svg" alt="Copy" className="h-5 w-5"/> </span>
            </button>

        {modelMenuOpen && !isModelLocked && (
          <div className="absolute left-0 top-11 w-80 rounded-2xl border border-zinc-200 bg-white shadow-lg p-2 z-20">
            {modelOptions.map((opt) => {
              const active = opt.key === effectiveModelKey;
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
                <div className="flex items-start gap-3">
                {(() => {
                    const icon = getModelIcon(opt.key);
                    return (
                    <img
                        src={icon.src}
                        alt={icon.alt}
                        className="mt-0.5 h-5 w-5 shrink-0"
                    />
                    );
                })()}

                <div className="min-w-0">
                    <div className="text-base text-zinc-900">{opt.name}</div>
                    <div className="text-sm text-zinc-500">{opt.description}</div>
                </div>
                </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Chat totals (top right) */}
      <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
        <span title="Total tokens and estimated total cost (input + output)" className="select-none">
          ≈ {chatTotalTokens.toLocaleString()} tok • {formatUSD(chatTotalCostUSD)}
        </span>
      </div>
    </div>
  );
}