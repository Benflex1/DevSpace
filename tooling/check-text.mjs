import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const checkedExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.mjs']);
const ignoredDirectories = new Set([
  '.git', '.next', 'blob-report', 'coverage', 'dist', 'node_modules', 'playwright-report',
  'test-results'
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

let failures = 0;
for (const file of await walk('.')) {
  if (!checkedExtensions.has(extname(file))) continue;
  const content = await readFile(file, 'utf8');
  if (!content.endsWith('\n')) {
    console.error(`${file}: missing final newline`);
    failures += 1;
  }
  content.split('\n').forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      console.error(`${file}:${index + 1}: trailing whitespace`);
      failures += 1;
    }
  });
}

if (failures > 0) process.exit(1);
console.log('text checks passed');
