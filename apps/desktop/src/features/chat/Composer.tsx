import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, Effort, PermissionMode } from '@cucicode/protocol';
import { useNav } from '../../state/nav.ts';
import { settingsApi, sidecar } from '../../bridge/tauri.ts';
import { useApp, type ChatMode, type ChatState } from '../../state/store.ts';
import { defaultConfig, modeRoute } from '../workflow/config.ts';
import { useWorkflow } from '../workflow/workflowStore.ts';
import { useToolkit, type ToolkitTab } from '../toolkit/toolkitStore.ts';
import { buildMenu, filterMenu, slashQuery, type SlashEntry } from './slashCommands.ts';
import { useDefaults } from '../defaults/useDefaults.ts';
import { claudeCommand, useTerminal } from '../terminal/terminalStore.ts';
import { useVoice, type VoiceControls } from './useVoice.ts';

const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Normal conversation with the main thread' },
  { id: 'brainstorm', label: 'Brainstorm', hint: 'Explore an idea with the planner model before deciding; your first message starts /cucicode:brainstorm' },
  { id: 'plan', label: 'Plan', hint: 'Planner model in plan mode: Claude researches and proposes a plan, and changes nothing until you approve' },
];

/** Shown before Claude Code reports the list, which also includes custom styles. */
const BUILT_IN_STYLES = ['default', 'Concise', 'Explanatory', 'Learning', 'Proactive'];

const MENU_SIZE = 10;
const NEW_COMMAND: SlashEntry = { name: 'New command…', description: 'Create your own slash command (opens Toolkit → Commands)', argumentHint: '', source: 'CuciCode', native: 'newCommand' };

