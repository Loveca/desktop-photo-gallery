/* ============================================================
   媒体流水线
   · 工作线程池（解析文件头 / 生成缩略图）
   · 两级优先队列：可视格插队，后台预热排队
   · 缩略图 Blob 落 IndexedDB，object URL 走 LRU，避免内存无限涨
   ============================================================ */

import { idb } from './db.js';

const THUMB_BOX   = 512;    // 缩略图长边
const URL_CAP     = 1200;   // 常驻内存的缩略图 URL 上限
const FULL_CAP    = 7;      // 原图 URL 上限（当前张 + 前后预载）

/* ---------------- 工作线程池 ---------------- */

class Pool {
  constructor(url, size) {
    this.jobs = new Map();
    this.seq  = 0;
    this.hi   = [];          // 后进先出：滚动时优先画眼前的
    this.lo   = [];          // 先进先出：后台预热
    this.idle = [];
    this.ok   = true;

    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(url, { type: 'classic' });
        w.onmessage = (e) => this._done(w, e.data);
        w.onerror   = (e) => { console.warn('[静照] worker 出错', e.message); };
        this.idle.push(w);
      }
    } catch (e) {
      console.warn('[静照] 无法启动工作线程，退回主线程模式：', e.message);
      this.ok = false;
    }
  }

  submit(task) {
    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject  = reject;
      task.seq = this.seq++;
      (task.prio === 0 ? this.hi : this.lo).push(task);
      this._pump();
    });
  }

  /**
   * 降级而不是取消。
   * 同一张缩略图可能同时被网格和胶片条等着，取消会连累另一边；
   * 而且这活儿早晚都要干（结果进磁盘缓存），挪到后台队列即可。
   */
  demote(key) {
    const i = this.hi.findIndex((t) => t.key === key);
    if (i >= 0) this.lo.push(...this.hi.splice(i, 1));
  }

  get pending() { return this.hi.length + this.lo.length + this.jobs.size; }

  _next() { return this.hi.pop() || this.lo.shift(); }

  _pump() {
    while (this.idle.length) {
      const task = this._next();
      if (!task) return;
      const w = this.idle.pop();
      const job = task.seq;
      this.jobs.set(job, { task, w });
      w.postMessage({ job, kind: task.kind, file: task.file, box: task.box, hint: task.hint });
    }
  }

  _done(w, data) {
    const rec = this.jobs.get(data.job);
    this.jobs.delete(data.job);
    this.idle.push(w);
    if (rec) {
      if (data.ok) rec.task.resolve(data);
      else rec.task.reject(new Error(data.err || 'worker failed'));
    }
    this._pump();
  }
}

const workerURL = new URL('../workers/media-worker.js', import.meta.url);
const poolSize  = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const pool      = new Pool(workerURL, poolSize);

/* ---------------- 主线程降级实现 ---------------- */

async function mainProbe(file) {
  try {
    const bmp = await createImageBitmap(file);
    const r = { rawW: bmp.width, rawH: bmp.height, w: bmp.width, h: bmp.height, orientation: 1, taken: 0 };
    bmp.close?.();
    return r;
  } catch {
    return { rawW: 0, rawH: 0, w: 0, h: 0, orientation: 1, taken: 0 };
  }
}

async function mainThumb(file, box) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const k = Math.min(1, box / Math.max(bmp.width, bmp.height));
  const tw = Math.max(1, Math.round(bmp.width * k));
  const th = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, tw, th);
  const w = bmp.width, h = bmp.height;
  bmp.close?.();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/webp', 0.82));
  return { blob, w, h, tw, th };
}

/* ---------------- 文件句柄 ---------------- */

export async function fileOf(photo) {
  if (photo.file) return photo.file;
  if (photo.handle) {
    const f = await photo.handle.getFile();
    photo.file = f;
    return f;
  }
  throw new Error('no file');
}

/* ---------------- URL 缓存（LRU） ---------------- */

class UrlCache {
  constructor(cap) { this.cap = cap; this.map = new Map(); this.pinned = new Set(); }

  get(id) {
    const u = this.map.get(id);
    if (u === undefined) return null;
    this.map.delete(id); this.map.set(id, u);   // touch
    return u;
  }

  set(id, url) {
    if (this.map.has(id)) { URL.revokeObjectURL(this.map.get(id)); this.map.delete(id); }
    this.map.set(id, url);
    this._trim();
  }

  pin(ids) { this.pinned = ids; }

