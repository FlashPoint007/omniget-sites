import { desktopScheme, formatBytes, parseLines, readLink, ROUTE_LABELS } from './lib/links.mjs';
import { connectBridge } from './lib/bridge.mjs';
import { createTaskTracker } from './lib/task-tracker.mjs';
import { DownloadError, saveDirect } from './lib/download.mjs';
import { assetsFor, fetchRelease } from './lib/releases.mjs';

const $ = (id) => document.getElementById(id);
const $$ = (query) => [...document.querySelectorAll(query)];
const STATUS = {
  pending: ['待处理', 'pending'],
  receiving: ['正在读取', 'active'],
  browser: ['已交给浏览器', 'done'],
  saved: ['已保存', 'done'],
  sending: ['正在发送', 'active'],
  opened: ['已请求打开桌面端', 'done'],
  accepted: ['桌面请求待确认', 'active'],
  'desktop-queued': ['桌面端排队中', 'active'],
  'desktop-active': ['桌面端下载中', 'active'],
  'desktop-paused': ['桌面端已暂停', 'active'],
  'desktop-done': ['桌面端已完成', 'done'],
  'desktop-error': ['桌面端失败', 'errors'],
  error: ['失败', 'errors'],
};
const TRACKED = new Set(['accepted', 'desktop-queued', 'desktop-active', 'desktop-paused']);
const MAX_ITEMS = 50;
const STORAGE_KEY = 'omniget-web-queue-v1';
const SAMPLE_URL = new URL('./samples/omniget-sample.txt', import.meta.url).href;
const SESSION_HINT = '签名链接和任务记录保留在当前浏览器会话。';
const MAX_FILE = 128 * 1024;
const bridgeDialog = $('bridge-dialog');
const links = $('links');
const queueList = $('queue-list');

let items = restoreQueue();
let filter = 'all';
let inputMode = 'single';
let bridge = null;
const taskTracker = createTaskTracker();
let bridgeAttempt = 0;
let polling = false;
let pollFailures = 0;
let sendingBatch = false;
let toastTimeout;
let directTransfer = null;
let release = null;
let releaseOrigin = '';
let activeOS = initialOS();

function element(tag, className = '', value = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function icon(name, small = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', small ? 'icon small' : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 4300);
}

function message(id, value, tone = '') {
  const node = $(id);
  node.textContent = value;
  node.dataset.tone = tone;
}

function restoreQueue() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.slice(0, MAX_ITEMS).flatMap((item) => {
      if (!item || typeof item.url !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)) return [];
      const link = readLink(item.url, item.mode);
      if (!link) return [];
      const interrupted = item.state === 'receiving';
      const unconfirmed = item.state === 'sending' || TRACKED.has(item.state);
      return [{
        ...link,
        id: item.id,
        mode: item.mode,
        state: unconfirmed ? 'accepted' : !interrupted && Object.hasOwn(STATUS, item.state) ? item.state : 'pending',
        detail: unconfirmed ? '页面已重新加载，任务结果未知，请在桌面端核对。' : interrupted ? '上次操作未确认，请核对后重试。' : String(item.detail || '').slice(0, 300),
        pct: !unconfirmed && typeof item.pct === 'number' ? Math.min(100, Math.max(0, item.pct)) : null,
        bytes: '',
      }];
    });
  } catch {
    return [];
  }
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(({ id, url, mode, state, detail, pct }) => (
      { id, url, mode, state, detail, pct }
    ))));
  } catch {
    // The queue remains usable when browser storage is disabled or full.
  }
}

