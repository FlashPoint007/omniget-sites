import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchRelease, assetsFor } from '../dist/lib/releases.mjs';

const snapshot = JSON.parse(await readFile(new URL('../dist/assets/releases.json', import.meta.url)));
const tag = 'v0.16.6';
const name = 'OmniGet_0.16.6_x64-setup.exe';
const base = 'https://github.com/OpenSelena/libreget/releases';
const url = `${base}/download/${tag}/${name}`;
const asset = { name, size: 123, browser_download_url: url, url: 'https://api.github.com/repos/OpenSelena/libreget/releases/assets/123' };
const release = { tag_name: tag, assets: [asset] };

test('release validation and fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const respond = (data) => { globalThis.fetch = async () => Response.json(data); };

  await t.test('canonical API, privacy options and all supported OS builds', async () => {
    globalThis.fetch = async (request, options) => {
      assert.equal(request, 'https://api.github.com/repos/OpenSelena/libreget/releases/latest');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(release);
    };
    const result = await fetchRelease(false);
    assert.equal(result.tag, tag);
    assert.equal(result.url, `${base}/tag/${tag}`);
    assert.equal(assetsFor(result, 'windows')[0].url, url);
    for (const [os, filename] of [['macos', 'OmniGet_aarch64.dmg'], ['linux', 'OmniGet_amd64.deb']]) {
      respond({ ...release, assets: [{ name: filename, size: 123, browser_download_url: `${base}/download/${tag}/${filename}` }] });
      assert.equal(assetsFor(await fetchRelease(false), os).length, 1);
    }
  });

  await t.test('legacy bundled snapshot remains available after live failure', async () => {
    globalThis.fetch = async (request, options) => {
      if (typeof request === 'string') return new Response('', { status: 503 });
      assert.ok(request.pathname.endsWith('/assets/releases.json'));
      assert.equal(options.credentials, 'same-origin');
      return Response.json(snapshot);
    };
    // Matches the UI: keep the snapshot when live metadata is unavailable.
    const live = fetchRelease(false).catch(() => null);
    const fallback = await fetchRelease(true);
    assert.equal(await live, null);
    assert.equal(fallback.tag, 'v0.15.1');
    for (const os of ['windows', 'macos', 'linux']) assert.ok(assetsFor(fallback, os).length);
    assert.ok(fallback.assets.every((item) => item.url.startsWith('https://github.com/OpenSelena/omniget/releases/download/')));
  });

  await t.test('reject spoofed hosts, owners, repos, tags, filenames and URL suffixes', async () => {
    for (const forged of [
      url.replace('github.com', 'github.com.evil.test'),
      url.replace('github.com', 'github.com@evil.test'),
      url.replace('OpenSelena', 'OtherOwner'),
      url.replace('/libreget/', '/libreget-fork/'),
      url.replace('/libreget/', '/omniget-fork/'),
      url.replace(tag, 'v0.16.5'),
      url.replace(name, 'other.exe'),
      url.replace('https:', 'http:'),
      url.replace('github.com/', 'github.com:443/'),
      `${url}?redirect=evil`, `${url}#evil`,
      url.replace('/download/', '/download/../download/'),
      url.replace('OpenSelena', '%4fpenSelena'),
    ]) {
      respond({ ...release, assets: [{ ...asset, browser_download_url: forged }] });
      await assert.rejects(fetchRelease(false), /no supported assets/);
    }
  });

  await t.test('malformed metadata and unusable responses fail closed', async () => {
    for (const data of [null, [], 'bad', {}, { tag_name: '../bad' }, { tag_name: tag, assets: {} }, { ...release, assets: [null, {}, { ...asset, size: -1 }, { ...asset, size: 1.5 }, { ...asset, name: '../bad.exe' }] }]) {
      respond(data);
      await assert.rejects(fetchRelease(false));
    }
    globalThis.fetch = async () => new Response('not JSON');
    await assert.rejects(fetchRelease(false));
    for (const status of [403, 404, 429, 500]) {
      globalThis.fetch = async () => new Response('', { status });
      await assert.rejects(fetchRelease(false), /unavailable/);
    }
    for (const error of [new TypeError('network failed'), new DOMException('timeout', 'TimeoutError')]) {
      globalThis.fetch = async () => { throw error; };
      await assert.rejects(fetchRelease(false), error);
    }
  });

  await t.test('ignore malformed individual assets and sanitize digest', async () => {
    respond({ ...release, assets: [null, { ...asset, digest: 'sha256:' + 'a'.repeat(64) }] });
    assert.equal((await fetchRelease(false)).assets[0].digest, 'a'.repeat(64));
    respond({ ...release, assets: [{ ...asset, digest: '<script>' }] });
    assert.equal((await fetchRelease(false)).assets[0].digest, '');
  });
});
