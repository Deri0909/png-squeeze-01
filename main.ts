// png-squeeze-01: lossless PNG recompressor, written from scratch in this session.
//
// Strategy per image (1280x720 RGBA):
//   1. Decode the stored input PNG.
//   2. Try every exact re-encoding that applies (palette by frequency and by
//      luminance, each with transparent entries first, when <= 256 colours;
//      grey; grey+alpha; RGB; RGB+tRNS; RGBA), each with several per-row
//      filter strategies (fixed 0, 2, 4, minimum signed sum, and a
//      brute-force per-row deflate trial on the best-screened candidates).
//      Screen with zlib level 6, weighing each form's PLTE/tRNS bytes.
//   3. Recompress the winner with zlib level 9 (default / huffman-only /
//      fixed strategies) and with a custom optimal-parse deflate written
//      here (hash-chain lazy parse, dynamic Huffman lengths, up to three
//      shortest-path DP re-parses under rebuilt tables, dynamic or fixed
//      blocks, 256 KiB blocks). Keep the smallest stream that inflates
//      back exactly.
//   4. Write a minimal PNG (IHDR/PLTE/tRNS/IDAT/IEND only, bit depth 8).
//
// Node 22 stdlib only, no network, no clock, deterministic: the same input
// always produces the same bytes. All work is budgeted by data size, never
// by wall time.
import { inflateSync, deflateRawSync, deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;
const NPIX = W * H;

// ---------------------------------------------------------------- CRC / Adler
const CRC_TAB = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; ) {
    const end = Math.min(buf.length, i + 5552);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ------------------------------------------------------------ PNG containers
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHAN = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function pngOf(chunks) {
  let size = 8;
  for (const c of chunks) size += 12 + c[1].length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = 8;
  for (const c of chunks) {
    v.setUint32(at, c[1].length);
    out[at + 4] = c[0].charCodeAt(0);
    out[at + 5] = c[0].charCodeAt(1);
    out[at + 6] = c[0].charCodeAt(2);
    out[at + 7] = c[0].charCodeAt(3);
    out.set(c[1], at + 8);
    v.setUint32(at + 8 + c[1].length, crc32(out, at + 4, at + 8 + c[1].length));
    at += 12 + c[1].length;
  }
  return out;
}
function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode any PNG the contest reads into RGBA (4 bytes per pixel).
function decodePng(bytes) {
  if (bytes.length < 8) throw new Error('short file');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], ct: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unsupported chunk ' + type);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete png');
  const { width, height, ct } = header;
  const bpp = CHAN[ct];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (ct === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e]; rgba[d + 1] = palette[e + 1]; rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------ row filtering
