import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const tauriRoot = join(desktopRoot, 'src-tauri');
const stagedRoot = join(tauriRoot, 'resources');
const binariesRoot = join(tauriRoot, 'binaries');

const sdkScope = '@anthropic-ai';
const sdkPackage = 'claude-agent-sdk';
const platformPackage = `${sdkPackage}-${process.platform}-${process.arch}`;
const targetTriples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const targetTriple = targetTriples[`${process.platform}-${process.arch}`];
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

function requirePath(path) {
  if (!existsSync(path)) {
    throw new Error(`${path} not found; run "npm install" and "npm run build:sidecar" in the repository root`);
  }
  return path;
}

function copyInto(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(requirePath(source), destination, { recursive: true });
}

if (!targetTriple) {
  throw new Error(`unsupported platform ${process.platform}-${process.arch}`);
}

rmSync(stagedRoot, { recursive: true, force: true });

const sidecarRoot = join(stagedRoot, 'sidecar');
copyInto(join(repoRoot, 'sidecar', 'dist', 'sidecar.mjs'), join(sidecarRoot, 'sidecar.mjs'));
for (const name of [sdkPackage, platformPackage]) {
  copyInto(join(repoRoot, 'node_modules', sdkScope, name), join(sidecarRoot, 'node_modules', sdkScope, name));
}

const marketplaceRoot = join(stagedRoot, 'marketplace');
copyInto(join(repoRoot, '.claude-plugin'), join(marketplaceRoot, '.claude-plugin'));
copyInto(join(repoRoot, 'plugin', 'cucicode'), join(marketplaceRoot, 'plugin', 'cucicode'));

copyInto(process.execPath, join(binariesRoot, `node-${targetTriple}${executableSuffix}`));
