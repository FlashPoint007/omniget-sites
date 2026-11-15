import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskTracker } from '../dist/lib/task-tracker.mjs';

const url = 'https://example.test/video';
const row = (id, type = 'Complete', link = url) => ({ id, url: link, percent: 80, status: { type, data: { success: true } } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function fixture() {
  let queue = [row(1)], time = 0, posts = 0;
  const connection = { queue: async () => queue, enqueue: async () => { posts++; } };
  const tracker = createTaskTracker({ now: () => time });
  const item = { url };
  return { tracker, connection, item, setQueue: (q) => { queue = q; }, tick: (ms) => { time += ms; }, posts: () => posts };
}

test('old completed task cannot complete a newly accepted request', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  const [result] = await f.tracker.poll(f.connection);
  assert.equal(result.state, 'accepted');
  assert.equal(result.pct, null);
});

test('bind a unique new ID and follow that ID through completion', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.setQueue([row(1), row(2, 'Active')]);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'desktop-active');
  f.setQueue([row(1), row(2)]);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'desktop-done');
});

test('no creation stays unknown after delay, then accepts a late unique task', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.tick(120_000);
  const [result] = await f.tracker.poll(f.connection);
  assert.equal(result.state, 'accepted');
  assert.match(result.detail, /创建失败/);
  assert.equal(f.posts(), 1);
  f.setQueue([row(1), row(2, 'Queued')]);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'desktop-queued');
});

test('concurrent same URL sends reserve before baseline and issue one POST', async () => {
  const f = fixture(), gate = deferred();
  f.connection.queue = () => gate.promise;
  const first = f.tracker.send(f.connection, f.item);
  await assert.rejects(f.tracker.send(f.connection, { url }), { code: 'duplicate' });
  gate.resolve([row(1)]);
  await first;
  assert.equal(f.posts(), 1);
});

test('different URLs can send concurrently without sharing task IDs', async () => {
  const f = fixture(), other = { url: url + '/other' };
  await Promise.all([f.tracker.send(f.connection, f.item), f.tracker.send(f.connection, other)]);
  f.setQueue([row(1), row(2, 'Active'), row(3, 'Queued', other.url)]);
  const result = await f.tracker.poll(f.connection);
  assert.deepEqual(result.map((r) => [r.item.url, r.state]), [[url, 'desktop-active'], [other.url, 'desktop-queued']]);
});

test('multiple new candidates remain ambiguous even if one later disappears', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.setQueue([row(1), row(2), row(3)]);
  assert.match((await f.tracker.poll(f.connection))[0].detail, /无法可靠关联/);
  f.setQueue([row(1), row(3)]);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'accepted');
});

test('missing bound ID never switches to another or the old completed ID', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.setQueue([row(1), row(2, 'Active')]);
  await f.tracker.poll(f.connection);
  f.setQueue([row(1)]);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'accepted');
  f.setQueue([row(1), row(3)]);
  assert.match((await f.tracker.poll(f.connection))[0].detail, /无法可靠关联/);
});

test('out of order poll response cannot roll newer progress back', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  const old = deferred();
  f.connection.queue = () => old.promise;
  const pending = f.tracker.poll(f.connection);
  f.connection.queue = async () => [row(1), row(2, 'Active')];
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'desktop-active');
  old.resolve([row(1)]);
  assert.deepEqual(await pending, []);
});

test('poll started before another send ACK does not consume it', async () => {
  const f = fixture(), other = { url: url + '/other' };
  await f.tracker.send(f.connection, f.item);
  const old = deferred();
  f.connection.queue = () => old.promise;
  const pending = f.tracker.poll(f.connection);
  f.connection.queue = async () => [row(1)];
  await f.tracker.send(f.connection, other);
  old.resolve([row(1), row(3, 'Complete', other.url)]);
  assert.deepEqual((await pending).map((r) => r.item), [f.item]);
});

test('preflight failure or cancellation sends nothing; safe retry is allowed', async () => {
  const f = fixture();
  f.connection.queue = async () => { throw new Error('queue failed'); };
  await assert.rejects(f.tracker.send(f.connection, f.item));
  assert.equal(f.posts(), 0);
  f.connection.queue = async () => [row(1)];
  await assert.rejects(f.tracker.send(f.connection, f.item, () => false), { code: 'cancelled' });
  assert.equal(f.posts(), 0);
  await f.tracker.send(f.connection, f.item);
  assert.equal(f.posts(), 1);
});

test('POST outcome unknown retains URL reservation, even across connections', async () => {
  const f = fixture();
  f.connection.enqueue = async () => { throw new Error('lost ACK'); };
  await assert.rejects(f.tracker.send(f.connection, f.item));
  const another = { queue: async () => [], enqueue: async () => assert.fail('must not resend') };
  await assert.rejects(f.tracker.send(another, { url }), { code: 'duplicate' });
  assert.deepEqual(await f.tracker.poll(another), []);
});

test('a later send after confirmed completion takes a fresh baseline', async () => {
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.setQueue([row(1), row(2)]);
  await f.tracker.poll(f.connection);
  const later = { url };
  await f.tracker.send(f.connection, later);
  assert.equal((await f.tracker.poll(f.connection))[0].state, 'accepted');
});

test('invalid or duplicate IDs fail closed before POST and during poll', async () => {
  for (const queue of [null, [null], [{ url }], [row(1), row(1)], [row(Number.MAX_SAFE_INTEGER + 1)]]) {
    const f = fixture();
    f.setQueue(queue);
    await assert.rejects(f.tracker.send(f.connection, f.item));
    assert.equal(f.posts(), 0);
  }
  const f = fixture();
  await f.tracker.send(f.connection, f.item);
  f.setQueue([row(1), row(1)]);
  await assert.rejects(f.tracker.poll(f.connection));
});