function setInputMode(mode) {
  inputMode = mode;
  const batch = mode === 'batch';
  for (const button of $$('[data-input-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.inputMode === mode));
  }
  $('input-box').classList.toggle('is-batch', batch);
  $('import-links').hidden = !batch;
  links.rows = batch ? 4 : 1;
  links.placeholder = batch ? '每行一条链接\nhttps://…' : 'https://…';
}

function readInput() {
  const mode = $('route').value;
  const { links: incoming, invalid, overLimit } = parseLines(links.value, mode, inputMode === 'single' ? 1 : MAX_ITEMS);
  if (overLimit) {
    message('form-hint', inputMode === 'single' ? '有多条链接，请切换到批量添加。' : '每次最多添加 50 条链接。', 'error');
    return;
  }
  const known = new Set(items.map((item) => item.url));
  const added = [];
  let duplicates = 0;
  let full = 0;
  for (const entry of incoming) {
    if (known.has(entry.url)) { duplicates += 1; continue; }
    if (items.length + added.length >= MAX_ITEMS) { full += 1; continue; }
    known.add(entry.url);
    added.push({ ...entry, id: crypto.randomUUID(), mode, state: 'pending', detail: '', pct: null, bytes: '' });
  }
  const result = [];
  if (added.length) result.push('已添加 ' + added.length + ' 条');
  if (duplicates) result.push('跳过 ' + duplicates + ' 条重复链接');
  if (invalid.length) result.push('第 ' + invalid.slice(0, 8).join('、') + (invalid.length > 8 ? ' 等' : '') + ' 行无效，请每行提供一条 HTTP(S) 或磁力链接');
  if (full) result.push('队列已满，请清理后再添加');
  if (!result.length) result.push('请输入下载链接');
  message('form-hint', result.join('，') + '。', invalid.length || full ? 'error' : added.length ? 'success' : '');
  if (!added.length) return;
  items.unshift(...added);
  filter = 'all';
  if (invalid.length && !full) {
    const rejected = new Set(invalid);
    links.value = links.value.split(/\r\n|\n|\r/).filter((_, index) => rejected.has(index + 1)).join('\n');
  } else if (!full) {
    links.value = '';
  }
  persist();
  renderQueue();
}

function action(name, label, variant = 'quiet', href = '') {
  const node = element(href ? 'a' : 'button', 'button button-' + variant, label);
  node.dataset.action = name;
  if (href) {
    node.href = href;
    if (/^https?:/.test(href)) {
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
  } else {
    node.type = 'button';
  }
  return node;
}

function renderItem(item) {
  const row = element('li', 'queue-row');
  row.dataset.id = item.id;
  const info = element('div', 'item-info');
  const glyph = element('span', 'section-icon ' + (item.route === 'direct' ? 'accent' : 'cool'));
  glyph.append(icon(item.route === 'direct' ? 'file' : 'monitor', true));
  const copy = element('div', 'item-text');
  const title = element('strong', 'item-title', item.title);
  title.title = item.title;
  const subtitle = [item.platform && !item.title.startsWith(item.platform) ? item.platform : '', item.source, ROUTE_LABELS[item.route]]
    .filter((value, i, values) => value && values.indexOf(value) === i).join(' · ');
  copy.append(title, element('p', 'item-subtitle', subtitle));
  if (item.detail) copy.append(element('p', 'item-detail', item.detail));
  info.append(glyph, copy);

  const status = element('div', 'item-status');
  const label = element('span', 'status-label', STATUS[item.state][0]);
  label.dataset.group = STATUS[item.state][1];
  status.append(label);
  const progress = element('progress', 'item-progress');
  progress.max = 100;
  progress.setAttribute('aria-label', '下载进度');
  if (item.pct != null) progress.value = item.pct;
  progress.hidden = item.pct == null && item.state !== 'receiving';
  const bytes = element('span', 'item-detail transfer-bytes', item.bytes || '');
  status.append(progress, bytes);

  const actions = element('div', 'item-actions');
  if (item.state === 'receiving') {
    actions.append(action('cancel', '取消读取', 'outline'));
  } else if (item.state !== 'sending') {
    if (item.route === 'direct') {
      const save = action('save', '保存文件', 'outline');
      save.disabled = Boolean(directTransfer);
      actions.append(save);
      if (typeof window.showSaveFilePicker === 'function' && window.top === window.self) {
        const stream = action('stream', '流式保存');
        stream.disabled = Boolean(directTransfer);
        actions.append(stream);
      }
      actions.append(action('source', '打开源文件', 'quiet', item.url));
      if (item.state === 'error') actions.append(action('open', '用桌面打开', 'quiet', desktopScheme(item.url)));
    } else if (item.route === 'plugin') {
      actions.append(action('guide', item.plugin + ' 插件说明', 'outline', '#guide'), action('copy', '复制链接'));
    } else {
      if (bridge && (item.state === 'pending' || item.state === 'opened' || item.state === 'error')) {
        actions.append(action('send', '发送到本机', 'outline'));
      }
      actions.append(action('open', '用桌面打开', bridge ? 'quiet' : 'outline', desktopScheme(item.url)));
      actions.append(action('copy', '复制链接'));
    }
    const remove = action('remove', '');
    remove.classList.add('icon-button');
    remove.setAttribute('aria-label', '从网页队列移除');
    remove.title = '从网页队列移除';
    remove.append(icon('close', true));
    actions.append(remove);
  }
  row.append(info, status, actions);
  return row;
}

function renderQueue() {
  const focused = document.activeElement?.closest?.('[data-action]');
  const focusedId = focused?.closest('[data-id]')?.dataset.id;
  const shown = items.filter((item) => filter === 'all' || STATUS[item.state][1] === filter);
  for (const button of $$('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  $('queue-count').textContent = String(items.length);
  $('clear-finished').hidden = !items.some(({ state }) => canClear(state));
  $('batch-send').hidden = !bridge || !items.some(({ route, state }) => route === 'desktop' && state === 'pending');
  $('batch-send').disabled = sendingBatch;
  $('queue-empty').hidden = shown.length !== 0;
  $('empty-title').textContent = items.length ? '没有符合筛选条件的任务' : '队列为空';
  $('empty-copy').textContent = items.length ? '切换筛选条件可查看其他任务。' : '添加链接后，从这里启动下载。';
  queueList.replaceChildren(...shown.map(renderItem));
  if (focusedId) {
    const row = queueList.querySelector('[data-id="' + focusedId + '"]');
    row?.querySelector('[data-action="' + focused.dataset.action + '"]')?.focus({ preventScroll: true });
  }
}

function canClear(state) {
  return !TRACKED.has(state) && (STATUS[state][1] === 'done' || STATUS[state][1] === 'errors');
}

function setItem(item, state, detail = '', pct = null) {
  item.state = state;
  item.detail = detail;
  item.pct = pct;
  item.bytes = '';
  persist();
  renderQueue();
}

async function runDirect(item, stream) {
  if (directTransfer) return;
  const controller = new AbortController();
  directTransfer = { id: item.id, controller };
  setItem(item, 'receiving', stream ? '选择保存位置后开始读取。' : '');
  let result;
  let failure;
  try {
    result = await saveDirect(item, {
      controller,
      stream,
      onProgress(received, total) {
        const pct = total ? Math.min(100, received / total * 100) : null;
        item.pct = pct;
        item.bytes = formatBytes(received) + (total ? ' / ' + formatBytes(total) : '');
        const row = queueList.querySelector('[data-id="' + item.id + '"]');
        const progress = row?.querySelector('progress');
        if (progress && pct != null) progress.value = pct;
        const bytes = row?.querySelector('.transfer-bytes');
        if (bytes) bytes.textContent = item.bytes;
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    directTransfer = null;
  }
  if (result) setItem(item, result.saved ? 'saved' : 'browser', formatBytes(result.received), 100);
  else if (failure?.name === 'AbortError' || controller.signal.aborted) setItem(item, 'pending', '已取消读取。');
  else setItem(item, 'error', failure instanceof DownloadError ? failure.message : '保存失败，请检查文件写入权限或打开源文件。');
}

function renderBridge() {
  $('bridge-state').dataset.connected = String(Boolean(bridge));
  $('bridge-status').textContent = bridge ? '已连接 · ' + bridge.version : '未连接桌面端';
  const open = $('open-bridge');
  open.replaceChildren(document.createTextNode(bridge ? '断开连接' : '连接桌面端'), icon('arrow', true));
  renderQueue();
}

function disconnect(text) {
  bridge = null;
  pollFailures = 0;
  for (const item of items) {
    if (TRACKED.has(item.state) || item.state === 'sending') {
      Object.assign(item, { state: 'accepted', pct: null, detail: '连接已断开，任务结果未知，请在桌面端核对。' });
    }
  }
  persist();
  renderBridge();
  if (text) notify(text);
}

async function sendOne(item) {
  if (!bridge || !items.includes(item) || item.state === 'sending') return false;
  const connection = bridge;
  setItem(item, 'sending');
  try {
    const result = await taskTracker.send(connection, item, () => bridge === connection && items.includes(item));
    if (bridge !== connection || !items.includes(item)) return false;
    setItem(item, result.state, result.detail);
    void pollQueue();
    return true;
  } catch (error) {
    if (bridge !== connection || !items.includes(item)) return false;
    const uncertain = error.code === 'unreachable';
    setItem(item, 'error', uncertain ? '未收到确认。请先检查桌面队列，再决定是否重试。' : error.message);
    if ((uncertain || error.code === 'unauthorized') && bridge === connection) disconnect(error.message);
    return false;
  }
}

async function pollQueue() {
  const connection = bridge;
  if (!connection || polling || document.hidden || !items.some(({ state }) => TRACKED.has(state))) return;
  polling = true;
  try {
    const updates = await taskTracker.poll(connection);
    if (connection !== bridge) return;
    pollFailures = 0;
    let changed = false;
    for (const { item, ...next } of updates) {
      if (!items.includes(item) || !TRACKED.has(item.state)) continue;
      if (!next || (item.state === next.state && item.pct === next.pct && item.detail === next.detail)) continue;
      Object.assign(item, next);
      changed = true;
    }
    if (changed) { persist(); renderQueue(); }
  } catch (error) {
    if (connection !== bridge) return;
    pollFailures += 1;
    if (error.code === 'unauthorized' || pollFailures >= 2) disconnect('桌面连接已中断。已发送的任务可在 OmniGet 中查看。');
  } finally {
    polling = false;
  }
}

function initialOS() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/mac/i.test(platform)) return 'macos';
  if (/linux/i.test(platform) && !/android/i.test(navigator.userAgent)) return 'linux';
  return 'windows';
}

function renderRelease() {
  for (const button of $$('[data-os]')) {
    button.setAttribute('aria-pressed', String(button.dataset.os === activeOS));
  }
  if (!release) return;
  $('release-label').textContent = (releaseOrigin === 'live' ? '最新稳定版 ' : '内置发行记录 ') + release.tag;
  const builds = assetsFor(release, activeOS);
  $('installer-list').replaceChildren(...builds.map((asset) => {
    const row = element('div', 'installer-row');
    const description = element('div');
    description.append(element('strong', '', asset.label), element('p', 'asset-meta', asset.name + ' · ' + formatBytes(asset.size)));
    if (asset.digest) {
      const details = element('details', 'asset-digest');
      details.append(element('summary', '', 'SHA-256'), element('code', '', asset.digest));
      description.append(details);
    }
    const download = element('a', 'button button-outline', '下载');
    download.prepend(icon('download', true));
    download.href = asset.url;
    download.target = '_blank';
    download.rel = 'noopener noreferrer';
    download.setAttribute('aria-label', '下载 ' + asset.label);
    row.append(description, download);
    return row;
  }));
  if (!builds.length) $('installer-list').textContent = '当前发行记录没有该系统的安装包，请查看上游发行页。';
}

async function loadRelease() {
  const live = fetchRelease(false).catch(() => null);
  release = await fetchRelease(true).catch(() => null);
  if (release) { releaseOrigin = 'snapshot'; renderRelease(); }
  const latest = await live;
  if (latest) {
    release = latest;
    releaseOrigin = 'live';
    renderRelease();
  } else if (!release) {
    $('release-label').textContent = '无法读取安装包列表，请打开上游发行页。';
  }
}

$('link-form').addEventListener('submit', (event) => { event.preventDefault(); readInput(); });
for (const button of $$('[data-input-mode]')) {
  button.addEventListener('click', () => setInputMode(button.dataset.inputMode));
}
for (const button of $$('[data-filter]')) {
  button.addEventListener('click', () => { filter = button.dataset.filter; renderQueue(); });
}
for (const button of $$('[data-os]')) {
  button.addEventListener('click', () => { activeOS = button.dataset.os; renderRelease(); });
}

links.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  if (inputMode === 'single' || event.metaKey || event.ctrlKey) {
    event.preventDefault();
    $('link-form').requestSubmit();
  }
});
links.addEventListener('input', () => {
  if (inputMode === 'single' && /[\r\n]/.test(links.value.trim())) setInputMode('batch');
  message('form-hint', SESSION_HINT);
});
$('paste-link').addEventListener('click', async () => {
  try {
    links.value = (await navigator.clipboard.readText()).slice(0, MAX_FILE);
    links.dispatchEvent(new Event('input'));
  } catch {
    message('form-hint', '剪贴板读取未授权。请在输入框中手动粘贴。', 'error');
  }
  links.focus();
});
$('use-sample').addEventListener('click', () => {
  links.value = SAMPLE_URL;
  $('route').value = 'auto';
  links.focus();
  message('form-hint', '示例已填入，加入队列后即可保存。');
});
$('import-links').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE) {
    message('form-hint', 'TXT 文件大小上限为 128 KB。', 'error');
    return;
  }
  try {
    links.value = await file.text();
    setInputMode('batch');
    message('form-hint', '文本已导入，确认后加入队列。', 'success');
  } catch {
    message('form-hint', '读取文本失败，请检查文件后重试。', 'error');
  }
});

