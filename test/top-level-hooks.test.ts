import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const HOOKS = ['before', 'after', 'beforeEach', 'afterEach'];
const WRITE = /^(?:(?:process\.env|console|globalThis|global)(?:\.\w+|\[[^\]]+\])?\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)|delete\s+(?:process\.env|console|globalThis|global)\b|process\.(?:on|once|addListener|prependListener|prependOnceListener)\s*\()/;

function topLevel(text: string): number[] {
  const imported = [...text.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]node:test['"]/g)].map((m) => m[1]).join(',');
  const aliases = [...imported.matchAll(/\b(?:before|after|beforeEach|afterEach)\s+as\s+(\w+)/g)].map((m) => m[1]);
  const hook = new RegExp(`^(?:\\w+\\.)?(?:${[...HOOKS, ...aliases].join('|')})\\s*\\(`);
  return text.split('\n').flatMap((line, i) => (hook.test(line) || WRITE.test(line) ? [i + 1] : []));
}

it('flags a line that starts with a hook call, or with a write to process.env, console, globalThis or global, or a process listener', () => {
  const flagged = [
    'before(() => {});', 'afterEach(() => {});', 'test.beforeEach(() => {});', 'setUp(() => {});', 'after(() => {});',
    "process.env.X = 'y';", "process.env.X += 'y';", "process.env['X'] ??= 'y';", 'delete process.env.X;',
    'console.error = () => {};', "console['log'] = () => {};", 'globalThis.fetch = f;', 'global.fetch = f;', 'delete globalThis.fetch;', 'delete globalThis.process.env.X;',
    "process.on('exit', f);", "process.once('exit', f);", "process.addListener('exit', f);", "process.prependListener('exit', f);", "process.prependOnceListener('exit', f);",
  ];
  const text = ['import { after, beforeEach as setUp } from "node:test";', ...flagged].join('\n');
  assert.deepEqual(topLevel(text), flagged.map((_, i) => i + 2));
});

it('leaves reads, comparisons, indented lines and other calls alone', () => {
  const text = [
    'const x = process.env.X;', 'process.env.X != null;', "process.env.X === 'y';", 'process.env.X <= 1;',
    '  before(() => {});', 'describe(() => {});', "console.error('x');",
  ].join('\n');
  assert.deepEqual(topLevel(text), []);
});

it("no line of a test file starts with a hook call, a write to process.env, console, globalThis or global, or a process listener, which at a file's top level npm test's one process would carry into every file's tests", () => {
  const dir = new URL('.', import.meta.url);
  const found = readdirSync(dir).filter((file) => file.endsWith('.ts')).sort().flatMap((name) => {
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
    return topLevel(lines.join('\n')).map((n) => `${name}:${n}: ${lines[n - 1]}`);
  });
  assert.deepEqual(found, []);
});
