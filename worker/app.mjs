import { signBilibiliQuery, wbiMixin } from './bilibili-sign.mjs';

const PAGE_LIMIT = 2 * 1024 * 1024;
const TOKEN_LIFETIME = 2 * 60 * 60 * 1000;
const MIME_TYPES = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};
const MANIFEST = /\.(?:m3u8?|mpd)(?:$|\?)/i;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

export class DownloadIssue extends Error {
  constructor(message, status = 422, upstreamStatus) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

function cleanName(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^[ .]+|[ .]+$/g, '').slice(0, 160) || 'omniget-download';
}

function publicIPv4(host) {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  return parts.length === 4 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) &&
    !(a === 203 && b === 0 && parts[2] === 113);
}

export function publicURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new DownloadIssue('请输入完整的 HTTP 或 HTTPS 链接。', 400); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
    (url.port && !['80', '443'].includes(url.port)) || url.href.length > 8192 ||
    !host.includes('.') || /[:\[\]]/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|arpa)$/.test(host) ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !publicIPv4(host))) {
    throw new DownloadIssue('仅支持公网 HTTP(S) 链接。', 400);
  }
  url.hash = '';
  return url;
}

async function readLimited(response, limit = PAGE_LIMIT, compressionDepth = 0) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DownloadIssue('页面内容过大，请使用文件直链。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (compressionDepth === 0 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const decoded = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return readLimited(new Response(decoded), limit, 1);
  }
  return new TextDecoder().decode(bytes);
}

function unescapeHTML(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, name) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (named[name.toLowerCase()]) return named[name.toLowerCase()];
    const number = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

function attributes(tag) {
  const fields = {};
  const pattern = /([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of tag.matchAll(pattern)) fields[match[1].toLowerCase()] = unescapeHTML(match[2] ?? match[3] ?? match[4]);
  return fields;
}

export function pageMedia(html, pageURL) {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let title = unescapeHTML(titleTag?.replace(/<[^>]*>/g, '')).trim().slice(0, 180);
  const candidates = [];
  const add = (value, label = '', mime = '') => {
    if (!value || /^(?:blob|data|javascript):/i.test(value)) return;
    let url;
    try { url = publicURL(new URL(value, pageURL).href).href; } catch { return; }
    if (MANIFEST.test(url) || /(?:mpegurl|dash\+xml)/i.test(mime)) return;
    if (!candidates.some((item) => item.url === url)) candidates.push({ url, label: label || '媒体文件', mime });
  };
  for (const match of html.matchAll(/<(?:meta|video|audio|source)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (/^<meta/i.test(match[0])) {
      const property = (attrs.property || attrs.name || '').toLowerCase();
      if (property === 'og:title') title = attrs.content?.slice(0, 180) || title;
      if (/^(?:og:(?:video|audio)(?::(?:url|secure_url))?|twitter:player:stream)$/.test(property)) add(attrs.content);
    } else {
      add(attrs.src, attrs.label, attrs.type);
    }
  }
  // JSON-LD can expose downloadable media when the player itself uses JS.
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack = [JSON.parse(match[1])];
      let visited = 0;
      while (stack.length && visited++ < 200) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (/VideoObject|AudioObject/.test(String(node['@type']))) {
          add(node.contentUrl, '', node.encodingFormat);
          title ||= String(node.name || '').slice(0, 180);
        }
        stack.push(...Object.values(node).filter((value) => value && typeof value === 'object'));
      }
    } catch { /* Other page candidates remain available. */ }
  }
  return { title, files: candidates.slice(0, 12) };
}