function SlashMenu({ entries, active, onChoose, onHover }: { entries: SlashEntry[]; active: number; onChoose: (entry: SlashEntry) => void; onHover: (index: number) => void }) {
  return (
    <div className="mb-2 max-h-72 overflow-y-auto rounded border border-line bg-raised" role="listbox">
      {entries.map((entry, index) => (
        <button
          key={entry.name}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`block w-full px-2 py-1 text-left ${index === active ? 'bg-accent/15' : ''}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(entry);
          }}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] text-accent">{entry.native === 'newCommand' ? entry.name : `/${entry.name}`}</span>
            {entry.argumentHint && <span className="font-mono text-[11px] text-muted">{entry.argumentHint}</span>}
            <span className="min-w-0 flex-1 truncate text-muted">{entry.description}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{entry.source}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const DEFAULT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_MODELS = [
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
];

async function toAttachment(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return { name: file.name, mediaType: file.type || 'text/plain', dataBase64: btoa(binary) };
}

const selectClass = 'rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-fg';

function VoiceButton({ voice }: { voice: VoiceControls }) {
  const base = 'rounded border px-2 py-1 select-none';
  switch (voice.phase) {
    case 'unknown':
      return voice.error ? <span className="text-[11px] text-bad">{voice.error}</span> : null;
    case 'needs_model':
      return (
        <button
          type="button"
          className={`${base} border-line text-muted hover:text-fg`}
          title={voice.error ?? 'Downloads the Whisper base model (about 148 MB) once. Speech is transcribed on this machine; no audio leaves it.'}
          onClick={voice.downloadModel}
        >
          {voice.error ? 'Retry voice setup' : 'Enable voice (148 MB)'}
        </button>
      );
    case 'downloading':
      return <span className="font-mono text-[11px] text-muted">downloading speech model{voice.downloadPercent !== null ? ` ${voice.downloadPercent}%` : '…'}</span>;
    case 'transcribing':
      return <span className="font-mono text-[11px] text-muted">transcribing…</span>;
    default:
      return (
        <button
          type="button"
          title={voice.error ?? 'Hold to talk (or hold Ctrl+Space). The transcript lands in the box for editing.'}
          className={`${base} ${voice.phase === 'recording' ? 'border-bad bg-bad/20 text-bad' : voice.error ? 'border-bad/60 text-bad' : 'border-line text-muted hover:text-fg'}`}
          onPointerDown={voice.startRecording}
          onPointerUp={voice.stopRecording}
          onPointerLeave={voice.stopRecording}
        >
          {voice.phase === 'recording' ? 'Listening…' : 'Hold to talk'}
        </button>
      );
  }
}

export function Composer({ projectId, chatId, chat }: { projectId: string; chatId: string; chat: ChatState | null }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = useApp((state) => state.send);
  const interrupt = useApp((state) => state.interrupt);
  const setModel = useApp((state) => state.setModel);
  const setEffort = useApp((state) => state.setEffort);
  const setPermissionMode = useApp((state) => state.setPermissionMode);

  const voice = useVoice((transcript) => setText((current) => (current.trim().length > 0 ? `${current.trimEnd()} ${transcript}` : transcript)));

  const modelSelect = useRef<HTMLSelectElement>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const toolkitItems = useToolkit((state) => state.scan?.items);
  const query = menuDismissed ? null : slashQuery(text);
  const menu = useMemo(() => {
    if (query === null) {
      return [];
    }
    return [...filterMenu(buildMenu(chat?.info?.commands ?? null, toolkitItems ?? [], chat?.timeline.init?.terminalSlashCommands ?? []), query).slice(0, MENU_SIZE), NEW_COMMAND];
  }, [query, chat?.info?.commands, toolkitItems, chat?.timeline.init?.terminalSlashCommands]);
  const menuOpen = query !== null;

  useEffect(() => {
    if (menuOpen && useToolkit.getState().scan === null) {
      const path = useApp.getState().projects.find((project) => project.id === projectId)?.path ?? null;
      void useToolkit.getState().load(path);
    }
  }, [menuOpen, projectId]);

  const openToolkit = (tab: ToolkitTab): void => {
    useToolkit.getState().setTab(tab);
    useNav.getState().go('toolkit');
  };
  const choose = (entry: SlashEntry): void => {
    setMenuIndex(0);
    switch (entry.native) {
      case null:
        setText(`/${entry.name} `);
        return;
      case 'model':
        setText('');
        modelSelect.current?.focus();
        return;
      case 'toolkit:agent':
        openToolkit('agent');
        break;
      case 'toolkit:mcp':
        openToolkit('mcp');
        break;
      case 'toolkit:hook':
        openToolkit('hook');
        break;
      case 'toolkit:plugins':
        openToolkit('plugins');
        break;
      case 'newCommand':
        openToolkit('command');
        break;
      case 'usage':
        useNav.getState().go('usage');
        break;
      case 'terminal':
        useTerminal.getState().show(claudeCommand({ slash: `/${entry.name}`, windows: navigator.userAgent.includes('Windows') }));
        break;
    }
    setText('');
  };

  const [styleNote, setStyleNote] = useState<string | null>(null);
  const currentStyle = chat?.info?.outputStyle ?? chat?.timeline.init?.outputStyle ?? null;
  const styles = Array.from(new Set([...(chat?.info?.outputStyles ?? BUILT_IN_STYLES), ...(currentStyle ? [currentStyle] : [])]));
  const changeStyle = async (style: string): Promise<void> => {
    try {
      if (chat?.open) {
        await sidecar('chat.setOutputStyle', { chatId, style });
        await useApp.getState().refreshInfo(chatId);
      } else {
        const path = useApp.getState().projects.find((project) => project.id === projectId)?.path ?? null;
        await settingsApi.setValue('local', path, 'outputStyle', style);
      }
      setStyleNote(`Style ${style} applies from your next message (saved in .claude/settings.local.json).`);
    } catch (reason) {
      setStyleNote(String(reason));
    }
  };

  const running = chat !== null && chat.timeline.runState !== 'idle';
  const models = chat?.info?.models ?? FALLBACK_MODELS;
  const activeModel = chat?.info?.models.find((model) => model.value === chat.model);
  const efforts = activeModel && activeModel.effortLevels.length > 0 ? (activeModel.effortLevels as Effort[]) : DEFAULT_EFFORTS;
  const canSend = text.trim().length > 0 || attachments.length > 0;

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const added = await Promise.all(Array.from(files, toAttachment));
    setAttachments((current) => [...current, ...added]);
  };
  const projectPath = useApp((state) => state.projects.find((project) => project.id === projectId)?.path ?? null);
  const defaultOf = useDefaults(projectPath, chatId);
  const isMain = chatId === projectId;
  const mode: ChatMode = chat?.mode ?? 'chat';
  const config = useWorkflow((state) => state.projects[projectId]?.config);
  const applyMode = useApp((state) => state.applyMode);
  const [modeIsFresh, setModeIsFresh] = useState(false);
  const changeMode = (next: ChatMode): void => {
    const route = modeRoute(config ?? defaultConfig(), next);
    void applyMode(chatId, next, { model: route.model, effort: route.effort as Effort | undefined, permissionMode: route.permissionMode });
    setModeIsFresh(next === 'brainstorm');
  };

  const submit = (interruptFirst: boolean): void => {
    if (!canSend) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '/usage' && attachments.length === 0) {
      useNav.getState().go('usage');
      setText('');
      return;
    }
    const outgoing = mode === 'brainstorm' && modeIsFresh && !trimmed.startsWith('/') ? `/cucicode:brainstorm ${trimmed}` : trimmed;
    void send(chatId, outgoing, attachments, interruptFirst);
    setModeIsFresh(false);
    setText('');
    setAttachments([]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && menu.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((menuIndex + step + menu.length) % menu.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const entry = menu[Math.min(menuIndex, menu.length - 1)];
        if (entry) {
          choose(entry);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(false);
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault();
      void addFiles(event.clipboardData.files);
    }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };

  return (
    <div className="border-t border-line bg-panel p-3" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((attachment, index) => (
            <button
              key={`${attachment.name}-${index}`}
              type="button"
              title="Remove"
              className="rounded border border-line px-2 py-0.5 font-mono text-[11px] text-muted hover:text-bad"
              onClick={() => setAttachments((current) => current.filter((_, position) => position !== index))}
            >
              {attachment.name} ×
            </button>
          ))}
        </div>
      )}
      {styleNote && (
        <div className="mb-1 flex gap-2 text-[11px] text-muted">
          <span className="flex-1">{styleNote}</span>
          <button type="button" onClick={() => setStyleNote(null)}>
            ×
          </button>
        </div>
      )}
      {menuOpen && <SlashMenu entries={menu} active={Math.min(menuIndex, menu.length - 1)} onChoose={choose} onHover={setMenuIndex} />}
      <textarea
        value={text}
        rows={3}
        placeholder={running ? 'Agent is running — Queue adds your message after this turn' : 'Message Claude Code  (Enter to send, Shift+Enter for a new line)'}
        className="w-full resize-none rounded border border-line bg-bg p-2 text-fg outline-none focus:border-accent"
        onChange={(event) => {
          setText(event.target.value);
          setMenuDismissed(false);
          setMenuIndex(0);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isMain && (
          <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="Mode">
            {MODES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={mode === entry.id}
                title={entry.hint}
                className={`px-2 py-1 text-[12px] ${mode === entry.id ? 'bg-accent/20 text-accent' : 'text-muted hover:text-fg'}`}
                onClick={() => changeMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <select ref={modelSelect} aria-label="Model" title={`Default: ${defaultOf('model').value} (${defaultOf('model').source})`} className={selectClass} value={chat?.model ?? ''} onChange={(event) => void setModel(chatId, event.target.value || undefined)}>
          <option value="">{`model: default · ${defaultOf('model').value}`}</option>
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.displayName}
            </option>
          ))}
        </select>
        <select
          aria-label="Effort"
          className={selectClass}
          value={chat?.effort ?? ''}
          title="Changing effort restarts the session process; the conversation is resumed on your next message"
          onChange={(event) => void setEffort(chatId, (event.target.value || undefined) as Effort | undefined)}
        >
          <option value="">{`effort: default · ${defaultOf('effort').value}`}</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        <select
          aria-label="Permission mode"
          className={selectClass}
          value={chat?.permissionMode ?? 'default'}
          onChange={(event) => void setPermissionMode(chatId, event.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === defaultOf('permissionMode').value ? `${mode} (default)` : mode}
            </option>
          ))}
        </select>
        {isMain && (
          <select aria-label="Conversation style" className={selectClass} title="Claude Code output style" value={currentStyle ?? ''} onChange={(event) => event.target.value && void changeStyle(event.target.value)}>
            {currentStyle === null && <option value="">{`style: default · ${defaultOf('outputStyle').value}`}</option>}
            {styles.map((style) => (
              <option key={style} value={style}>
                style: {style}
                {style === defaultOf('outputStyle').value ? ' (default)' : ''}
              </option>
            ))}
          </select>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => event.target.files && void addFiles(event.target.files)} />
        <button type="button" className="rounded border border-line px-2 py-1 text-muted hover:text-fg" onClick={() => fileInput.current?.click()}>
          Attach
        </button>
        <VoiceButton voice={voice} />
        <button type="button" className="rounded border border-line px-2 py-1 text-muted hover:text-fg" title="A shell in the project folder; run claude there for anything the app does not cover" onClick={() => (useTerminal.getState().open ? useTerminal.getState().hide() : useTerminal.getState().show())}>
          Terminal
        </button>
        <div className="flex-1" />
        {running ? (
          <>
            <button type="button" className="rounded border border-bad/60 px-3 py-1 text-bad hover:bg-bad/10" onClick={() => void interrupt(chatId)}>
              Stop
            </button>
            <button type="button" disabled={!canSend} className="rounded border border-line px-3 py-1 hover:bg-raised disabled:opacity-40" onClick={() => submit(true)}>
              Interrupt and send
            </button>
            <button type="button" disabled={!canSend} className="rounded bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30 disabled:opacity-40" onClick={() => submit(false)}>
              Queue
            </button>
          </>
        ) : (
          <button type="button" disabled={!canSend} className="rounded bg-accent/20 px-4 py-1 text-accent hover:bg-accent/30 disabled:opacity-40" onClick={() => submit(false)}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
