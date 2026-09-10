/* 通用小工具 */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function rafThrottle(fn) {
  let queued = false, lastArgs;
  return (...a) => {
    lastArgs = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

export const icon = (id, cls = '') =>
  `<svg class="${cls}"><use href="#${id}"/></svg>`;

/* ---------- 格式化 ---------- */

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function fmtDate(ts, style = 'full') {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (style === 'year')  return y + ' 年';
  if (style === 'month') return `${y} 年 ${m} 月`;
  if (style === 'day')   return `${y} 年 ${m} 月 ${day} 日`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hh}:${mm}`;
}

export const weekdayOf = (ts) => (ts ? WEEK[new Date(ts).getDay()] : '');

/** 今天 / 昨天 / 3 天前 … 只在近期使用 */
export function relDay(ts) {
  if (!ts) return '';
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date();   b.setHours(0, 0, 0, 0);
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return '';
}

/** 1/250 这类快门写法 */
export function fmtShutter(sec) {
  if (!sec) return null;
  if (sec >= 1) return (Math.round(sec * 10) / 10) + 's';
  return '1/' + Math.round(1 / sec) + 's';
}

export function fmtFocal(mm) {
  if (!mm) return null;
  return Math.round(mm) + 'mm';
}

export function fmtAperture(f) {
  if (!f) return null;
  return 'f/' + (f % 1 === 0 ? f : f.toFixed(1));
}

export const ext = (name) => (name.split('.').pop() || '').toLowerCase();

export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
export const dirName  = (path) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};

/** 自然序比较：IMG_2 排在 IMG_10 前面 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
export const natCmp = (a, b) => collator.compare(a, b);

/* ---------- 提示条 ---------- */
let toastHost;
export function toast(msg, kind = '', ms = 2600) {
  toastHost ||= document.getElementById('toasts');
  if (!toastHost) return;
  const t = el('div', 'toast ' + kind);
  t.textContent = msg;
  toastHost.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
}

/* ---------- 浮层 ---------- */
export function popover(trigger, panel) {
  const close = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.classList.remove('on');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => {
    if (panel.contains(e.target) || trigger.contains(e.target)) return;
    close();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!panel.hidden) return close();
    panel.hidden = false;
    trigger.classList.add('on');
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  return { close };
}