queueList.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-action]');
  const item = items.find(({ id }) => id === control?.closest('[data-id]')?.dataset.id);
  if (!item) return;
  const selected = control.dataset.action;
  if (selected === 'save' || selected === 'stream') void runDirect(item, selected === 'stream');
  if (selected === 'cancel') directTransfer?.controller.abort();
  if (selected === 'send') void sendOne(item);
  if (selected === 'source' && !['browser', 'saved'].includes(item.state)) {
    setTimeout(() => {
      if (items.includes(item)) setItem(item, 'browser', '已请求打开源文件，可在浏览器中保存。');
    }, 0);
  }
  if (selected === 'open') {
    if (!TRACKED.has(item.state) && item.state !== 'desktop-done') {
      setTimeout(() => {
        if (items.includes(item)) setItem(item, 'opened', '请在系统提示中确认，然后查看桌面端。');
      }, 0);
    }
  }
  if (selected === 'copy') {
    try { await navigator.clipboard.writeText(item.url); notify('链接已复制。'); }
    catch { notify('无法写入剪贴板。请检查浏览器权限。'); }
  }
  if (selected === 'guide') {
    $('guide').querySelector('details:last-child').open = true;
  }
  if (selected === 'remove') {
    items = items.filter((entry) => entry !== item);
    persist();
    renderQueue();
  }
});

