/* ============================================================
   静照 · 启动与装配
   ============================================================ */

import { $, el, icon, debounce, clamp, fmtSize, toast, popover } from './util.js';
import { loadSettings, saveSettings, loadFavs, addFav, delFav,
         saveLibrary, loadLibrary, forgetLibrary, idb } from './db.js';
import { store, bus, setPhotos, setScope, setQuery, patchSettings,
         recompute, yearBuckets, favCount, totalBytes } from './store.js';
import { media } from './media.js';
import { createGrid } from './grid.js';
import { createViewer } from './viewer.js';
import { supportsFsAccess, pickDirectory, ensurePermission, scanHandle,
         fromFiles, rootNameOfFiles, fromDrop, buildFolderTree } from './library.js';

/* ---------------- 启动 ---------------- */

const app      = $('#app');
const scroller = $('#scroller');
const canvas   = $('#canvas');
const emptyEl  = $('#empty');
const noresEl  = $('#nores');

let grid, viewer;

boot();

async function boot() {
  store.settings = await loadSettings();
  store.favs = await loadFavs();
  applySettings();

  grid = createGrid({
    scroller, canvas,
    scrub: $('#scrub'),
    chip:  $('#floatChip'),
    onOpen: (i) => viewer.openAt(i),
  });

  viewer = createViewer({
    onIndexChange: (i) => grid.follow(i),
  });

  wireTopbar();
  wireSidebar();
  wireImport();
  wireKeyboard();
  wireEmptyState();

  bus.on('view', () => { refreshEmptyState(); viewer.resync(); });
  bus.on('photos', refreshSidebar);
  bus.on('fav', (p) => {
    (p.fav ? addFav : delFav)(p.path);
    $('#cntFav').textContent = favCount();
  });

  await offerResume();
  refreshEmptyState();
}

/* ---------------- 设置落地 ---------------- */

const persist = debounce(() => saveSettings(store.settings), 400);

function applySettings() {
  const s = store.settings;
  document.documentElement.dataset.theme = s.theme;
  app.classList.toggle('side-off', !s.sidebar);
  $('#density').value = s.density;
  syncDensityFill();
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.classList.toggle('on', b.dataset.layout === s.layout);
  }
  syncSortMenu();
}

/* 滑杆左半段要跟着值走强调色，这是 Apple 滑杆的样子 */
function syncDensityFill() {
  const r = $('#density');
  const pct = (r.value - r.min) / (r.max - r.min) * 100;
  r.parentElement.style.setProperty('--fill-pct', pct + '%');
}

function syncSortMenu() {
  const s = store.settings;
  for (const b of document.querySelectorAll('#popSort .pop-item')) {
    const on = (b.dataset.sort && b.dataset.sort === s.sort) ||
               (b.dataset.dir && b.dataset.dir === s.dir) ||
               (b.dataset.group && b.dataset.group === s.group);
    b.classList.toggle('on', !!on);
  }
}

/* ---------------- 顶栏 ---------------- */

function wireTopbar() {
  $('#btnSidebar').addEventListener('click', () => {
    const on = !store.settings.sidebar;
    patchSettings({ sidebar: on }, { relayout: false });
    app.classList.toggle('side-off', !on);
    persist();
    setTimeout(() => grid.relayout(), 400);
  });

  $('#btnTheme').addEventListener('click', toggleTheme);

  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      if (store.settings.layout === b.dataset.layout) return;
      patchSettings({ layout: b.dataset.layout }, { relayout: false });
      applySettings();
      grid.relayout();
      persist();
    });
  }

  const dens = $('#density');
  dens.addEventListener('input', () => {
    syncDensityFill();
    patchSettings({ density: +dens.value }, { relayout: false });
    grid.relayout();
    persist();
  });

  popover($('#btnSort'), $('#popSort'));
  $('#popSort').addEventListener('click', (e) => {
    const item = e.target.closest('.pop-item');
    if (!item) return;
    const patch = {};
    if (item.dataset.sort)  patch.sort = item.dataset.sort;
    if (item.dataset.dir)   patch.dir = item.dataset.dir;
    if (item.dataset.group) patch.group = item.dataset.group;
    patchSettings(patch);
    syncSortMenu();
    persist();
  });

  const search = $('#search');
  const clear  = $('#searchClear');
  const run = debounce(() => setQuery(search.value), 180);
  search.addEventListener('input', () => { clear.hidden = !search.value; run(); });
  clear.addEventListener('click', () => { search.value = ''; clear.hidden = true; setQuery(''); search.focus(); });

  $('#btnHelp').addEventListener('click', () => toggleHelp(true));
  $('#helpClose').addEventListener('click', () => toggleHelp(false));
  $('#helpSheet').addEventListener('click', (e) => { if (e.target.id === 'helpSheet') toggleHelp(false); });

  $('#btnClearFilters').addEventListener('click', () => {
    search.value = ''; clear.hidden = true;
    setQuery('');
    setScope('all');
  });
}

