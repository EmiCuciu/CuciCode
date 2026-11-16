import type { RailSection } from '../../state/nav.ts';

const SECTIONS: { id: RailSection; label: string; phase: number }[] = [
  { id: 'projects', label: 'Projects', phase: 1 },
  { id: 'activity', label: 'Activity', phase: 4 },
  { id: 'toolkit', label: 'Toolkit', phase: 2 },
  { id: 'usage', label: 'Usage', phase: 4 },
  { id: 'concepts', label: 'Concepts', phase: 4 },
  { id: 'settings', label: 'Settings', phase: 1 },
];

export function LeftRail({ active, onSelect }: { active: RailSection; onSelect: (section: RailSection) => void }) {
  return (
    <nav className="flex w-[76px] shrink-0 flex-col gap-1 border-r border-line bg-panel py-2">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-current={active === section.id}
          onClick={() => onSelect(section.id)}
          className={`mx-1 rounded px-1 py-2 text-[11px] ${active === section.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

export function sectionPhase(section: RailSection): number {
  return SECTIONS.find((item) => item.id === section)?.phase ?? 1;
}
