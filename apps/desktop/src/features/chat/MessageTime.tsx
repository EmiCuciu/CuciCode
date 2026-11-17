import { createContext, useContext } from 'react';
import { defaultAppSettings } from '../settings/appSettings.ts';
import { formatMessageTime, formatResponseTime, type MessageTimeFormat } from './messageTime.ts';

/** Carries the resolved timestamp settings to every row, and renders a message time or a response duration. */
export const MessageTimeContext = createContext<MessageTimeFormat>(defaultAppSettings().chat.timestamps);

const MUTED_MONO = 'font-mono text-[11px] text-muted';

export function MessageTime({ ts }: { ts: number | null }) {
  const format = useContext(MessageTimeContext);
  if (!format.show) {
    return null;
  }
  const formatted = formatMessageTime(ts, Date.now(), format);
  if (formatted === null) {
    return null;
  }
  return (
    <time dateTime={formatted.iso} title={formatted.detail} aria-label={formatted.spokenDetail} className={MUTED_MONO}>
      {formatted.label}
    </time>
  );
}

export function ResponseTime({ ms }: { ms: number }) {
  const format = useContext(MessageTimeContext);
  if (!format.showResponseTime) {
    return null;
  }
  const text = formatResponseTime(ms, format);
  if (text === null) {
    return null;
  }
  return <div className={MUTED_MONO}>{text}</div>;
}