function assignedJSON(html, pattern) {
  const start = pattern.exec(html);
  if (!start) return null;
  const begin = start.index + start[0].lastIndexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = begin; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(begin, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}

async function signingKey(secret) {
  if (!secret || secret.length < 32) throw new DownloadIssue('下载服务尚未配置完成，请稍后重试。', 503);
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueTicket(file, secret, origin) {
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify({ ...file, origin, expires: Date.now() + TOKEN_LIFETIME })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(body));
  return body + '.' + bytesToBase64(new Uint8Array(signature));
}

async function readTicket(token, secret, origin) {
  if (typeof token !== 'string' || token.length > 20_000) throw new DownloadIssue('下载链接无效，请重新解析。', 400);
  const [body, signature, extra] = token.split('.');
  try {
    if (!body || !signature || extra || !await crypto.subtle.verify('HMAC', await signingKey(secret), base64ToBytes(signature), new TextEncoder().encode(body))) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
    if (data.origin !== origin || data.expires < Date.now() || typeof data.url !== 'string') throw new Error();
    return data;
  } catch {
    throw new DownloadIssue('下载链接已失效，请重新解析后下载。', 410);
  }
}

function assetResponse(assets, path, head = false) {
  const asset = assets[path];
  if (!asset) return null;
  const body = asset.base64
    ? Uint8Array.from(atob(asset.body), (char) => char.charCodeAt(0)) : asset.body;
  return new Response(head ? null : body, { headers: {
    'Content-Type': asset.mime,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  } });
}

export function createApp(assets, { fetch: upstreamFetch = (...args) => fetch(...args) } = {}) {
  const dnsCache = new Map();
  const budgets = new Map();

  async function checkDNS(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
    const cached = dnsCache.get(host);
    if (cached > Date.now()) return;
    const response = await upstreamFetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A', {
      headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(7000), redirect: 'manual',
    });
    if (!response.ok) throw new DownloadIssue('暂时无法验证源站地址，请稍后重试。', 502);
    const answer = JSON.parse(await readLimited(response, 48 * 1024));
    const addresses = (answer.Answer || []).filter((entry) => entry.type === 1).map((entry) => entry.data);
    if (!addresses.length || addresses.some((address) => !publicIPv4(address))) {
      throw new DownloadIssue('源站地址无法解析为公网地址。', 400);
    }
    if (dnsCache.size > 200) dnsCache.clear();
    dnsCache.set(host, Date.now() + 60_000);
  }

  async function fetchSource(raw, origin, { referer = '', range = '', signal, headers: extra = {} } = {}) {
    let target = new URL(raw);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (target.origin === origin) {
        const local = assetResponse(assets, target.pathname === '/' ? '/index.html' : target.pathname);
        if (!local) throw new DownloadIssue('本站链接未指向可下载文件。', 404);
        return { response: local, url: target.href };
      }
      target = publicURL(target.href);
      await checkDNS(target.hostname);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity', ...extra };
      if (referer) headers.Referer = referer;
      if (range) headers.Range = range;
      let response;
      try {
        response = await upstreamFetch(target.href, { headers, redirect: 'manual', signal: controller.signal });
      } catch {
        throw new DownloadIssue('无法连接源站，可能暂时不可用或限制了访问。', 502);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new DownloadIssue('源站未提供有效的跳转地址。', 502);
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadIssue('源站返回 HTTP ' + response.status + '，该链接当前无法下载。', 502, response.status);
      }
      return { response, url: target.href };
    }
    throw new DownloadIssue('源站跳转次数过多。', 502);
  }

  async function getJSON(url, origin, referer = '') {
    const { response } = await fetchSource(url, origin, { referer });
    try { return JSON.parse(await readLimited(response)); }
    catch (error) {
      if (error instanceof DownloadIssue) throw error;
      throw new DownloadIssue('平台接口未返回有效内容，可能需要登录或验证。', 502);
    }
  }

  async function bilibili(url, origin) {
    const rawID = /\/(BV[0-9a-z]{10}|av\d+)(?:\/|$)/i.exec(url.pathname)?.[1];
    if (!rawID) throw new DownloadIssue('请粘贴 B 站单个视频的 BV 或 AV 链接。');
    const id = rawID.replace(/^bv/i, 'BV').replace(/^av/i, 'av');
    const part = Number(url.searchParams.get('p') || 1);
    if (!Number.isSafeInteger(part) || part < 1) throw new DownloadIssue('分 P 参数无效。', 400);
    const canonical = new URL('https://www.bilibili.com/video/' + id + '/');
    if (part > 1) canonical.searchParams.set('p', String(part));
    const getBilibiliJSON = async (path, stage) => {
      try { return await getJSON('https://api.bilibili.com' + path, origin, canonical.href); }
      catch (error) {
        if (error instanceof DownloadIssue && [403, 412, 429].includes(error.upstreamStatus)) {
          throw new DownloadIssue('B 站在' + stage + '时限制了本站服务器访问（HTTP ' + error.upstreamStatus + '）。' +
            '当前无法从网页下载此视频；可打开原链接在 B 站观看。', 403);
        }
        throw error;
      }
    };

    const nav = await getBilibiliJSON('/x/web-interface/nav', '获取播放器签名');
    const images = nav.data?.wbi_img;
    const imageKey = (value) => typeof value === 'string' ? /\/([a-f0-9]{32})\.[a-z]+(?:\?|$)/i.exec(value)?.[1] : '';
    const mixin = wbiMixin(imageKey(images?.img_url), imageKey(images?.sub_url));
    if (!mixin) throw new DownloadIssue('暂时无法取得 B 站播放器签名信息。', 502);

    const identity = id.startsWith('BV') ? { bvid: id } : { aid: id.slice(2) };
    const detailQuery = signBilibiliQuery({ ...identity, platform: 'web' }, mixin);
    const detail = await getBilibiliJSON('/x/web-interface/wbi/view/detail?' + detailQuery, '读取视频信息');
    const metadata = detail.data?.View;
    if (detail.code === -352 || detail.code === -412) {
      throw new DownloadIssue('B 站要求安全验证，当前无法读取视频信息。', 403);
    }
    if (detail.code !== 0 || !metadata?.bvid || !metadata?.cid) {
      throw new DownloadIssue(detail.code === -403 || detail.code === -101
        ? '该 B 站视频需要登录或相应观看权限。'
        : detail.code === -404 ? '该视频已下架，或当前地区无法观看。'
          : 'B 站未返回公开视频信息。');
    }
    if (id.startsWith('BV') && metadata.bvid !== id) throw new DownloadIssue('视频信息与请求的 BV 号不一致。');
    const pages = Array.isArray(metadata.pages) && metadata.pages.length ? metadata.pages : [{ cid: metadata.cid }];
    if (part > pages.length) throw new DownloadIssue('该视频没有第 ' + part + ' P。', 400);
    const cid = pages[part - 1].cid;
    if (!Number.isSafeInteger(cid) || cid <= 0) throw new DownloadIssue('B 站没有有效的分 P 信息。');
    const query = signBilibiliQuery({
      bvid: metadata.bvid, cid, qn: 64, fnval: 1, fnver: 0, fourk: 0,
      platform: 'html5', high_quality: 1,
    }, mixin);
    const stream = await getBilibiliJSON('/x/player/wbi/playurl?' + query, '取得播放地址');
    if (stream.code !== 0 || !stream.data?.durl?.length) {
      throw new DownloadIssue(stream.code === -101 || stream.code === -403
        ? '该视频需要 B 站登录或相应观看权限。'
        : stream.code === -352 || stream.code === -412
          ? 'B 站要求安全验证，当前无法取得下载地址。'
          : '该视频当前未提供可直接下载的公开完整视频文件。');
    }
    const title = String(metadata.title || metadata.bvid) + (pages.length > 1 ? ' - P' + part : '');
    const quality = stream.data.accept_description?.[stream.data.accept_quality?.indexOf(stream.data.quality)] ||
      ({ 6: '240P', 16: '360P', 32: '480P', 64: '720P', 80: '1080P' })[stream.data.quality] || '公开视频';
    const durations = stream.data.durl.map((entry) => Number(entry.length));
    const partDuration = pages[part - 1].duration || (pages.length === 1 ? metadata.duration : 0);
    if (Number.isFinite(partDuration) && partDuration > 60 &&
      durations.every(Number.isFinite) && durations.reduce((a, b) => a + b, 0) < partDuration * 1000 * 0.9) {
      throw new DownloadIssue('B 站返回了试看片段，当前无法取得完整视频。');
    }
    return { title, files: stream.data.durl.slice(0, 12).filter((entry) => entry.url).map((entry, index, all) => ({
      url: entry.url, referer: canonical.href,
      name: cleanName(title) + (all.length > 1 ? ' - 分段' + (index + 1) : '') +
        (/\.flv(?:\?|$)/.test(entry.url) ? '.flv' : '.mp4'),
      label: quality + (all.length > 1 ? ' · 分段 ' + (index + 1) : ' · 含音频'),
    })) };
  }

  async function resolve(raw, mode, origin) {
    let url;
    try { url = new URL(raw); } catch { throw new DownloadIssue('请输入有效链接。', 400); }
    if (url.origin !== origin) url = publicURL(raw);
    if (url.protocol === 'magnet:') throw new DownloadIssue('浏览器下载仅支持 HTTP(S) 文件或公开媒体页面。');
    if (mode !== 'direct' && /(^|\.)bilibili\.com$/i.test(url.hostname)) return bilibili(url, origin);
    const fetched = await fetchSource(url.href, origin, { range: 'bytes=0-2097151' });
    const type = fetched.response.headers.get('content-type') || '';
    const disposition = fetched.response.headers.get('content-disposition') || '';
    const page = /(?:text\/html|application\/xhtml\+xml)/i.test(type);
    if (mode === 'direct' || !page || /attachment/i.test(disposition)) {
      await fetched.response.body?.cancel();
      if (MANIFEST.test(fetched.url) || /(?:mpegurl|dash\+xml)/i.test(type)) throw new DownloadIssue('这是分片播放清单，当前网页支持完整媒体文件下载。');
      const rawName = new URL(fetched.url).pathname.split('/').filter(Boolean).at(-1) || '';
      let name;
      try { name = decodeURIComponent(rawName); } catch { name = rawName; }
      const encodedName = /filename\*=UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1];
      if (encodedName) {
        try { name = decodeURIComponent(encodedName.trim()); } catch { /* keep URL name */ }
      } else {
        const match = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(disposition);
        if (match) name = match[1] || match[2];
      }
      name = cleanName(name);
      if (!/\.[a-z0-9]{1,8}$/i.test(name) && MIME_TYPES[type.split(';')[0]]) name += '.' + MIME_TYPES[type.split(';')[0]];
      return { title: name, files: [{ url: fetched.url, name, label: '原始文件', allowHTML: mode === 'direct' }] };
    }
    const html = await readLimited(fetched.response);
    const finalURL = new URL(fetched.url);
    if (/^b23\.tv$/i.test(url.hostname) && /(^|\.)bilibili\.com$/i.test(finalURL.hostname)) return bilibili(finalURL, origin);
    if (/(^|\.)(?:youtube\.com|youtu\.be)$/i.test(finalURL.hostname)) {
      const player = assignedJSON(html, /(?:ytInitialPlayerResponse\s*=|["']ytInitialPlayerResponse["']\s*:)\s*\{/);
      const formats = player?.streamingData?.formats?.filter((format) => format.url && format.audioQuality && /^video\//.test(format.mimeType)) || [];
      if (!formats.length) throw new DownloadIssue('该 YouTube 链接需要平台签名、验证或登录，当前未取得可直接下载的音视频文件。');
      const title = player.videoDetails?.title || 'YouTube';
      return { title, files: formats.sort((a, b) => (b.height || 0) - (a.height || 0)).map((format) => ({
        url: format.url, name: cleanName(title) + (/webm/i.test(format.mimeType) ? '.webm' : '.mp4'),
        label: (format.qualityLabel || '视频') + ' · 含音频',
      })) };
    }
    const media = pageMedia(html, finalURL);
    if (!media.files.length) throw new DownloadIssue('页面未提供可直接下载的公开媒体文件。需登录、加密或分片合并的内容暂时无法处理。');
    return { title: media.title || finalURL.hostname, files: media.files.map((file, index) => {
      let extension = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(file.url)?.[1];
      extension ||= MIME_TYPES[file.mime] || 'mp4';
      const label = [file.label === '媒体文件' ? '' : file.label, extension.toUpperCase(),
        media.files.length > 1 ? '文件 ' + (index + 1) : ''].filter(Boolean).join(' · ');
      return { ...file, label, referer: finalURL.origin + '/',
        name: cleanName(media.title || '媒体') + (media.files.length > 1 ? '-' + (index + 1) : '') + '.' + extension };
    }) };
  }

  function throttle(request) {
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip) return;
    const minute = Math.floor(Date.now() / 60_000);
    const old = budgets.get(ip);
    const count = old?.minute === minute ? old.count + 1 : 1;
    if (budgets.size > 2000) budgets.clear();
    budgets.set(ip, { minute, count });
    if (count > 40) throw new DownloadIssue('操作过于频繁，请稍后再试。', 429);
  }

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/api/resolve' && request.method === 'POST') {
          if ((request.headers.get('origin') && request.headers.get('origin') !== url.origin) ||
            request.headers.get('sec-fetch-site') === 'cross-site') throw new DownloadIssue('请从下载工作台提交链接。', 403);
          throttle(request);
          let body;
          try { body = JSON.parse(await readLimited(request, 12 * 1024)); }
          catch (error) { if (error instanceof DownloadIssue) throw error; throw new DownloadIssue('请求内容无效。', 400); }
          if (typeof body.url !== 'string' || !['auto', 'direct'].includes(body.mode || 'auto')) throw new DownloadIssue('下载链接或模式无效。', 400);
          const resolved = await resolve(body.url, body.mode || 'auto', url.origin);
          const files = await Promise.all(resolved.files.slice(0, 12).map(async (file) => ({
            name: cleanName(file.name), label: file.label || '媒体文件',
            href: '/api/download?t=' + await issueTicket(file, env.DOWNLOAD_SIGNING_KEY, url.origin),
          })));
          return Response.json({ title: resolved.title, files }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (url.pathname === '/api/download' && ['GET', 'HEAD'].includes(request.method)) {
          const file = await readTicket(url.searchParams.get('t'), env.DOWNLOAD_SIGNING_KEY, url.origin);
          const checking = url.searchParams.get('check') === '1' || request.method === 'HEAD';
          const range = checking ? 'bytes=0-0' : request.headers.get('range') || '';
          if (range && !/^bytes=\d*-\d*$/.test(range)) throw new DownloadIssue('不支持该下载范围。', 416);
          const { response } = await fetchSource(file.url, url.origin, { referer: file.referer || '', range, signal: request.signal });
          if (!file.allowHTML && /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel();
            throw new DownloadIssue('源站返回了网页或登录验证页，无法下载该媒体文件。');
          }
          if (checking) {
            await response.body?.cancel();
            return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
          }
          const headers = new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': "attachment; filename=\"omniget-download\"; filename*=UTF-8''" + encodeURIComponent(cleanName(file.name)),
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          });
          for (const name of ['content-range', 'accept-ranges', 'content-length', 'last-modified', 'etag']) {
            if (response.headers.has(name) && !response.headers.has('content-encoding')) headers.set(name, response.headers.get(name));
          }
          return new Response(response.body, { status: response.status, headers });
        }
        if (url.pathname.startsWith('/api/')) throw new DownloadIssue('接口或请求方式不存在。', 404);
        if (!['GET', 'HEAD'].includes(request.method)) throw new DownloadIssue('不支持该请求方式。', 405);
        return assetResponse(assets, url.pathname === '/' ? '/index.html' : url.pathname, request.method === 'HEAD') ||
          new Response('页面不存在', { status: 404 });
      } catch (error) {
        if (!(error instanceof DownloadIssue)) {
          console.error('download_service_error', error.name,
            String(error.message).replace(/https?:\/\/\S+/gi, '[source]').slice(0, 160));
        }
        const message = error instanceof DownloadIssue ? error.message : '解析服务暂时不可用，请稍后重试。';
        return Response.json({ error: message }, { status: error instanceof DownloadIssue ? error.status : 502,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
    },
  };
}