function toggleTheme() {
  const theme = store.settings.theme === 'dark' ? 'light' : 'dark';
  patchSettings({ theme }, { relayout: false });
  document.documentElement.dataset.theme = theme;
  persist();
}

const toggleHelp = (on) => { $('#helpSheet').hidden = !on; };

/* ---------------- 侧栏 ---------------- */

const collapsed = new Set();

function wireSidebar() {
  for (const b of document.querySelectorAll('.side-item[data-scope]')) {
    b.addEventListener('click', () => setScope(b.dataset.scope));
  }
  $('#btnRescan').addEventListener('click', rescan);
  bus.on('scope', markScope);
}

function refreshSidebar() {
  const has = store.photos.length > 0;
  $('#cntAll').textContent = store.photos.length;
  $('#cntFav').textContent = favCount();
  $('#sideFoot').hidden = !has;

  if (has) {
    $('#libName').textContent = store.library?.name || '本地照片';
    $('#libMeta').textContent = `${store.photos.length} 张 · ${fmtSize(totalBytes())}`;
  }

  // 年份
  const years = yearBuckets();
  $('#yearsGroup').hidden = years.length < 2;
  const yh = $('#years');
  yh.innerHTML = '';
  for (const [y, n] of years) {
    const b = el('button', 'side-item');
    b.dataset.year = y;
    b.innerHTML = `${icon('i-clock')}<span>${y} 年</span><em>${n}</em>`;
    b.addEventListener('click', () => setScope('year', y));
    yh.appendChild(b);
  }

  // 文件夹
  const tree = buildFolderTree(store.photos);
  const host = $('#folders');
  host.innerHTML = '';
  $('#foldersGroup').hidden = !tree.children.length;
  for (const kid of tree.children) host.appendChild(renderNode(kid, 0));

  markScope();
}

function renderNode(node, depth) {
  const wrap = el('div');
  const row = el('div', 'tree-row');
  const hasKids = node.children.length > 0;
  const isOpen = !collapsed.has(node.path);
  if (hasKids && isOpen) row.classList.add('open');

  const twist = el('button', 'tree-twist' + (hasKids ? '' : ' leaf'), icon('i-down'));
  const item  = el('button', 'side-item');
  item.dataset.folder = node.path;
  item.style.paddingLeft = 4 + depth * 12 + 'px';
  item.innerHTML = `${icon('i-folder')}<span></span><em>${node.count}</em>`;
  item.querySelector('span').textContent = node.name;
  item.title = node.path;

  row.append(twist, item);
  wrap.appendChild(row);

  let kids = null;
  if (hasKids) {
    kids = el('div', 'tree-kids');
    kids.hidden = !isOpen;
    for (const k of node.children) kids.appendChild(renderNode(k, depth + 1));
    wrap.appendChild(kids);
    twist.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowOpen = collapsed.has(node.path);
      if (nowOpen) collapsed.delete(node.path); else collapsed.add(node.path);
      kids.hidden = !nowOpen;
      row.classList.toggle('open', nowOpen);
    });
  }

  item.addEventListener('click', () => setScope('folder', node.path));
  return wrap;
}

