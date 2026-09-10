/* ============================================================
   图库导入
   三条路都通向同一个 photo[]：
   · File System Access API 选目录（可记住，下次直接恢复）
   · <input webkitdirectory>（老浏览器兜底）
   · 拖放（能拿到句柄就拿句柄，拿不到退回 entry 遍历）
   ============================================================ */

import { ext, baseName, dirName } from './util.js';

export const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'gif',
  'bmp', 'tif', 'tiff', 'heic', 'heif',
]);

const SKIP_DIR = new Set([
  'node_modules', '.git', '.svn', '@eadir', '.thumbnails',
  '$recycle.bin', 'system volume information', '.trash', '.ds_store',
]);

export const isImageName = (name) =>
  !name.startsWith('._') && !name.startsWith('.') && IMAGE_EXT.has(ext(name));

const skipDir = (name) => name.startsWith('.') || SKIP_DIR.has(name.toLowerCase());

export const supportsFsAccess = typeof window.showDirectoryPicker === 'function';

/* ---------------- 权限 ---------------- */

export async function ensurePermission(handle, interactive = true) {
  if (!handle?.queryPermission) return true;
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!interactive) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

/* ---------------- 选目录 ---------------- */

export async function pickDirectory() {
  if (!supportsFsAccess) return null;
  try {
    return await window.showDirectoryPicker({ id: 'jingzhao-lib', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

/* ---------------- 构造 photo ---------------- */

function makePhoto({ name, path, file, handle, size, mtime }) {
  return {
    id: `${path}|${size}|${mtime}`,
    name,
    path,
    dir: dirName(path),
    size,
    mtime,
    file: file || null,
    handle: handle || null,
    meta: null,
    w: 0, h: 0, ar: 1,
    taken: mtime,
    fav: false,
    dead: false,          // 浏览器解不开的格式
  };
}

/* ---------------- 目录句柄遍历 ---------------- */

export async function scanHandle(root, onProgress, signal) {
  const photos = [];
  const stack = [{ handle: root, prefix: '' }];
  let seen = 0;

  while (stack.length) {
    if (signal?.aborted) break;
    const { handle, prefix } = stack.pop();

    let entries;
    try { entries = handle.entries(); }
    catch { continue; }

    const files = [];
    try {
      for await (const [name, h] of entries) {
        if (signal?.aborted) break;
        if (h.kind === 'directory') {
          if (!skipDir(name)) stack.push({ handle: h, prefix: prefix ? `${prefix}/${name}` : name });
        } else if (isImageName(name)) {
          files.push([name, h]);
        }
      }
    } catch (e) {
      console.warn('[静照] 读取目录失败', prefix, e.message);
      continue;
    }

    // 取 size / mtime 需要 getFile()，分批并发，别一次性开几千个
    const CHUNK = 48;
    for (let i = 0; i < files.length; i += CHUNK) {
      if (signal?.aborted) break;
      await Promise.all(files.slice(i, i + CHUNK).map(async ([name, h]) => {
        try {
          const f = await h.getFile();
          const path = prefix ? `${prefix}/${name}` : name;
          photos.push(makePhoto({
            name, path, handle: h, file: f,
            size: f.size, mtime: f.lastModified,
          }));
        } catch { /* 文件在扫描途中没了，跳过 */ }
      }));
      seen += Math.min(CHUNK, files.length - i);
      onProgress?.(photos.length, seen);
    }
    onProgress?.(photos.length, seen);
  }
  return photos;
}

/* ---------------- <input webkitdirectory> ---------------- */

export function fromFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    if (!isImageName(f.name)) continue;
    // webkitRelativePath 形如 "相册/2024/a.jpg"，去掉最外层目录名和路径保持一致
    const rel = f.webkitRelativePath || f.name;
    const cut = rel.indexOf('/');
    const path = cut >= 0 ? rel.slice(cut + 1) : rel;
    // 和目录句柄扫描保持同一套忽略规则
    const segs = path.split('/');
    if (segs.slice(0, -1).some(skipDir)) continue;
    out.push(makePhoto({
      name: f.name, path, file: f,
      size: f.size, mtime: f.lastModified,
    }));
  }
  return out;
}

export function rootNameOfFiles(fileList) {
  for (const f of fileList) {
    const rel = f.webkitRelativePath;
    if (rel && rel.includes('/')) return rel.slice(0, rel.indexOf('/'));
  }
  return '本地照片';
}

/* ---------------- 拖放 ---------------- */

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    if (!isImageName(entry.name)) return;
    const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
    if (!file) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(makePhoto({
      name: entry.name, path, file,
      size: file.size, mtime: file.lastModified,
    }));
    return;
  }
  if (!entry.isDirectory || skipDir(entry.name)) return;

  const reader = entry.createReader();
  const next = prefix ? `${prefix}/${entry.name}` : entry.name;
  for (;;) {
    const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, next, out);
  }
}

export async function fromDrop(dataTransfer, onProgress) {
  const items = [...dataTransfer.items].filter((i) => i.kind === 'file');
  if (!items.length) return null;

  // 优先要句柄：拿到就能记住这个图库
  if (items[0].getAsFileSystemHandle) {
    const handles = await Promise.all(items.map((i) => i.getAsFileSystemHandle().catch(() => null)));
    const dir = handles.find((h) => h && h.kind === 'directory');
    if (dir) {
      const photos = await scanHandle(dir, onProgress);
      return { photos, rootHandle: dir, rootName: dir.name };
    }
    const files = handles.filter((h) => h && h.kind === 'file');
    if (files.length) {
      const photos = [];
      for (const h of files) {
        if (!isImageName(h.name)) continue;
        try {
          const f = await h.getFile();
          photos.push(makePhoto({ name: h.name, path: h.name, handle: h, file: f, size: f.size, mtime: f.lastModified }));
        } catch { /* ignore */ }
      }
      if (photos.length) return { photos, rootHandle: null, rootName: '拖入的照片' };
    }
  }

  // 兜底：老的 entry 接口
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return null;
  const out = [];
  for (const e of entries) {
    await walkEntry(e, '', out);
    onProgress?.(out.length, out.length);
  }
  const rootName = entries.length === 1 && entries[0].isDirectory ? entries[0].name : '拖入的照片';
  // walkEntry 给顶层目录也加了前缀，这里统一削掉一层，路径显示更干净
  if (entries.length === 1 && entries[0].isDirectory) {
    const head = entries[0].name + '/';
    for (const p of out) {
      if (p.path.startsWith(head)) {
        p.path = p.path.slice(head.length);
        p.dir = dirName(p.path);
        p.id = `${p.path}|${p.size}|${p.mtime}`;
      }
    }
  }
  return out.length ? { photos: out, rootHandle: null, rootName } : null;
}

/* ---------------- 文件夹树 ---------------- */

export function buildFolderTree(photos) {
  const root = { name: '', path: '', count: 0, kids: new Map() };
  for (const p of photos) {
    root.count++;
    if (!p.dir) continue;
    let node = root, acc = '';
    for (const seg of p.dir.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      let kid = node.kids.get(seg);
      if (!kid) { kid = { name: seg, path: acc, count: 0, kids: new Map() }; node.kids.set(seg, kid); }
      kid.count++;
      node = kid;
    }
  }
  const sortRec = (n) => {
    n.children = [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    n.kids = null;
    n.children.forEach(sortRec);
    return n;
  };
  return sortRec(root);
}

export { baseName };