$('clear-finished').addEventListener('click', () => {
  items = items.filter(({ state }) => !canClear(state));
  persist();
  renderQueue();
});
$('batch-send').addEventListener('click', async () => {
  if (sendingBatch || !bridge) return;
  const connection = bridge;
  const pending = items.filter(({ route, state }) => route === 'desktop' && state === 'pending');
  sendingBatch = true;
  renderQueue();
  let sent = 0;
  try {
    for (const item of pending) {
      if (bridge !== connection) break;
      if (item.state === 'pending' && await sendOne(item)) sent += 1;
    }
  } finally {
    sendingBatch = false;
    renderQueue();
  }
  if (sent) notify('桌面端已接收 ' + sent + ' / ' + pending.length + ' 条请求，任务创建仍待确认。');
});

$('open-bridge').addEventListener('click', () => {
  if (bridge) disconnect('已断开桌面端。');
  else {
    message('bridge-message', '');
    bridgeDialog.showModal();
  }
});
$('close-bridge').addEventListener('click', () => bridgeDialog.close());
bridgeDialog.addEventListener('close', () => {
  bridgeAttempt += 1;
  $('bridge-token').value = '';
  $('connect-bridge').disabled = false;
});
$('bridge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const attempt = ++bridgeAttempt;
  const button = $('connect-bridge');
  button.disabled = true;
  message('bridge-message', '正在验证本机连接…');
  try {
    const connection = await connectBridge($('bridge-port').value, $('bridge-token').value);
    if (attempt !== bridgeAttempt || !bridgeDialog.open) return;
    bridge = connection;
    bridgeDialog.close();
    renderBridge();
    void pollQueue();
  } catch (error) {
    if (attempt === bridgeAttempt) message('bridge-message', error.message, 'error');
  } finally {
    if (attempt === bridgeAttempt) button.disabled = false;
  }
});
document.querySelector('.bridge-help').addEventListener('click', () => { $('guide-bridge').open = true; });

function updateNav() {
  const hash = ['#desktop', '#guide'].includes(location.hash) ? location.hash : '#workspace';
  for (const link of $$('.site-nav a')) {
    if (link.hash === hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', updateNav);
document.addEventListener('visibilitychange', () => { void pollQueue(); });
setInterval(pollQueue, 3000);
renderQueue();
renderRelease();
updateNav();
void loadRelease();
