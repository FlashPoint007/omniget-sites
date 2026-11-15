import { BridgeError, taskProgress } from './bridge.mjs';

const WAITING = '已接收请求，等待桌面端创建新任务；接收不代表下载完成。';
const UNKNOWN = '无法可靠关联桌面任务，请在桌面端核对；不会自动重试。';
const idOf = (entry) => Number.isSafeInteger(entry?.id) && entry.id >= 0 ? entry.id : null;

function validateQueue(queue) {
  if (!Array.isArray(queue) || queue.some((entry) => idOf(entry) === null || typeof entry.url !== 'string') ||
      new Set(queue.map(idOf)).size !== queue.length) {
    throw new BridgeError('桌面队列缺少可靠的任务 ID，请在桌面端核对。', 'invalid');
  }
  return queue;
}

// The bridge acknowledges dispatch, not creation, and has no request/task ID.
// Only a unique same-URL ID absent before POST is a candidate. Never pick the
// largest ID, reuse an old task, or switch IDs once bound. Keep unresolved URL
// reservations even after removal/disconnect/POST failure (creation may be late).
export function createTaskTracker({ now = Date.now } = {}) {
  const attempts = new Map();
  const byUrl = new Map();
  let pollSequence = 0;

  return {
    async send(connection, item, isCurrent = () => true) {
      const previous = byUrl.get(item.url);
      if (previous && !previous.finished) {
        throw new BridgeError('该链接已有未确认的发送请求，请先在桌面端核对，避免重复提交。', 'duplicate');
      }
      const attempt = { connection, item, url: item.url, ready: false, finished: false, bound: null, ambiguous: false, lastPoll: 0 };
      byUrl.set(item.url, attempt);
      attempts.set(item, attempt);
      try {
        attempt.baseline = new Set(validateQueue(await connection.queue()).map(idOf));
        if (!isCurrent()) throw new BridgeError('发送已取消，请在桌面端核对。', 'cancelled');
      } catch (error) {
        // No POST occurred, so this reservation can safely be released.
        if (byUrl.get(item.url) === attempt) byUrl.delete(item.url);
        attempts.delete(item);
        throw error;
      }
      attempt.started = now();
      await connection.enqueue(attempt.url);
      attempt.ready = true;
      return { state: 'accepted', pct: null, detail: WAITING };
    },

    async poll(connection) {
      // Capture eligible sends BEFORE the request. A pre-send/in-flight response
      // must never be used to associate a request acknowledged later.
      const eligible = [...attempts.values()].filter((a) => a.connection === connection && a.ready && !a.finished);
      if (!eligible.length) return [];
      const sequence = ++pollSequence;
      const queue = validateQueue(await connection.queue());
      const updates = [];
      for (const attempt of eligible) {
        if (attempts.get(attempt.item) !== attempt || sequence <= attempt.lastPoll || attempt.finished) continue;
        attempt.lastPoll = sequence;
        const candidates = queue.filter((entry) => entry.url === attempt.url && !attempt.baseline.has(entry.id));
        if (candidates.length > 1 || (attempt.bound !== null && candidates.some((entry) => entry.id !== attempt.bound))) {
          attempt.ambiguous = true;
        }
        let next = { state: 'accepted', pct: null, detail: now() - attempt.started >= 30_000
          ? '尚未确认新任务。可能仍在创建或创建失败，请在桌面端核对；不会自动重试。' : WAITING };
        if (attempt.ambiguous) next.detail = UNKNOWN;
        else if (candidates.length === 1) {
          attempt.bound ??= candidates[0].id;
          const progress = taskProgress(candidates[0]);
          if (progress) {
            next = { ...progress, detail: [progress.detail, '匹配发送后新增的同链接任务，请在桌面端核对。'].filter(Boolean).join(' ') };
            attempt.finished = ['desktop-done', 'desktop-error'].includes(progress.state);
          }
        } else if (attempt.bound !== null) next.detail = UNKNOWN;
        updates.push({ item: attempt.item, ...next });
      }
      return updates;
    },
  };
}
