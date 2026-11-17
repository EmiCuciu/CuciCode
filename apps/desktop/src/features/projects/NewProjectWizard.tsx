import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { pluginApi, projectsApi, toolkitApi, workflowApi } from '../../bridge/tauri.ts';
import type { Marketplace } from '../../bridge/types.ts';
import { useApp } from '../../state/store.ts';
import { defaultConfig, modeRoute } from '../workflow/config.ts';
import { defaultForm, joinPath, summary, TEMPLATES, validateForm, type NewProjectForm, type Template } from './newProject.ts';

interface Step {
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail: string;
}

const input = 'w-full rounded border border-line bg-bg px-2 py-1 outline-none focus:border-accent';
const SCAFFOLD_LABELS: Record<string, string> = {
  folder: 'Create the folder',
  template: 'Starter files',
  gitignore: '.gitignore',
  claude_md: 'CLAUDE.md',
  stories: 'Stories/ and Plans/',
  claude_settings: 'Claude Code settings',
  cucicode_settings: 'CuciCode settings and Code Rules',
  git: 'git init and first commit',
};

function Check({ label, note, checked, onChange }: { label: string; note?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 py-0.5">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {note && <span className="block text-[11px] text-muted">{note}</span>}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1 font-mono text-[11px] tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function NewProjectWizard({ onClose }: { onClose: () => void }) {
  const projects = useApp((state) => state.projects);
  const firstParent = projects[0]?.path.replace(/[\\/][^\\/]+$/, '') ?? '';
  const [form, setForm] = useState<NewProjectForm>(defaultForm(firstParent));
  const [phase, setPhase] = useState<'form' | 'summary' | 'running' | 'finished'>('form');
  const [steps, setSteps] = useState<Step[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const set = <K extends keyof NewProjectForm>(key: K, value: NewProjectForm[K]): void => setForm({ ...form, [key]: value });
  const problem = validateForm(form);

  useEffect(() => {
    toolkitApi
      .scan(null)
      .then((scan) => setMarketplaces(scan.marketplaces))
      .catch(() => setMarketplaces([]));
  }, []);

  const pickParent = async (): Promise<void> => {
    const selected = await open({ directory: true, multiple: false, title: 'Create the project in' });
    if (typeof selected === 'string') {
      set('parent', selected);
    }
  };

  const run = async (): Promise<void> => {
    setPhase('running');
    const log: Step[] = [];
    const push = (step: Step): void => {
      log.push(step);
      setSteps([...log]);
    };
    const attempt = async (label: string, work: () => Promise<string>): Promise<boolean> => {
      push({ label, state: 'running', detail: '' });
      const index = log.length - 1;
      try {
        log[index] = { label, state: 'done', detail: await work() };
        setSteps([...log]);
        return true;
      } catch (reason) {
        log[index] = { label, state: 'failed', detail: String(reason) };
        setSteps([...log]);
        return false;
      }
    };

    let path: string;
    try {
      const result = await invoke<{ path: string; steps: { step: string; ok: boolean; detail: string }[] }>('project_scaffold', {
        spec: { name: form.name, parent: form.parent, template: form.template, gitInit: form.gitInit, gitignore: form.gitignore, claudeMd: form.claudeMd, codeRules: form.codeRules, stories: form.stories, pipeline: form.pipeline, predefinedRouting: form.predefinedRouting },
      });
      path = result.path;
      for (const step of result.steps) {
        push({ label: SCAFFOLD_LABELS[step.step] ?? step.step, state: step.ok ? 'done' : 'failed', detail: step.detail });
      }
    } catch (reason) {
      push({ label: 'Create the project', state: 'failed', detail: String(reason) });
      setPhase('finished');
      return;
    }

    if (form.remote !== 'none') {
      await attempt(`Create the ${form.remote === 'github' ? 'GitHub' : 'Bitbucket'} repository and push`, () => invoke<string>('project_create_remote', { projectPath: path, host: form.remote, owner: form.remoteOwner.trim(), name: form.name }));
    }
    const added = await attempt('Add it to CuciCode', async () => (await projectsApi.add(path)).name);
    if (form.codeRules || form.pipeline) {
      await attempt('Install the CuciCode plugin', async () => {
        const scan = await toolkitApi.scan(path);
        if (scan.items.some((item) => item.plugin === 'cucicode')) {
          return 'already installed';
        }
        const source = await workflowApi.pluginSource();
        await pluginApi.addMarketplace(source, 'user', path).catch((reason: unknown) => {
          if (!String(reason).toLowerCase().includes('already')) {
            throw reason;
          }
        });
        await pluginApi.act('install', 'cucicode@cucicode', 'user', path);
        return 'installed at user scope';
      });
    }
    for (const plugin of form.sharedPlugins) {
      await attempt(`Install ${plugin}`, async () => {
        await pluginApi.act('install', plugin, 'project', path);
        return 'installed for this project';
      });
    }
    if (added) {
      await attempt('Open the project', async () => {
        await useApp.getState().loadProjects();
        const project = useApp.getState().projects.find((entry) => entry.path.toLowerCase() === path.toLowerCase());
        if (!project) {
          throw new Error('the project was added but is not in the list');
        }
        await useApp.getState().selectProject(project.id);
        if (form.brainstorm) {
          const route = modeRoute(defaultConfig(), 'brainstorm');
          await useApp.getState().applyMode(project.id, 'brainstorm', { model: route.model, effort: route.effort as never, permissionMode: route.permissionMode });
          return 'in Brainstorm mode';
        }
        return project.name;
      });
    }
    setPhase('finished');
  };

  if (phase === 'running' || phase === 'finished') {
    const failed = steps.some((step) => step.state === 'failed');
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="mb-3 text-base font-semibold">{phase === 'running' ? `Creating ${form.name}…` : failed ? `${form.name} was created with problems` : `${form.name} is ready`}</h2>
        {steps.map((step, index) => (
          <div key={index} className="flex items-baseline gap-3 py-0.5">
            <span className={`w-14 shrink-0 font-mono text-[11px] ${step.state === 'done' ? 'text-ok' : step.state === 'failed' ? 'text-bad' : 'text-muted'}`}>{step.state}</span>
            <span className="w-72 shrink-0">{step.label}</span>
            <span className="min-w-0 flex-1 break-all text-[12px] text-muted">{step.detail}</span>
          </div>
        ))}
        {phase === 'finished' && (
          <>
            {failed && <p className="mt-3 text-muted">Steps before a failure were kept; nothing was rolled back. Fix the cause and do the failed step by hand, or from Settings.</p>}
            <button type="button" className="mt-4 rounded bg-accent/20 px-3 py-1 text-accent" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    );
  }

  if (phase === 'summary') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h2 className="mb-1 text-base font-semibold">Create {form.name}?</h2>
        <p className="mb-3 text-muted">Nothing has been created yet. This is what will happen, in order:</p>
        <ol className="mb-4 list-decimal pl-6">
          {summary(form).map((line) => (
            <li key={line} className="py-0.5">
              {line}
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <button type="button" className="rounded bg-accent/20 px-3 py-1 text-accent" onClick={() => void run()}>
            Create the project
          </button>
          <button type="button" className="rounded border border-line px-3 py-1" onClick={() => setPhase('form')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const available = marketplaces.flatMap((marketplace) => marketplace.plugins.map((plugin) => ({ id: `${plugin.name}@${marketplace.name}`, description: plugin.description })));
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h2 className="mb-3 text-base font-semibold">New project</h2>
        <Section title="Project">
          <label className="mb-2 block">
            <span className="text-muted">Name</span>
            <input className={`${input} font-mono`} value={form.name} placeholder="my-app" onChange={(event) => set('name', event.target.value)} />
          </label>
          <div className="mb-2 flex items-end gap-2">
            <label className="block min-w-0 flex-1">
              <span className="text-muted">Location</span>
              <input className={`${input} font-mono`} value={form.parent} onChange={(event) => set('parent', event.target.value)} />
            </label>
            <button type="button" className="rounded border border-line px-2 py-1 hover:bg-raised" onClick={() => void pickParent()}>
              Browse
            </button>
          </div>
          {form.name && form.parent && <div className="mb-2 font-mono text-[11px] text-muted">{joinPath(form.parent, form.name)}</div>}
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                aria-pressed={form.template === template.id}
                title={template.note}
                className={`rounded border px-3 py-1 ${form.template === template.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-raised'}`}
                onClick={() => set('template', template.id as Template)}
              >
                {template.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Git">
          <Check label="git init" checked={form.gitInit} onChange={(value) => set('gitInit', value)} />
          <Check label="Generate .gitignore" note="Always includes .env*, secrets, editor and build output" checked={form.gitignore} onChange={(value) => set('gitignore', value)} />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span>Remote repository</span>
            <select className="rounded border border-line bg-panel px-1.5 py-1" value={form.remote} onChange={(event) => set('remote', event.target.value as NewProjectForm['remote'])}>
              <option value="none">none</option>
              <option value="github">create on GitHub and push</option>
              <option value="bitbucket">create on Bitbucket and push</option>
            </select>
            {form.remote !== 'none' && (
              <input className="w-56 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px]" placeholder={form.remote === 'github' ? 'organisation (empty = your account)' : 'workspace'} value={form.remoteOwner} onChange={(event) => set('remoteOwner', event.target.value)} />
            )}
          </div>
          {form.remote !== 'none' && <div className="text-[11px] text-muted">Uses the access token stored in Settings → Workflow → Git. The repository is created private.</div>}
        </Section>

        <Section title="Claude Code">
          <Check label="Generate CLAUDE.md" note="A starter you can extend later with /init" checked={form.claudeMd} onChange={(value) => set('claudeMd', value)} />
          <Check label="Enable Code Rules" note="Guidance rules file and enforcement hooks" checked={form.codeRules} onChange={(value) => set('codeRules', value)} />
          <Check label="Create Stories/" checked={form.stories} onChange={(value) => set('stories', value)} />
          <Check label="Enable the full agentic pipeline" checked={form.pipeline} onChange={(value) => set('pipeline', value)} />
          <Check label="Default model routing" note="Predefined table: planner on Opus, explorer on Haiku, the rest on Sonnet. Off = Auto" checked={form.predefinedRouting} onChange={(value) => set('predefinedRouting', value)} />
          <Check label="Start in Brainstorm mode" checked={form.brainstorm} onChange={(value) => set('brainstorm', value)} />
        </Section>

        {available.length > 0 && (
          <Section title="Shared toolkit">
            <p className="mb-1 text-[11px] text-muted">Plugins from your marketplaces, installed for this project only.</p>
            <div className="max-h-48 overflow-y-auto rounded border border-line p-2">
              {available.map((plugin) => (
                <Check
                  key={plugin.id}
                  label={plugin.id}
                  note={plugin.description ?? undefined}
                  checked={form.sharedPlugins.includes(plugin.id)}
                  onChange={(value) => set('sharedPlugins', value ? [...form.sharedPlugins, plugin.id] : form.sharedPlugins.filter((entry) => entry !== plugin.id))}
                />
              ))}
            </div>
          </Section>
        )}

        {problem && form.name.length > 0 && <div className="mb-2 text-bad">{problem}</div>}
        <div className="flex gap-2">
          <button type="button" disabled={problem !== null} className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40" onClick={() => setPhase('summary')}>
            Review
          </button>
          <button type="button" className="rounded border border-line px-3 py-1" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
