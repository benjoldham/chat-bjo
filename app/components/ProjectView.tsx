'use client';

type Thread = { id: string; title: string; projectId?: string | null };
type Project = { id: string; name: string; description?: string | null };

export default function ProjectView(props: {
  project: Project;
  threads: Thread[];
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onEditProject: () => void;
}) {
    const { project, threads, onSelectThread, onDeleteThread, onEditProject } = props;

  return (
    <div className="h-full w-full overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 md:px-6 py-8 pb-40">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📁</span>
          <div>
            <div className="text-2xl font-medium tracking-tight text-zinc-900">{project.name}</div>
            <div className="text-sm text-zinc-500 mt-1">
              {project.description?.trim()
                ? project.description
                : 'Add a description to guide how the assistant responds in this project.'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onEditProject}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
        >
          Edit
        </button>
      </div>

      {/* Project chat list */}
      <div className="mt-6">
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <span className="rounded-full bg-zinc-100 px-3 py-1">Chats</span>
        </div>

        <div className="mt-3 divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-white">
          {threads.length === 0 ? (
            <div className="p-4 text-sm text-zinc-600">No chats in this project yet.</div>
          ) : (
            threads.map((t) => (
              <div key={t.id} className="group relative flex items-center">
                <button
                  type="button"
                  onClick={() => onSelectThread(t.id)}
                  className="w-full px-4 py-3 pr-12 text-left hover:bg-zinc-50"
                  title={t.title}
                >
                  <div className="text-sm text-zinc-900 truncate">{t.title}</div>
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDeleteThread(t.id);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-sm text-zinc-500 opacity-0 transition hover:bg-zinc-100 group-hover:opacity-100"
                  title="Delete chat"
                  aria-label="Delete chat"
                >
                  🗑
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  </div>
  );
}