// Filter one row (cur, stride samples, bpp bytes per pixel, prev row or null)
// with filter type t into out. Returns nothing; out is reused scratch.
function filterRowInto(t, cur, prev, bpp, out) {
  const n = cur.length;
  if (t === 0) { out.set(cur); return; }
  if (t === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
    return;
  }
  if (t === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
    return;
  }
  if (t === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
// ------------------------------------------------------- candidate encodings
// A candidate: colour type, sample bytes (height rows of width*bpp), bpp,
// optional PLTE bytes and tRNS bytes.
function buildCandidates(rgba) {
  const cands = [];
  const n = NPIX;
  // Colour statistics in one pass.
  let allOpaque = true;
  let allGrey = true;
  const uniq = new Map(); // rgba32 -> count
  let transRgb = -1; // single RGB value seen with alpha 0, or -2 if several
  let transGrey = -1;
  let transCount = 0;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) {
      allOpaque = false;
      transCount++;
      const rgb = (r << 16) | (g << 8) | b;
      if (transRgb === -1) transRgb = rgb;
      else if (transRgb !== rgb) transRgb = -2;
      if (r === g && g === b) {
        if (transGrey === -1) transGrey = r;
        else if (transGrey !== r) transGrey = -2;
      } else transGrey = -2;
    }
    if (r !== g || g !== b) allGrey = false;
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    uniq.set(key, (uniq.get(key) || 0) + 1);
  }

  // RGBA always works.
  cands.push({ ct: 6, samples: rgba, bpp: 4, plte: null, trns: null });

  if (allOpaque) {
    // RGB, no alpha channel at all.
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgb[s] = rgba[d]; rgb[s + 1] = rgba[d + 1]; rgb[s + 2] = rgba[d + 2];
    }
    cands.push({ ct: 2, samples: rgb, bpp: 3, plte: null, trns: null });
  } else if (transRgb >= 0) {
    // Exactly one RGB value is transparent, and no opaque pixel shares it
    // (checked below): RGB + tRNS key.
    let ok = true;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const rgb = (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
      if (rgb === transRgb && rgba[d + 3] !== 0) { ok = false; break; }
    }
    if (ok) {
      const rgb = new Uint8Array(n * 3);
      for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
        rgb[s] = rgba[d]; rgb[s + 1] = rgba[d + 1]; rgb[s + 2] = rgba[d + 2];
      }
      const trns = new Uint8Array(6);
      trns[1] = (transRgb >> 16) & 255; trns[3] = (transRgb >> 8) & 255; trns[5] = transRgb & 255;
      cands.push({ ct: 2, samples: rgb, bpp: 3, plte: null, trns });
    }
  }

  if (allGrey) {
    if (allOpaque) {
      const grey = new Uint8Array(n);
      for (let i = 0; i < n; i++) grey[i] = rgba[i * 4];
      cands.push({ ct: 0, samples: grey, bpp: 1, plte: null, trns: null });
    } else if (transGrey >= 0) {
      let ok = true;
      for (let i = 0; i < n; i++) if (rgba[i * 4] === transGrey && rgba[i * 4 + 3] !== 0) { ok = false; break; }
      if (ok) {
        const grey = new Uint8Array(n);
        for (let i = 0; i < n; i++) grey[i] = rgba[i * 4];
        const trns = new Uint8Array(2);
        trns[1] = transGrey;
        cands.push({ ct: 0, samples: grey, bpp: 1, plte: null, trns });
      }
    }
    const ga = new Uint8Array(n * 2);
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      ga[s] = rgba[d]; ga[s + 1] = rgba[d + 3];
    }
    cands.push({ ct: 4, samples: ga, bpp: 2, plte: null, trns: null });
  }

  // Palette when the image holds at most 256 distinct RGBA colours.
  if (uniq.size <= 256) {
    const entries = [...uniq.entries()]; // [rgba32, count]
    const lumOf = (key) => ((key >>> 24) & 255) * 3 + ((key >>> 16) & 255) * 6 + ((key >>> 8) & 255);
    // Transparent entries first (by alpha) so tRNS is short, as the
    // reference does; then by the order's own key.
    const transparentFirst = (arr, keyFn) => arr.slice().sort((x, y) => {
      const tx = (x[0] & 255) === 255 ? 1 : 0;
      const ty = (y[0] & 255) === 255 ? 1 : 0;
      if (tx !== ty) return tx - ty;
      if (tx === 0 && (x[0] & 255) !== (y[0] & 255)) return (x[0] & 255) - (y[0] & 255);
      return keyFn(x, y);
    });
    const orders = [];
    orders.push(entries.slice().sort((x, y) => y[1] - x[1]));
    orders.push(transparentFirst(entries, (x, y) => y[1] - x[1]));
    orders.push(entries.slice().sort((x, y) => lumOf(x[0]) - lumOf(y[0]) || y[1] - x[1]));
    orders.push(transparentFirst(entries, (x, y) => lumOf(x[0]) - lumOf(y[0]) || y[1] - x[1]));
    for (const order of orders) {
      const m = order.length;
      const plte = new Uint8Array(m * 3);
      const trnsFull = new Uint8Array(m);
      let needTrns = false;
      const index = new Map();
      for (let e = 0; e < m; e++) {
        const key = order[e][0];
        index.set(key, e);
        plte[e * 3] = (key >>> 24) & 255;
        plte[e * 3 + 1] = (key >>> 16) & 255;
        plte[e * 3 + 2] = (key >>> 8) & 255;
        trnsFull[e] = key & 255;
        if ((key & 255) !== 255) needTrns = true;
      }
      const idx = new Uint8Array(n);
      for (let i = 0, d = 0; i < n; i++, d += 4) {
        const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
        idx[i] = index.get(key);
      }
      let trns = null;
      if (needTrns) {
        // Trim trailing opaque entries: tRNS may be shorter than the palette.
        let last = m - 1;
        while (last > 0 && trnsFull[last] === 255) last--;
        trns = trnsFull.subarray(0, last + 1);
      }
      cands.push({ ct: 3, samples: idx, bpp: 1, plte, trns });
    }
  }
  return cands;
}

