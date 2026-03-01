'use client';

import React from 'react';

type Attachment = {
  metaKey: string;
  name: string;
};

export default function MessageComposer(props: {
  // file upload
  fileInputRef: React.RefObject<HTMLInputElement>;
  uploadFiles: (files: FileList | null) => void;

  // attachments UI
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  uploadingCount: number;

  // nova controls
  isNova: boolean;
  novaQuality: 'standard' | 'premium';
  setNovaQuality: (v: 'standard' | 'premium') => void;
  novaSize: 1024 | 2048;
  setNovaSize: (v: 1024 | 2048) => void;
  novaAR: '1:1' | '16:9' | '9:16';
  setNovaAR: (v: '1:1' | '16:9' | '9:16') => void;
  novaImages: 1 | 2;
  setNovaImages: (v: 1 | 2) => void;
  novaStyle: 'none' | 'photoreal' | 'illustration' | '3d' | 'anime';
  setNovaStyle: (v: 'none' | 'photoreal' | 'illustration' | '3d' | 'anime') => void;
  novaSeed: string;
  setNovaSeed: (v: string) => void;

  // textarea
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onComposerKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  resizeTextarea: () => void;

  // send
  sending: boolean;
  sendFromComposer: () => void;
  TypingIndicator: React.ComponentType;

  // footer
  estimatedInputTokens: number;
  estimatedInputCostUSD: number;
  formatUSD: (n: number) => string;
  selectedModelName: string;
  isModelLocked: boolean;
}) {
  const {
    fileInputRef,
    uploadFiles,
    attachments,
    setAttachments,
    uploadingCount,
    isNova,
    novaQuality,
    setNovaQuality,
    novaSize,
    setNovaSize,
    novaAR,
    setNovaAR,
    novaImages,
    setNovaImages,
    novaStyle,
    setNovaStyle,
    novaSeed,
    setNovaSeed,
    textareaRef,
    input,
    handleInputChange,
    onComposerKeyDown,
    resizeTextarea,
    sending,
    sendFromComposer,
    TypingIndicator,
    estimatedInputTokens,
    estimatedInputCostUSD,
    formatUSD,
    selectedModelName,
    isModelLocked,
  } = props;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 p-4 md:p-6 gradient-gradual">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.json,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.go,.java,.cs,.rb,.php,.rs,.c,.cpp,.h,.hpp,.pdf,.docx,image/*"
            className="hidden"
            onChange={(e) => void uploadFiles(e.target.files)}
          />

          {/* Attachments row (above composer, horizontal scroll) */}
          {(attachments.length > 0 || uploadingCount > 0) && (
            <div className="mb-2 px-1">
              <div className="hide-scrollbar flex flex-nowrap gap-2 overflow-x-auto whitespace-nowrap pb-1">
                {attachments.map((a) => (
                  <span
                    key={a.metaKey}
                    className="shrink-0 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700"
                  >
                    <span className="truncate max-w-[220px]">{a.name}</span>
                    <button
                      type="button"
                      className="text-zinc-400 hover:text-zinc-700"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((x) => x.metaKey !== a.metaKey))
                      }
                      aria-label={`Remove ${a.name}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}

                {uploadingCount > 0 && (
                  <span className="shrink-0 inline-flex items-center rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-500">
                    Uploading…
                  </span>
                )}
              </div>
            </div>
          )}

          {isNova && (
            <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
              {/* Quality */}
              <div className="inline-flex rounded-full border border-zinc-200 bg-white p-1">
                <button
                  type="button"
                  onClick={() => setNovaQuality('standard')}
                  className={`px-3 py-1 text-xs rounded-full ${
                    novaQuality === 'standard'
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  Standard
                </button>
                <button
                  type="button"
                  onClick={() => setNovaQuality('premium')}
                  className={`px-3 py-1 text-xs rounded-full ${
                    novaQuality === 'premium'
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                  title="Higher quality (higher cost)"
                >
                  Premium
                </button>
              </div>

              {/* Size */}
              <div className="inline-flex rounded-full border border-zinc-200 bg-white p-1">
                <button
                  type="button"
                  onClick={() => setNovaSize(1024)}
                  className={`px-3 py-1 text-xs rounded-full ${
                    novaSize === 1024 ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  1024
                </button>
                <button
                  type="button"
                  onClick={() => setNovaSize(2048)}
                  className={`px-3 py-1 text-xs rounded-full ${
                    novaSize === 2048 ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  2048
                </button>
              </div>

              {/* Aspect ratio */}
              <div className="inline-flex rounded-full border border-zinc-200 bg-white p-1">
                {(['1:1', '16:9', '9:16'] as const).map((ar) => (
                  <button
                    key={ar}
                    type="button"
                    onClick={() => setNovaAR(ar)}
                    className={`px-3 py-1 text-xs rounded-full ${
                      novaAR === ar ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                  >
                    {ar}
                  </button>
                ))}
              </div>

              {/* Images per prompt */}
              <div className="inline-flex rounded-full border border-zinc-200 bg-white p-1">
                {[1, 2].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setNovaImages(n as 1 | 2)}
                    className={`px-3 py-1 text-xs rounded-full ${
                      novaImages === n ? 'bg-zinc-900 text-white' : 'text-zinc-700 hover:bg-zinc-100'
                    }`}
                    title={n === 2 ? 'Generates 2 images (cost x2)' : undefined}
                  >
                    {n}
                  </button>
                ))}
              </div>

              {/* Style */}
              <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1">
                <span className="text-xs text-zinc-500">Style</span>
                <select
                  value={novaStyle}
                  onChange={(e) => setNovaStyle(e.target.value as any)}
                  className="bg-transparent text-xs text-zinc-700 outline-none"
                >
                  <option value="none">None</option>
                  <option value="photoreal">Photoreal</option>
                  <option value="illustration">Illustration</option>
                  <option value="3d">3D</option>
                  <option value="anime">Anime</option>
                </select>
              </div>

              {/* Seed */}
              <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1">
                <span className="text-xs text-zinc-500">Seed</span>
                <input
                  value={novaSeed}
                  onChange={(e) => setNovaSeed(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
                  placeholder="random"
                  className="w-24 bg-transparent text-xs text-zinc-700 outline-none placeholder:text-zinc-400"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  onClick={() => setNovaSeed(String(Math.floor(Math.random() * 858_993_460)))}
                  className="text-xs text-zinc-600 hover:text-zinc-900"
                  title="Randomise seed"
                >
                  ↻
                </button>
                {novaSeed.trim().length > 0 && (
                  <button
                    type="button"
                    onClick={() => setNovaSeed('')}
                    className="text-xs text-zinc-400 hover:text-zinc-700"
                    title="Clear seed"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Composer input */}
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
              className="w-full resize-none rounded-4xl border border-zinc-200 bg-white background-primary pl-14 pr-20 py-[18px] text-base text-primary leading-relaxed outline-none focus:border-zinc-400 max-h-[400px] overflow-y-auto"
            />

            {/* Attach button pinned bottom-left */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute left-2 bottom-2 h-10 w-10 rounded-full hover:bg-zinc-100 flex items-center justify-center text-zinc-600"
              title="Attach files"
              aria-label="Attach files"
              disabled={sending}
            >
              📎
            </button>

            {/* Send button pinned bottom-right */}
            <button
              onClick={() => void sendFromComposer()}
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
                ({selectedModelName}{isModelLocked ? '' : ''})
              </span>
            </span>
            <span>≈ {formatUSD(estimatedInputCostUSD)} input</span>
          </div>
        </div>
      </div>
    </div>
  );
}