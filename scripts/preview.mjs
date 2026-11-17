import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../worker/app.mjs';

const MIME = { html: 'text/html; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', png: 'image/png' };
// The dev server reads the current sources on each request, while the production
// artifact embeds exactly the asset versions used for its build.
const { readdir } = await import('node:fs/promises');
const assetPaths = [];
async function list(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!prefix && entry.name === 'server')) continue;
    const name = prefix + '/' + entry.name;
    if (entry.isDirectory()) await list(dir + '/' + entry.name, name);
    else assetPaths.push(name);
  }
}
const webRoot = fileURLToPath(new URL('../dist', import.meta.url));
await list(webRoot);
const sourceAssets = {};
const app = createApp(sourceAssets);
const portArgument = process.argv.indexOf('--port');
const hostArgument = process.argv.indexOf('--host');
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 3000);
const host = hostArgument >= 0 ? process.argv[hostArgument + 1] : '127.0.0.1';
createServer(async (incoming, outgoing) => {
  try {
    for (const name of assetPaths) {
      const data = await readFile(webRoot + name);
      const binary = /\.png$/i.test(name);
      sourceAssets[name] = { body: data.toString(binary ? 'base64' : 'utf8'), base64: binary,
        mime: MIME[name.split('.').at(-1)] || 'application/octet-stream' };
    }
    const origin = 'http://' + incoming.headers.host;
    const controller = new AbortController();
    outgoing.on('close', () => { if (!outgoing.writableFinished) controller.abort(); });
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method, headers: incoming.headers, signal: controller.signal,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }),
    });
    const response = await app.fetch(request, { DOWNLOAD_SIGNING_KEY: 'omniget-local-preview-only-signing-key' });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'text/plain' }).end('Preview unavailable');
  }
}).listen(port, host);