// ---------------------------------------------------------- filter strategies
// Assemble the filtered raw bytes of one candidate under one strategy.
// strategy: 0..4 fixed filter; 5 minsum; 7 brute (per-row isolated
// deflate). rows: five reusable row buffers (one per filter type).
function assembleFiltered(cand, strategy, rows) {
  const { samples, bpp } = cand;
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  // Trial rows with their filter byte, reused across rows (brute force).
  const trials = strategy === 7
    ? Array.from({ length: 5 }, (_, t) => { const r = new Uint8Array(stride + 1); r[0] = t; return r; })
    : null;
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const out = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    let type;
    if (strategy <= 4) {
      type = strategy;
      filterRowInto(type, cur, prev, bpp, out);
    } else {
      for (let t = 0; t < 5; t++) filterRowInto(t, cur, prev, bpp, rows[t]);
      if (strategy === 5) {
        let best = Infinity;
        type = 0;
        for (let t = 0; t < 5; t++) {
          const s = signedSum(rows[t].subarray(0, stride));
          if (s < best) { best = s; type = t; }
        }
      } else {
        // Context-aware brute: each filter trial compressed after the 32 KiB
        // already written (as a zlib dictionary), level 4 — the marginal
        // cost of this row given what precedes it. The trial includes its
        // filter byte, as the reference's screen does.
        const at = y * (stride + 1);
        const before = raw.subarray(Math.max(0, at - 32768), at);
        let best = Infinity;
        type = 0;
        for (let t = 0; t < 5; t++) {
          trials[t].set(rows[t].subarray(0, stride), 1);
          const opts = before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before };
          const z = deflateSync(trials[t], opts).length;
          if (z < best) { best = z; type = t; }
        }
      }
      out.set(rows[type].subarray(0, stride));
    }
    raw[y * (stride + 1)] = type;
  }
  return raw;
}

function deflateLevel(raw, level, strategy, memLevel = 8) {
  return deflateRawSync(raw, { level, strategy, memLevel });
}
function zlibWrap(rawDeflate, raw) {
  const out = new Uint8Array(2 + rawDeflate.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(rawDeflate, 2);
  const v = new DataView(out.buffer);
  v.setUint32(2 + rawDeflate.length, adler32(raw));
  return out;
}

// ------------------------------------------------------------ Huffman helpers
// Deflate length / distance symbol tables (RFC 1951).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenSymbol(len) {
  // Longest base <= len, with 258 handled by symbol 285.
  if (len === 258) return 285;
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return 257 + lo;
}
function distSymbol(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Length-limited Huffman code lengths from frequencies, maxLen 15 (or 7).
// Builds a Huffman tree by repeated smallest-pair selection, then applies
// zlib's overflow fix when any depth exceeds maxLen, then reassigns lengths
// by frequency order. Returns Uint8Array lengths (0 = unused).
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const len = new Uint8Array(n);
  // Collect used symbols.
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return len;
  if (used.length === 1) { len[used[0]] = 1; return len; }
  // Tree nodes: leaves are symbol indexes; internal nodes hold combined freq.
  // depth[i] = depth of leaf i in the tree. Build by merging smallest pairs.
  const depth = new Uint8Array(n);
  // Working list of (freq, tiebreak, leafSet). Use simple arrays; n <= 286.
  let nodes = used.map((s) => ({ f: freq[s], leaves: [s] }));
  // Tie-break: zlib favours smaller depth; here freq only, stable by symbol.
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.f - b.f || a.leaves[0] - b.leaves[0]);
    const a = nodes.shift();
    const b = nodes.shift();
    for (const s of a.leaves) depth[s]++;
    for (const s of b.leaves) depth[s]++;
    nodes.push({ f: a.f + b.f, leaves: a.leaves.concat(b.leaves) });
  }
  // Count lengths and fix overflow (zlib gen_bitlen method).
  const blCount = new Int32Array(maxLen + 1);
  let overflow = 0;
  for (const s of used) {
    if (depth[s] > maxLen) { overflow++; blCount[maxLen]++; }
    else blCount[depth[s]]++;
  }
  if (overflow > 0) {
    // overflow counts codes longer than maxLen; the fix moves pairs up.
    do {
      let bits = maxLen - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxLen]--;
      overflow -= 2;
    } while (overflow > 0);
    // Reassign: shortest lengths to the most frequent symbols.
    const order = used.slice().sort((a, b) => freq[b] - freq[a] || a - b);
    let k = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      for (let j = 0; j < blCount[bits]; j++) len[order[k++]] = bits;
    }
  } else {
    for (const s of used) len[s] = depth[s];
  }
  return len;
}

