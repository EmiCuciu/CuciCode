import { useEffect, useState } from 'react';
import { inDesktopShell, onSidecarEvent } from './bridge/tauri.ts';
import { ChatView } from './features/chat/ChatView.tsx';
import { Inspector } from './features/inspector/Inspector.tsx';
import { LeftRail, sectionPhase } from './features/layout/LeftRail.tsx';
import { TopBar } from './features/layout/TopBar.tsx';
import { ProjectsSidebar } from './features/projects/ProjectsSidebar.tsx';
import { SettingsView } from './features/settings/SettingsView.tsx';
import { ToolkitView } from './features/toolkit/ToolkitView.tsx';
import { WorkflowSettings } from './features/workflow/WorkflowSettings.tsx';
import { useWorkflow } from './features/workflow/workflowStore.ts';
import { useNav } from './state/nav.ts';
import { selectChat, useApp } from './state/store.ts';

type Theme = 'dark' | 'light';
const THEME_KEY = 'cucicode.theme';

function storedTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function App() {
  const section = useNav((state) => state.section);
  const setSection = useNav((state) => state.go);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const activeId = useApp((state) => state.activeProjectId);
  const project = useApp((state) => state.projects.find((item) => item.id === state.activeProjectId) ?? null);
  const chat = useApp(selectChat(activeId));
  const error = useApp((state) => state.error);
  const dismissError = useApp((state) => state.dismissError);
  const desktop = inDesktopShell();
  const [settingsTab, setSettingsTab] = useState<'claude' | 'workflow'>(import.meta.env.VITE_START_SETTINGS_TAB === 'workflow' ? 'workflow' : 'claude');
  const workflowError = useWorkflow((state) => state.error);

  useEffect(() => {
    if (desktop && activeId) {
      void useWorkflow.getState().load(activeId);
    }
  }, [desktop, activeId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    const { receive, loadProjects } = useApp.getState();
    const unlisten = onSidecarEvent(receive);
    void loadProjects();
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [desktop]);

  return (
    <div className="flex h-full flex-col">
      <TopBar project={project} chat={chat} theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
      {!desktop && <div className="bg-warn/15 px-3 py-1 text-warn">Running in a browser without the desktop shell: start the app with "npm run dev" from the repository root.</div>}
      {workflowError && (
        <div className="flex items-center gap-3 bg-bad/15 px-3 py-1 text-bad">
          <span className="min-w-0 flex-1 truncate">{workflowError}</span>
          <button type="button" onClick={() => useWorkflow.getState().dismissError()}>
            dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-3 bg-bad/15 px-3 py-1 text-bad">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" onClick={dismissError}>
            dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <LeftRail active={section} onSelect={setSection} />
        {section === 'projects' && (
          <>
            <ProjectsSidebar />
            {activeId ? (
              <>
                <ChatView projectId={activeId} />
                <Inspector projectId={activeId} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted">Add or select a project.</div>
            )}
          </>
        )}
        {section === 'settings' && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex gap-1 border-b border-line px-3 py-1">
              {(['claude', 'workflow'] as const).map((tab) => (
                <button key={tab} type="button" aria-current={settingsTab === tab} className={`rounded px-2 py-1 ${settingsTab === tab ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`} onClick={() => setSettingsTab(tab)}>
                  {tab === 'claude' ? 'Claude Code settings' : 'Workflow (CuciCode)'}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1">{settingsTab === 'claude' ? <SettingsView project={project} /> : <WorkflowSettings project={project} />}</div>
          </div>
        )}
        {section === 'toolkit' && <ToolkitView />}
        {section !== 'projects' && section !== 'settings' && section !== 'toolkit' && (
          <div className="flex flex-1 items-center justify-center text-muted">This section arrives in Phase {sectionPhase(section)}.</div>
        )}
      </div>
    </div>
  );
}
