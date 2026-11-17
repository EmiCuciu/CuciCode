import published from '../../assets/claude-code-settings.schema.json';
import type { ResolvedSetting } from '../../bridge/types.ts';
import type { SettingsSchema } from '../settings/settingsSchema.ts';

export type DefaultKey = 'model' | 'effort' | 'permissionMode' | 'outputStyle';

export interface DefaultValue {
  value: string;
  source: string;
}

export interface SessionFacts {
  model: string;
  effort: string | null;
  permissionMode: string;
  outputStyle: string;
}

export interface DefaultsInput {
  resolved: ResolvedSetting[];
  /** What the running session reports. Only trusted for a key the user has not overridden. */
  init: SessionFacts | null;
  overridden: Partial<Record<DefaultKey, boolean>>;
  /** What Claude Code resolves its "default" model alias to, from the session's model list. */
  defaultModel: string | null;
}

const SETTING_KEY: Record<DefaultKey, string> = { model: 'model', effort: 'effortLevel', permissionMode: 'permissions.defaultMode', outputStyle: 'outputStyle' };
const SCHEMA_KEY: Record<DefaultKey, string | null> = { model: 'model', effort: 'effortLevel', permissionMode: null, outputStyle: 'outputStyle' };
const BUILT_IN: Partial<Record<DefaultKey, string>> = { permissionMode: 'default' };
const UNDOCUMENTED: Partial<Record<DefaultKey, string>> = { model: "your account's default model", effort: "the model's default effort" };

const schema = published as unknown as SettingsSchema;

export function schemaDefaultText(key: string): string | null {
  const value = schema.properties[key]?.default;
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fromSession(key: DefaultKey, input: DefaultsInput): string | null {
  const { init } = input;
  if (key === 'model' && input.defaultModel) {
    return input.defaultModel;
  }
  if (!init || input.overridden[key]) {
    return null;
  }
  const value = { model: init.model, effort: init.effort, permissionMode: init.permissionMode, outputStyle: init.outputStyle }[key];
  return value && value.length > 0 ? value : null;
}

/**
 * What a picker means by "default": the first of the effective Claude Code setting, the value the
 * running session reports, the documented default, and finally plain words saying who decides.
 */
export function effectiveDefault(key: DefaultKey, input: DefaultsInput): DefaultValue {
  const setting = input.resolved.find((entry) => entry.key === SETTING_KEY[key] && typeof entry.value === 'string');
  if (setting) {
    return { value: String(setting.value), source: `${setting.scope} setting, ${setting.path}` };
  }
  const live = fromSession(key, input);
  if (live !== null) {
    return { value: live, source: 'reported by the running session' };
  }
  const schemaKey = SCHEMA_KEY[key];
  const documented = schemaKey === null ? null : schemaDefaultText(schemaKey);
  if (documented !== null) {
    return { value: documented, source: 'documented default' };
  }
  const builtIn = BUILT_IN[key];
  if (builtIn !== undefined) {
    return { value: builtIn, source: 'Claude Code built-in' };
  }
  return { value: UNDOCUMENTED[key] ?? 'chosen by Claude Code', source: 'not set in any settings file' };
}

/** Text for a setting that has no value in any scope. */
export function unsetText(key: string): string {
  const documented = schemaDefaultText(key);
  if (documented !== null) {
    return `Default: ${documented}.`;
  }
  if (key === 'model') {
    return "No setting; Claude Code uses your account's default model.";
  }
  return 'No documented default; Claude Code decides.';
}

/** Defaults Claude Code documents for how long a hook may run, by handler type. */
export const HOOK_TIMEOUT_SECONDS: Record<string, number> = { command: 600, http: 600, mcp_tool: 600, prompt: 30, agent: 60 };
