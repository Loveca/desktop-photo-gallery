/* ============================================================
   沉浸式查看器
   适应窗口 / 自由缩放平移 / 交叉淡入切换 / 胶片条 / EXIF 面板 /
   幻灯片（可选 Ken Burns 推移）/ 闲置自动隐藏界面
   ============================================================ */

import { media } from './media.js';
import { store, toggleFav } from './store.js';
import { $, el, clamp, icon, fmtSize, fmtDate, weekdayOf, fmtShutter, fmtFocal, fmtAperture, ext } from './util.js';

const IDLE_MS   = 2600;
const FILM_HALF = 60;

export function createViewer({ onIndexChange }) {
  const root   = $('#viewer');
  const stage  = $('#vwStage');
  const frame  = $('#vwFrame');
  const img    = $('#vwImg');
  const fail   = $('#vwFail');
  const ambient= $('#vwAmbient');
  const chrome = $('#vwChrome');
  const panel  = $('#vwPanel');
  const track  = $('#filmTrack');
  const strip  = $('#filmstrip');
  const prog   = $('#vwSlideProg').firstElementChild;

  let index = -1;
  let photo = null;
  let open  = false;

  // 变换状态：frame 的 transform 为 translate(tx,ty) scale(scale)，原点 0 0
  let nw = 0, nh = 0;              // 图片自然像素
  let scale = 1, fitScale = 1, tx = 0, ty = 0;
  let token = 0;                   // 防止慢加载覆盖新图

  let idleTimer = null, hoverChrome = false;
  let playing = false, slideTimer = null;
  let filmFrom = -1;

  /* ---------------- 舞台盒子 ---------------- */

  function stageBox() {
    const W = root.clientWidth, H = root.clientHeight;
    const narrow = W < 720;
    const panelW = (!panel.hidden && !narrow) ? panel.offsetWidth : 0;
    const pad = narrow ? { t: 46, b: 26, x: 12 } : { t: 52, b: 96, x: 56 };
    return {
      W, H, panelW,
      x: pad.x,
      y: pad.t,
      w: Math.max(60, W - panelW - pad.x * 2),
      h: Math.max(60, H - pad.t - pad.b),
    };
  }

  function computeFit() {
    const b = stageBox();
    if (!nw || !nh) { fitScale = 1; return; }
    fitScale = Math.min(b.w / nw, b.h / nh);
    if (fitScale > 1) fitScale = Math.min(fitScale, 1.0);   // 小图不放大，保持锐利
  }

  function centerAtFit() {
    const b = stageBox();
    scale = fitScale;
    tx = b.x + (b.w - nw * scale) / 2;
    ty = b.y + (b.h - nh * scale) / 2;
    apply();
  }

  function clampPan() {
    const b = stageBox();
    const iw = nw * scale, ih = nh * scale;
    const availL = 0, availR = b.W - b.panelW;
    if (iw <= availR - availL) tx = availL + (availR - availL - iw) / 2;
    else tx = clamp(tx, availR - iw, availL);
    if (ih <= b.H) ty = (b.H - ih) / 2;
    else ty = clamp(ty, b.H - ih, 0);
  }

  function apply() {
    frame.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${scale})`;
    $('#vwZoomVal').textContent = Math.round(scale * 100) + '%';
    const zoomed = scale > fitScale * 1.01;
    stage.classList.toggle('grab', zoomed);
    stage.classList.toggle('zoomable', !zoomed && !!nw);
  }

  function zoomTo(next, cx, cy) {
    const b = stageBox();
    const min = fitScale * 0.6;
    const max = Math.max(8, fitScale * 6);
    next = clamp(next, min, max);
    if (cx == null) { cx = b.x + b.w / 2; cy = b.y + b.h / 2; }
    const px = (cx - tx) / scale, py = (cy - ty) / scale;
    scale = next;
    tx = cx - px * scale;
    ty = cy - py * scale;
    if (scale <= fitScale * 1.005) centerAtFit(); else { clampPan(); apply(); }
  }

  /* ---------------- 载入一张 ---------------- */

  async function show(i, dir = 0) {
    const list = store.view;
    if (!list.length) return close();
    index = (i + list.length) % list.length;
    photo = list[index];
    const my = ++token;

    onIndexChange?.(index);
    paintChrome();
    paintPanel();
    buildFilm();
    markFilm();

    // 环境底用缩略图，便宜且够用
    media.thumb(photo).then((u) => {
      if (my !== token) return;
      ambient.style.backgroundImage = `url("${u}")`;
    }).catch(() => { ambient.style.backgroundImage = 'none'; });

    let url;
    try { url = await media.full(photo); }
    catch { return showFail(); }
    if (my !== token) return;

    const ghost = spawnGhost();
    const probe = new Image();
    probe.decoding = 'async';
    probe.src = url;

    try { await probe.decode(); }
    catch {
      if (my !== token) return;
      ghost?.remove();
      return showFail();
    }
    if (my !== token) { return; }

    fail.hidden = true;
    img.hidden = false;
    nw = probe.naturalWidth  || photo.w || 1;
    nh = probe.naturalHeight || photo.h || 1;
    img.src = url;
    img.style.width  = nw + 'px';
    img.style.height = nh + 'px';
    img.classList.remove('fresh');
    void img.offsetWidth;
    img.classList.add('fresh');

    computeFit();
    centerAtFit();
    if (ghost) setTimeout(() => ghost.remove(), 360);

    preload(dir);
    if (playing) armSlide();
  }

  function spawnGhost() {
    if (!img.src || img.hidden) return null;
    const wrap = el('div', 'vw-ghost');
    wrap.style.transform = frame.style.transform;
    wrap.style.transformOrigin = '0 0';
    const c = new Image();
    c.src = img.src;
    c.style.width = img.style.width;
    c.style.height = img.style.height;
    wrap.appendChild(c);
    stage.appendChild(wrap);
    wrap.addEventListener('animationend', () => wrap.remove(), { once: true });
    return wrap;
  }

  function showFail() {
    img.hidden = true;
    fail.hidden = false;
    $('#vwFailName').textContent = `${photo?.name || ''} · ${ext(photo?.name || '').toUpperCase()}`;
    if (photo) photo.dead = true;
    nw = nh = 0;
    apply();
  }

  function preload(dir) {
    const list = store.view;
    const pin = new Set([photo.id]);
    const around = dir >= 0 ? [1, 2, -1] : [-1, -2, 1];
    for (const d of around) {
      const p = list[(index + d + list.length) % list.length];
      if (!p || p === photo) continue;
      pin.add(p.id);
      media.full(p).then((u) => { const im = new Image(); im.decoding = 'async'; im.src = u; }).catch(() => {});
    }
    media.pinFull(pin);
  }

  /* ---------------- 顶部 / 面板 ---------------- */

  function paintChrome() {
    $('#vwName').textContent  = photo.name;
    $('#vwPath').textContent  = photo.dir || '根目录';
    $('#vwIndex').textContent = `${index + 1} / ${store.view.length}`;
    $('#vwFav').classList.toggle('on', !!photo.fav);
    const only = store.view.length <= 1;
    $('#vwPrev').disabled = only;
    $('#vwNext').disabled = only;
  }

  function row(dt, dd) { return dd ? `<dt>${dt}</dt><dd>${dd}</dd>` : ''; }

  function paintPanel() {
    if (panel.hidden) return;
    const m = photo.meta || {};
    const body = $('#vwPanelBody');

    const cam = [m.make, m.model].filter(Boolean).join(' ')
      .replace(/(\w+)\s+\1/i, '$1');            // "NIKON NIKON Z6" 这种重复去掉
    const shutter = fmtShutter(m.exposure);
    const aperture = fmtAperture(m.fnumber);
    const iso = m.iso ? 'ISO ' + m.iso : null;

    const dims = photo.w && photo.h
      ? `${photo.w} × ${photo.h}` + (photo.w * photo.h >= 1e6 ? `  ·  ${(photo.w * photo.h / 1e6).toFixed(1)} MP` : '')
      : '未知';

    let html = '';

    if (shutter || aperture || iso) {
      html += `<div class="panel-sec"><h5>曝光</h5><div class="exposure">
        <div><b>${aperture || '—'}</b><span>光圈</span></div>
        <div><b>${shutter || '—'}</b><span>快门</span></div>
        <div><b>${m.iso || '—'}</b><span>ISO</span></div>
      </div></div>`;
    }

    html += `<div class="panel-sec"><h5>文件</h5><dl class="panel-kv">
      ${row('文件名', escapeHtml(photo.name))}
      ${row('位置', escapeHtml(photo.dir || '根目录'))}
      ${row('大小', fmtSize(photo.size))}
      ${row('尺寸', dims)}
      ${row('格式', ext(photo.name).toUpperCase())}
    </dl></div>`;

    const taken = photo.taken
      ? fmtDate(photo.taken) + '  ' + weekdayOf(photo.taken)
      : null;
    html += `<div class="panel-sec"><h5>时间</h5><dl class="panel-kv">
      ${row('拍摄', m.taken ? taken : null)}
      ${row('修改', fmtDate(photo.mtime))}
    </dl></div>`;

    if (cam || m.lens || m.focal || m.gps) {
      html += `<div class="panel-sec"><h5>相机</h5><dl class="panel-kv">
        ${row('机身', escapeHtml(cam))}
        ${row('镜头', escapeHtml(m.lens))}
        ${row('焦距', fmtFocal(m.focal) + (m.focal35 && Math.round(m.focal35) !== Math.round(m.focal || 0) ? ` (等效 ${fmtFocal(m.focal35)})` : ''))}
        ${row('坐标', m.gps ? `${m.gps[0]}, ${m.gps[1]}` : null)}
      </dl></div>`;
    }

    body.innerHTML = html;
  }

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 胶片条 ---------------- */

  function buildFilm() {
    const list = store.view;
    const from = Math.max(0, Math.min(index - FILM_HALF, list.length - FILM_HALF * 2 - 1));
    const start = Math.max(0, from);
    if (filmFrom >= 0 && Math.abs(index - (filmFrom + FILM_HALF)) < FILM_HALF / 2 && track.childElementCount) return;
    filmFrom = start;

    const end = Math.min(list.length, start + FILM_HALF * 2 + 1);
    track.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const p = list[i];
      const cell = el('div', 'film-cell' + (p.fav ? ' fav' : ''));
      cell.dataset.i = i;
      const im = new Image();
      cell.appendChild(im);
      const cached = media.peekThumb(p);
      if (cached) im.src = cached;
      else media.thumb(p).then((u) => { im.src = u; }).catch(() => {});
      frag.appendChild(cell);
    }
    track.appendChild(frag);
  }

  function markFilm() {
    for (const c of track.children) c.classList.toggle('on', +c.dataset.i === index);
    const cur = track.querySelector('.film-cell.on');
    if (cur) {
      strip.scrollTo({
        left: cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2,
        behavior: 'smooth',
      });
    }
  }

  track.addEventListener('click', (e) => {
    const cell = e.target.closest('.film-cell');
    if (!cell) return;
    const i = +cell.dataset.i;
    show(i, i > index ? 1 : -1);
  });

  /* ---------------- 幻灯片 ---------------- */

  function armSlide() {
    clearTimeout(slideTimer);
    const ms = store.settings.slideMs;

    prog.style.transition = 'none';
    prog.style.width = '0%';
    void prog.offsetWidth;
    prog.style.transition = `width ${ms}ms linear`;
    prog.style.width = '100%';

    if (store.settings.kenBurns && nw) {
      const dx = (Math.random() * 2 - 1) * 1.6;
      const dy = (Math.random() * 2 - 1) * 1.2;
      const zin = Math.random() > 0.5;
      img.style.setProperty('--kb-from', zin ? 'scale(1) translate(0,0)' : `scale(1.07) translate(${dx}%, ${dy}%)`);
      img.style.setProperty('--kb-to',   zin ? `scale(1.07) translate(${dx}%, ${dy}%)` : 'scale(1) translate(0,0)');
      img.style.setProperty('--kb-dur', ms + 'ms');
      root.classList.add('kb');
      img.style.animation = 'none';
      void img.offsetWidth;
      img.style.animation = '';
    }

    slideTimer = setTimeout(() => show(index + 1, 1), ms);
  }

  function setPlaying(on) {
    playing = on;
    root.classList.toggle('playing', on);
    if (on) { armSlide(); kickIdle(true); }
    else {
      clearTimeout(slideTimer);
      root.classList.remove('kb');
      img.style.animation = 'none';
      prog.style.transition = 'none';
      prog.style.width = '0%';
      kickIdle();
    }
  }

  /* ---------------- 闲置隐藏 ---------------- */

  function kickIdle(force = false) {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!open) return;
    if (hoverChrome && !force) return;
    idleTimer = setTimeout(() => {
      if (!hoverChrome) root.classList.add('idle');
    }, playing ? 1600 : IDLE_MS);
  }

  chrome.addEventListener('pointerenter', () => { hoverChrome = true; kickIdle(); }, true);
  chrome.addEventListener('pointerleave', () => { hoverChrome = false; kickIdle(); }, true);
  root.addEventListener('pointermove', () => kickIdle());

  /* ---------------- 指针：缩放 / 平移 / 拖拽翻页 ---------------- */

  const pts = new Map();
  let dragging = false, swipe = 0, startX = 0, startY = 0, startTx = 0, startTy = 0;
  let pinchD0 = 0, pinchS0 = 1;

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchD0 = Math.hypot(a.x - b.x, a.y - b.y);
      pinchS0 = scale;
      dragging = false;
      return;
    }
    dragging = true;
    swipe = 0;
    startX = e.clientX; startY = e.clientY;
    startTx = tx; startTy = ty;
    stage.classList.add('grabbing');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD0 > 0) zoomTo(pinchS0 * (d / pinchD0), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!dragging) return;

    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (scale > fitScale * 1.01) {
      tx = startTx + dx; ty = startTy + dy;
      clampPan(); apply();
    } else if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
      swipe = dx;
      frame.style.transition = 'none';
      frame.style.transform =
        `translate3d(${(tx + dx * 0.45).toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${scale})`;
    }
  });

  function endPointer(e) {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchD0 = 0;
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('grabbing');

    if (swipe && Math.abs(swipe) > 70) {
      const dir = swipe < 0 ? 1 : -1;
      swipe = 0;
      show(index + dir, dir);
      return;
    }
    if (swipe) {
      frame.style.transition = 'transform .28s cubic-bezier(.22,.78,.24,1)';
      apply();
      setTimeout(() => { frame.style.transition = ''; }, 300);
      swipe = 0;
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (e) => {
    if (!nw) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.02 : 0.0016));
    zoomTo(scale * f, e.clientX, e.clientY);
    kickIdle();
  }, { passive: false });

  stage.addEventListener('dblclick', (e) => {
    if (!nw) return;
    if (scale > fitScale * 1.01) centerAtFit();
    else zoomTo(Math.max(1, fitScale * 2.5), e.clientX, e.clientY);
  });

  /* ---------------- 打开 / 关闭 ---------------- */

  function openAt(i) {
    if (open) return show(i, 0);
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.remove('closing');
    document.body.style.overflow = 'hidden';
    show(i, 0);
    kickIdle();
    root.focus?.();
  }

  function close() {
    if (!open) return;
    open = false;
    token++;
    setPlaying(false);
    clearTimeout(idleTimer);
    root.classList.add('closing');
    root.classList.remove('idle');
    setTimeout(() => {
      root.hidden = true;
      root.classList.remove('closing');
      root.setAttribute('aria-hidden', 'true');
      img.removeAttribute('src');
      ambient.style.backgroundImage = 'none';
      stage.querySelectorAll('.vw-ghost').forEach((n) => n.remove());
    }, 180);
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  /* ---------------- 按钮 ---------------- */

  $('#vwPrev').addEventListener('click', () => show(index - 1, -1));
  $('#vwNext').addEventListener('click', () => show(index + 1, 1));
  $('#vwClose').addEventListener('click', close);
  $('#vwZoomIn').addEventListener('click', () => zoomTo(scale * 1.4));
  $('#vwZoomOut').addEventListener('click', () => zoomTo(scale / 1.4));
  $('#vwZoomVal').addEventListener('click', () => centerAtFit());
  $('#vwSlide').addEventListener('click', () => setPlaying(!playing));

  $('#vwFav').addEventListener('click', () => {
    const on = toggleFav(photo);
    $('#vwFav').classList.toggle('on', on);
    const cell = track.querySelector(`.film-cell[data-i="${index}"]`);
    cell?.classList.toggle('fav', on);
  });

  function togglePanel(force) {
    const willOpen = force ?? panel.hidden;
    panel.hidden = !willOpen;
    root.classList.toggle('panel-open', willOpen);
    $('#vwInfo').classList.toggle('on', willOpen);
    if (willOpen) paintPanel();
    if (nw) { computeFit(); centerAtFit(); }
  }
  $('#vwInfo').addEventListener('click', () => togglePanel());
  $('#vwPanelClose').addEventListener('click', () => togglePanel(false));

  $('#vwFull').addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    root.classList.toggle('fs', !!document.fullscreenElement);
    if (open && nw) { computeFit(); centerAtFit(); }
  });

  // 点空白处退出（拖动过就不算）
  stage.addEventListener('click', (e) => {
    if (e.target !== stage) return;
    if (Math.abs(swipe) > 4) return;
    close();
  });

  window.addEventListener('resize', () => {
    if (!open || !nw) return;
    computeFit(); centerAtFit();
  });

  /* ---------------- 键盘 ---------------- */

  function onKey(e) {
    if (!open) return false;
    const k = e.key;
    if (k === 'Escape')      { close(); }
    else if (k === 'ArrowLeft')  { show(index - 1, -1); }
    else if (k === 'ArrowRight') { show(index + 1, 1); }
    else if (k === 'Home')   { show(0, -1); }
    else if (k === 'End')    { show(store.view.length - 1, 1); }
    else if (k === ' ')      { setPlaying(!playing); }
    else if (k === 'i' || k === 'I') { togglePanel(); }
    else if (k === 's' || k === 'S') { $('#vwFav').click(); }
    else if (k === 'f' || k === 'F') { toggleFullscreen(); }
    else if (k === '0')      { centerAtFit(); }
    else if (k === '+' || k === '=') { zoomTo(scale * 1.4); }
    else if (k === '-' || k === '_') { zoomTo(scale / 1.4); }
    else return false;
    e.preventDefault();
    kickIdle(true);
    return true;
  }

  return {
    openAt,
    close,
    onKey,
    get isOpen() { return open; },
    get index() { return index; },
    /** 视图重排后，尽量停在同一张照片上 */
    resync() {
      if (!open) return;
      const i = store.view.indexOf(photo);
      if (i < 0) return close();
      index = i;
      paintChrome();
      filmFrom = -1;
      buildFilm(); markFilm();
    },
  };
}