function markScope() {
  const { kind, value } = store.scope;
  for (const b of document.querySelectorAll('.side-item')) {
    const on =
      (b.dataset.scope && kind === b.dataset.scope) ||
      (b.dataset.year && kind === 'year' && +b.dataset.year === value) ||
      (b.dataset.folder !== undefined && kind === 'folder' && b.dataset.folder === value);
    b.classList.toggle('on', !!on);
  }
}

/* ---------------- 空状态 ---------------- */

function wireEmptyState() {
  $('#btnForget').addEventListener('click', async () => {
    await forgetLibrary();
    $('#resume').hidden = true;
    toast('已忘记上次的图库');
  });
}

function refreshEmptyState() {
  const hasPhotos = store.photos.length > 0;
  emptyEl.hidden = hasPhotos;
  noresEl.hidden = !hasPhotos || store.view.length > 0;
  if (!noresEl.hidden) {
    $('#noresText').textContent = store.query
      ? `没有匹配「${store.query}」的照片`
      : '这个范围里还没有照片';
  }
}

/* ---------------- 导入 ---------------- */

let fileInput;

function wireImport() {
  fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.webkitdirectory = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files.length) return;
    const files = [...fileInput.files];
    fileInput.value = '';
    await ingest({
      name: rootNameOfFiles(files),
      collect: () => fromFiles(files),
      handle: null,
    });
  });
  document.body.appendChild(fileInput);

  $('#btnOpen').addEventListener('click', openFolder);
  $('#btnOpen2').addEventListener('click', openFolder);

  wireDrop();
}

async function openFolder() {
  if (!supportsFsAccess) { fileInput.click(); return; }
  let handle;
  try { handle = await pickDirectory(); }
  catch (e) { toast('打开文件夹失败：' + e.message, 'bad'); return; }
  if (!handle) return;
  await ingestHandle(handle);
}

async function ingestHandle(handle) {
  await ingest({
    name: handle.name,
    handle,
    collect: (onProgress, signal) => scanHandle(handle, onProgress, signal),
  });
}

async function rescan() {
  const lib = store.library;
  if (lib?.handle) {
    if (!(await ensurePermission(lib.handle))) { toast('没有拿到读取权限', 'bad'); return; }
    await ingestHandle(lib.handle);
  } else {
    fileInput.click();
  }
}

/** 统一的导入流程：收集文件 → 解析元数据 → 交给 store */
async function ingest({ name, handle, collect }) {
  if (store.scanning) return;
  store.scanning = true;
  scanShow(0, `正在读取「${name}」…`);

  try {
    const found = await collect((count) => {
      scanShow(0, `已找到 ${count} 张照片…`);
    });

    if (!found.length) {
      scanHide();
      store.scanning = false;
      toast('这个文件夹里没有找到可显示的图片', 'bad', 3200);
      return;
    }

    for (const p of found) p.fav = store.favs.has(p.path);

    // 先把网格铺出来，元数据边解析边补
    store.library = { name, count: found.length, when: Date.now(), handle: handle || null };
    setPhotos(found);
    refreshEmptyState();

    scanShow(0.02, `正在解析 ${found.length} 张照片的信息…`);
    let lastPaint = 0;
    await media.probeAll(found, (done, total) => {
      scanShow(done / total, `解析中 ${done} / ${total}`);
      const now = performance.now();
      if (now - lastPaint > 700) { lastPaint = now; recompute(); }
    });

    recompute();
    // 拍摄时间是解析完才有的，侧栏的年份分桶要等到这时候才算得准
    bus.emit('photos');
    scanHide();

    if (handle) {
      await saveLibrary({ name, count: found.length, when: Date.now(), handle });
    } else {
      await saveLibrary({ name, count: found.length, when: Date.now(), handle: null });
    }
    $('#resume').hidden = true;

    toast(`已载入 ${found.length} 张照片`);
  } catch (e) {
    console.error(e);
    scanHide();
    toast('导入出错：' + e.message, 'bad', 4000);
  } finally {
    store.scanning = false;
  }
}

