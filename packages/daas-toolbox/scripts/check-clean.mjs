// Fails when the files that ship (this package, as a snapshot) carry personal or
// environment-specific text. Run before copying the package into another codebase.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN =
  /chris|luyi|zustand-demo-archive|~\/Github|\/home\/[a-z]|daas-platform|anthropic|session_0|\/Users\/[A-Za-z]/i;
const SKIP = /\.(png|jpe?g|gif|ico|woff2?|svg|lock)$/i;

const files = execFileSync('git', ['ls-files', '--', '.'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.test(f) && f !== 'scripts/check-clean.mjs');

const hits = [];
for (const f of files) {
  readFileSync(join(root, f), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
if (hits.length) {
  console.error(`check-clean: ${hits.length} personal/environment reference(s):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('check-clean: package is clean.');
