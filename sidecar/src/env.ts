const CREDENTIAL_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export const CLIENT_APP = 'cucicode/0.1.0';

export function buildAgentEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, ...extra };
  for (const name of CREDENTIAL_OVERRIDES) {
    delete env[name];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
  return env;
}
