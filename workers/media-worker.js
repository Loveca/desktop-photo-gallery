/* ============================================================
   静照 · 媒体工作线程
   两件事，都在主线程之外做：
   1) probe —— 只读文件头，拿到尺寸 / 方向 / EXIF，不解码整图
   2) thumb —— 解码并缩放成缩略图，编码为 WebP Blob
   ============================================================ */

const HEAD_BYTES = 192 * 1024;   // 足够覆盖 APP1(最大 64K) 之后的 SOF

/* ------------------------------------------------------------
   文件头解析
   ------------------------------------------------------------ */

function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

/* ---- EXIF (TIFF IFD) ---- */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readValue(dv, entry, tiff, le) {
  const type  = dv.getUint16(entry + 2, le);
  const count = dv.getUint32(entry + 4, le);
  const unit  = TYPE_SIZE[type];
  if (!unit) return null;
  const total = unit * count;
  const at = total <= 4 ? entry + 8 : tiff + dv.getUint32(entry + 8, le);
  if (at < 0 || at + total > dv.byteLength) return null;

  switch (type) {
    case 2: {                                   // ASCII
      let s = '';
      for (let i = 0; i < count; i++) {
        const c = dv.getUint8(at + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    case 1: case 6: case 7:
      return count === 1 ? dv.getUint8(at) : null;
    case 3:
      return count === 1 ? dv.getUint16(at, le)
           : Array.from({ length: Math.min(count, 8) }, (_, i) => dv.getUint16(at + i * 2, le));
    case 4:
      return count === 1 ? dv.getUint32(at, le) : null;
    case 9:
      return count === 1 ? dv.getInt32(at, le) : null;
    case 5: case 10: {                          // RATIONAL
      const rd = (p) => {
        const n = type === 5 ? dv.getUint32(p, le) : dv.getInt32(p, le);
        const d = type === 5 ? dv.getUint32(p + 4, le) : dv.getInt32(p + 4, le);
        return d ? n / d : null;
      };
      if (count === 1) return rd(at);
      return Array.from({ length: Math.min(count, 3) }, (_, i) => rd(at + i * 8));
    }
    default:
      return null;
  }
}

function walkIFD(dv, pos, tiff, le, want, out) {
  if (pos + 2 > dv.byteLength) return;
  const n = dv.getUint16(pos, le);
  if (n > 512) return;                          // 明显不对，别啃了
  for (let i = 0; i < n; i++) {
    const entry = pos + 2 + i * 12;
    if (entry + 12 > dv.byteLength) return;
    const tag = dv.getUint16(entry, le);
    const key = want[tag];
    if (key) {
      const v = readValue(dv, entry, tiff, le);
      if (v !== null && v !== '') out[key] = v;
    }
  }
}

const IFD0 = {
  0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation',
  0x0132: 'dateTime', 0x8769: '_exifPtr', 0x8825: '_gpsPtr',
  0x0100: 'tiffW', 0x0101: 'tiffH',
};
const EXIF_IFD = {
  0x829a: 'exposure', 0x829d: 'fnumber', 0x8827: 'iso',
  0x9003: 'dateOriginal', 0x9004: 'dateDigitized',
  0x920a: 'focal', 0xa405: 'focal35', 0xa434: 'lens', 0x9205: 'maxAperture',
  0xa002: 'exifW', 0xa003: 'exifH',
};
const GPS_IFD = {
  0x0001: 'latRef', 0x0002: 'lat', 0x0003: 'lonRef', 0x0004: 'lon',
  0x0005: 'altRef', 0x0006: 'alt',
};

function parseExifDate(s) {
  if (typeof s !== 'string') return 0;
  // "YYYY:MM:DD HH:MM:SS"
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : 0;
}

function dms(v, ref) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [d, m = 0, s = 0] = v;
  let deg = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') deg = -deg;
  return Math.round(deg * 1e6) / 1e6;
}

function parseTiff(dv, tiff) {
  if (tiff + 8 > dv.byteLength) return null;
  const bom = dv.getUint16(tiff);
  if (bom !== 0x4949 && bom !== 0x4d4d) return null;
  const le = bom === 0x4949;
  if (dv.getUint16(tiff + 2, le) !== 42) return null;

  const raw = {};
  const ifd0 = tiff + dv.getUint32(tiff + 4, le);
  walkIFD(dv, ifd0, tiff, le, IFD0, raw);
  if (raw._exifPtr) walkIFD(dv, tiff + raw._exifPtr, tiff, le, EXIF_IFD, raw);
  if (raw._gpsPtr)  walkIFD(dv, tiff + raw._gpsPtr,  tiff, le, GPS_IFD,  raw);

  const out = {
    orientation: raw.orientation >= 1 && raw.orientation <= 8 ? raw.orientation : 1,
    taken: parseExifDate(raw.dateOriginal) || parseExifDate(raw.dateDigitized) || parseExifDate(raw.dateTime) || 0,
    make: raw.make || null,
    model: raw.model || null,
    lens: raw.lens || null,
    iso: Array.isArray(raw.iso) ? raw.iso[0] : (raw.iso || null),
    fnumber: typeof raw.fnumber === 'number' ? raw.fnumber : null,
    exposure: typeof raw.exposure === 'number' ? raw.exposure : null,
    focal: typeof raw.focal === 'number' ? raw.focal : null,
    focal35: typeof raw.focal35 === 'number' ? raw.focal35 : null,
    exifW: raw.exifW || raw.tiffW || 0,
    exifH: raw.exifH || raw.tiffH || 0,
  };
  const la = dms(raw.lat, raw.latRef), lo = dms(raw.lon, raw.lonRef);
  if (la != null && lo != null) out.gps = [la, lo];
  return out;
}

/* ---- 各格式的尺寸 ---- */

function parseJpeg(dv) {
  let off = 2, w = 0, h = 0, exif = null;
  const len = dv.byteLength;

  while (off + 4 <= len) {
    if (dv.getUint8(off) !== 0xff) { off++; continue; }   // 重新对齐
    let marker = dv.getUint8(off + 1);
    while (marker === 0xff && off + 2 < len) { off++; marker = dv.getUint8(off + 1); }

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;        // 到图像数据了

    const size = dv.getUint16(off + 2);
    if (size < 2) break;

    if (marker === 0xe1 && off + 10 < len && ascii(dv, off + 4, 4) === 'Exif') {
      exif = parseTiff(dv, off + 10);
    } else if (marker >= 0xc0 && marker <= 0xcf &&
               marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 <= len) { h = dv.getUint16(off + 5); w = dv.getUint16(off + 7); }
      if (exif) break;                                    // 尺寸和 EXIF 都齐了
    }
    off += 2 + size;
  }

  if (!w && exif) { w = exif.exifW; h = exif.exifH; }
  return { w, h, exif };
}

function parsePng(dv) {
  if (dv.byteLength < 24) return null;
  return { w: dv.getUint32(16), h: dv.getUint32(20), exif: null };
}

function parseGif(dv) {
  if (dv.byteLength < 10) return null;
  return { w: dv.getUint16(6, true), h: dv.getUint16(8, true), exif: null };
}

function parseBmp(dv) {
  if (dv.byteLength < 26) return null;
  return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)), exif: null };
}

