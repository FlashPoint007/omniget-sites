const RELEASE_URL = 'https://github.com/OpenSelena/omniget/releases';
const API_URL = 'https://api.github.com/repos/OpenSelena/omniget/releases/latest';

const BUILDS = {
  windows: [
    [/x64-setup\.exe$/i, 'Windows x64 · 安装版'],
    [/x64-portable\.exe$/i, 'Windows x64 · 便携版'],
    [/x64.*\.msi$/i, 'Windows x64 · MSI'],
    [/arm64-setup\.exe$/i, 'Windows ARM64 · 安装版'],
    [/arm64-portable\.exe$/i, 'Windows ARM64 · 便携版'],
    [/arm64.*\.msi$/i, 'Windows ARM64 · MSI'],
  ],
  macos: [
    [/(?:aarch64|arm64)\.dmg$/i, 'macOS · Apple Silicon'],
    [/(?:x64|x86_64)\.dmg$/i, 'macOS · Intel'],
    [/universal\.dmg$/i, 'macOS · Universal'],
  ],
  linux: [
    [/amd64\.deb$/i, 'Debian / Ubuntu · x64'],
    [/arm64\.deb$/i, 'Debian / Ubuntu · ARM64'],
    [/x86_64\.rpm$/i, 'Fedora / openSUSE · x64'],
    [/aarch64\.rpm$/i, 'Fedora / openSUSE · ARM64'],
    [/(?:amd64|x86_64)\.AppImage$/i, 'AppImage · x64'],
    [/(?:aarch64|arm64)\.AppImage$/i, 'AppImage · ARM64'],
  ],
};

function normalize(data) {
  const tag = data.tag || data.tag_name;
  if (!/^v?\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*)$/.test(tag)) throw new Error('Invalid release tag');
  const assets = (Array.isArray(data.assets) ? data.assets : []).flatMap((asset) => {
    const url = asset.url || asset.browser_download_url;
    // In GitHub's REST response asset.url is the API URL; prefer the download URL.
    const download = asset.browser_download_url || url;
    if (!/^[a-z0-9_.-]{1,140}$/i.test(asset.name) ||
      download !== RELEASE_URL + '/download/' + tag + '/' + asset.name ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0) return [];
    const digest = /^sha256:[0-9a-f]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7) : '';
    return [{ name: asset.name, url: download, size: asset.size, digest }];
  });
  if (!assets.length) throw new Error('Release has no supported assets');
  return { tag, url: RELEASE_URL + '/tag/' + tag, assets };
}

export async function fetchRelease(local) {
  const url = local ? new URL('../assets/releases.json', import.meta.url) : API_URL;
  const response = await fetch(url, {
    credentials: local ? 'same-origin' : 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new Error('Release data unavailable');
  return normalize(await response.json());
}

export function assetsFor(release, os) {
  return BUILDS[os].flatMap(([match, label]) => {
    const asset = release.assets.find(({ name }) => match.test(name));
    return asset ? [{ ...asset, label }] : [];
  });
}
