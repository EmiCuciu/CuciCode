import { useUpdates } from './updateStore.ts';

export function UpdateBanner() {
  const phase = useUpdates((state) => state.phase);
  const version = useUpdates((state) => state.version);
  const message = useUpdates((state) => state.message);
  const installUpdate = useUpdates((state) => state.installUpdate);
  const dismiss = useUpdates((state) => state.dismiss);

  if (phase === 'idle') return null;
  const failed = phase === 'failed';
  return (
    <div role="status" className={`flex items-center gap-3 px-3 py-1 ${failed ? 'bg-bad/15 text-bad' : 'bg-accent/15 text-accent'}`}>
      <span className="min-w-0 flex-1 truncate">
        {failed && `Update failed: ${message}`}
        {phase === 'available' && `CuciCode ${version} is available.`}
        {phase === 'installing' && `Installing CuciCode ${version}; the app restarts when it finishes.`}
      </span>
      {phase === 'available' && (
        <button type="button" onClick={() => void installUpdate()}>
          Update and restart
        </button>
      )}
      {phase !== 'installing' && (
        <button type="button" onClick={dismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
