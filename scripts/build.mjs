import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
};
const assets = {};
async function collect(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (relative === '' && entry.name === 'server')) continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), child);
    else {
      const data = await readFile(path.join(directory, entry.name));
      const binary = /\.(?:png|ico|wav|mp4|webm)$/i.test(entry.name);
      assets['/' + child] = { mime: MIME[path.extname(entry.name)] || 'application/octet-stream',
        body: data.toString(binary ? 'base64' : 'utf8'), base64: binary };
    }
  }
}
await collect(dist);
await mkdir(path.join(dist, 'server'), { recursive: true });
await mkdir(path.join(dist, '.openai'), { recursive: true });
await writeFile(path.join(dist, 'server', 'index.js'),
  await readFile(path.join(root, 'worker', 'app.mjs'), 'utf8') +
  '\nconst assets = ' + JSON.stringify(assets) + ';\nexport default createApp(assets);\n');
await writeFile(path.join(dist, '.openai', 'hosting.json'), await readFile(path.join(root, '.openai', 'hosting.json')));
console.log('Built Worker with ' + Object.keys(assets).length + ' web assets.');
