/* ============================================================
   虚拟化照片网格
   布局是纯计算（O(n) 一遍），DOM 只挂载视口内的几行。
   两种排布：
   · justified —— 等高行、右边缘对齐，尊重每张图的原始比例
   · square    —— 等边方格，密度最高，适合快速扫一遍
   ============================================================ */

import { media } from './media.js';
import { store, bus, toggleFav } from './store.js';
import { el, icon, rafThrottle, clamp, ext } from './util.js';

const GAP        = 6;
const SEC_H      = 54;      // 分组标题占的高度
const PAD_TOP    = 16;
const PAD_BOTTOM = 60;
const OVERSCAN   = 700;     // 视口上下各多渲染这么多像素

export function createGrid({ scroller, canvas, scrub, chip, onOpen }) {
  let rows = [];            // 布局结果：分组标题行 + 照片行
  let rowTops = [];         // rows[i].y，二分查找用
  let locate = [];          // view 下标 -> {r, c}
  let totalH = 0;
  let width = 0;
  let sel = -1;
  let freshUntil = 0;

  const mounted = new Map();   // rowIndex -> element
  const tileOf  = new Map();   // view 下标 -> tile 元素

  /* ---------------- 布局 ---------------- */

  const arOf = (p) => {
    const a = p.ar || 1;
    return clamp(a, 0.22, 5);      // 极端比例会把整行撑坏
  };

  function layout() {
    const { settings, view, sections } = store;
    width = canvas.clientWidth || scroller.clientWidth;

    // 行的下标和几何都会变，已挂载的节点一律作废，否则会留下旧尺寸的格子
    for (const [, n] of mounted) n.remove();
    mounted.clear(); tileOf.clear();

    rows = []; locate = new Array(view.length);

    if (!view.length || width < 40) { totalH = 0; applyHeight(); return; }

    const target = settings.density;
    const square = settings.layout === 'square';
    let y = PAD_TOP;

    for (const sec of sections) {
      if (sec.label) {
        rows.push({ type: 'sec', y, h: SEC_H, label: sec.label, sub: sec.sub });
        y += SEC_H;
      }

      if (square) {
        const cols = Math.max(1, Math.round((width + GAP) / (target + GAP)));
        const cell = (width - GAP * (cols - 1)) / cols;
        for (let i = sec.from; i < sec.to; i += cols) {
          const end = Math.min(i + cols, sec.to);
          const cells = [];
          let fx = 0;
          for (let k = i; k < end; k++) {
            const x0 = Math.round(fx), x1 = Math.round(fx + cell);
            locate[k] = { r: rows.length, c: cells.length };
            cells.push({ i: k, x: x0, w: x1 - x0 });
            fx += cell + GAP;
          }
          const h = Math.round(cell);
          rows.push({ type: 'row', y, h, cells });
          y += h + GAP;
        }
      } else {
        let i = sec.from;
        while (i < sec.to) {
          let sum = 0, j = i, h = target;
          while (j < sec.to) {
            sum += arOf(view[j]);
            j++;
            h = (width - GAP * (j - i - 1)) / sum;
            if (h <= target) break;
          }
          const stretched = h <= target;
          const rowH = stretched ? h : target;

          const cells = [];
          let fx = 0;
          for (let k = i; k < j; k++) {
            const w = arOf(view[k]) * rowH;
            const x0 = Math.round(fx), x1 = Math.round(fx + w);
            locate[k] = { r: rows.length, c: cells.length };
            cells.push({ i: k, x: x0, w: Math.max(1, x1 - x0) });
            fx += w + GAP;
          }
          const hh = Math.round(rowH);
          rows.push({ type: 'row', y, h: hh, cells });
          y += hh + GAP;
          i = j;
        }
      }
      y += 14;   // 组与组之间留口气
    }

    totalH = y + PAD_BOTTOM;
    rowTops = rows.map((r) => r.y);
    applyHeight();
  }

  function applyHeight() {
    canvas.style.height = totalH + 'px';
    canvas.classList.toggle('tiny', store.settings.density < 160);
  }

  /* ---------------- 视口计算 ---------------- */

  function firstRowAt(y) {
    let lo = 0, hi = rowTops.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid] <= y) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res;
  }

  /* ---------------- 挂载 ---------------- */

  function mountSection(row) {
    const n = el('div', 'sec');
    n.style.transform = `translateY(${row.y}px)`;
    n.style.height = row.h + 'px';
    n.innerHTML =
      `<span class="sec-label"></span><span class="sec-sub"></span><span class="sec-rule"></span>`;
    n.querySelector('.sec-label').textContent = row.label;
    n.querySelector('.sec-sub').textContent = row.sub;
    return n;
  }

  function mountRow(row, fresh) {
    const n = el('div', 'row' + (fresh ? ' fresh' : ''));
    n.style.transform = `translateY(${row.y}px)`;
    n.style.height = row.h + 'px';

    const frag = document.createDocumentFragment();
    for (const cell of row.cells) {
      const p = store.view[cell.i];
      if (!p) continue;
      const tile = el('div', 'tile');
      tile.style.left = cell.x + 'px';
      tile.style.width = cell.w + 'px';
      tile.style.height = row.h + 'px';
      tile.dataset.i = cell.i;
      if (p.fav) tile.classList.add('faved');
      if (cell.i === sel) tile.classList.add('sel');

      tile.innerHTML =
        `<img alt="" decoding="async" />` +
        `<span class="tile-name"></span>` +
        `<button class="tile-fav" tabindex="-1" title="收藏">${icon('i-star')}</button>`;
      tile.querySelector('.tile-name').textContent = p.name;

      fillTile(tile, p);
      tileOf.set(cell.i, tile);
      frag.appendChild(tile);
    }
    n.appendChild(frag);
    return n;
  }

  function fillTile(tile, p) {
    const img = tile.querySelector('img');

    if (p.dead) return markDead(tile, p);

    const cached = media.peekThumb(p);
    if (cached) {
      img.src = cached;
      img.classList.add('in');
      return;
    }

    tile.classList.add('load');
    media.thumb(p).then((url) => {
      if (!tile.isConnected) return;
      img.src = url;
      img.onload = () => { tile.classList.remove('load'); img.classList.add('in'); };
      img.onerror = () => markDead(tile, p);
    }).catch(() => {
      p.dead = true;
      if (tile.isConnected) markDead(tile, p);
    });
  }

  function markDead(tile, p) {
    tile.classList.remove('load');
    tile.classList.add('dead');
    const img = tile.querySelector('img');
    if (img) img.remove();
    if (!tile.querySelector('.tile-dead')) {
      tile.insertAdjacentHTML('afterbegin',
        `<span class="tile-dead">${icon('i-broken')}<span>${ext(p.name)}</span></span>`);
    }
  }

  /* ---------------- 渲染循环 ---------------- */

  function render() {
    if (!rows.length) {
      for (const [, n] of mounted) n.remove();
      mounted.clear(); tileOf.clear();
      renderScrub();
      return;
    }

    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    const lo = firstRowAt(top - OVERSCAN);
    let hi = lo;
    while (hi < rows.length && rows[hi].y < bottom + OVERSCAN) hi++;

    // 卸载
    for (const [idx, node] of mounted) {
      if (idx >= lo && idx < hi) continue;
      const row = rows[idx];
      if (row?.type === 'row') {
        for (const c of row.cells) {
          tileOf.delete(c.i);
          const p = store.view[c.i];
          if (p) media.dropThumb(p);
        }
      }
      node.remove();
      mounted.delete(idx);
    }

    // 挂载
    const fresh = performance.now() < freshUntil;
    const frag = document.createDocumentFragment();
    for (let i = lo; i < hi; i++) {
      if (mounted.has(i)) continue;
      const row = rows[i];
      const node = row.type === 'sec' ? mountSection(row) : mountRow(row, fresh);
      mounted.set(i, node);
      frag.appendChild(node);
    }
    if (frag.childNodes.length) canvas.appendChild(frag);

    // 告诉 media 哪些缩略图不能回收
    const pin = new Set();
    for (let i = lo; i < hi; i++) {
      const row = rows[i];
      if (row.type !== 'row') continue;
      for (const c of row.cells) { const p = store.view[c.i]; if (p) pin.add(p.id); }
    }
    media.pinThumbs(pin);

    updateChip(top);
  }

  const onScroll = rafThrottle(render);

  /* ---------------- 浮动分组标签 ---------------- */

  let chipTimer;
  function updateChip(top) {
    if (!chip) return;
    const secs = store.sections;
    if (!secs.length || !secs[0].label) { chip.classList.remove('show'); return; }

    let cur = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.type !== 'sec') continue;
      if (r.y - 8 <= top) cur = r; else break;
    }
    const label = cur ? cur.label : secs[0].label;
    if (chip.textContent !== label) chip.textContent = label;
    chip.hidden = false;
    chip.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('show'), 1100);
  }

  /* ---------------- 右缘刻度 ---------------- */

  function renderScrub() {
    if (!scrub) return;
    const mode = store.groupMode;
    const timeMode = mode === 'day' || mode === 'month' || mode === 'year';
    if (!timeMode || totalH <= scroller.clientHeight * 1.5) { scrub.hidden = true; return; }

    const seen = new Set();
    const ticks = [];
    for (const r of rows) {
      if (r.type !== 'sec') continue;
      const y = String(r.label).slice(0, 4);
      if (seen.has(y)) continue;
      seen.add(y);
      ticks.push({ y: r.y, label: y });
    }
    if (ticks.length < 2) { scrub.hidden = true; return; }

    scrub.hidden = false;
    scrub.innerHTML = '';
    const H = scroller.clientHeight;
    const usable = Math.max(1, totalH - H);
    for (const t of ticks) {
      const node = el('div', 'scrub-tick');
      node.textContent = t.label;
      node.style.top = clamp(t.y / usable, 0, 1) * (H - 28) + 14 + 'px';
      node.addEventListener('click', () => {
        scroller.scrollTo({ top: Math.max(0, t.y - PAD_TOP), behavior: 'smooth' });
      });
      scrub.appendChild(node);
    }
  }

  /* ---------------- 交互 ---------------- */

  canvas.addEventListener('click', (e) => {
    const favBtn = e.target.closest('.tile-fav');
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const i = +tile.dataset.i;
    const p = store.view[i];
    if (!p) return;

    if (favBtn) {
      e.stopPropagation();
      const on = toggleFav(p);
      tile.classList.toggle('faved', on);
      return;
    }
    setSel(i, false);
    onOpen?.(i);
  });

  /* ---------------- 选中 ---------------- */

  function setSel(i, scroll = true) {
    if (sel === i) return;
    tileOf.get(sel)?.classList.remove('sel');
    sel = i;
    tileOf.get(sel)?.classList.add('sel');
    if (scroll) scrollToIndex(i, 'nearest');
  }

  function move(dx, dy) {
    const n = store.view.length;
    if (!n) return;
    if (sel < 0) return setSel(0);

    if (dx) return setSel(clamp(sel + dx, 0, n - 1));

    const at = locate[sel];
    if (!at) return setSel(clamp(sel + dy, 0, n - 1));
    const cur = rows[at.r];
    const cx = cur.cells[at.c].x + cur.cells[at.c].w / 2;

    // 找相邻的照片行（跳过分组标题）
    let r = at.r + (dy > 0 ? 1 : -1);
    while (r >= 0 && r < rows.length && rows[r].type !== 'row') r += dy > 0 ? 1 : -1;
    if (r < 0 || r >= rows.length) return;

    let best = rows[r].cells[0], bd = Infinity;
    for (const c of rows[r].cells) {
      const d = Math.abs(c.x + c.w / 2 - cx);
      if (d < bd) { bd = d; best = c; }
    }
    setSel(best.i);
  }

  function scrollToIndex(i, mode = 'center') {
    const at = locate[i];
    if (!at) return;
    const row = rows[at.r];
    const top = scroller.scrollTop;
    const H = scroller.clientHeight;
    if (mode === 'nearest' && row.y >= top + 8 && row.y + row.h <= top + H - 8) return;
    const want = mode === 'center'
      ? row.y - (H - row.h) / 2
      : (row.y < top ? row.y - 20 : row.y + row.h - H + 20);
    scroller.scrollTo({ top: clamp(want, 0, Math.max(0, totalH - H)), behavior: mode === 'center' ? 'auto' : 'smooth' });
  }

  /* ---------------- 生命周期 ---------------- */

  /** 视口顶部那张照片，重排后用它把位置钉回去 */
  function topPhoto() {
    const r = firstRowAt(scroller.scrollTop);
    for (let i = r; i < rows.length; i++) {
      if (rows[i].type === 'row') return store.view[rows[i].cells[0].i];
    }
    return null;
  }

  function rebuild({ animate = false, keepScroll = false } = {}) {
    const prevTop = scroller.scrollTop;
    const anchor = keepScroll ? topPhoto() : null;

    for (const [, n] of mounted) n.remove();
    mounted.clear(); tileOf.clear();
    if (animate) freshUntil = performance.now() + 500;
    layout();

    if (!keepScroll) {
      scroller.scrollTop = 0;
    } else {
      // 边扫描边排序时次序会变，尽量停在同一张照片上，而不是同一个像素位置
      const i = anchor ? store.view.indexOf(anchor) : -1;
      const want = i >= 0 && locate[i] ? rows[locate[i].r].y - PAD_TOP : prevTop;
      scroller.scrollTop = clamp(want, 0, Math.max(0, totalH - scroller.clientHeight));
    }
    render();
    renderScrub();
  }

  const ro = new ResizeObserver(rafThrottle(() => {
    const w = canvas.clientWidth || scroller.clientWidth;
    if (Math.abs(w - width) < 1) return;
    // 保持视口中心那张照片大致不动
    const anchor = anchorIndex();
    layout();
    render();
    renderScrub();
    if (anchor >= 0) scrollToIndex(anchor, 'center');
  }));
  ro.observe(scroller);

  function anchorIndex() {
    const mid = scroller.scrollTop + scroller.clientHeight / 2;
    const r = firstRowAt(mid);
    for (let i = r; i >= 0; i--) if (rows[i]?.type === 'row') return rows[i].cells[0].i;
    return -1;
  }

  scroller.addEventListener('scroll', onScroll, { passive: true });

  // 扫描期间元数据是陆续到的，会反复触发重排：保持位置、也别反复播入场动画
  bus.on('view', () => {
    sel = -1;
    rebuild({ animate: !store.scanning, keepScroll: store.scanning });
  });
  bus.on('fav', (p) => {
    for (const [i, tile] of tileOf) {
      if (store.view[i] === p) tile.classList.toggle('faved', p.fav);
    }
  });

  return {
    rebuild,
    relayout: () => { const a = anchorIndex(); layout(); render(); renderScrub(); if (a >= 0) scrollToIndex(a, 'center'); },
    render,
    move,
    setSel,
    get selected() { return sel; },
    scrollToIndex,
    /** 查看器切换到某张时，让网格也跟过去 */
    follow(i) { setSel(i, false); scrollToIndex(i, 'nearest'); },
    destroy() { ro.disconnect(); scroller.removeEventListener('scroll', onScroll); },
  };
}
