import { decide } from './paths.mjs';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
}

let reason = null;
try {
  reason = decide(JSON.parse(input), process.env);
} catch {
  reason = null;
}

if (reason !== null) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}
