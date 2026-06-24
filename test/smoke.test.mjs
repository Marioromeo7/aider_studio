import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('package.json has the fields the Marketplace requires', () => {
  for (const k of ['name', 'displayName', 'version', 'publisher', 'license', 'icon',
                   'repository', 'engines', 'main', 'contributes']) {
    assert.ok(pkg[k], `package.json missing "${k}"`);
  }
});

test('every contributed command is registered in extension.js', () => {
  const ext = readFileSync(new URL('../out/extension.js', import.meta.url), 'utf8');
  for (const c of pkg.contributes.commands) {
    assert.ok(ext.includes(c.command), `command not registered: ${c.command}`);
  }
});

test('compiled entry point and runtime assets exist', () => {
  for (const f of ['out/extension.js', 'out/panels/chatPanel.js', 'out/utils/aiderProcess.js',
                   'media/chat.js', 'resources/icon.png', 'LICENSE', 'CHANGELOG.md', '.vscodeignore']) {
    assert.ok(existsSync(new URL('../' + f, import.meta.url)), `missing ${f}`);
  }
});

test('the webview script parses', () => {
  execSync('node --check media/chat.js'); // throws on syntax error
});

test('no stray NUL bytes in webview script', () => {
  const buf = readFileSync(new URL('../media/chat.js', import.meta.url));
  assert.equal(buf.includes(0x00), false);
});