function parseWebp(dv) {
  if (dv.byteLength < 30) return null;
  const tag = ascii(dv, 12, 4);
  if (tag === 'VP8X') {
    const w = (dv.getUint8(24) | (dv.getUint8(25) << 8) | (dv.getUint8(26) << 16)) + 1;
    const h = (dv.getUint8(27) | (dv.getUint8(28) << 8) | (dv.getUint8(29) << 16)) + 1;
    return { w, h, exif: null };
  }
  if (tag === 'VP8L') {
    const bits = dv.getUint32(21, true);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, exif: null };
  }
  if (tag === 'VP8 ') {
    // 3 字节 frame tag + 3 字节 sync code(9d 01 2a)
    if (dv.getUint8(23) !== 0x9d) return null;
    return {
      w: dv.getUint16(26, true) & 0x3fff,
      h: dv.getUint16(28, true) & 0x3fff,
      exif: null,
    };
  }
  return null;
}

/** HEIC / AVIF：在盒子流里找最大的 ispe，再顺手找 Exif */
function parseIso(dv, bytes) {
  let w = 0, h = 0, best = 0;
  for (let i = 0; i + 20 < bytes.length; i++) {
    if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
      const cw = dv.getUint32(i + 8), ch = dv.getUint32(i + 12);
      if (cw > 0 && ch > 0 && cw < 65536 && ch < 65536 && cw * ch > best) {
        best = cw * ch; w = cw; h = ch;
      }
    }
  }
  let exif = null;
  for (let i = 0; i + 12 < bytes.length; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66 &&
        bytes[i + 4] === 0 && bytes[i + 5] === 0) {
      exif = parseTiff(dv, i + 6);
      if (exif) break;
    }
  }
  return w ? { w, h, exif } : (exif ? { w: exif.exifW, h: exif.exifH, exif } : null);
}