// Canonical Huffman codes from lengths: returns {codes, lengths} where
// codes[s] is the bit-reversed code value ready for LSB-first output.
function canonicalCodes(lengths) {
  const n = lengths.length;
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l === 0) continue;
    // Reverse the bits of nextCode[l] (MSB-first code -> LSB-first output).
    let c = nextCode[l]++;
    let rev = 0;
    for (let j = 0; j < l; j++) { rev = (rev << 1) | (c & 1); c >>= 1; }
    codes[i] = rev;
  }
  return { codes, lengths, maxLen };
}

// Fixed Huffman tables (RFC 1951).
const FIXED_LIT = (() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return canonicalCodes(lengths);
})();
const FIXED_DIST = (() => {
  const lengths = new Uint8Array(30);
  lengths.fill(5);
  return canonicalCodes(lengths);
})();

// --------------------------------------------------------------- bit writer
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.at = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  // Total bits written so far (flushed bytes + pending bits).
  bits() {
    return this.at * 8 + this.bitCnt;
  }
  writeBits(value, count) {
    this.bitBuf |= value << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      if (this.at >= this.buf.length) this.grow();
      this.buf[this.at++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  // Append exactly `bits` bits from `src` (whose bytes hold them LSB-first).
  // Bit-contiguous: the appended bits continue at the current bit position.
  appendBits(src, bits) {
    const full = Math.floor(bits / 8);
    for (let i = 0; i < full; i++) this.writeBits(src[i], 8);
    const rem = bits % 8;
    if (rem > 0) this.writeBits(src[full] & ((1 << rem) - 1), rem);
  }
  grow() {
    const nb = new Uint8Array(this.buf.length * 2);
    nb.set(this.buf);
    this.buf = nb;
  }
  finish() {
    if (this.bitCnt > 0) {
      if (this.at >= this.buf.length) this.grow();
      this.buf[this.at++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return this.buf.subarray(0, this.at);
  }
}

// ------------------------------------------------------------- LZ77 matching
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const MAX_DIST = 32768;
const MAX_LEN = 258;
class MatchFinder {
  constructor(data, n) {
    this.d = data;
    this.n = n;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(n).fill(-1);
  }
  hashAt(i) {
    const d = this.d;
    return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK);
  }
  insert(pos) {
    if (pos + 2 >= this.n) return;
    const h = this.hashAt(pos);
    this.prev[pos] = this.head[h];
    this.head[h] = pos;
  }
  // Longest match at pos; candidates are positions < pos. Returns {len, dist}.
  longest(pos, maxChain) {
    const d = this.d;
    const n = this.n;
    if (pos + 2 >= n) return { len: 0, dist: 0 };
    const maxLen = Math.min(MAX_LEN, n - pos);
    let bestLen = 0;
    let bestDist = 0;
    let cand = this.head[this.hashAt(pos)];
    let chain = 0;
    while (cand >= 0 && chain < maxChain) {
      chain++;
      const dist = pos - cand;
      if (dist > MAX_DIST) break;
      // Quick reject on the byte past the current best length.
      if (bestLen > 0 && d[cand + bestLen] !== d[pos + bestLen]) {
        cand = this.prev[cand];
        continue;
      }
      let len = 0;
      while (len < maxLen && d[cand + len] === d[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = dist;
        if (len >= maxLen) break;
      }
      cand = this.prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  }
  // Pareto-optimal (len, dist) candidates: strictly increasing lengths.
  pareto(pos, maxChain, outLen, outDist) {
    const d = this.d;
    const n = this.n;
    let count = 0;
    if (pos + 2 >= n) return 0;
    const maxLen = Math.min(MAX_LEN, n - pos);
    let bestLen = 2;
    let cand = this.head[this.hashAt(pos)];
    let chain = 0;
    while (cand >= 0 && chain < maxChain && count < 6) {
      chain++;
      const dist = pos - cand;
      if (dist > MAX_DIST) break;
      if (bestLen > 2 && d[cand + bestLen] !== d[pos + bestLen]) {
        cand = this.prev[cand];
        continue;
      }
      let len = 0;
      while (len < maxLen && d[cand + len] === d[pos + len]) len++;
      if (len > bestLen) {
        outLen[count] = len;
        outDist[count] = dist;
        count++;
        bestLen = len;
        if (len >= maxLen) break;
      }
      cand = this.prev[cand];
    }
    return count;
  }
}

// Tokens: Int32Array; literal = byte 0..255; match = (1<<25) | (len<<16) | dist
// (len <= 258 needs bits 16..24, dist <= 32768 needs bits 0..15: no overlap).
function lazyParse(data, n) {
  const finder = new MatchFinder(data, n);
  const toks = [];
  let i = 0;
  let pending = null; // {pos, len, dist}
  while (i < n) {
    const m = i + 2 < n ? finder.longest(i, 256) : { len: 0, dist: 0 };
    finder.insert(i);
    if (pending !== null && pending.len >= 3 && m.len <= pending.len) {
      toks.push((1 << 25) | (pending.len << 16) | pending.dist);
      for (let k = i + 1; k < pending.pos + pending.len; k++) finder.insert(k);
      i = pending.pos + pending.len;
      pending = null;
    } else {
      if (pending !== null) toks.push(data[pending.pos]);
      else if (m.len < 3) toks.push(data[i]);
      pending = m.len >= 3 ? { pos: i, len: m.len, dist: m.dist } : null;
      i++;
    }
  }
  if (pending !== null) toks.push((1 << 25) | (pending.len << 16) | pending.dist);
  return toks;
}

function tokenFrequencies(toks) {
  const litFreq = new Int32Array(286);
  const distFreq = new Int32Array(30);
  for (const t of toks) {
    if (t < 256) litFreq[t]++;
    else {
      const len = (t >>> 16) & 0x1ff;
      const dist = t & 0xffff;
      litFreq[lenSymbol(len)]++;
      distFreq[distSymbol(dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// Shortest-path DP re-parse with bit costs from the given code lengths.
function dpParse(data, n, litLen, distLen) {
  // Symbols unused in the first pass have length 0; they are not free —
  // price them at the maximum length so the DP cannot cheat with them.
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : 15;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const s = lenSymbol(l);
    lenCost[l] = (litLen[s] > 0 ? litLen[s] : 15) + LEN_EXTRA[s - 257];
  }
  const distCost = new Float64Array(MAX_DIST + 1);
  for (let dd = 1; dd <= MAX_DIST; dd++) {
    const s = distSymbol(dd);
    distCost[dd] = (distLen[s] > 0 ? distLen[s] : 15) + DIST_EXTRA[s];
  }
  const cost = new Float64Array(n + 1).fill(Infinity);
  cost[0] = 0;
  const prevPos = new Int32Array(n + 1);
  const choiceLen = new Uint16Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  const finder = new MatchFinder(data, n);
  const pLen = new Int32Array(6);
  const pDist = new Int32Array(6);
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) { finder.insert(i); continue; }
    const nc = finder.pareto(i, 32, pLen, pDist);
    finder.insert(i);
    // Literal.
    const lc = ci + litCost[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      prevPos[i + 1] = i;
      choiceLen[i + 1] = 0;
    }
    for (let k = 0; k < nc; k++) {
      const len = pLen[k];
      const dist = pDist[k];
      const mc = ci + lenCost[len] + distCost[dist];
      const j = i + len;
      if (mc < cost[j]) {
        cost[j] = mc;
        prevPos[j] = i;
        choiceLen[j] = len;
        choiceDist[j] = dist;
      }
    }
  }
  // Reconstruct tokens backwards.
  const toks = [];
  let j = n;
  while (j > 0) {
    const i = prevPos[j];
    const len = choiceLen[j];
    if (len === 0) toks.push(data[i]);
    else toks.push((1 << 25) | (len << 16) | choiceDist[j]);
    j = i;
  }
  toks.reverse();
  return toks;
}

// ------------------------------------------------------------ block emission
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitTokens(bw, toks, litCodes, distCodes) {
  for (const t of toks) {
    if (t < 256) {
      bw.writeBits(litCodes.codes[t], litCodes.lengths[t]);
    } else {
      const len = (t >>> 16) & 0x1ff;
      const dist = t & 0xffff;
      const ls = lenSymbol(len);
      bw.writeBits(litCodes.codes[ls], litCodes.lengths[ls]);
      const le = LEN_EXTRA[ls - 257];
      if (le > 0) bw.writeBits(len - LEN_BASE[ls - 257], le);
      const ds = distSymbol(dist);
      bw.writeBits(distCodes.codes[ds], distCodes.lengths[ds]);
      const de = DIST_EXTRA[ds];
      if (de > 0) bw.writeBits(dist - DIST_BASE[ds], de);
    }
  }
  bw.writeBits(litCodes.codes[256], litCodes.lengths[256]);
}

// RLE-encode the code-length sequence; returns [symbols, extras, extraBits].
function rleCodeLengths(lens) {
  const syms = [];
  const extras = [];
  const ebits = [];
  let i = 0;
  const n = lens.length;
  while (i < n) {
    const v = lens[i];
    if (v === 0) {
      let run = 0;
      while (i + run < n && lens[i + run] === 0) run++;
      i += run;
      while (run >= 11) {
        const take = Math.min(run, 138);
        syms.push(18); extras.push(take - 11); ebits.push(7);
        run -= take;
      }
      if (run >= 3) {
        syms.push(17); extras.push(run - 3); ebits.push(3);
        run = 0;
      }
      while (run > 0) { syms.push(0); extras.push(0); ebits.push(0); run--; }
    } else {
      syms.push(v); extras.push(0); ebits.push(0);
      i++;
      let run = 0;
      while (i + run < n && lens[i + run] === v) run++;
      i += run;
      while (run >= 3) {
        const take = Math.min(run, 6);
        syms.push(16); extras.push(take - 3); ebits.push(2);
        run -= take;
      }
      while (run > 0) { syms.push(v); extras.push(0); ebits.push(0); run--; }
    }
  }
  return { syms, extras, ebits };
}

function emitDynamicBlock(bw, isFinal, toks, litLen, distLen) {
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2); // dynamic
  let litCount = 257;
  for (let s = 286 - 1; s >= 257; s--) if (litLen[s] > 0) { litCount = s + 1; break; }
  let distCount = 1;
  for (let s = 29; s >= 0; s--) if (distLen[s] > 0) { distCount = s + 1; break; }
  const allLens = new Uint8Array(litCount + distCount);
  allLens.set(litLen.subarray(0, litCount), 0);
  allLens.set(distLen.subarray(0, distCount), litCount);
  const rle = rleCodeLengths(allLens);
  const clFreq = new Int32Array(19);
  for (const s of rle.syms) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLen);
  let hclen = 0;
  for (let k = 0; k < 19; k++) if (clLen[CL_ORDER[k]] > 0) hclen = k;
  hclen = Math.max(0, hclen - 3);
  bw.writeBits(litCount - 257, 5);
  bw.writeBits(distCount - 1, 5);
  bw.writeBits(hclen, 4);
  for (let k = 0; k < hclen + 4; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < rle.syms.length; k++) {
    const s = rle.syms[k];
    bw.writeBits(clCodes.codes[s], clCodes.lengths[s]);
    if (rle.ebits[k] > 0) bw.writeBits(rle.extras[k], rle.ebits[k]);
  }
  emitTokens(bw, toks, litCodes, distCodes);
}

function emitFixedBlock(bw, isFinal, toks) {
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(1, 2); // fixed
  emitTokens(bw, toks, FIXED_LIT, FIXED_DIST);
}

// Compress one block of filtered bytes with the custom deflate.
// Returns {bytes, bits}: the raw deflate bytes of the block and how many of
// their bits are real (the last byte may hold zero padding past `bits`).
// rounds: 1 = lazy parse + one DP re-parse; each further round is another
// DP re-parse under rebuilt tables (zopfli-style iteration).
function customDeflateBlock(data, isFinal, rounds) {
  const n = data.length;
  if (n === 0) {
    const bw = new BitWriter(8);
    bw.writeBits(isFinal ? 1 : 0, 1);
    bw.writeBits(1, 2);
    bw.writeBits(FIXED_LIT.codes[256], FIXED_LIT.lengths[256]);
    const bits = bw.bits();
    return { bytes: bw.finish(), bits };
  }
  const toks1 = lazyParse(data, n);
  const f1 = tokenFrequencies(toks1);
  // The distance alphabet needs at least one used symbol for a valid header.
  if (f1.distFreq.every((v) => v === 0)) f1.distFreq[0] = 1;
  const litLen1 = huffmanLengths(f1.litFreq, 15);
  const distLen1 = huffmanLengths(f1.distFreq, 15);
  // Every DP round re-parses under the previous round's tables; each
  // parse is emitted as a dynamic block and the smallest is kept.
  const parses = [];
  let ll = litLen1;
  let dl = distLen1;
  for (let r = 1; r <= rounds; r++) {
    const toks = dpParse(data, n, ll, dl);
    const f = tokenFrequencies(toks);
    if (f.distFreq.every((v) => v === 0)) f.distFreq[0] = 1;
    ll = huffmanLengths(f.litFreq, 15);
    dl = huffmanLengths(f.distFreq, 15);
    parses.push([toks, ll, dl]);
  }
  const toksBest = parses[parses.length - 1][0];
  const cap = Math.max(1024, n);
  // Emit a dynamic block for each parse tried (and a fixed block for the
  // best parse); keep the smallest.
  const candidates = [];
  for (const [toks, l, d] of parses) {
    const bwDyn = new BitWriter(cap);
    emitDynamicBlock(bwDyn, isFinal, toks, l, d);
    const bits = bwDyn.bits();
    candidates.push({ bytes: bwDyn.finish(), bits });
  }
  const bwFix = new BitWriter(cap);
  emitFixedBlock(bwFix, isFinal, toksBest);
  const fixBits = bwFix.bits();
  candidates.push({ bytes: bwFix.finish(), bits: fixBits });
  let bestCand = candidates[0];
  for (const c of candidates) if (c.bits < bestCand.bits) bestCand = c;
  return bestCand;
}

// Compress a whole filtered stream with the custom deflate. All blocks share
// one bit writer: deflate blocks are bit-contiguous, so a block must start
// at the exact bit where the previous one ended, never at a fresh byte.
function customDeflate(raw, rounds) {
  const bw = new BitWriter(Math.max(1024, raw.length));
  for (let at = 0; at < raw.length; at += BLOCK) {
    const block = raw.subarray(at, Math.min(raw.length, at + BLOCK));
    const last = at + BLOCK >= raw.length;
    const part = customDeflateBlock(block, last, rounds);
    bw.appendBits(part.bytes, part.bits);
  }
  return bw.finish();
}

// ----------------------------------------------------------- per-image pipeline
const BLOCK = 262144; // 256 KiB custom-deflate blocks

function compressRaw(raw) {
  // zlib level 9, several strategies; keep the smallest. Strategy 1
  // (filtered) is skipped: it essentially never beats default/fixed here.
  let best = null;
  for (const strategy of [0, 2, 4]) {
    const z = zlibWrap(deflateLevel(raw, 9, strategy), raw);
    if (best === null || z.length < best.length) best = z;
  }
  // Custom optimal-parse deflate, one shared bit stream over all blocks.
  // Round 1 always; if it already beats zlib's best, one further call
  // with 3 DP rounds (which also emits the round-2 parse) and keep the
  // smallest verified stream.
  try {
    const d1 = customDeflate(raw, 1);
    const w1 = zlibWrap(d1, raw);
    let customBest = null;
    if (verifyDeflate(w1, raw)) customBest = w1;
    if (customBest !== null && customBest.length < best.length) {
      const d3 = customDeflate(raw, 3);
      const w3 = zlibWrap(d3, raw);
      if (verifyDeflate(w3, raw) && w3.length < customBest.length) customBest = w3;
    }
    if (customBest !== null && customBest.length < best.length) best = customBest;
  } catch (e) {
    // Any failure in the custom path: keep the zlib result.
  }
  return best;
}

// True when `wrapped` is a zlib stream that inflates to exactly `raw`.
function verifyDeflate(wrapped, raw) {
  let back;
  try {
    back = inflateSync(wrapped);
  } catch (e) {
    return false;
  }
  if (back.length !== raw.length) return false;
  for (let i = 0; i < raw.length; i++) if (back[i] !== raw[i]) return false;
  return true;
}

function processImage(rgba) {
  const cands = buildCandidates(rgba);
  const maxStride = W * 4;
  const rows = Array.from({ length: 5 }, () => new Uint8Array(maxStride));
  // Screen every (candidate, strategy) except brute force by zlib level 6,
  // weighing each form's PLTE and tRNS chunks as the screen does. Keep only
  // each candidate's best raw, so memory stays bounded.
  const perCand = [];
  for (const cand of cands) {
    const chunks = (cand.plte !== null ? 12 + cand.plte.length : 0) + (cand.trns !== null ? 12 + cand.trns.length : 0);
    let b = null;
    // Fixed filters 1 (Sub) and 3 (Average) are screened out: minsum
    // and brute already choose those filters per row when they help, so
    // a fixed 1/3 pass over all rows almost never wins. Minpairs is also
    // skipped: minsum + brute cover its wins and it costs a full extra
    // filter pass per row.
    for (const s of [0, 2, 4, 5]) {
      const raw = assembleFiltered(cand, s, rows);
      const size = deflateLevel(raw, 6, 0).length + chunks;
      if (b === null || size < b.size) b = { cand, raw, size };
    }
    perCand.push(b);
  }
  perCand.sort((a, b) => a.size - b.size);
  let best = perCand[0];
  // Context-aware brute force is the most expensive filter choice, so run
  // it only on the two best-screened candidates, not on every form.
  for (const e of perCand.slice(0, 2)) {
    const cand = e.cand;
    const chunks = (cand.plte !== null ? 12 + cand.plte.length : 0) + (cand.trns !== null ? 12 + cand.trns.length : 0);
    const raw = assembleFiltered(cand, 7, rows);
    const size = deflateLevel(raw, 6, 0).length + chunks;
    if (size < best.size) best = { cand, raw, size };
  }
  const bestRaw = best.raw;
  const bestCand = best.cand;
  const stream = compressRaw(bestRaw);
  const chunks = [['IHDR', ihdr(W, H, bestCand.ct)]];
  if (bestCand.plte !== null) chunks.push(['PLTE', bestCand.plte]);
  if (bestCand.trns !== null) chunks.push(['tRNS', bestCand.trns]);
  chunks.push(['IDAT', stream]);
  chunks.push(['IEND', new Uint8Array(0)]);
  const png = pngOf(chunks);
  // Verify the final PNG decodes to exactly the input image.
  const back = decodePng(png);
  if (back.width !== W || back.height !== H) throw new Error('size mismatch after encode');
  for (let i = 0; i < rgba.length; i++) if (back.rgba[i] !== rgba[i]) throw new Error('pixel mismatch after encode');
  return png;
}

// ------------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const inFile = join(I, id, 'image.png');
  const outDir = join(O, id);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'image.png');
  try {
    const bytes = readFileSync(inFile);
    const { rgba } = decodePng(bytes);
    writeFileSync(outFile, processImage(rgba));
  } catch (e) {
    // Never leave an instance unanswered: fall back to the stored input PNG.
    writeFileSync(outFile, readFileSync(inFile));
  }
}
