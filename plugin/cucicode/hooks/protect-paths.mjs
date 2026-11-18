import { decide, protectedMode } from './paths.mjs';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

let reason = null;
let mode = 'block';
try {
  const event = JSON.parse(input);
  reason = decide(event, process.env);
  mode = protectedMode(process.env.CLAUDE_PROJECT_DIR || (typeof event.cwd === 'string' ? event.cwd : process.cwd()));
} catch {
  reason = null;
}

if (reason !== null && mode === 'ask') {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
} else if (reason !== null) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}
