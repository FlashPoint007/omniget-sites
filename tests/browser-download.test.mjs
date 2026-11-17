import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { signBilibiliQuery, wbiMD5, wbiMixin } from '../worker/bilibili-sign.mjs';
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

test('Bilibili uses WBI metadata and player with the requested part and CDN Referer', async () => {
  const keys = { img: '7cd084941338484aae1ad9425b84077c', sub: '4932caff0ff746eab6f01bf08b70ac45' };
  const metadata = { bvid: 'BV1GJ411x7h7', cid: 11, title: 'Sample', duration: 600,
    pages: [{ cid: 11, duration: 420 }, { cid: 22, duration: 180 }] };
  const { app, calls } = fixture({
    'api.bilibili.com/x/web-interface/wbi/view/detail': (_, url) => {
      assert.equal(url.searchParams.get('bvid'), 'BV1GJ411x7h7');
      assert.equal(url.searchParams.get('platform'), 'web');
      assert.equal(url.searchParams.has('spm_id_from'), false);
      const page = JSON.stringify({ code: 0, data: { View: metadata } });
      return new Response(gzipSync(page), { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    },
    'api.bilibili.com/x/web-interface/nav': () => Response.json({
      code: -101, data: { isLogin: false, wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/' + keys.img + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + keys.sub + '.png',
      } },
    }),
    'api.bilibili.com/x/player/wbi/playurl': (_, url) => {
      assert.equal(url.searchParams.get('cid'), '22');
      const query = url.search.slice(1);
      const unsigned = query.split('&w_rid=')[0];
      const signature = createHash('md5').update(unsigned + wbiMixin(keys.img, keys.sub)).digest('hex');
      assert.equal(url.searchParams.get('w_rid'), signature);
      return Response.json({ code: 0, data: { quality: 16, accept_quality: [16],
        accept_description: ['360P'], durl: [{ url: 'https://cdn.example.com/video.mp4', length: 180000 }] } });
    },
    'cdn.example.com/video.mp4': (init) => {
      assert.equal(init.headers.Referer, 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2');
      return new Response('video-and-audio', { headers: { 'Content-Type': 'video/mp4' } });
    },
  });
  const response = await app.fetch(post('https://www.bilibili.com/video/BV1GJ411x7h7?p=2&spm_id_from=test'), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.files[0].name, 'Sample - P2.mp4');
  assert.equal(result.files[0].label, '360P · 含音频');
  const download = await http(app, result.files[0].href);
  assert.equal(await download.text(), 'video-and-audio');
  assert.equal(calls.some((call) => call.url.pathname === '/x/web-interface/view'), false);
});

test('WBI checksum handles UTF-8 and block boundaries and signs canonical query values', () => {
  for (const value of ['', 'a', 'abc', '中文😀', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(4000)]) {
    assert.equal(wbiMD5(value), createHash('md5').update(value).digest('hex'));
  }
  assert.equal(wbiMixin('invalid', 'invalid'), null);
  const mixin = wbiMixin('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  const result = signBilibiliQuery({ foo: 114, bar: 514, baz: 1919810 }, mixin, 1702204169);
  assert.equal(result, 'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee');
});

test('Bilibili security challenges stop extraction and invalid parts are rejected', async () => {
  const { app, calls } = fixture({
    'api.bilibili.com/x/web-interface/nav': () => Response.json({ data: { wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    } } }),
    'api.bilibili.com/x/web-interface/wbi/view/detail': () => Response.json({ code: -352, message: 'challenge' }),
  });
  assert.equal((await app.fetch(post('https://www.bilibili.com/video/BV1GJ411x7h7'), env)).status, 403);
  assert.equal(calls.some((call) => call.url.pathname === '/x/player/wbi/playurl'), false);
  assert.equal((await app.fetch(post('https://www.bilibili.com/video/BV1GJ411x7h7?p=1.5'), env)).status, 400);
});

test('Bilibili upstream blocks identify the failing stage and stop further requests', async () => {
  const { app, calls } = fixture({
    'api.bilibili.com/x/web-interface/nav': () => new Response('blocked', { status: 412 }),
  });
  const response = await app.fetch(post('https://www.bilibili.com/video/BV1gfGw6RE5p/?spm_id_from=search'), env);
  assert.equal(response.status, 403);
  const result = await response.json();
  assert.match(result.error, /获取播放器签名.*HTTP 412/);
  assert.match(result.error, /当前无法从网页下载/);
  assert.equal(result.files, undefined);
  assert.equal(calls.filter((call) => call.url.hostname === 'api.bilibili.com').length, 1);
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