function scanShow(ratio, text) {
  const bar = $('#scanbar');
  bar.hidden = false;
  $('#scanfill').style.width = clamp(ratio, 0, 1) * 100 + '%';
  $('#scantext').textContent = text;
}
function scanHide() {
  $('#scanfill').style.width = '100%';
  setTimeout(() => { $('#scanbar').hidden = true; $('#scanfill').style.width = '0%'; }, 320);
}

/* ---------------- 上次的图库 ---------------- */

async function offerResume() {
  const lib = await loadLibrary();
  if (!lib?.handle) return;
  const ok = await ensurePermission(lib.handle, false);

  const when = new Date(lib.when);
  $('#resumeText').textContent =
    `${lib.name} · ${lib.count} 张 · ${when.getMonth() + 1}月${when.getDate()}日`;
  $('#resume').hidden = false;

  const go = async () => {
    if (!(await ensurePermission(lib.handle, true))) {
      toast('需要授权才能读取这个文件夹', 'bad');
      return;
    }
    await ingestHandle(lib.handle);
  };
  $('#btnResume').addEventListener('click', go);

  // 权限还在的话，直接接着上次看
  if (ok) go();
}

/* ---------------- 拖放 ---------------- */

function wireDrop() {
  const veil = $('#dropveil');
  let depth = 0;

  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    veil.classList.add('on');
  });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--depth <= 0) { depth = 0; veil.classList.remove('on'); }
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    veil.classList.remove('on');

    if (store.scanning) return;
    store.scanning = true;
    scanShow(0, '正在读取拖入的内容…');
    let res;
    try {
      res = await fromDrop(e.dataTransfer, (n) => scanShow(0, `已找到 ${n} 张照片…`));
    } catch (err) {
      console.error(err);
    }
    store.scanning = false;
    scanHide();

    if (!res || !res.photos.length) { toast('没找到可显示的图片', 'bad'); return; }

    await ingest({
      name: res.rootName,
      handle: res.rootHandle,
      collect: () => res.photos,
    });
  });
}

/* ---------------- 键盘 ---------------- */

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (viewer.isOpen) { viewer.onKey(e); return; }

    if (!$('#helpSheet').hidden) {
      if (e.key === 'Escape' || e.key === '?') { toggleHelp(false); e.preventDefault(); }
      return;
    }

    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

    if (typing) {
      if (e.key === 'Escape') { t.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case '/':  e.preventDefault(); $('#search').focus(); $('#search').select(); break;
      case '[':  e.preventDefault(); $('#btnSidebar').click(); break;
      case 't': case 'T': toggleTheme(); break;
      case '?':  e.preventDefault(); toggleHelp(true); break;
      case 'ArrowLeft':  e.preventDefault(); grid.move(-1, 0); break;
      case 'ArrowRight': e.preventDefault(); grid.move(1, 0); break;
      case 'ArrowUp':    e.preventDefault(); grid.move(0, -1); break;
      case 'ArrowDown':  e.preventDefault(); grid.move(0, 1); break;
      case 'Enter':
        if (grid.selected >= 0) { e.preventDefault(); viewer.openAt(grid.selected); }
        break;
      case '-': case '_': stepDensity(-24); break;
      case '+': case '=': stepDensity(24); break;
      case 'Escape':
        if (store.query) { $('#search').value = ''; $('#searchClear').hidden = true; setQuery(''); }
        else if (store.scope.kind !== 'all') setScope('all');
        break;
    }
  });
}

function stepDensity(d) {
  const input = $('#density');
  const v = clamp(store.settings.density + d, +input.min, +input.max);
  input.value = v;
  syncDensityFill();
  patchSettings({ density: v }, { relayout: false });
  grid.relayout();
  persist();
}

/* 开发时方便看一眼内部状态 */
window.__jz = { store, media, idb };
