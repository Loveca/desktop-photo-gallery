/* ============================================================
   本地持久化（IndexedDB）
   kv     : 设置、上次的目录句柄
   meta   : 文件头解析出来的尺寸 / EXIF，键 = 指纹
   thumb  : 缩略图 Blob，键 = 指纹
   fav    : 收藏，键 = 相对路径（换机器仍然对得上）
   指纹 = 相对路径|字节数|修改时间，文件一改就自动失效。
   ============================================================ */

const NAME = 'jingzhao';
const VER  = 1;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(NAME, VER); }
    catch (e) { return reject(e); }

    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['kv', 'meta', 'thumb', 'fav']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  }).catch((e) => {
    console.warn('[静照] 本地缓存不可用，本次不做持久化：', e.message);
    return null;                       // 降级：内存模式
  });
  return dbp;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

async function run(store, mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const os  = tx(db, store, mode);
    const req = fn(os);
    if (!req) { os.transaction.oncomplete = () => resolve(); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }).catch((e) => { console.warn('[静照] IDB', store, e); return undefined; });
}

export const idb = {
  get:    (store, key)        => run(store, 'readonly',  (os) => os.get(key)),
  put:    (store, key, value) => run(store, 'readwrite', (os) => os.put(value, key)),
  del:    (store, key)        => run(store, 'readwrite', (os) => os.delete(key)),
  keys:   (store)             => run(store, 'readonly',  (os) => os.getAllKeys()),
  clear:  (store)             => run(store, 'readwrite', (os) => os.clear()),

  /** 批量取：一次事务拿多个键，扫描时比逐条快得多 */
  async getMany(store, keys) {
    const db = await open();
    if (!db || !keys.length) return new Map();
    return new Promise((resolve) => {
      const out = new Map();
      const os = tx(db, store, 'readonly');
      let left = keys.length;
      for (const k of keys) {
        const r = os.get(k);
        r.onsuccess = () => {
          if (r.result !== undefined) out.set(k, r.result);
          if (--left === 0) resolve(out);
        };
        r.onerror = () => { if (--left === 0) resolve(out); };
      }
    }).catch(() => new Map());
  },

  /** 批量写：合并成一个事务 */
  async putMany(store, entries) {
    const db = await open();
    if (!db || !entries.length) return;
    return new Promise((resolve) => {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const [k, v] of entries) os.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror    = () => resolve();
    });
  },
};

/* ---------- 设置 ---------- */
const SETTINGS_KEY = 'settings';
export const DEFAULT_SETTINGS = {
  theme: 'dark',
  layout: 'justified',   // justified | square
  density: 220,          // 目标行高 / 方格边长（px）
  sort: 'taken',         // taken | mtime | name | size
  dir: 'desc',           // desc | asc
  group: 'month',        // none | day | month | year | folder
  sidebar: true,
  slideMs: 5000,
  kenBurns: true,
};

export async function loadSettings() {
  const s = await idb.get('kv', SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
export const saveSettings = (s) => idb.put('kv', SETTINGS_KEY, s);

/* ---------- 上次的图库 ---------- */
export const saveLibrary = (rec) => idb.put('kv', 'library', rec);
export const loadLibrary = ()    => idb.get('kv', 'library');
export const forgetLibrary = ()  => idb.del('kv', 'library');

/* ---------- 收藏 ---------- */
export async function loadFavs() {
  const keys = await idb.keys('fav');
  return new Set(keys || []);
}
export const addFav = (path) => idb.put('fav', path, 1);
export const delFav = (path) => idb.del('fav', path);

/* ---------- 缓存体积 ---------- */
export async function cacheStats() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? { used: est.usage, quota: est.quota } : null;
  } catch { return null; }
}