function sniff(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (bytes.length < 12) return null;

  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8) return parseJpeg(dv);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return parsePng(dv);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return parseGif(dv);
  if (b[0] === 0x42 && b[1] === 0x4d) return parseBmp(dv);
  if (ascii(dv, 0, 4) === 'RIFF' && ascii(dv, 8, 4) === 'WEBP') return parseWebp(dv);
  if (ascii(dv, 4, 4) === 'ftyp') return parseIso(dv, bytes);
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) {
    const exif = parseTiff(dv, 0);
    return exif ? { w: exif.exifW, h: exif.exifH, exif } : null;
  }
  return null;
}

async function probe(file) {
  let head;
  try {
    head = await file.slice(0, Math.min(HEAD_BYTES, file.size)).arrayBuffer();
  } catch {
    return { w: 0, h: 0, orientation: 1, taken: 0 };
  }

  const r = sniff(head) || { w: 0, h: 0, exif: null };
  const e = r.exif || {};
  const orientation = e.orientation || 1;
  const swap = orientation >= 5 && orientation <= 8;

  return {
    rawW: r.w || 0,
    rawH: r.h || 0,
    w: swap ? (r.h || 0) : (r.w || 0),        // 已按方向摆正，布局直接用
    h: swap ? (r.w || 0) : (r.h || 0),
    orientation,
    taken: e.taken || 0,
    make: e.make || null,
    model: e.model || null,
    lens: e.lens || null,
    iso: e.iso || null,
    fnumber: e.fnumber || null,
    exposure: e.exposure || null,
    focal: e.focal || null,
    focal35: e.focal35 || null,
    gps: e.gps || null,
  };
}

/* ------------------------------------------------------------
   缩略图
   ------------------------------------------------------------ */

const canEncodeWebp = (() => {
  try { return typeof OffscreenCanvas !== 'undefined'; } catch { return false; }
})();

async function thumb(file, box, hint) {
  const opts = { imageOrientation: 'from-image' };

  // 已知原始尺寸时，让解码器直接吐小图，省内存也更快
  if (hint && hint.rawW > 0 && hint.rawH > 0) {
    const k = Math.min(1, box / Math.max(hint.rawW, hint.rawH));
    if (k < 1) {
      opts.resizeWidth  = Math.max(1, Math.round(hint.rawW * k));
      opts.resizeHeight = Math.max(1, Math.round(hint.rawH * k));
      opts.resizeQuality = 'medium';
    }
  }

  let bmp;
  try {
    bmp = await createImageBitmap(file, opts);
  } catch {
    bmp = await createImageBitmap(file);          // 有的实现不认 options
  }

  // 保险：解码器忽略了 resize 时，这里再缩一次
  let tw = bmp.width, th = bmp.height;
  const k = Math.min(1, box / Math.max(tw, th));
  tw = Math.max(1, Math.round(tw * k));
  th = Math.max(1, Math.round(th * k));

  const cv = new OffscreenCanvas(tw, th);
  const cx = cv.getContext('2d', { alpha: true });
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, tw, th);
  const w = bmp.width, h = bmp.height;
  bmp.close?.();

  let blob;
  try { blob = await cv.convertToBlob({ type: 'image/webp', quality: 0.82 }); }
  catch { blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.86 }); }

  return { blob, w, h, tw, th };
}

/* ------------------------------------------------------------
   消息循环
   ------------------------------------------------------------ */

self.onmessage = async (ev) => {
  const { job, kind, file, box, hint } = ev.data;
  try {
    if (kind === 'probe') {
      const meta = await probe(file);
      self.postMessage({ job, ok: true, meta });
    } else if (kind === 'thumb') {
      const r = await thumb(file, box || 512, hint);
      self.postMessage({ job, ok: true, blob: r.blob, w: r.w, h: r.h, tw: r.tw, th: r.th });
    } else {
      self.postMessage({ job, ok: false, err: 'unknown kind' });
    }
  } catch (e) {
    self.postMessage({ job, ok: false, err: String(e && e.message || e) });
  }
};
