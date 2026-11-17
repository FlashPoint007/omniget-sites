import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createApp, publicURL } from '../worker/app.mjs';
import { readLink } from '../dist/lib/links.mjs';
import { resolveBrowserDownload, startBrowserDownload } from '../dist/lib/browser-download.mjs';

const origin = 'https://omniget.example.com';
const env = { DOWNLOAD_SIGNING_KEY: 'test-signing-secret-never-for-production-0123456789' };
const post = (url, mode = 'auto') => new Request(origin + '/api/resolve', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({ url, mode }),
});
const http = (app, path, init) => app.fetch(new Request(origin + path, init), env);

function fixture(routes) {
  const calls = [];
  const app = createApp({}, { fetch: async (raw, init) => {
    assert.notEqual(init.redirect, 'error', 'Workers require manual redirect checks');
    const url = new URL(raw);
    calls.push({ url, ...init });
    if (url.hostname === 'cloudflare-dns.com') {
      const host = url.searchParams.get('name');
      return Response.json({ Answer: [{ type: 1, data: host === 'private.example.com' ? '10.0.0.1' : '8.8.8.8' }] });
    }
    const handler = routes[url.href] || routes[url.hostname + url.pathname];
    assert.ok(handler, 'Unexpected network request ' + url.hostname + url.pathname);
    return handler(init, url);
  } });
  return { app, calls };
}

test('all public HTTP links default to browser resolution, including signed and extensionless links', () => {
  assert.equal(readLink('https://www.bilibili.com/video/BV1GJ411x7h7').route, 'direct');
  assert.equal(readLink('https://youtu.be/jNQXAC9IVRw').route, 'direct');
  assert.equal(readLink('https://cdn.example.com/get?Signature=aa%2Fbb').url, 'https://cdn.example.com/get?Signature=aa%2Fbb');
  assert.equal(readLink('https://cdn.example.com/get?Signature=aa%2Fbb').route, 'direct');
  assert.equal(readLink('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), null);
});

test('attachment response streams bytes, preserves filename and Range, and sends no visitor credentials', async () => {
  const { app, calls } = fixture({
    'cdn.example.com/file.zip': (init) => new Response(init.headers.Range === 'bytes=2-5' ? '2345' : '01234567', {
      status: init.headers.Range === 'bytes=2-5' ? 206 : 200,
      headers: { 'Content-Type': 'application/zip', 'Accept-Ranges': 'bytes',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.zip",
        ...(init.headers.Range === 'bytes=2-5' ? { 'Content-Range': 'bytes 2-5/8' } : {}) },
    }),
  });
  const response = await app.fetch(post('https://cdn.example.com/file.zip?sig=abc%2Fdef'), env);
  assert.equal(response.status, 200);
  const { files } = await response.json();
  assert.equal(files[0].name, '文件.zip');
  const check = await http(app, files[0].href + '&check=1');
  assert.equal(check.status, 200);
  const download = await http(app, files[0].href, { headers: { Range: 'bytes=2-5', Cookie: 'private=secret', Authorization: 'Bearer visitor' } });
  assert.equal(download.status, 206);
  assert.equal(download.headers.get('content-range'), 'bytes 2-5/8');
  assert.match(download.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''%E6/);
  assert.equal(await download.text(), '2345');
  for (const call of calls) {
    assert.equal(call.headers.Cookie, undefined);
    assert.equal(call.headers.Authorization, undefined);
  }
});

test('HTML video, Open Graph and JSON-LD media are resolved to downloadable original files', async () => {
  const { app } = fixture({
    'page.example.com/watch': () => new Response('<title>Example &amp; video</title><video><source src="/media/movie.mp4?x=1&amp;y=2" type="video/mp4"></video>' +
      '<meta property="og:video:secure_url" content="/media/movie.mp4?x=1&amp;y=2">' +
      '<script type="application/ld+json">{"@type":"AudioObject","contentUrl":"https://media.example.com/audio.mp3"}</script>', { headers: { 'Content-Type': 'text/html' } }),
  });
  const response = await app.fetch(post('https://page.example.com/watch'), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.title, 'Example & video');
  assert.equal(result.files.length, 2);
  assert.match(result.files[0].name, /\.mp4$/);
  assert.match(result.files[1].name, /\.mp3$/);
});

test('Bilibili progressive download uses the requested part and the required CDN Referer', async () => {
  const { app, calls } = fixture({
    'api.bilibili.com/x/web-interface/view': () => Response.json({
      code: 0, data: { title: 'Sample', pages: [{ cid: 11 }, { cid: 22 }] },
    }),
    'api.bilibili.com/x/player/playurl': (_, url) => {
      assert.equal(url.searchParams.get('cid'), '22');
      return Response.json({ code: 0, data: { quality: 32, durl: [{ url: 'https://cdn.example.com/video.mp4' }] } });
    },
    'cdn.example.com/video.mp4': (init) => {
      assert.equal(init.headers.Referer, 'https://www.bilibili.com/');
      return new Response('video-and-audio', { headers: { 'Content-Type': 'video/mp4' } });
    },
  });
  const response = await app.fetch(post('https://www.bilibili.com/video/BV1GJ411x7h7?p=2'), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.files[0].name, 'Sample - P2.mp4');
  const download = await http(app, result.files[0].href);
  assert.equal(await download.text(), 'video-and-audio');
  assert.ok(calls.some((call) => call.url.hostname === 'api.bilibili.com'));
});

test('unsafe hosts, credentials, private DNS and redirect targets never reach upstream', async () => {
  for (const raw of ['http://127.1/a', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://10.0.0.1/', 'https://user:pass@example.com/', 'ftp://cdn.example.com/a', 'https://localhost/a']) {
    assert.throws(() => publicURL(raw));
  }
  const { app, calls } = fixture({
    'cdn.example.com/redirect': () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }),
  });
  const blocked = await app.fetch(post('https://private.example.com/secret'), env);
  assert.equal(blocked.status, 400);
  const redirected = await app.fetch(post('https://cdn.example.com/redirect'), env);
  assert.equal(redirected.status, 400);
  assert.equal(calls.some(({ url }) => url.hostname === '127.0.0.1' || url.hostname === 'private.example.com'), false);
});

test('tampered and cross-origin tickets are rejected; unsupported pages produce actionable errors', async () => {
  const { app } = fixture({
    'cdn.example.com/file.mp4': () => new Response('file', { headers: { 'Content-Type': 'video/mp4' } }),
    'page.example.com/private': () => new Response('<title>Log in</title>', { headers: { 'Content-Type': 'text/html' } }),
    'cdn.example.com/live.m3u8': () => new Response('#EXTM3U', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }),
  });
  const { files } = await (await app.fetch(post('https://cdn.example.com/file.mp4'), env)).json();
  const tampered = files[0].href.replace('t=', 't=A');
  assert.equal((await http(app, tampered)).status, 410);
  assert.equal((await app.fetch(new Request('https://other.example.com' + files[0].href), env)).status, 410);
  const unsupported = await app.fetch(post('https://page.example.com/private'), env);
  assert.equal(unsupported.status, 422);
  assert.match((await unsupported.json()).error, /未提供/);
  assert.equal((await app.fetch(post('https://cdn.example.com/live.m3u8'), env)).status, 422);
  const external = new Request(origin + '/api/resolve', { method: 'POST', headers: { Origin: 'https://other.example.com' }, body: '{}' });
  assert.equal((await app.fetch(external, env)).status, 403);
});

