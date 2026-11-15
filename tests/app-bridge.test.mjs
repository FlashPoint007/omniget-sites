import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTaskTracker } from '../dist/lib/task-tracker.mjs';

const app = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');
const code = app.slice(app.indexOf('function disconnect('), app.indexOf('function initialOS('));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function harness(connection) {
  const item = { url: 'https://example.test/video', state: 'pending' };
  const context = vm.createContext({
    bridge: connection, items: [item], taskTracker: createTaskTracker(),
    TRACKED: new Set(['accepted', 'desktop-active', 'desktop-queued', 'desktop-paused']),
    polling: false, pollFailures: 0, document: { hidden: false },
    renderBridge() {}, persist() {}, renderQueue() {}, notify() {},
    setItem(target, state, detail, pct = null) { Object.assign(target, { state, detail, pct }); },
  });
  vm.runInContext(code, context);
  return { item, context, run: (source) => vm.runInContext(source, context) };
}

test('app cancels POST when disconnected while reading baseline', async () => {
  const gate = deferred(); let posts = 0;
  const h = harness({ queue: () => gate.promise, enqueue: async () => { posts++; } });
  const send = h.run('sendOne(items[0])');
  h.run('disconnect()');
  gate.resolve([]);
  assert.equal(await send, false);
  assert.equal(posts, 0);
  assert.equal(h.item.state, 'accepted');
  assert.match(h.item.detail, /结果未知/);
});

test('app ignores ACK from previous connection', async () => {
  const ack = deferred(), started = deferred();
  const h = harness({ queue: async () => [], enqueue: () => { started.resolve(); return ack.promise; } });
  const send = h.run('sendOne(items[0])');
  await started.promise;
  h.run('disconnect(); bridge = {queue: async () => []}');
  ack.resolve();
  assert.equal(await send, false);
  assert.match(h.item.detail, /结果未知/);
});

test('app ignores a poll response after disconnect/reconnect', async () => {
  const h = harness({ queue: async () => [], enqueue: async () => {} });
  await h.context.taskTracker.send(h.context.bridge, h.item);
  h.item.state = 'accepted';
  const gate = deferred();
  h.context.bridge.queue = () => gate.promise;
  const pending = h.run('pollQueue()');
  h.run('disconnect(); bridge = {queue: async () => []}');
  gate.resolve([{ id: 2, url: h.item.url, status: { type: 'Complete', data: { success: true } } }]);
  await pending;
  assert.equal(h.item.state, 'accepted');
  assert.match(h.item.detail, /结果未知/);
});

test('app preserves removed rows when delayed ACK arrives', async () => {
  const ack = deferred(), started = deferred();
  const h = harness({ queue: async () => [], enqueue: () => { started.resolve(); return ack.promise; } });
  const send = h.run('sendOne(items[0])');
  await started.promise;
  h.run('items = []');
  ack.resolve();
  assert.equal(await send, false);
  assert.equal(h.context.items.length, 0);
});

test('refresh restores in-flight sends as unknown, never retryable pending or stale active progress', () => {
  const restore = app.slice(app.indexOf('function restoreQueue('), app.indexOf('function persist('));
  for (const state of ['sending', 'accepted', 'desktop-active', 'desktop-queued', 'desktop-paused']) {
    const saved = { id: '00000000-0000-0000-0000-000000000001', url: 'https://example.test/video', state, pct: 80 };
    const context = vm.createContext({
      sessionStorage: { getItem: () => JSON.stringify([saved]) }, STORAGE_KEY: '', MAX_ITEMS: 50,
      readLink: (url) => ({ url }), STATUS: {},
      TRACKED: new Set(['accepted', 'desktop-active', 'desktop-queued', 'desktop-paused']),
    });
    const [item] = vm.runInContext(restore + '; restoreQueue()', context);
    assert.equal(item.state, 'accepted');
    assert.equal(item.pct, null);
    assert.match(item.detail, /结果未知/);
  }
});
