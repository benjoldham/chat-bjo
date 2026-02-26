'use client';

type Thread = {
  id: string;
  title: string;
};

type MonthlyUsage = {
  monthLabel: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
};

type ModelOption = {
  key: string;
  name: string;
  description: string;
};

export default function Sidebar(props: {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;

  newChat: () => void;

  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;

  filteredThreads: Thread[];
  activeThreadId: string | null;
  setActiveThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  
  // ✅ NEW: lets parent set active thread + locked model key together
  onSelectThread?: (threadId: string) => void;

  softDeleteChat: (threadId: string) => void;

  monthlyTotalsOpenMobile: boolean;
  setMonthlyTotalsOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;

  monthlyUsage: MonthlyUsage | null;

  modelOptions: ModelOption[];
  formatUSD: (amount: number) => string;

  onSignOut: () => void;
}) {

  const {
    sidebarOpen,
    setSidebarOpen,
    newChat,
    query,
    setQuery,
    filteredThreads,
    activeThreadId,
    setActiveThreadId,
    onSelectThread,
    softDeleteChat,
    monthlyTotalsOpenMobile,
    setMonthlyTotalsOpenMobile,
    monthlyUsage,
    modelOptions,
    formatUSD,
    onSignOut,
  } = props;

  return (
    <>
      {/* Sidebar */}
      <aside
        id="sidebar"
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
            <button onClick={() => setSidebarOpen(false)}className="rounded-md px-1 py-1 text-sm text-zinc-600 hover:bg-zinc-200" aria-label="Collapse sidebar">
                  <img src="/icons/sidebar.svg"  alt="Toggle sidebar"  className="h-5 w-5" />
            </button>
          </div>

          <div id="getStarted" className="flex flex-col px-2.5 gap-2">
            <div className="text-sm px-2.5 font-regular text-secondary tracking-tighter">Get started</div>

            <ul className="space-y-1">
              <li className="mb-0">
                <button onClick={newChat}
                  className="flex flex-row w-full rounded-lg px-2.5 py-2 gap-1.5 text-sm font-regular text-primary text-left tracking-tighter button sidebar transition"
                > <img src="/icons/compose.svg"  alt="Start a new chat"  className="h-5 w-5" /> New chat </button>
              </li>

              <li className="">

                <button className="flex flex-row items-center w-full rounded-lg gap-1.5 px-2.5 py-2 button sidebar transition">

                    <img src="/icons/search.svg"  alt="Search your chat history"  className="h-5 w-5" />

                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chat" className="w-full rounded-lg text-sm font-regular tracking-tighter text-primary text-left outline-none focus:border-zinc-400"/>

                </button>

              </li>
            </ul>
          </div>

          <div id="chatHistory" className="flex flex-col flex-1 overflow-y-auto px-2.5 pb-2 gap-2">
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
                        if (onSelectThread) onSelectThread(t.id);
                        else setActiveThreadId(t.id);

                        // Close the sidebar on mobile so the chat is visible
                        if (window.innerWidth < 768) setSidebarOpen(false);
                        }}
                        className="w-full rounded-lg px-2.5 py-2 pr-10 text-left text-sm tracking-tighter text-primary transition button sidebar truncate whitespace-nowrap overflow-hidden text-ellipsis"
                      >
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

          <div id="monthlyTotals" className="px-3 pb-2">
            <div className="rounded-xl border border-zinc-200 bg-white p-3">
              <button
                type="button"
                onClick={() => setMonthlyTotalsOpenMobile((v) => !v)}
                className="flex w-full items-center justify-between text-left"
                aria-expanded={monthlyTotalsOpenMobile}
              >
                <span className="text-sm font-medium text-zinc-900 tracking-tighter">This month</span>
                <span className="text-xs text-zinc-500 md:hidden">
                  {monthlyTotalsOpenMobile ? 'Hide' : 'Show'}
                </span>
              </button>

              {/* Collapsed on mobile, always shown on md+ */}
              <div className={`mt-2 ${monthlyTotalsOpenMobile ? 'block' : 'hidden'} md:block`}>
                {!monthlyUsage ? (
                  <div className="text-sm text-zinc-600">Calculating…</div>
                ) : (
                  <div className="space-y-1 text-sm text-zinc-700">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600">{monthlyUsage.monthLabel}</span>
                      <span className="font-medium">{formatUSD(monthlyUsage.totalCostUSD)}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600">Input tokens</span>
                      <span>{monthlyUsage.inputTokens.toLocaleString()}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600">Output tokens</span>
                      <span>{monthlyUsage.outputTokens.toLocaleString()}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-zinc-600">Total tokens</span>
                      <span>{monthlyUsage.totalTokens.toLocaleString()}</span>
                    </div>

                    <div className="mt-2 border-t border-zinc-100 pt-2 space-y-1">
                      {Object.entries(monthlyUsage.byModel).map(([mk, v]) => (
                        <div key={mk} className="flex items-center justify-between text-xs text-zinc-600">
                          <span className="truncate">{modelOptions.find((m) => m.key === mk)?.name ?? mk}</span>
                          <span>{formatUSD(v.costUSD)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
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
    </>
  );
}