// Conservative release hygiene. This is not a complete secret scanner.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.test-state', 'coverage']);
let files;
try {
  files = execFileSync('git', ['-C', root, 'ls-files', '-z'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean);
} catch {
  const walk = (dir) => fs.readdirSync(path.join(root, dir), {withFileTypes:true}).flatMap((e) => {
    if (ignored.has(e.name)) return [];
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : [rel];
  });
  files = walk('');
}
if (!files.length) throw new Error('No public source files found');
const forbidden = /(^|\/)(node_modules|dist|build|\.test-state|coverage|credentials\.json|\.env(?:\..*)?)($|\/)|\.(sqlite.*|db|jsonl|pem|key|mcpb|log)$|receipt\.json$/i;
const rules = [
  ['absolute personal home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider token pattern', /\b(?:sk-ant-api\d*-|gh[pousr]_)[A-Za-z0-9_-]{20,}/],
];
const findings = [];
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith('.env.example')) findings.push([file, 'private/generated filename']);
  const full = path.join(root, file);
  if (fs.lstatSync(full).isSymbolicLink()) { findings.push([file, 'symlink in public source']); continue; }
  const contents = fs.readFileSync(full, 'utf8');
  for (const [label, pattern] of rules) if (pattern.test(contents)) findings.push([file, label]);
}
if (findings.length) {
  for (const [file, label] of findings) console.error(`${file}: ${label}`);
  process.exitCode = 1;
} else console.log(`Public source hygiene passed (${files.length} files; content/history review still required).`);
