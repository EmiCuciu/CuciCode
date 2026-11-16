import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, Effort, PermissionMode } from '@cucicode/protocol';
import { useApp, type ChatState } from '../../state/store.ts';
import { useVoice, type VoiceControls } from './useVoice.ts';

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

export function Composer({ projectId, chat }: { projectId: string; chat: ChatState | null }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = useApp((state) => state.send);
  const interrupt = useApp((state) => state.interrupt);
  const setModel = useApp((state) => state.setModel);
  const setEffort = useApp((state) => state.setEffort);
  const setPermissionMode = useApp((state) => state.setPermissionMode);

  const voice = useVoice((transcript) => setText((current) => (current.trim().length > 0 ? `${current.trimEnd()} ${transcript}` : transcript)));

  const running = chat !== null && chat.timeline.runState !== 'idle';
  const models = chat?.info?.models ?? FALLBACK_MODELS;
  const activeModel = chat?.info?.models.find((model) => model.value === chat.model);
  const efforts = activeModel && activeModel.effortLevels.length > 0 ? (activeModel.effortLevels as Effort[]) : DEFAULT_EFFORTS;
  const canSend = text.trim().length > 0 || attachments.length > 0;

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const added = await Promise.all(Array.from(files, toAttachment));
    setAttachments((current) => [...current, ...added]);
  };
  const submit = (interruptFirst: boolean): void => {
    if (!canSend) {
      return;
    }
    void send(projectId, text.trim(), attachments, interruptFirst);
    setText('');
    setAttachments([]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
      <textarea
        value={text}
        rows={3}
        placeholder={running ? 'Agent is running — Queue adds your message after this turn' : 'Message Claude Code  (Enter to send, Shift+Enter for a new line)'}
        className="w-full resize-none rounded border border-line bg-bg p-2 text-fg outline-none focus:border-accent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Model" className={selectClass} value={chat?.model ?? ''} onChange={(event) => void setModel(projectId, event.target.value || undefined)}>
          <option value="">model: default</option>
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
          disabled={chat?.open === true}
          title={chat?.open === true ? 'Effort is fixed once the session has started; start a new session to change it' : undefined}
          onChange={(event) => setEffort(projectId, (event.target.value || undefined) as Effort | undefined)}
        >
          <option value="">effort: default</option>
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
          onChange={(event) => void setPermissionMode(projectId, event.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => event.target.files && void addFiles(event.target.files)} />
        <button type="button" className="rounded border border-line px-2 py-1 text-muted hover:text-fg" onClick={() => fileInput.current?.click()}>
          Attach
        </button>
        <VoiceButton voice={voice} />
        <div className="flex-1" />
        {running ? (
          <>
            <button type="button" className="rounded border border-bad/60 px-3 py-1 text-bad hover:bg-bad/10" onClick={() => void interrupt(projectId)}>
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
