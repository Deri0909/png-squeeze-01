// png-squeeze entry: lossless PNG recompressor.
//
// Pipeline per screenshot (1280x720 RGBA, 8-bit):
//   1. Decode the stored PNG to RGBA.
//   2. Try every exact re-encoding form: palette (colour type 3, ordered by
//      frequency and by luminance) when the image has at most 256 colours;
//      grey (0), grey+alpha (4), RGB (2) or RGBA (6) otherwise, with a tRNS
//      key when there is a single fully-transparent value no opaque pixel uses.
//   3. For each form, try filter strategies per row (fixed filters, the
//      minimum-sum heuristic, the fewest-distinct-pairs heuristic, and brute
//      force: each filter trial actually deflated at level 4 after the 32 KiB
//      written before the row, smallest kept). Screen every candidate with
//      zlib level 6 and keep the smallest total (stream + PLTE/tRNS chunks).
//   4. Recompress the winner twice and keep the smaller verified stream:
//      zlib level 9 (default, filtered and fixed strategies) and a custom
//      optimal-parse deflate (lazy parse, dynamic Huffman tables, shortest
//      path). Only Node's standard library is used. No clock, no environment value and no
// file outside /input and /output influences the result, so two runs of the
// same input are byte-identical.

import { inflateSync, deflateSync, constants } from 'node:zlib';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(samples, raw, width, height, bpp) {
  const stride = width * bpp;
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
      }
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
      }
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] =
          raw[src + i] +
          (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else {
      throw new Error('bad filter type ' + ft);
    }
  }
}

// Decode any 8-bit, non-interlaced PNG of colour type 0, 2, 3, 4 or 6 to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error('not a PNG');
  }
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
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error('chunk ' + type + ' fails CRC');
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
  }
  if (!header || !ended || idat.length === 0) throw new Error('truncated PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), {
    maxOutputLength: expected + 1,
  });
  if (raw.length !== expected) throw new Error('IDAT inflates to wrong size');
  const samples = new Uint8Array(height * stride);
  unfilter(samples, raw, width, height, bpp);
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] =
        ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { rgba, width, height };
}

// ------------------------------------------------------------------ filtering

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
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

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filter `samples` by `choice`: a fixed filter 0-4 for every row, 'minsum'
// (least signed sum per row), 'pairs' (fewest distinct byte pairs per row)
// or 'brute' (each filter actually deflated at level 4 after the 32 KiB
// written before the row, smallest kept). Lowest type wins ties. `raw`, when
// given and the right size, is reused as the output buffer.
function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  if (raw === undefined || raw.length !== height * (stride + 1)) {
    raw = new Uint8Array(height * (stride + 1));
  }
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (choice === 'pairs') {
        cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      } else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// --------------------------------------------------------------------- forms

// Colour key from bytes (endianness-free): r,g,b,a packed into one number.
function keyOf(rgba, d) {
  return ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = keyOf(rgba, d);
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours = [...counts.entries()].map(([key, count]) => ({
    r: (key >>> 24) & 0xff,
    g: (key >>> 16) & 0xff,
    b: (key >>> 8) & 0xff,
    a: key & 0xff,
    key,
    count,
  }));
  return { opaque, grey, colours };
}

// The one fully-transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) indices[i] = index.get(keyOf(rgba, d));
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      p.filters = order === 'count' ? [0] : [0, 'minsum', 'brute'];
      forms.push(p);
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

function chunkBytesOf(form) {
  return (
    (form.plte === null ? 0 : 12 + form.plte.length) +
    (form.trns === null ? 0 : 12 + form.trns.length)
  );
}

function pngOfForm(width, height, form, idat) {
  const chunks = [chunkBytes('IHDR', ihdrOf(width, height, form.colourType))];
  if (form.plte !== null) chunks.push(chunkBytes('PLTE', form.plte));
  if (form.trns !== null) chunks.push(chunkBytes('tRNS', form.trns));
  chunks.push(chunkBytes('IDAT', idat));
  chunks.push(chunkBytes('IEND', new Uint8Array(0)));
  return pngOf(chunks);
}

// ------------------------------------------- custom deflate (optimal parse)
//
// A second compressor for the winning filtered stream, kept only when it
// beats zlib level 9. It parses the stream twice: a lazy hash-chain parse
// with fixed-Huffman costs builds dynamic Huffman tables, then a
// shortest-path (optimal-parse) pass over those tables chooses the symbols,
// the tables are rebuilt from that parse, and the block is emitted with
// dynamic Huffman codes (or fixed codes, whichever is smaller). Every stream
// it produces is inflated back and compared before it is trusted; any
// failure falls back to zlib. Deterministic: fixed parameters, no clock.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  for (let i = 28; i >= 0; i--) if (len >= LEN_BASE[i]) return i;
  return 0;
}
function distCodeOf(dist) {
  for (let i = 29; i >= 0; i--) if (dist >= DIST_BASE[i]) return i;
  return 0;
}

