/* 渲染层：今日 / 本周 / 习惯卡片 / 日历周视图，全部由 IndexedDB 真数据驱动 */

import { db } from './db.js';
import {
  todayStr, weekDates, dateStr, dayHead, ddlText, daysUntil, toMinutes,
  todayIdxInWeek, periodOf,
} from './util.js';

export const HOUR_H = 56, START_H = 8, END_H = 22;

/* ── 类别缓存 ── */
let CATS = {};
export async function loadCats() {
  CATS = Object.fromEntries((await db.getAll('categories')).map(c => [c.id, c]));
}
export const catList = () => Object.values(CATS);
export const catName = (id) => (CATS[id] ? CATS[id].name : id);
/** 类别兜底：不存在的类别归到「生活杂事」 */
export const normalizeCat = (id) => (CATS[id] ? id : 'life');

/* ── 工具 ── */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'anno-toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ── 完成庆祝动效 ── */
let celebEl = null, celebTimer = null;
const PRAISES = ['好耶！', '棒！', '真不错～', '继续保持！', '太厉害啦！', '满分节奏！', '冲冲冲！', '爱了爱了！', '越来越棒！', '今天也很努力！'];
export function showCelebration(count = 1) {
  if (celebEl) celebEl.remove();
  clearTimeout(celebTimer);
  const el = document.createElement('div');
  el.className = 'celebrate';

  // 完成越多越热闹：4 档（1 件 / 3 件 / 5 件 / 10 件+）
  const tier = count >= 10 ? 3 : count >= 5 ? 2 : count >= 3 ? 1 : 0;
  const n = 22 + tier * 18; // 彩带数量
  const colors = ['#EF6E5A', '#EFAF3C', '#55B37E', '#EF87A5', '#6B9CD8', '#F7B26C', '#B78BE0', '#5BC0BE'];
  let particles = '';
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 80 + Math.random() * 150;
    const c = colors[i % colors.length];
    const s = 5 + Math.random() * 8;
    particles += `<i class="fw-p" style="--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;` +
      `background:${c};width:${s.toFixed(0)}px;height:${s.toFixed(0)}px;animation-delay:${(Math.random() * 0.12).toFixed(2)}s"></i>`;
  }

  // 文案：里程碑 > 连击 > 随机夸奖
  let phrase;
  if (count === 1) phrase = '好耶！';
  else if (count >= 10) phrase = '今日 MVP！🏆';
  else if (count % 5 === 0) phrase = `今天完成 ${count} 件啦！`;
  else if (count % 3 === 0) phrase = `连击 ×${count} 🎉`;
  else phrase = PRAISES[count % PRAISES.length];

  const size = 96 + tier * 22; // 吉祥物随档位变大
  el.innerHTML = `<div class="glow"></div>${particles}` +
    `<svg class="face" viewBox="0 0 64 64" style="width:${size}px;height:${size}px"><use href="#mascotFaceHappy"/></svg>` +
    `<div class="celebrate-txt">${phrase}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  celebEl = el;
  celebTimer = setTimeout(() => { el.remove(); celebEl = null; }, 1600);
}

/* ── 习惯视图模型：本周进度 + 连续天数（由 habitLogs 计算） ── */
export function buildRoutineVMs(routines, logs) {
  const week = weekDates(0).map(dateStr);
  const today = todayStr();
  return routines.map(r => {
    const mine = logs.filter(l => l.routineId === r.id && l.done);
    const weekDone = mine.filter(l => week.includes(l.date)).length;
    // 连续打卡：从今天往前走，跳过未安排的日子，遇到安排了但没打卡即断
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 400; i++) {
      if (r.daysOfWeek.includes(d.getDay())) {
        if (dateStr(d) === today) {
          // 今天还没打不算断，也不计入
        } else if (mine.some(l => l.date === dateStr(d))) streak++;
        else break;
      }
      d.setDate(d.getDate() - 1);
    }
    return { ...r, weekDone, weekTotal: r.daysOfWeek.length, streak };
  });
}

export function freqText(days) {
  if (days.length === 7) return '每天';
  const sorted = [...days].sort((a, b) => a - b);
  return '每周' + sorted.map(d => '日一二三四五六'[d]).join('、');
}

/** 习惯表单的星期选择 chips（0=周日，与 JS Date 对齐） */
export const WD_CHIPS = () =>
  ['日', '一', '二', '三', '四', '五', '六']
    .map((d, i) => `<button class="chip" data-day="${i}">周${d}</button>`).join('');

/* ── 任务 meta 文案 ── */
function taskMeta(t, vmMap) {
  if (t.type === 'routine_instance') {
    const vm = vmMap[t.routineId];
    return `<span class="pill">习惯</span><span>${vm && vm.streak ? '连续 ' + vm.streak + ' 天' : ''}</span>`;
  }
  if (t.type === 'ddl') {
    const n = t.deadline || t.date;
    const warn = daysUntil(n) <= 1;
    return `<span class="pill">DDL</span><span class="${warn ? 'warn' : ''}">${esc(ddlText(n))}</span>`;
  }
  if (t.type === 'event') return `<span>${esc(t.startTime || '')}${t.endTime ? ' – ' + esc(t.endTime) : ''}</span>`;
  return t.note ? `<span>${esc(t.note)}</span>` : '';
}

/* ── 今日 To Do ── */
const PERIODS = ['上午', '下午', '晚上', '全天'];
export function renderToday(tasks, vmMap) {
  const wrap = document.getElementById('todayItems');
  const byPeriod = Object.fromEntries(PERIODS.map(p => [p, []]));
  tasks.forEach(t => byPeriod[periodOf(t.startTime)].push(t));
  let html = '';
  for (const p of PERIODS) {
    const list = byPeriod[p].sort((a, b) => (a.startTime || '99').localeCompare(b.startTime || '99'));
    if (!list.length) continue;
    html += `<div class="group-label">${p}</div>` + list.map(t => `
      <div class="task${t.status === 'done' ? ' done' : ''}" style="--cat:var(--c-${t.categoryId})" data-id="${t.id}" draggable="true" title="点这里编辑 · 可拖到日历改期">
        <button class="cb">✓</button>
        <div class="task-main">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">${taskMeta(t, vmMap)}</div>
        </div>
        <button class="t-del" data-id="${t.id}" title="删除">✕</button>
      </div>`).join('');
  }
  wrap.innerHTML = html || '<div class="group-label">今天还没有安排，点下面加一条吧</div>';

  const done = tasks.filter(t => t.status === 'done').length;
  const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  document.getElementById('progText').textContent = `${done}/${tasks.length} 已完成`;
  document.getElementById('progPct').textContent = pct + '%';
  document.getElementById('progBar').style.width = pct + '%';
  document.getElementById('bubble').textContent =
    pct === 100 && tasks.length ? '全部完成！你太棒啦！' : '今天也要加油鸭！';
}

/* ── 本周待办 ── */
function weekItemMeta(t) {
  if (t.type === 'ddl') {
    const n = t.deadline || t.date;
    return { text: 'DDL · ' + ddlText(n), warn: daysUntil(n) <= 1 };
  }
  if (t.type === 'routine_instance') return { text: '习惯', warn: false };
  if (t.type === 'event') return { text: t.startTime + (t.endTime ? ' – ' + t.endTime : ''), warn: false };
  return { text: t.note || '', warn: false };
}
export function renderWeek(tasks) {
  const wrap = document.getElementById('weekItems');
  const byDate = new Map();
  tasks.forEach(t => {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  });
  let html = '';
  for (const date of [...byDate.keys()].sort()) {
    const d = new Date(date.replace(/-/g, '/'));
    html += `<div class="week-day-head">${dayHead(d)}</div>`;
    html += byDate.get(date).map(t => {
      const m = weekItemMeta(t);
      return `
      <div class="week-item${t.status === 'done' ? ' done' : ''}" style="--cat:var(--c-${t.categoryId})" data-id="${t.id}" draggable="true" title="点圆圈打勾 · 点标题编辑 · 可拖到日历改期">
        <span class="dot"></span>
        <span class="wi-title">${esc(t.title)}</span>
        ${m.text ? `<span class="wi-meta${m.warn ? ' warn' : ''}">${esc(m.text)}</span>` : ''}
        <span class="wi-check">✓</span>
        <button class="t-del" data-id="${t.id}" title="删除">✕</button>
      </div>`;
    }).join('');
  }
  wrap.innerHTML = html || '<div class="anno-empty">本周还没有待办，叨叨一句就有了～</div>';
}

/* ── 习惯迷你卡片（本周面板顶部） ── */
export function renderRoutineMini(vms) {
  document.getElementById('routineCards').innerHTML = vms.filter(r => r.active).map(r => `
    <div class="routine-card${r.active ? '' : ' paused'}" style="--cat:var(--c-${r.categoryId})" data-id="${r.id}">
      <div class="rt"><span>${esc(r.title)}</span><i>${r.weekDone}/${r.weekTotal}</i></div>
      <div class="track"><i style="width:${Math.round(r.weekDone / r.weekTotal * 100)}%"></i></div>
    </div>`).join('');
}

/* ── 日历周视图 ── */
const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/* 同一天时间重叠的日程 → 并排分列（先按时间归"簇"，簇内贪心找空列），互不遮挡 */
export function packDayEvents(evs) {
  const items = evs
    .map(e => {
      const s = toMinutes(e.startTime);
      const en = toMinutes(e.endTime || e.startTime) + 30; // 无结束时间默认占半小时
      return { e, s, en };
    })
    .sort((a, b) => a.s - b.s || a.en - b.en);
  const out = [];
  let cluster = [], clusterEnd = 0;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds = []; // 每列当前最后一刻结束时间
    for (const it of cluster) {
      let col = colEnds.findIndex(end => end <= it.s);
      if (col === -1) { col = colEnds.length; colEnds.push(it.en); }
      else colEnds[col] = it.en;
      it.col = col;
    }
    const n = Math.max(colEnds.length, 1);
    for (const it of cluster) {
      it.leftPct = (it.col * 100) / n;
      it.widthPct = 100 / n;
      out.push(it);
    }
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush(); // 与前面都不重叠 → 前一簇收尾
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.en);
  }
  flush();
  return out;
}

export function renderCalendar(dates, tasks, { showNow }) {
  const grid = document.getElementById('calGrid');
  grid.style.height = ''; // 复位（月视图会设 100%）
  const todayIdx = todayIdxInWeek();
  const isCurrentWeek = showNow;
  const strDates = dates.map(dateStr);

  let html = '<div class="cal-header-row"><div></div>';
  dates.forEach((d, i) => {
    html += `<div class="gh-day${isCurrentWeek && i === todayIdx ? ' today' : ''}" data-date="${strDates[i]}"><span>周${'日一二三四五六'[d.getDay()]}</span><b>${d.getDate()}</b></div>`;
  });
  html += '</div><div class="allday-row"><div class="gutter-label">全天</div>';
  for (let i = 0; i < 7; i++) {
    const ad = tasks.filter(t => !t.startTime && t.date === strDates[i]);
    html += `<div class="ad-cell" data-date="${strDates[i]}">` +
      ad.map(a => `<div class="ad-item" data-id="${a.id}" draggable="true"><div class="ad-pill" style="--c:var(--c-${a.categoryId})">${esc(a.title)}</div><button class="t-del" data-id="${a.id}" title="删除">✕</button></div>`).join('') +
      `</div>`;
  }
  html += '</div><div class="time-area" id="timeArea"><div class="cols-wrap">';
  for (let i = 0; i < 7; i++) {
    html += `<div class="col" data-day="${i}" data-date="${strDates[i]}">`;
    for (const it of packDayEvents(tasks.filter(t => t.startTime && t.date === strDates[i]))) {
      const e = it.e;
      const top = (it.s - START_H * 60) / 60 * HOUR_H;
      const h = Math.max((it.en - it.s) / 60 * HOUR_H, 20);
      html += `<div class="evt${h < 34 ? ' sm' : ''}" style="--c:var(--c-${e.categoryId});top:${top}px;height:${h - 2}px;left:calc(${it.leftPct}% + 2px);width:calc(${it.widthPct}% - 4px)" data-id="${e.id}" draggable="true" title="点击：完成 / 删除 / 编辑 · 可拖到别的时间">
        <div class="evt-t">${esc(e.title)}</div><div class="evt-s">${e.startTime}${e.endTime ? ' - ' + e.endTime : ''}</div><button class="t-del" data-id="${e.id}" title="删除">✕</button></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  for (let i = 0; i <= END_H - START_H; i++) {
    html += `<div class="hour-line" style="top:${i * HOUR_H}px"></div>`;
    if (i < END_H - START_H) html += `<div class="hour-label" style="top:${i * HOUR_H}px">${fmt((START_H + i) * 60)}</div>`;
  }
  html += `<div class="now-line" id="nowLine"${isCurrentWeek ? '' : ' style="display:none"'}><i class="dot"></i><span class="tag" id="nowTag"></span></div>`;
  html += '</div>';
  grid.innerHTML = html;
  if (isCurrentWeek) updateNowLine(true);
}

