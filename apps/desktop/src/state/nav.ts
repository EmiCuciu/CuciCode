import { create } from 'zustand';

export type RailSection = 'projects' | 'activity' | 'toolkit' | 'usage' | 'concepts' | 'settings';

interface NavState {
  section: RailSection;
  go: (section: RailSection) => void;
}

const SECTIONS: readonly RailSection[] = ['projects', 'activity', 'toolkit', 'usage', 'concepts', 'settings'];

/** Development aid: `VITE_START_SECTION=toolkit npm run dev` opens the app on that section. */
function initialSection(): RailSection {
  const requested = import.meta.env.VITE_START_SECTION as string | undefined;
  return SECTIONS.find((section) => section === requested) ?? 'projects';
}

export const useNav = create<NavState>((set) => ({
  section: initialSection(),
  go: (section) => set({ section }),
}));
