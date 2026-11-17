import { openUrl } from '@tauri-apps/plugin-opener';
import { create } from 'zustand';
import { CONCEPTS } from './concepts.ts';

interface LearnState {
  selected: string;
  show: (id: string) => void;
}

export const useLearn = create<LearnState>((set) => ({
  selected: CONCEPTS[0]?.id ?? '',
  show: (id) => set({ selected: id }),
}));

export function ConceptsView() {
  const selected = useLearn((state) => state.selected);
  const show = useLearn((state) => state.show);
  const current = CONCEPTS.find((entry) => entry.id === selected) ?? CONCEPTS[0];
  return (
    <section className="flex min-w-0 flex-1">
      <nav className="w-60 shrink-0 overflow-y-auto border-r border-line bg-panel py-2">
        {CONCEPTS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={entry.id === current?.id}
            className={`block w-full border-l-2 px-3 py-1.5 text-left ${entry.id === current?.id ? 'border-accent bg-raised' : 'border-transparent text-muted hover:text-fg'}`}
            onClick={() => show(entry.id)}
          >
            {entry.title}
          </button>
        ))}
      </nav>
      {current && (
        <article className="max-w-3xl flex-1 overflow-y-auto p-6">
          <h1 className="mb-2 text-lg font-semibold">{current.title}</h1>
          <p className="mb-4 text-[15px]">{current.summary}</p>
          {current.body.map((paragraph) => (
            <p key={paragraph} className="mb-3 leading-relaxed text-fg/90">
              {paragraph}
            </p>
          ))}
          <div className="mt-4 rounded border border-line bg-raised p-3">
            <div className="mb-1 font-mono text-[11px] tracking-wide text-muted uppercase">In CuciCode</div>
            {current.inCuciCode}
          </div>
          <button type="button" className="mt-4 text-accent hover:underline" onClick={() => void openUrl(current.docs)}>
            Read the Claude Code documentation ↗
          </button>
        </article>
      )}
    </section>
  );
}