test('native download frontend checks the file before dispatch and creates a browser download', async (t) => {
  const requests = [];
  let clicked = false;
  const savedFetch = globalThis.fetch;
  const savedDocument = globalThis.document;
  t.after(() => { globalThis.fetch = savedFetch; globalThis.document = savedDocument; });
  const app = createApp({ '/sample.txt': { body: 'sample', mime: 'text/plain' } });
  globalThis.fetch = async (path, init) => {
    requests.push(path);
    return app.fetch(new Request(new URL(path, origin), init), env);
  };
  globalThis.document = {
    createElement() { return { click() { clicked = true; }, remove() {} }; },
    body: { append() {} },
  };
  const controller = new AbortController();
  const result = await resolveBrowserDownload({ url: origin + '/sample.txt', mode: 'auto' }, controller.signal);
  await startBrowserDownload(result.files[0], controller.signal);
  assert.equal(clicked, true);
  assert.match(requests[1], /check=1$/);
});

test('a completed browser transfer is not fabricated after failed or cancelled parsing', async () => {
  const source = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function runBrowser('), source.indexOf('function renderBridge('));
  const item = { id: 'one', url: 'https://cdn.example.com/file.mp4', state: 'pending' };
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  const context = vm.createContext({
    items: [item], resolutions: new Map(), AbortController,
    BrowserDownloadError: Error, resolveBrowserDownload: async () => { throw error; },
    setItem(target, state, detail) { Object.assign(target, { state, detail }); },
  });
  await vm.runInContext(functionSource + '; runBrowser(items[0])', context);
  assert.equal(item.state, 'pending');
  assert.match(item.detail, /已取消/);
});
