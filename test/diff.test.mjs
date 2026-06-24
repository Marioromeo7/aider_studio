import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff } from '../out/utils/diff.js';

test('identical input → only context, no changes', () => {
  const h = computeLineDiff('a\nb\nc', 'a\nb\nc');
  assert.ok(!h.some((x) => x.t !== 'ctx'));
});

test('an inserted line is reported as add', () => {
  const h = computeLineDiff('a\nb', 'a\nx\nb');
  assert.ok(h.some((x) => x.t === 'add' && x.s === 'x'));
  assert.ok(!h.some((x) => x.t === 'del'));
});

test('a removed line is reported as del', () => {
  const h = computeLineDiff('a\nb\nc', 'a\nc');
  assert.ok(h.some((x) => x.t === 'del' && x.s === 'b'));
  assert.ok(!h.some((x) => x.t === 'add'));
});

test('a changed line is del + add', () => {
  const h = computeLineDiff('hello\nworld', 'hello\nthere');
  assert.ok(h.some((x) => x.t === 'del' && x.s === 'world'));
  assert.ok(h.some((x) => x.t === 'add' && x.s === 'there'));
});

test('huge change is guarded, not expanded', () => {
  const big = Array.from({ length: 1600 }, (_, i) => 'line ' + i).join('\n');
  const h = computeLineDiff('', big);
  assert.equal(h.length, 1);
  assert.match(h[0].s, /large change/);
});

test('output is capped (does not flood)', () => {
  const a = Array.from({ length: 300 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 300 }, (_, i) => 'b' + i).join('\n');
  const h = computeLineDiff(a, b);
  assert.ok(h.length <= 80);
});