const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

// Huffman code lengths from symbol frequencies (heap-built tree; halve all
// frequencies and retry until no length exceeds maxLen).
function huffmanLengths(freqs, maxLen) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const active = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) active.push(i);
  if (active.length === 0) return lengths;
  if (active.length === 1) {
    lengths[active[0]] = 1;
    return lengths;
  }
  let f = freqs.slice();
  for (;;) {
    let nodes = active.map((s) => ({ freq: f[s], syms: [s] }));
    nodes.sort((a, b) => a.freq - b.freq);
    while (nodes.length > 1) {
      const a = nodes.shift();
      const b = nodes.shift();
      const merged = { freq: a.freq + b.freq, syms: null, left: a, right: b };
      let j = 0;
      while (j < nodes.length && nodes[j].freq < merged.freq) j++;
      nodes.splice(j, 0, merged);
    }
    const assign = (node, d) => {
      if (node.syms) {
        for (const s of node.syms) lengths[s] = d;
        return;
      }
      assign(node.left, d + 1);
      assign(node.right, d + 1);
    };
    assign(nodes[0], 0);
    let mx = 0;
    for (const s of active) if (lengths[s] > mx) mx = lengths[s];
    if (mx <= maxLen) return lengths;
    f = f.map((x) => (x > 0 ? Math.max(1, x >> 1) : 0));
  }
}

