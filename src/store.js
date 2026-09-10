/* ============================================================
   应用状态：一份照片全集 + 一份「当前视图」
   视图 = 范围筛选 → 搜索 → 排序 → 分组，任何一环变了就重算。
   ============================================================ */

import { natCmp, fmtDate, weekdayOf, relDay } from './util.js';
import { DEFAULT_SETTINGS } from './db.js';

function emitter() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev).delete(fn); },
    emit(ev, arg) { map.get(ev)?.forEach((fn) => fn(arg)); },
  };
}

export const bus = emitter();

export const store = {
  photos: [],                       // 全集
  view: [],                         // 当前可见的照片，按当前排序
  sections: [],                     // [{label, sub, from, to}]
  favs: new Set(),                  // 收藏（按相对路径记）
  settings: { ...DEFAULT_SETTINGS },
  scope: { kind: 'all', value: null },
  query: '',
  library: null,                    // {name, count, when, hasHandle}
  scanning: false,
};

/* ---------------- 排序 ---------------- */

const KEYERS = {
  taken: (p) => p.taken || p.mtime || 0,
  mtime: (p) => p.mtime || 0,
  size:  (p) => p.size || 0,
};

function comparator(sort, dir) {
  const s = dir === 'asc' ? 1 : -1;
  if (sort === 'name') {
    return (a, b) => natCmp(a.name, b.name) * s || natCmp(a.path, b.path);
  }
  const key = KEYERS[sort] || KEYERS.taken;
  return (a, b) => (key(a) - key(b)) * s || natCmp(a.path, b.path);
}

/* ---------------- 分组 ---------------- */

function dayKey(ts)   { const d = new Date(ts); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function monthKey(ts) { const d = new Date(ts); return d.getFullYear() * 100 + d.getMonth() + 1; }
function yearKey(ts)  { return new Date(ts).getFullYear(); }

function grouper(group) {
  switch (group) {
    case 'day':    return { key: (p) => (p.taken ? dayKey(p.taken) : 0),   label: (p) => labelDay(p) };
    case 'month':  return { key: (p) => (p.taken ? monthKey(p.taken) : 0), label: (p) => (p.taken ? fmtDate(p.taken, 'month') : '未知时间') };
    case 'year':   return { key: (p) => (p.taken ? yearKey(p.taken) : 0),  label: (p) => (p.taken ? fmtDate(p.taken, 'year') : '未知时间') };
    case 'folder': return { key: (p) => p.dir,                             label: (p) => (p.dir || '根目录') };
    default:       return null;
  }
}

function labelDay(p) {
  if (!p.taken) return '未知时间';
  const rel = relDay(p.taken);
  return fmtDate(p.taken, 'day') + (rel ? ` · ${rel}` : ` · ${weekdayOf(p.taken)}`);
}

/* ---------------- 重算视图 ---------------- */

export function recompute() {
  const { scope, query, settings, photos } = store;
  const q = query.trim().toLowerCase();

  let list = photos;

  if (scope.kind === 'fav') {
    list = list.filter((p) => p.fav);
  } else if (scope.kind === 'folder') {
    const pre = scope.value ? scope.value + '/' : '';
    list = scope.value
      ? list.filter((p) => p.dir === scope.value || p.dir.startsWith(pre))
      : list;
  } else if (scope.kind === 'year') {
    list = list.filter((p) => p.taken && new Date(p.taken).getFullYear() === scope.value);
  }

  if (q) {
    list = list.filter((p) => p.name.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q));
  }

  list = list.slice().sort(comparator(settings.sort, settings.dir));

  // 排序字段不是时间时，按时间分组没有意义，自动退成文件夹或不分组
  let group = settings.group;
  if ((settings.sort === 'name' || settings.sort === 'size') &&
      (group === 'day' || group === 'month' || group === 'year')) {
    group = 'folder';
  }

  const g = grouper(group);
  const sections = [];
  if (g && list.length) {
    let curKey = g.key(list[0]), from = 0;
    for (let i = 1; i <= list.length; i++) {
      const k = i < list.length ? g.key(list[i]) : Symbol('end');
      if (k !== curKey) {
        sections.push({ label: g.label(list[from]), sub: `${i - from} 张`, from, to: i, key: curKey });
        curKey = k; from = i;
      }
    }
  } else if (list.length) {
    sections.push({ label: null, sub: '', from: 0, to: list.length, key: 'all' });
  }

  store.view = list;
  store.sections = sections;
  store.groupMode = group;
  bus.emit('view');
}

/* ---------------- 变更入口 ---------------- */

export function setPhotos(photos) {
  store.photos = photos;
  for (const p of photos) p.fav = store.favs.has(p.path);
  bus.emit('photos');
  recompute();
}

export function setScope(kind, value = null) {
  if (store.scope.kind === kind && store.scope.value === value) return;
  store.scope = { kind, value };
  bus.emit('scope');
  recompute();
}

export function setQuery(q) {
  if (store.query === q) return;
  store.query = q;
  recompute();
}

export function patchSettings(patch, { relayout = true } = {}) {
  Object.assign(store.settings, patch);
  bus.emit('settings', patch);
  if (relayout) recompute();
}

export function toggleFav(photo) {
  photo.fav = !photo.fav;
  if (photo.fav) store.favs.add(photo.path); else store.favs.delete(photo.path);
  bus.emit('fav', photo);
  if (store.scope.kind === 'fav') recompute();
  return photo.fav;
}

/* ---------------- 派生 ---------------- */

export function yearBuckets() {
  const m = new Map();
  for (const p of store.photos) {
    if (!p.taken) continue;
    const y = new Date(p.taken).getFullYear();
    m.set(y, (m.get(y) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[0] - a[0]);
}

export const favCount = () => store.photos.reduce((n, p) => n + (p.fav ? 1 : 0), 0);

export const totalBytes = () => store.photos.reduce((n, p) => n + (p.size || 0), 0);
