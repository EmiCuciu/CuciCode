export type Transport = 'stdio' | 'http' | 'sse';

export interface KeyValue {
  name: string;
  value: string;
  secret: boolean;
}

export interface McpForm {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: KeyValue[];
  headers: KeyValue[];
}

export interface McpPreset {
  label: string;
  note: string;
  form: McpForm;
}

const blank: McpForm = { name: '', transport: 'stdio', command: '', args: '', url: '', env: [], headers: [] };
export const emptyMcpForm = blank;

/** Starting points only: package names and URLs change, so each preset is shown for review before saving. */
export const MCP_PRESETS: McpPreset[] = [
  {
    label: 'GitHub',
    note: 'Remote server. Needs a personal access token.',
    form: { ...blank, name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', value: 'Bearer ', secret: true }] },
  },
  { label: 'Linear', note: 'Remote server. Signs in with OAuth the first time it is used.', form: { ...blank, name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' } },
  { label: 'Atlassian (Bitbucket, Jira)', note: 'Remote server. Signs in with OAuth.', form: { ...blank, name: 'atlassian', transport: 'sse', url: 'https://mcp.atlassian.com/v1/sse' } },
  {
    label: 'Postgres',
    note: 'Local server. Put the connection string in the secret.',
    form: { ...blank, name: 'postgres', command: 'npx', args: '-y @modelcontextprotocol/server-postgres ${POSTGRES_URL}', env: [{ name: 'POSTGRES_URL', value: '', secret: true }] },
  },
  { label: 'Filesystem', note: 'Local server. Replace the path with the folder to expose.', form: { ...blank, name: 'filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' } },
  { label: 'Browser (Playwright)', note: 'Local server that drives a browser.', form: { ...blank, name: 'playwright', command: 'npx', args: '-y @playwright/mcp@latest' } },
];

export interface SecretToStore {
  name: string;
  value: string;
}

export interface BuiltMcp {
  config: Record<string, unknown>;
  secrets: SecretToStore[];
}

export function secretName(server: string, key: string): string {
  const clean = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const name = `${clean(server)}_${clean(key)}`;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export function splitArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

/**
 * Builds the server entry Claude Code stores. A value marked secret is not put in the
 * entry: it goes to the keychain and the entry holds a `${NAME}` reference instead.
 */
export function buildMcp(form: McpForm): BuiltMcp {
  const secrets: SecretToStore[] = [];
  const mapPairs = (pairs: KeyValue[], isEnv: boolean): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const pair of pairs) {
      const key = pair.name.trim();
      if (key.length === 0) {
        continue;
      }
      if (!pair.secret) {
        result[key] = pair.value;
        continue;
      }
      const variable = isEnv && /^[A-Z_][A-Z0-9_]*$/.test(key) ? key : secretName(form.name, key);
      const prefix = /^(Bearer|Basic|Token)\s+/i.exec(pair.value)?.[0] ?? '';
      secrets.push({ name: variable, value: pair.value.slice(prefix.length) });
      result[key] = `${prefix}\${${variable}}`;
    }
    return result;
  };
  const env = mapPairs(form.env, true);
  const headers = mapPairs(form.headers, false);
  const config: Record<string, unknown> =
    form.transport === 'stdio'
      ? { type: 'stdio', command: form.command.trim(), args: splitArgs(form.args), ...(Object.keys(env).length > 0 ? { env } : {}) }
      : { type: form.transport, url: form.url.trim(), ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  return { config, secrets: secrets.filter((secret) => secret.value.length > 0) };
}

export function validateMcp(form: McpForm): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(form.name)) {
    return 'Name: use letters, digits, . _ and -.';
  }
  if (form.transport === 'stdio' && form.command.trim().length === 0) {
    return 'Enter the command that starts the server.';
  }
  if (form.transport !== 'stdio' && !/^https?:\/\/\S+$/.test(form.url.trim())) {
    return 'Enter the server URL, starting with http:// or https://.';
  }
  const missing = [...form.env, ...form.headers].find((pair) => pair.secret && pair.name.trim() && pair.value.replace(/^(Bearer|Basic|Token)\s+/i, '').length === 0);
  return missing ? `Enter the secret value for ${missing.name}.` : null;
}
