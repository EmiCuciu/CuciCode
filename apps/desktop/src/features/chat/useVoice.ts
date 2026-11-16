import { useCallback, useEffect, useRef, useState } from 'react';
import { inDesktopShell, voiceApi } from '../../bridge/tauri.ts';

export type VoicePhase = 'unknown' | 'needs_model' | 'downloading' | 'ready' | 'recording' | 'transcribing';

export interface VoiceControls {
  phase: VoicePhase;
  downloadPercent: number | null;
  error: string | null;
  downloadModel: () => void;
  startRecording: () => void;
  stopRecording: () => void;
}

export function useVoice(onTranscript: (text: string) => void): VoiceControls {
  const [phase, setPhase] = useState<VoicePhase>('unknown');
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const deliver = useRef(onTranscript);
  deliver.current = onTranscript;

  useEffect(() => {
    if (!inDesktopShell()) {
      return;
    }
    voiceApi
      .status()
      .then((status) => setPhase(status.modelReady ? 'ready' : 'needs_model'))
      .catch((reason: unknown) => setError(String(reason)));
    const unlisten = voiceApi.onDownloadProgress(({ received, total }) => {
      setDownloadPercent(total ? Math.round((received / total) * 100) : null);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const downloadModel = useCallback(() => {
    if (phaseRef.current !== 'needs_model') {
      return;
    }
    setPhase('downloading');
    setError(null);
    voiceApi
      .downloadModel()
      .then(() => setPhase('ready'))
      .catch((reason: unknown) => {
        setError(String(reason));
        setPhase('needs_model');
      });
  }, []);

  const startRecording = useCallback(() => {
    if (phaseRef.current !== 'ready') {
      return;
    }
    setPhase('recording');
    setError(null);
    voiceApi.start().catch((reason: unknown) => {
      setError(String(reason));
      setPhase('ready');
    });
  }, []);

  const stopRecording = useCallback(() => {
    if (phaseRef.current !== 'recording') {
      return;
    }
    setPhase('transcribing');
    voiceApi
      .stop()
      .then((text) => {
        if (text.length > 0) {
          deliver.current(text);
        }
      })
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setPhase('ready'));
  }, []);

  useEffect(() => {
    const isShortcut = (event: KeyboardEvent): boolean => event.code === 'Space' && event.ctrlKey;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isShortcut(event)) {
        event.preventDefault();
        if (!event.repeat) {
          startRecording();
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space' || event.key === 'Control') {
        stopRecording();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [startRecording, stopRecording]);

  return { phase, downloadPercent, error, downloadModel, startRecording, stopRecording };
}
