// Bilibili's public WBI query-signing protocol. The permutation is documented
// by the site's web player and yt-dlp/extractor/bilibili.py (Unlicense).
const WBI_PERMUTATION = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32));

// MD5 is required by WBI. Download tickets continue to use HMAC-SHA256.
export function wbiMD5(text) {
  const input = new TextEncoder().encode(text);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, (input.length * 8) >>> 0, true);
  view.setUint32(bytes.length - 4, Math.floor(input.length / 2 ** 29), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let round = 0; round < 64; round++) {
      let mixed;
      let word;
      if (round < 16) { mixed = (b & c) | (~b & d); word = round; }
      else if (round < 32) { mixed = (d & b) | (~d & c); word = (5 * round + 1) % 16; }
      else if (round < 48) { mixed = b ^ c ^ d; word = (3 * round + 5) % 16; }
      else { mixed = c ^ (b | ~d); word = (7 * round) % 16; }
      const sum = (a + mixed + MD5_CONSTANTS[round] + view.getUint32(offset + word * 4, true)) | 0;
      const shift = MD5_SHIFTS[round];
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      [a, b, c, d] = [d, (b + rotated) | 0, b, c];
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
  }
  return state.flatMap((word) => [0, 8, 16, 24].map((shift) =>
    ((word >>> shift) & 0xff).toString(16).padStart(2, '0'))).join('');
}

export function wbiMixin(imgKey, subKey) {
  if (![imgKey, subKey].every((key) => /^[a-f0-9]{32}$/i.test(key || ''))) return null;
  const keys = imgKey + subKey;
  return WBI_PERMUTATION.map((index) => keys[index]).join('').slice(0, 32);
}

export function signBilibiliQuery(parameters, mixin, timestamp = Math.floor(Date.now() / 1000)) {
  const values = { ...parameters, wts: timestamp };
  const query = Object.keys(values).sort().map((key) => {
    const value = String(values[key]).replace(/[!'()*]/g, '');
    return encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }).join('&');
  return query + '&w_rid=' + wbiMD5(query + mixin);
}