  _trim() {
    if (this.map.size <= this.cap) return;
    let over = this.map.size - this.cap;
    for (const id of [...this.map.keys()]) {
      if (over <= 0) break;
      if (this.pinned.has(id)) continue;
      URL.revokeObjectURL(this.map.get(id));
      this.map.delete(id);
      over--;
    }
  }

  clear() {
    for (const u of this.map.values()) URL.revokeObjectURL(u);
    this.map.clear();
  }
}

const thumbURLs = new UrlCache(URL_CAP);
const fullURLs  = new UrlCache(FULL_CAP);

/* ---------------- 对外接口 ---------------- */

const inflightThumb = new Map();   // id -> Promise

export const media = {
  /** 已在内存里的缩略图 URL，网格挂载时先问这个，命中就没有闪烁 */
  peekThumb(photo) { return thumbURLs.get(photo.id); },

  pinThumbs(idSet) { thumbURLs.pin(idSet); },

  /** 取缩略图：内存 → IndexedDB → 现生成 */
  async thumb(photo, { prio = 0 } = {}) {
    const hit = thumbURLs.get(photo.id);
    if (hit) return hit;

    if (inflightThumb.has(photo.id)) return inflightThumb.get(photo.id);

    const p = (async () => {
      const cached = await idb.get('thumb', photo.id);
      if (cached) {
        const url = URL.createObjectURL(cached);
        thumbURLs.set(photo.id, url);
        return url;
      }

      const file = await fileOf(photo);
      let r;
      if (pool.ok) {
        r = await pool.submit({
          key: 'T' + photo.id, kind: 'thumb', file,
          box: THUMB_BOX, hint: photo.meta, prio,
        });
      } else {
        r = await mainThumb(file, THUMB_BOX);
      }
      if (!r.blob) throw new Error('empty thumb');

      idb.put('thumb', photo.id, r.blob);

      // 生成时顺手把真实尺寸补上（文件头没解析出来的情况）
      if (r.w && (!photo.w || !photo.h)) {
        photo.w = r.w; photo.h = r.h;
        photo.ar = r.w / r.h;
      }

      const url = URL.createObjectURL(r.blob);
      thumbURLs.set(photo.id, url);
      return url;
    })().finally(() => inflightThumb.delete(photo.id));

    inflightThumb.set(photo.id, p);
    return p;
  },

  /** 格子滚出视口：把它挪到后台队列，别挡着眼前要看的那些 */
  dropThumb(photo) {
    pool.demote('T' + photo.id);
  },

  /** 原图 URL，看图时用 */
  async full(photo) {
    const hit = fullURLs.get(photo.id);
    if (hit) return hit;
    const file = await fileOf(photo);
    const url = URL.createObjectURL(file);
    fullURLs.set(photo.id, url);
    return url;
  },

  pinFull(idSet) { fullURLs.pin(idSet); },

  /** 批量解析文件头：先查缓存，剩下的丢给线程池 */
  async probeAll(photos, onProgress) {
    const need = [];
    const ids  = photos.map((p) => p.id);

    const cached = await idb.getMany('meta', ids);
    for (const p of photos) {
      const m = cached.get(p.id);
      if (m) applyMeta(p, m); else need.push(p);
    }

    let done = photos.length - need.length;
    onProgress?.(done, photos.length);

    if (!need.length) return;

    const writeBuf = [];
    const flush = () => {
      if (!writeBuf.length) return;
      idb.putMany('meta', writeBuf.splice(0));
    };

    const CHUNK = 64;
    for (let i = 0; i < need.length; i += CHUNK) {
      const slice = need.slice(i, i + CHUNK);
      await Promise.all(slice.map(async (p) => {
        try {
          const file = await fileOf(p);
          const meta = pool.ok
            ? (await pool.submit({ key: 'P' + p.id, kind: 'probe', file, prio: 1 })).meta
            : await mainProbe(file);
          applyMeta(p, meta);
          writeBuf.push([p.id, meta]);
        } catch {
          applyMeta(p, { w: 0, h: 0, orientation: 1, taken: 0 });
        } finally {
          done++;
        }
      }));
      flush();
      onProgress?.(done, photos.length);
      // 让出主线程，扫描时界面不卡
      await new Promise((r) => setTimeout(r, 0));
    }
    flush();
  },

  get queueDepth() { return pool.pending; },

  reset() {
    thumbURLs.clear();
    fullURLs.clear();
    inflightThumb.clear();
  },
};

function applyMeta(p, m) {
  p.meta = m;
  p.w = m.w || 0;
  p.h = m.h || 0;
  p.ar = (m.w && m.h) ? m.w / m.h : 1;
  p.taken = m.taken || p.mtime || 0;
}