const nowMinutes = () => {
  const n = new Date();
  return Math.min(Math.max(n.getHours() * 60 + n.getMinutes(), START_H * 60), END_H * 60);
};
export function updateNowLine(scroll) {
  const line = document.getElementById('nowLine');
  if (!line) return;
  const m = nowMinutes();
  const top = (m - START_H * 60) / 60 * HOUR_H;
  line.style.top = top + 'px';
  const tag = document.getElementById('nowTag');
  if (tag) tag.textContent = fmt(m);
  const col = document.querySelector(`.col[data-day="${todayIdxInWeek()}"]`);
  if (col) line.querySelector('.dot').style.left = (col.offsetLeft - 5) + 'px';
  if (scroll) {
    const sc = document.getElementById('calScroll');
    sc.scrollTop = Math.max(0, top - 200);
  }
}

/* ── 月视图（苹果风格）：月首所在周（周一起）到月末所在周日，6 行网格 ── */
/** 锚点月覆盖到的日期数组（含前后补齐的相邻月日期） */
export function monthGridDates(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = new Date(first);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7); // 回到本周周一
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - (end.getDay() + 6) % 7)); // 补到周日
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(new Date(d));
  return dates;
}

/** 月视图：事件按天渲染成小胶囊（复用 .ad-item 结构 → 点弹操作卡片 / 悬停出 ✕ 都直接可用） */
export function renderMonth(anchor, tasks, { showToday }) {
  const grid = document.getElementById('calGrid');
  grid.style.height = '100%'; // 周视图渲染时会复位，让 1fr 行高撑满面板
  const dates = monthGridDates(anchor);
  const today = todayStr();
  const weeks = dates.length / 7;
  const MAX_PILL = 3; // 格子最多直显 3 条，多收进「还有 N 项」

  let html = `<div class="month-grid" style="grid-template-rows:26px repeat(${weeks}, 1fr)">`;
  html += `<div class="mhead-row">${['一', '二', '三', '四', '五', '六', '日'].map(w => `<span>周${w}</span>`).join('')}</div>`;
  for (const d of dates) {
    const str = dateStr(d);
    const out = d.getMonth() !== anchor.getMonth();
    const isToday = showToday && str === today;
    const list = tasks
      .filter(t => t.date === str)
      .sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));
    const shown = list.slice(0, MAX_PILL);
    const more = list.length - shown.length;
    html += `<div class="mday${out ? ' out' : ''}${isToday ? ' today' : ''}" data-date="${str}" title="点这天切到周视图">
      <span class="mnum">${d.getDate()}</span>
      ${shown.map(t => `<div class="ad-item" data-id="${t.id}" draggable="true"><div class="ad-pill" style="--c:var(--c-${t.categoryId})">${t.startTime ? `<b>${esc(t.startTime)}</b>` : ''}${esc(t.title)}</div><button class="t-del" data-id="${t.id}" title="删除">✕</button></div>`).join('')}
      ${more > 0 ? `<span class="mmore">还有 ${more} 项</span>` : ''}
    </div>`;
  }
  html += '</div>';
  grid.innerHTML = html;
}