function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) codes[i] = nextCode[lengths[i]]++;
  }
  return codes;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  writeBits(value, count) {
    this.bitbuf |= (value & ((1 << count) - 1)) << this.bitcnt;
    this.bitcnt += count;
    while (this.bitcnt >= 8) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(code, len) {
    for (let i = len - 1; i >= 0; i--) this.writeBits((code >> i) & 1, 1);
  }
  save() {
    return { len: this.bytes.length, buf: this.bitbuf, cnt: this.bitcnt };
  }
  restore(s) {
    this.bytes.length = s.len;
    this.bitbuf = s.buf;
    this.bitcnt = s.cnt;
  }
  finish() {
    if (this.bitcnt > 0) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

// Hash-chain match finder shared by the lazy and optimal parsers. Positions
// are inserted incrementally as parsing advances, so chains only hold
// positions strictly before the current one.
function makeMatcher(data) {
  const n = data.length;
  const HASH_MASK = (1 << 15) - 1;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (p) => ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & HASH_MASK;
  let insertedUpTo = 0;
  function insertUpTo(upto) {
    const lim = Math.min(upto, n - 2);
    for (let p = insertedUpTo; p < lim; p++) {
      const h = hashAt(p);
      prev[p] = head[h];
      head[h] = p;
    }
    if (lim > insertedUpTo) insertedUpTo = lim;
  }
  return { n, head, prev, hashAt, insertUpTo };
}

function matchCostOf(len, dist, litLen, distLen) {
  const lc = lenCodeOf(len);
  const dc = distCodeOf(dist);
  return (litLen[257 + lc] || 15) + LEN_EXTRA[lc] + (distLen[dc] || 15) + DIST_EXTRA[dc];
}

// Longest match at pos (cheapest wins ties); null when none of length >= 3.
function bestMatchAt(matcher, data, pos, litLen, distLen, maxChain) {
  const { n, head, prev, hashAt, insertUpTo } = matcher;
  if (pos + 3 > n) return null;
  insertUpTo(pos + 1);
  const h = hashAt(pos);
  const maxLen = Math.min(258, n - pos);
  let best = null;
  let bestLen = 0;
  let chain = maxChain;
  let cand = prev[pos];
  while (cand !== -1 && cand < pos && chain-- > 0) {
    const dist = pos - cand;
    if (dist > 32768) break;
    if (bestLen > 0 && data[cand + bestLen] !== data[pos + bestLen]) {
      cand = prev[cand];
      continue;
    }
    let len = 0;
    while (len < maxLen && data[cand + len] === data[pos + len]) len++;
    if (len >= 3) {
      const cost = matchCostOf(len, dist, litLen, distLen);
      if (best === null || len > best.len || (len === best.len && cost < best.cost)) {
        best = { len, dist, cost };
      }
      if (len > bestLen) {
        bestLen = len;
        if (len >= 258) break;
        if (len >= 32) chain = Math.min(chain, 32);
      }
    }
    cand = prev[cand];
  }
  return best;
}

// Lazy parse: at each position take the longest match unless the next
// position's match is longer (then emit one literal and reconsider).
function lazyParse(data, litLen, distLen, maxChain) {
  const matcher = makeMatcher(data);
  const n = data.length;
  const symbols = [];
  let i = 0;
  while (i < n) {
    const m1 = bestMatchAt(matcher, data, i, litLen, distLen, maxChain);
    if (m1 && i + 1 < n) {
      const m2 = bestMatchAt(matcher, data, i + 1, litLen, distLen, maxChain);
      if (m2 && m2.len > m1.len) {
        symbols.push(data[i]);
        i++;
        continue;
      }
    }
    if (m1) {
      symbols.push(m1);
      i += m1.len;
    } else {
      symbols.push(data[i]);
      i++;
    }
  }
  return symbols;
}

function freqsOf(symbols) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (const s of symbols) {
    if (typeof s === 'number') litFreq[s]++;
    else {
      litFreq[257 + lenCodeOf(s.len)]++;
      distFreq[distCodeOf(s.dist)]++;
    }
  }
  litFreq[256] = 1;
  return { litFreq, distFreq };
}

// Shortest-path parse: cost[i] is the cheapest bit cost of encoding data
// [0, i). From each position the literal and the longest match (at every
// length where the length code changes, plus its full length) relax forward.
function optimalParse(data, litLen, distLen, maxChain) {
  const matcher = makeMatcher(data);
  const n = data.length;
  const LEN_CODE_BY_LEN = new Uint8Array(259);
  for (let l = 0; l <= 258; l++) LEN_CODE_BY_LEN[l] = lenCodeOf(l);
  const BOUNDARY_LENS = [3];
  for (let l = 4; l <= 258; l++) {
    if (LEN_CODE_BY_LEN[l] !== LEN_CODE_BY_LEN[l - 1]) BOUNDARY_LENS.push(l - 1);
  }
  BOUNDARY_LENS.push(258);
  const lenCostByLen = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const lc = LEN_CODE_BY_LEN[l];
    lenCostByLen[l] = (litLen[257 + lc] || 15) + LEN_EXTRA[lc];
  }
  const litCostOf = (b) => litLen[b] || 15;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const chLen = new Int16Array(n + 1);
  const chDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const nl = ci + litCostOf(data[i]);
    if (nl < cost[i + 1]) {
      cost[i + 1] = nl;
      chLen[i + 1] = 0;
    }
    const m = bestMatchAt(matcher, data, i, litLen, distLen, maxChain);
    if (m !== null) {
      const dc = distCodeOf(m.dist);
      const dcost = (distLen[dc] || 15) + DIST_EXTRA[dc];
      for (let k = 0; k < BOUNDARY_LENS.length; k++) {
        const l = BOUNDARY_LENS[k];
        if (l > m.len) break;
        const nc = ci + dcost + lenCostByLen[l];
        if (nc < cost[i + l]) {
          cost[i + l] = nc;
          chLen[i + l] = l;
          chDist[i + l] = m.dist;
        }
      }
      if (!BOUNDARY_LENS.includes(m.len)) {
        const nc = ci + dcost + lenCostByLen[m.len];
        if (nc < cost[i + m.len]) {
          cost[i + m.len] = nc;
          chLen[i + m.len] = m.len;
          chDist[i + m.len] = m.dist;
        }
      }
    }
  }
  const symbols = [];
  let i = n;
  while (i > 0) {
    const l = chLen[i];
    if (l === 0) {
      symbols.push(data[i - 1]);
      i--;
    } else {
      symbols.push({ len: l, dist: chDist[i] });
      i -= l;
    }
  }
  symbols.reverse();
  return symbols;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitDynamicBlock(w, symbols, litLen, distLen, isLast) {
  w.writeBits(isLast ? 1 : 0, 1);
  w.writeBits(2, 2);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  let maxLit = 256;
  for (let i = 287; i > 256; i--) if (litLen[i]) { maxLit = i; break; }
  let maxDist = 0;
  for (let i = 29; i >= 0; i--) if (distLen[i]) { maxDist = i; break; }
  const hlit = maxLit + 1;
  const hdist = maxDist + 1;
  const seq = [];
  for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
  for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
  const rle = [];
  let j = 0;
  while (j < seq.length) {
    const v = seq[j];
    let run = 1;
    while (j + run < seq.length && seq[j + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        rle.push([18, take]);
        r -= take;
      }
      if (r >= 3) {
        rle.push([17, r]);
        r = 0;
      }
      while (r-- > 0) rle.push([0, 0]);
    } else {
      rle.push([v, 0]);
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        rle.push([16, take]);
        r -= take;
      }
      while (r-- > 0) rle.push([v, 0]);
    }
    j += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of rle) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.writeBits(clLen[CL_ORDER[k]], 3);
  for (const [s, extra] of rle) {
    w.writeCode(clCodes[s], clLen[s]);
    if (s === 16) w.writeBits(extra - 3, 2);
    else if (s === 17) w.writeBits(extra - 3, 3);
    else if (s === 18) w.writeBits(extra - 11, 7);
  }
  for (const s of symbols) {
    if (typeof s === 'number') {
      w.writeCode(litCodes[s], litLen[s]);
    } else {
      const lc = lenCodeOf(s.len);
      const dc = distCodeOf(s.dist);
      w.writeCode(litCodes[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc]) w.writeBits(s.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      w.writeCode(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc]) w.writeBits(s.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.writeCode(litCodes[256], litLen[256]);
}

function emitFixedBlock(w, symbols, isLast) {
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  w.writeBits(isLast ? 1 : 0, 1);
  w.writeBits(1, 2);
  for (const s of symbols) {
    if (typeof s === 'number') {
      w.writeCode(litCodes[s], FIXED_LIT_LEN[s]);
    } else {
      const lc = lenCodeOf(s.len);
      const dc = distCodeOf(s.dist);
      w.writeCode(litCodes[257 + lc], FIXED_LIT_LEN[257 + lc]);
      if (LEN_EXTRA[lc]) w.writeBits(s.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      w.writeCode(distCodes[dc], 5);
      if (DIST_EXTRA[dc]) w.writeBits(s.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.writeCode(litCodes[256], 7);
}

function adler32Of(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// The custom deflate stream for `data`, or null when anything about it
// fails verification. The stream is split into blocks of at most 512 KiB so
// the optimal-parse tables stay small and adapt to the image's regions;
// each block is parsed (lazy, then optimal-parse), its tables rebuilt, and
// emitted with dynamic or fixed Huffman codes, whichever is smaller. The
// caller keeps whichever of this and zlib level 9 is smaller.
function deflateCustom(data) {
  const BLOCK = 524288;
  const w = new BitWriter();
  w.writeBits(0x78, 8);
  w.writeBits(0xda, 8);
  for (let at = 0; at < data.length; at += BLOCK) {
    const end = Math.min(data.length, at + BLOCK);
    const block = data.subarray(at, end);
    const isLast = end === data.length;
    let litLen = FIXED_LIT_LEN;
    let distLen = FIXED_DIST_LEN;
    const sym = lazyParse(block, litLen, distLen, 128);
    let f = freqsOf(sym);
    litLen = huffmanLengths(f.litFreq, 15);
    distLen = huffmanLengths(f.distFreq, 15);
    const sym2 = optimalParse(block, litLen, distLen, 128);
    const f2 = freqsOf(sym2);
    litLen = huffmanLengths(f2.litFreq, 15);
    distLen = huffmanLengths(f2.distFreq, 15);
    const save = w.save();
    emitDynamicBlock(w, sym2, litLen, distLen, isLast);
    const dynLen = w.bytes.length + (w.bitcnt > 0 ? 1 : 0);
    w.restore(save);
    emitFixedBlock(w, sym2, isLast);
    const fixLen = w.bytes.length + (w.bitcnt > 0 ? 1 : 0);
    if (dynLen <= fixLen) {
      w.restore(save);
      emitDynamicBlock(w, sym2, litLen, distLen, isLast);
    }
  }
  const raw = w.finish();
  const out = new Uint8Array(raw.length + 4);
  out.set(raw, 0);
  const ad = adler32Of(data);
  out[raw.length] = (ad >>> 24) & 0xff;
  out[raw.length + 1] = (ad >>> 16) & 0xff;
  out[raw.length + 2] = (ad >>> 8) & 0xff;
  out[raw.length + 3] = ad & 0xff;
  // Verify before trusting it.
  const back = inflateSync(out);
  if (back.length !== data.length) return null;
  for (let i = 0; i < data.length; i++) if (back[i] !== data[i]) return null;
  return out;
}

// -------------------------------------------------------------------- driver

function compressOne(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytesOf(form);
    for (const choice of form.filters) {
      const data = filtered(
        form.samples,
        width,
        height,
        form.bpp,
        choice,
        spare !== null && spare.length === size ? spare : undefined,
      );
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, data, bytes };
      } else {
        spare = data;
      }
    }
  }
  // Recompress the winner at level 9, trying three strategies, then try the
  // custom optimal-parse deflate and keep whichever verified stream is
  // smaller. Any failure in the custom path falls back to zlib.
  let out = null;
  for (const s of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_FIXED]) {
    const z = deflateSync(best.data, { level: 9, memLevel: 9, strategy: s });
    if (out === null || z.length < out.length) out = z;
  }
  try {
    const custom = deflateCustom(best.data);
    if (custom !== null && custom.length < out.length) out = custom;
  } catch {
    // Fall back to the zlib stream.
  }
  return pngOfForm(width, height, best.form, out);
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { rgba, width, height } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compressOne(rgba, width, height));
}
