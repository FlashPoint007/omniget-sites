import { detectSupportedMediaUrl } from './detect.mjs';

const FILE_EXTENSION = /\.(?:7z|aac|apk|appimage|ass|avi|avif|bin|csv|deb|dmg|docx?|epub|exe|flac|gif|gz|iso|jpe?g|json|m4a|m4v|mkv|mov|mp3|mp4|msi|ogg|opus|pdf|png|pptx?|rar|rpm|srt|svg|tar|torrent|ts|txt|vtt|wav|webm|webp|xlsx?|zip)$/i;
const MANIFEST_EXTENSION = /\.(?:m3u8?|mpd)$/i;
const WEB_PREFIX = /^https?:\/\//i;
const MAGNET_PREFIX = /^magnet:\?/i;
const MAX_LINK_LENGTH = 8192;

const PLATFORMS = {
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter: 'X / Twitter',
  reddit: 'Reddit',
  twitch: 'Twitch',
  vimeo: 'Vimeo',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
  telegram: 'Telegram',
  hotmart: 'Hotmart',
  udemy: 'Udemy',
};

export const ROUTE_LABELS = { direct: '浏览器下载', desktop: '本机 OmniGet', plugin: '桌面插件' };

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function safeFilename(value) {
  const name = String(value || '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^[ .]+|[ .]+$/g, '').slice(0, 180);
  return name || 'omniget-download';
}

function candidateFromLine(line) {
  if (/^(?:https?:\/\/|magnet:\?)[^\s<>"“”「」]+$/i.test(line)) return line;
  const candidates = line.match(/(?:https?:\/\/|magnet:\?)[^\s<>"“”「」]+/gi);
  if (candidates?.length !== 1) return null;
  return candidates[0].replace(/[，。；！？、）】》』)\]]+$/u, '');
}

export function readLink(line, mode = 'auto') {
  const value = candidateFromLine(line.trim());
  if (!value || value.length > MAX_LINK_LENGTH || /[\x00-\x1f\x7f\\]/.test(value)) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (MAGNET_PREFIX.test(value)) {
    const validHash = parsed.searchParams.getAll('xt').some((hash) =>
      /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(hash) ||
      /^urn:btmh:1220[0-9a-f]{64}$/i.test(hash));
    if (!validHash || mode !== 'desktop') return null;
    return {
      url: 'magnet:' + parsed.href.slice(7),
      route: 'desktop',
      platform: 'BitTorrent',
      title: parsed.searchParams.get('dn')?.trim().slice(0, 160) || '磁力链接',
      source: '磁力链接',
    };
  }

  if (!WEB_PREFIX.test(value) || parsed.username || parsed.password) return null;
  const url = parsed.href;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const media = detectSupportedMediaUrl(url);
  const isCourse = media?.platform === 'udemy' || media?.platform === 'hotmart';
  const plugin = isCourse ? 'Courses' : media?.platform === 'telegram' ? 'Telegram' : '';
  const path = decoded(parsed.pathname);
  const segment = path.split('/').filter(Boolean).at(-1) || '';
  const filename = safeFilename(segment);
  const looksLikeFile = FILE_EXTENSION.test(path);
  const manifest = MANIFEST_EXTENSION.test(path);
  let route = mode === 'desktop' ? 'desktop' : 'direct';
  if (plugin && mode === 'desktop') route = 'plugin';

  const platform = PLATFORMS[media?.platform] || (looksLikeFile || mode === 'direct' ? 'HTTP 文件' : manifest ? 'HLS / DASH' : '');
  const mediaId = media?.platform === 'youtube'
    ? parsed.searchParams.get('v') || parsed.searchParams.get('list') || segment
    : segment;
  const pageTitle = [platform || hostname, mediaId.slice(0, 100)].filter(Boolean).join(' · ');
  return {
    url,
    route,
    plugin,
    platform,
    source: hostname,
    title: looksLikeFile || manifest || (mode === 'direct' && segment) ? filename : pageTitle,
    filename,
  };
}

export function parseLines(input, mode, limit) {
  const lines = input.split(/\r\n|\n|\r/).map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.trim());
  if (lines.length > limit) return { links: [], invalid: [], overLimit: true };
  const links = [];
  const invalid = [];
  for (const { line, n } of lines) {
    const link = readLink(line, mode);
    if (link) links.push(link);
    else invalid.push(n);
  }
  return { links, invalid, overLimit: false };
}

export function desktopScheme(url) {
  // Mirrors upstream send-via-scheme for HTTPS/magnet; preserves an explicit
  // HTTP scheme with the opaque syntax supported by normalize_external_url.
  return url.startsWith('https://') ? 'omniget://' + url.slice(8) : 'omniget:' + url;
}

// Adapted from src/lib/download-format.ts in OpenSelena/omniget.
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}
