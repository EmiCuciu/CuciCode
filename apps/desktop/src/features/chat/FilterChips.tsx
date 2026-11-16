import { EVENT_CATEGORIES, type EventCategory } from '@cucicode/protocol';
import { useApp } from '../../state/store.ts';

export function FilterChips({ projectId, hidden }: { projectId: string; hidden: ReadonlySet<EventCategory> }) {
  const toggle = useApp((state) => state.toggleCategory);
  return (
    <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
      {EVENT_CATEGORIES.map((category) => {
        const shown = !hidden.has(category);
        return (
          <button
            key={category}
            type="button"
            aria-pressed={shown}
            onClick={() => void toggle(projectId, category)}
            className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
              shown ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-muted line-through'
            }`}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}
