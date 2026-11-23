/* 入口：初始化数据 → 渲染 → 事件接线（语音/习惯看板/设置/主题/分隔条） */

import { db, uid, closeDB } from './db.js';
import { seedIfEmpty, seedDemo, DEFAULT_CATEGORIES, DEFAULT_CATEGORY_KEYWORDS } from './seed.js';
import { migrateLocalStorage, applyCatColors } from './store.js';
import * as R from './render.js';
import { parseInput } from './parse.js';
import { llmParse, llmConfig } from './llm.js';
import * as B from './badges.js';
import { todayStr, weekDates, dateStr, parseDate, dayHead, toMinutes, fmtMin } from './util.js';

const $ = (id) => document.getElementById(id);

let weekOffset = 0; // 周视图正在看的周（0=本周）
let viewMode = 'week'; // 'week' | 'month'
let monthOffset = 0; // 月视图正在看的月（0=本月）

/* ═══════════ Routine 引擎（切片③）：习惯到点自动生成实例进「今日 To Do」 ═══════════
   - 扫描本周（今天起）每天：习惯安排在那天 且 没有实例任务 且 没有当天日志 → 生成一条实例
   - 当天日志（含 done:false）= "今天处理过了"：删掉实例不会马上重生成的标记
   - 过去的日子不回填（周一没开应用就不会冒出逾期的周一实例） */
async function ensureRoutineInstances() {
  const [routines, tasks, logs] = await Promise.all([
    db.getAll('routines'), db.getAll('tasks'), db.getAll('habitLogs'),
  ]);
  const today = todayStr();
  const week = weekDates(0).map(dateStr);
  for (const r of routines) {
    if (!r.active) continue;
    for (const date of week) {
      if (date < today) continue; // 不回填过去
      if (!r.daysOfWeek.includes(new Date(date.replace(/-/g, '/')).getDay())) continue;
      if (tasks.some(t => t.routineId === r.id && t.date === date)) continue;
      if (logs.some(l => l.routineId === r.id && l.date === date)) continue;
      await db.put('tasks', {
        id: uid('t-'), title: r.title, type: 'routine_instance',
        date, startTime: null, endTime: null, deadline: null,
        categoryId: r.categoryId, routineId: r.id, priority: 0, tags: [], note: '',
        source: 'routine', status: 'todo', createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  }
}

/* 删除某习惯生成的全部实例任务（暂停/删除打卡时调用，清空页面里的打卡记录） */
async function removeRoutineInstances(routineId) {
  for (const t of await db.getWhere('tasks', x => x.type === 'routine_instance' && x.routineId === routineId)) {
    await db.delete('tasks', t.id);
  }
}

/* 修改习惯打卡日后，删掉不再属于新打卡日的实例（否则旧日子会残留在本周待办 / 日历里） */
async function pruneRoutineInstances(routineId, daysOfWeek) {
  for (const t of await db.getWhere('tasks', x => x.type === 'routine_instance' && x.routineId === routineId)) {
    const wd = new Date(t.date.replace(/-/g, '/')).getDay();
    if (!daysOfWeek.includes(wd)) await db.delete('tasks', t.id);
  }
}

/* ═══════════ 数据刷新 ═══════════ */
async function refresh() {
  await ensureRoutineInstances(); // 先补齐习惯实例，再取数渲染
  const week0 = weekDates(0).map(dateStr);
  const [weekTasks, routines, logs] = await Promise.all([
    db.getTasksBetween(week0[0], week0[6]),
    db.getAll('routines'),
    db.getAll('habitLogs'),
  ]);
  const vms = R.buildRoutineVMs(routines, logs);
  const vmMap = Object.fromEntries(vms.map(v => [v.id, v]));
  const today = todayStr();

  R.renderToday(weekTasks.filter(t => t.date === today), vmMap);
  // 本周待办 = 本周日历里的事项，但不含今天（今天的一切只出现在「今日 To Do」，不重复）
  R.renderWeek(weekTasks.filter(t => t.date !== today));
  R.renderRoutineMini(vms);

  if (viewMode === 'month') {
    const anchor = new Date();
    anchor.setDate(1);
    anchor.setMonth(anchor.getMonth() + monthOffset);
    const cells = R.monthGridDates(anchor);
    const start = dateStr(cells[0]), end = dateStr(cells[cells.length - 1]);
    let viewTasks;
    if (monthOffset === 0) {
      // 本月格子可能跨到上/下月；本周数据已在 weekTasks 里，合并去重省一次查询
      const extra = await db.getTasksBetween(start, end);
      viewTasks = [...weekTasks, ...extra].filter((t, i, a) => a.findIndex(x => x.id === t.id) === i);
    } else {
      viewTasks = await db.getTasksBetween(start, end);
    }
    // 日历不保留已完成的事项（用户：做完一项，日历里对应的就去掉，看着有歧义）
    R.renderMonth(anchor, viewTasks.filter(t => t.status !== 'done'), { showToday: monthOffset === 0 });
    renderCalTitle();
    return;
  }

  const viewWeek = weekDates(weekOffset).map(dateStr);
  const viewTasks = (weekOffset === 0
    ? weekTasks
    : await db.getTasksBetween(viewWeek[0], viewWeek[6]));
  R.renderCalendar(weekDates(weekOffset), viewTasks.filter(t => t.status !== 'done'), { showNow: weekOffset === 0 });
  renderCalTitle();
}

function renderCalTitle() {
  if (viewMode === 'month') {
    const a = new Date();
    a.setDate(1);
    a.setMonth(a.getMonth() + monthOffset);
    $('calTitle').textContent = `${a.getFullYear()}年${a.getMonth() + 1}月`;
    return;
  }
  const dates = weekDates(weekOffset);
  const mon = dates[0], sun = dates[6];
  $('calTitle').textContent = mon.getMonth() === sun.getMonth()
    ? `${mon.getFullYear()}年${mon.getMonth() + 1}月`
    : `${mon.getFullYear()}年${mon.getMonth() + 1}月–${sun.getMonth() + 1}月`;
}

/* ═══════════ 打勾（今日/本周联动 + 习惯打卡日志） ═══════════ */
async function toggleTask(id, done) {
  const t = await db.get('tasks', id);
  if (!t || t.status === (done ? 'done' : 'todo')) return;
  t.status = done ? 'done' : 'todo';
  t.updatedAt = Date.now();
  await db.put('tasks', t);
  // 习惯实例打勾同步写打卡日志（连续天数/本周进度据此计算）
  if (t.type === 'routine_instance' && t.routineId) {
    const log = await db.getHabitLog(t.routineId, t.date);
    if (log) { log.done = done; await db.put('habitLogs', log); }
    else await db.put('habitLogs', { id: uid('hl-'), routineId: t.routineId, date: t.date, done });
  }
  await refresh();
  if (done) {
    const doneCount = (await db.getTasksByDate(todayStr())).filter(x => x.status === 'done').length;
    R.showCelebration(doneCount);
    // 完成后结算奖章（连续全勤/清零到节点即发）
    const fresh = await B.evaluate();
    if (fresh.length) {
      R.toast(`🏅 获得奖章「${fresh.map(b => b.name).join('」「')}」！`);
      R.showCelebration(doneCount);
    }
  }
}

/* ═══════════ 删除任务（今日/本周/日历通用，带撤销） ═══════════ */
async function deleteTask(id) {
  const t = await db.get('tasks', id);
  if (!t) return;
  await db.delete('tasks', id);
  // 删的是习惯实例 → 记一条当天日志（done:false 不影响连击）， Routine 引擎就不会马上再生成
  if (t.type === 'routine_instance' && t.routineId) {
    const log = await db.getHabitLog(t.routineId, t.date);
    if (!log) await db.put('habitLogs', { id: uid('hl-'), routineId: t.routineId, date: t.date, done: false });
  }
  await refresh();
  // 可撤销：点「撤销」把原任务原样写回
  const el = document.createElement('div');
  el.className = 'anno-toast';
  el.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 18px;';
  const hint = t.type === 'routine_instance' ? '（习惯实例：不想再生成可到打卡看板暂停该习惯）' : '';
  el.innerHTML = `<span>${R.esc(`已删除「${t.title}」${hint}`)}</span>` +
    `<button style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px">撤销</button>`;
  el.querySelector('button').onclick = async () => {
    await db.put('tasks', t);
    el.remove();
    await refresh();
    R.toast('已恢复');
  };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), hint ? 8000 : 6000);
}

$('todayPanel').addEventListener('click', (e) => {
  const del = e.target.closest('.t-del');
  if (del?.dataset.id) return deleteTask(del.dataset.id);
  const task = e.target.closest('.task');
  if (!task?.dataset.id) return;
  if (e.target.closest('.cb')) {
    toggleTask(task.dataset.id, !task.classList.contains('done'));
    return;
  }
  openEditTask(task.dataset.id);
});
$('weekItems').addEventListener('click', (e) => {
  const del = e.target.closest('.t-del');
  if (del?.dataset.id) return deleteTask(del.dataset.id);
  const item = e.target.closest('.week-item');
  if (!item?.dataset.id) return;
  if (e.target.closest('.wi-check')) {
    toggleTask(item.dataset.id, !item.classList.contains('done'));
    return;
  }
  openEditTask(item.dataset.id);
});
/* ═══════════ 日历日程操作卡片（点日程块/全天条弹出：完成 / 删除） ═══════════ */
let evtPop = null;
function closeEvtPop() { if (evtPop) { evtPop.remove(); evtPop = null; } }

async function showEvtPopover(el) {
  closeEvtPop();
  const t = await db.get('tasks', el.dataset.id);
  if (!t) return;
  const r = el.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'evt-pop';
  const time = t.startTime ? `${t.startTime}${t.endTime ? ' - ' + t.endTime : ''}` : '全天';
  pop.innerHTML = `
    <div class="ep-title">${R.esc(t.title)}</div>
    <div class="ep-meta">${dateLabel(t.date)} · ${time} · ${TYPE_LABEL[t.type] || ''}</div>
    <div class="ep-btns">
      <button data-op="${t.status === 'done' ? 'undone' : 'done'}">${t.status === 'done' ? '↩ 恢复待办' : '✓ 完成'}</button>
      <button data-op="edit">编辑</button>
      <button data-op="del" class="danger">删除</button>
    </div>`;
  document.body.appendChild(pop);
  const pw = 230, ph = pop.offsetHeight || 110;
  pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - pw - 8) + 'px';
  pop.style.top = (r.bottom + ph + 12 > window.innerHeight ? Math.max(r.top - ph - 8, 8) : r.bottom + 6) + 'px';
  evtPop = pop;
  pop.addEventListener('click', async (e) => {
    const op = e.target.closest('button')?.dataset.op;
    if (!op) return;
    e.stopPropagation();
    closeEvtPop();
    if (op === 'del') deleteTask(t.id);
    else if (op === 'edit') openEditTask(t.id);
    else toggleTask(t.id, op === 'done');
  });
}

/* 点别处关闭（点另一个日程块则由 showEvtPopover 先关旧的再开新的） */
document.addEventListener('click', (e) => {
  if (evtPop && !evtPop.contains(e.target) && !e.target.closest('.evt, .ad-item')) closeEvtPop();
});

/* ═══════════ 任务编辑卡片（点任务弹出：改标题/日期/时间/类别，含删除） ═══════════ */
const editTaskModal = makeModal();
let editingTaskId = null;

async function openEditTask(id) {
  const t = await db.get('tasks', id);
  if (!t) return;
  editingTaskId = id;
  const cats = R.catList();
  const isRoutine = t.type === 'routine_instance';
  editTaskModal.backdrop.innerHTML = `
    <div class="modal" style="width:460px">
      <div class="modal-head">
        <div><h2>编辑任务</h2><div class="sub">${isRoutine ? '习惯实例 · 改内容不影响打卡' : (TYPE_LABEL[t.type] || '任务') + ' · ' + dateLabel(t.date)}</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div style="margin-top:16px">
        <div class="f-label">标题</div>
        <input type="text" id="etTitle" value="${R.esc(t.title)}" maxlength="60"
          style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13.5px;padding:10px 12px;outline:none">
        <div class="f-row" style="margin-top:12px">
          <div><div class="f-label">日期</div><input type="date" id="etDate" value="${t.date}"
            style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13px;padding:8px 10px;outline:none"></div>
          <div><div class="f-label">开始</div><input type="time" id="etStart" value="${t.startTime || ''}"
            style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13px;padding:8px 10px;outline:none"></div>
          <div><div class="f-label">结束</div><input type="time" id="etEnd" value="${t.endTime || ''}"
            style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13px;padding:8px 10px;outline:none"></div>
        </div>
        <div class="f-label">类别</div>
        <select id="etCat"
          style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13px;padding:9px 11px;outline:none">
          ${cats.map(c => `<option value="${c.id}" ${c.id === t.categoryId ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
        <div class="f-btns">
          <button class="cancel" id="etDelete" style="color:var(--c-ddl)">删除</button>
          <button class="cancel" data-close>取消</button>
          <button class="save" id="etSave">保存</button>
        </div>
      </div>
    </div>`;
  editTaskModal.backdrop.classList.add('show');
  editTaskModal.backdrop.querySelector('#etTitle').focus();
}

editTaskModal.backdrop.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-close]')) return editTaskModal.closeModal();
  if (t.id === 'etSave') {
    const task = await db.get('tasks', editingTaskId);
    if (!task) return;
    const title = editTaskModal.backdrop.querySelector('#etTitle').value.trim();
    if (!title) return R.toast('标题不能为空');
    const date = editTaskModal.backdrop.querySelector('#etDate').value || todayStr();
    const startTime = editTaskModal.backdrop.querySelector('#etStart').value || null;
    const endTime = editTaskModal.backdrop.querySelector('#etEnd').value || null;
    const categoryId = editTaskModal.backdrop.querySelector('#etCat').value;
    task.title = title; task.date = date; task.startTime = startTime;
    task.endTime = endTime; task.categoryId = categoryId;
    if (task.type === 'task' && startTime) task.type = 'event';
    else if (task.type === 'event' && !startTime) task.type = 'task';
    if (task.type === 'ddl') task.deadline = date;
    task.updatedAt = Date.now();
    await db.put('tasks', task);
    editTaskModal.closeModal();
    await refresh();
    R.toast('已保存');
    return;
  }
  if (t.id === 'etDelete') { editTaskModal.closeModal(); deleteTask(editingTaskId); }
});
editTaskModal.backdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'etTitle') editTaskModal.backdrop.querySelector('#etSave').click();
});

/* ═══════════ 拖拽改期（清单 ↔ 日历互拖） ═══════════ */
let dragTaskId = null;
let dropHighlight = null;
const DROP_TARGETS = '.ad-cell, .col, .gh-day, .mday, #todayPanel';

document.addEventListener('dragstart', (e) => {
  if (e.target.closest('.t-del, .cb, .wi-check')) return; // 点删除/勾选不触发拖拽
  const el = e.target.closest('.task, .week-item, .evt, .ad-item');
  if (!el || !el.dataset.id) return;
  dragTaskId = el.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', el.dataset.id); } catch (err) {}
});
document.addEventListener('dragover', (e) => {
  const target = e.target.closest(DROP_TARGETS);
  if (!target || !dragTaskId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (dropHighlight && dropHighlight !== target) dropHighlight.classList.remove('drag-over');
  target.classList.add('drag-over');
  dropHighlight = target;
});
document.addEventListener('dragleave', (e) => {
  const target = e.target.closest(DROP_TARGETS);
  if (target && target === dropHighlight) { target.classList.remove('drag-over'); dropHighlight = null; }
});
document.addEventListener('dragend', () => {
  dragTaskId = null;
  if (dropHighlight) { dropHighlight.classList.remove('drag-over'); dropHighlight = null; }
});
document.addEventListener('drop', async (e) => {
  const target = e.target.closest(DROP_TARGETS);
  if (!target || !dragTaskId) return;
  e.preventDefault();
  const id = dragTaskId;
  dragTaskId = null;
  if (dropHighlight) { dropHighlight.classList.remove('drag-over'); dropHighlight = null; }

  // 拖到「今日 To Do」面板 → 改到今天（本周待办里的昨天/未来事项都能直接拖进来）
  if (target.id === 'todayPanel') {
    const date = todayStr();
    const t = await db.get('tasks', id);
    if (!t) return;
    if (t.date === date) return; // 本来就在今天，无需处理
    t.date = date;
    if (t.type === 'ddl') t.deadline = date;
    t.updatedAt = Date.now();
    await db.put('tasks', t);
    await refresh();
    R.toast('已移到今日 To Do');
    return;
  }

  const date = target.dataset.date;
  if (!date) return;
  const t = await db.get('tasks', id);
  if (!t) return;
  t.date = date;
  if (target.classList.contains('ad-cell')) {
    // 落到全天行：改成那天全天（清时间）
    t.startTime = null; t.endTime = null;
    if (t.type === 'event') t.type = 'task';
  } else if (target.classList.contains('col')) {
    // 落到时间轴：按落点设开始时间（有结束时间则保持时长）
    const rect = target.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const raw = R.START_H * 60 + (y / R.HOUR_H) * 60;
    const mins = Math.max(R.START_H * 60, Math.min(R.END_H * 60, Math.round(raw / 15) * 15));
    const ns = fmtMin(mins);
    if (t.endTime) {
      const dur = Math.max(toMinutes(t.endTime) - toMinutes(t.startTime || ns), 30);
      t.startTime = ns;
      t.endTime = fmtMin(Math.min(R.END_H * 60, mins + dur));
    } else {
      t.startTime = ns;
    }
    if (t.type === 'task') t.type = 'event';
  }
  // 落到周表头 / 月格子：只改日期，时间不动
  if (t.type === 'ddl') t.deadline = date;
  t.updatedAt = Date.now();
  await db.put('tasks', t);
  await refresh();
  R.toast('已改期到 ' + dateLabel(date));
});

$('calGrid').addEventListener('click', (e) => {
  const del = e.target.closest('.t-del');
  if (del?.dataset.id) { closeEvtPop(); return deleteTask(del.dataset.id); }
  const host = e.target.closest('.evt, .ad-item');
  if (host?.dataset.id) { showEvtPopover(host); return; }
  const dayCell = e.target.closest('.mday');
  if (dayCell?.dataset.date) {
    // 月视图点某天 → 切到那天的周视图（苹果日历交互）
    const d = parseDate(dayCell.dataset.date);
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7);
    const now = new Date();
    const nowMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
    weekOffset = Math.round((mon - nowMon) / 604800000);
    viewMode = 'week';
    updateSegUI();
    refresh();
  }
});

/* ═══════════ 弹层骨架 ═══════════ */
function makeModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  function closeModal() { backdrop.classList.remove('show'); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  return { backdrop, closeModal };
}

/* ═══════════ 打字补充任务（语音解析前的兜底入口，B4） ═══════════ */
const addModal = makeModal();
$('addTaskBtn').addEventListener('click', () => {
  const cats = R.catList();
  addModal.backdrop.innerHTML = `
    <div class="modal" style="width:460px">
      <div class="modal-head">
        <div><h2>打字补充一条</h2><div class="sub">加一条任务 · 语音智能解析后续版本上线</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div style="margin-top:16px">
        <div class="f-label">标题</div>
        <input type="text" id="atTitle" placeholder="如：写实验报告、取快递…" maxlength="60"
          style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13.5px;padding:10px 12px;outline:none">
        <div class="f-row" style="margin-top:12px">
          <div><div class="f-label">日期</div><input type="date" id="atDate" value="${todayStr()}"></div>
          <div><div class="f-label">时间（可选）</div><input type="time" id="atTime"></div>
          <div><div class="f-label">类别</div>
            <select id="atCat">${cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
          </div>
        </div>
        <div class="f-btns"><button class="save" id="atSave">保存</button><button class="cancel" data-close>取消</button></div>
      </div>
    </div>`;
  addModal.backdrop.classList.add('show');
  const title = addModal.backdrop.querySelector('#atTitle');
  title.focus();
  const save = async () => {
    const v = title.value.trim();
    if (!v) return R.toast('写点内容再保存呀');
    const date = addModal.backdrop.querySelector('#atDate').value || todayStr();
    const startTime = addModal.backdrop.querySelector('#atTime').value || null;
    await db.put('tasks', {
      id: uid('t-'), title: v, type: startTime ? 'event' : 'task',
      date, startTime, endTime: null,
      categoryId: addModal.backdrop.querySelector('#atCat').value,
      priority: 0, tags: [], note: '', source: 'text', status: 'todo',
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    addModal.closeModal();
    await refresh();
    R.toast('已保存');
  };
  addModal.backdrop.querySelector('#atSave').onclick = save;
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
});
addModal.backdrop.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) addModal.closeModal();
});

/* ═══════════ Routine 管理看板（CRUD 走 IndexedDB） ═══════════ */
const routineModal = makeModal();
let editingRoutineId = null;

async function renderRoutineModal() {
  const routines = await db.getAll('routines');
  const logs = await db.getAll('habitLogs');
  const vms = R.buildRoutineVMs(routines, logs);
  const cats = R.catList();
  const card = (r) => `
    <div class="rt-card${r.active ? '' : ' paused'}" style="--cat:var(--c-${r.categoryId})">
      <span class="rt-dot"></span>
      <div class="rt-info">
        <div class="rt-name">${R.esc(r.title)}${r.active ? '' : '<span class="paused-tag">已暂停</span>'}</div>
        <div class="rt-meta">${R.freqText(r.daysOfWeek)} · 连续 <b>${r.streak}</b> 天</div>
      </div>
      <div class="rt-prog">
        <div class="pct">${r.weekDone}/${r.weekTotal}</div>
        <div class="track"><i style="width:${Math.round(r.weekDone / r.weekTotal * 100)}%"></i></div>
      </div>
      <div class="rt-ops">
        <button data-op="edit" data-id="${r.id}">编辑</button>
        <button data-op="toggle" data-id="${r.id}">${r.active ? '暂停' : '恢复'}</button>
        <button class="danger" data-op="del" data-id="${r.id}">删除</button>
      </div>
    </div>`;
  const active = vms.filter(r => r.active);
  const paused = vms.filter(r => !r.active);
  const pausedBlock = paused.length ? `
    <div id="rtPausedHead" style="margin-top:14px;font-size:12px;color:var(--text-2);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px">
      <span id="rtPausedArrow">▸</span> 已暂停的打卡（${paused.length}）· 点击展开
    </div>
    <div id="rtPausedList" style="display:none">${paused.map(card).join('')}</div>` : '';
  routineModal.backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div><h2>Routine 习惯打卡</h2><div class="sub">习惯实例每天自动合并进「今日 To Do」· 支持语音一句话设置</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      ${active.map(card).join('') || '<div class="anno-empty">还没有启用的习惯，点下面新增一个吧</div>'}
      <button class="rt-add" data-add>＋ 新增习惯</button>
      <div class="rt-form" style="display:none" id="rtForm">
        <div class="f-label">习惯名称</div>
        <input type="text" id="rfName" placeholder="如：健身、学习打卡…" maxlength="20">
        <div class="f-label">重复频率</div>
        <div class="chips" id="rfDays">${R.WD_CHIPS()}</div>
        <div class="f-label">类别颜色</div>
        <select id="rfCat">${cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <div class="f-btns"><button class="save" id="rfSave">保存</button><button class="cancel" id="rfCancel">取消</button></div>
      </div>
      ${pausedBlock}
    </div>`;
}

function openRoutineForm(r) {
  editingRoutineId = r ? r.id : null;
  const form = routineModal.backdrop.querySelector('#rtForm');
  form.style.display = 'block';
  routineModal.backdrop.querySelector('#rfName').value = r ? r.title : '';
  routineModal.backdrop.querySelector('#rfCat').value = r ? r.categoryId : 'sport';
  const days = new Set(r ? r.daysOfWeek : [1, 3, 5]);
  routineModal.backdrop.querySelectorAll('#rfDays .chip').forEach(ch => {
    ch.classList.toggle('on', days.has(+ch.dataset.day));
  });
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  routineModal.backdrop.querySelector('#rfName').focus();
}

routineModal.backdrop.addEventListener('click', async (e) => {
  // 展开 / 收起「已暂停的打卡」
  if (e.target.closest('#rtPausedHead')) {
    const list = routineModal.backdrop.querySelector('#rtPausedList');
    const arrow = routineModal.backdrop.querySelector('#rtPausedArrow');
    const open = list && list.style.display !== 'none';
    if (list) list.style.display = open ? 'none' : 'block';
    if (arrow) arrow.textContent = open ? '▸' : '▾';
    return;
  }
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.close !== undefined) return routineModal.closeModal();
  if (t.dataset.add !== undefined) return openRoutineForm(null);
  if (t.dataset.day !== undefined) return t.classList.toggle('on');
  if (t.id === 'rfCancel') {
    routineModal.backdrop.querySelector('#rtForm').style.display = 'none';
    return;
  }
  if (t.id === 'rfSave') {
    const name = routineModal.backdrop.querySelector('#rfName').value.trim();
    const days = [...routineModal.backdrop.querySelectorAll('#rfDays .chip.on')].map(c => +c.dataset.day);
    if (!name) return alert('写个习惯名称吧');
    if (!days.length) return alert('至少选一天哦');
    const categoryId = routineModal.backdrop.querySelector('#rfCat').value;
    if (editingRoutineId) {
      const r = await db.get('routines', editingRoutineId);
      const oldTitle = r.title;
      Object.assign(r, { title: name, daysOfWeek: days, categoryId });
      await db.put('routines', r);
      // 打卡日变了 → 清掉旧打卡日残留的实例，只保留新日程里的日子
      await pruneRoutineInstances(r.id, days);
      // 改名时同步奖章名（保持「习惯名 · 铜/银/金」）
      if (oldTitle !== name) {
        for (const d of await db.getAll('badgeDefs')) {
          if (d.routineId === r.id) {
            d.name = `${name} · ${d.name.split(' · ')[1] || ''}`.trim();
            await db.put('badgeDefs', d);
          }
        }
      }
    } else {
      const id = uid('r-');
      await db.put('routines', {
        id, title: name, daysOfWeek: days, categoryId,
        active: true, badgeCode: null, createdAt: Date.now(),
      });
      await createHabitBadgeDefs(id, name); // 新习惯自动配三档专属奖章
    }
    await renderRoutineModal();
    await refresh();
    return;
  }
  const { op, id } = t.dataset;
  if (!op) return;
  const r = await db.get('routines', id);
  if (!r) return;
  if (op === 'edit') openRoutineForm(r);
  if (op === 'toggle') {
    r.active = !r.active;
    await db.put('routines', r);
    if (!r.active) await removeRoutineInstances(r.id); // 暂停时清掉已生成的实例
    await renderRoutineModal();
    await refresh();
  }
  if (op === 'del' && confirm(`删除习惯「${r.title}」吗？`)) {
    await removeRoutineInstances(id); // 先删掉该习惯的所有实例
    await db.delete('routines', id);
    for (const d of await db.getAll('badgeDefs')) {
      if (d.routineId === id) await db.delete('badgeDefs', d.code);
    }
    await renderRoutineModal();
    await refresh();
  }
});

$('routineBtn').addEventListener('click', async () => {
  await renderRoutineModal();
  routineModal.backdrop.classList.add('show');
});

/* ═══════════ 奖章墙（规则 v2：连续全勤/清零发章 · 消耗式兑换阶梯） ═══════════ */
const badgeModal = makeModal();
const TIER_ICON = { bronze: '🥉', silver: '🥈', gold: '🥇' };
const TIER_DEFS = [
  { tier: 'bronze', suffix: '铜', weeks: 1 },
  { tier: 'silver', suffix: '银', weeks: 2 },
  { tier: 'gold',   suffix: '金', weeks: 4 },
];

/** 新建习惯时自动配三档专属奖章（奖章名 = 习惯名，可与其他习惯区分） */
async function createHabitBadgeDefs(routineId, title) {
  for (const t of TIER_DEFS) {
    await db.put('badgeDefs', {
      code: `${routineId}-${t.tier}`, name: `${title} · ${t.suffix}`,
      kind: 'habit', tier: t.tier, routineId: routineId, weeks: t.weeks,
      repeatable: true, condition: `连续 ${t.weeks} 周全勤`, rulesVersion: 2,
    });
  }
}

function medalSlot(def, cnt, current) {
  const need = def.weeks ?? def.days;
  const unit = def.kind === 'habit' ? '周' : '天';
  let sub;
  if (cnt && def.tier === 'gold' && current >= need) {
    const next = Math.ceil((current + 1) / need) * need - current;
    sub = `已得 ×${cnt} · 再 ${next} ${unit}又一枚`;
  } else if (cnt) {
    sub = `已得 ×${cnt}`;
  } else {
    sub = `连续 ${current} / ${need} ${unit}`;
  }
  return `
    <div class="bd-medal${cnt ? '' : ' locked'}">
      <div class="ico">${TIER_ICON[def.tier]}</div>
      <div class="nm">${R.esc(def.name)}</div>
      <div class="sub">${sub}</div>
    </div>`;
}

async function renderBadgeModal() {
  const [routines, logs, defs, badges, history, balance] = await Promise.all([
    db.getAll('routines'), db.getAll('habitLogs'), db.getAll('badgeDefs'),
    db.getAll('badges'), B.redeemHistory(), B.badgeBalance(),
  ]);
  const ladder = await db.getSetting('rewardLadder', []);
  const cntOf = (code) => badges.filter(b => b.code === code).length;

  // 习惯奖章分组
  const groups = [];
  for (const r of routines) {
    const tiers = ['bronze', 'silver', 'gold']
      .map(t => defs.find(d => d.kind === 'habit' && d.routineId === r.id && d.tier === t))
      .filter(Boolean);
    if (!tiers.length) continue;
    const { weeks } = B.habitWeekStreak(r, logs);
    const base = tiers[0].name.replace(/ · [铜银金]$/, '');
    groups.push(`
      <div class="bd-group">
        <div class="bd-group-title">${R.esc(r.title)}「${R.esc(base)}」<span class="sub">当前连续 ${weeks} 周</span></div>
        <div class="bd-medals">${tiers.map(d => medalSlot(d, cntOf(d.code), weeks)).join('')}</div>
      </div>`);
  }

  // TODO 奖章分组
  const todoDefs = ['bronze', 'silver', 'gold']
    .map(t => defs.find(d => d.kind === 'todo' && d.tier === t)).filter(Boolean);
  if (todoDefs.length) {
    const { days } = await B.todoClearStreak();
    groups.push(`
      <div class="bd-group">
        <div class="bd-group-title">每日 To Do「今日清零」<span class="sub">当前连续 ${days} 天</span></div>
        <div class="bd-medals">${todoDefs.map(d => medalSlot(d, cntOf(d.code), days)).join('')}</div>
      </div>`);
  }

  const ladderHtml = ladder.map((rw, i) => `
    <button class="bd-rw" data-redeem="${i}" ${balance >= rw.cost ? '' : 'disabled'}>
      <div class="bd-rw-cost">${rw.cost} 枚</div>
      <div class="bd-rw-name">${R.esc(rw.name)}</div>
      <div class="bd-rw-hint">${balance >= rw.cost ? '可兑换' : `还差 ${rw.cost - balance} 枚`}</div>
    </button>`).join('');

  const histHtml = history.length ? history.map(h => `
    <div class="bd-hist-row">
      <span>${h.fulfilled ? '✅' : '🎁'} ${R.esc(h.reward)}</span>
      <span class="meta">${new Date(h.redeemedAt).toLocaleDateString()} · ${h.cost} 枚
        ${h.fulfilled ? '' : `<button data-fulfilled="${h.id}">标为已兑现</button>`}</span>
    </div>`).join('') : '<div class="anno-empty">还没有兑换过奖励，攒奖章吧～</div>';

  badgeModal.backdrop.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head">
        <div><h2>奖章墙</h2><div class="sub">连续全勤 / 清空每日清单得奖章 · 攒奖章换奖励</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div class="bd-hero"><span class="num">${balance}</span><span class="lbl">枚奖章可用</span></div>
      <div class="bd-ladder">${ladderHtml}</div>
      ${groups.join('') || '<div class="anno-empty">还没有可计算的奖章规则</div>'}
      <div class="bd-hist">
        <div class="bd-group-title" style="margin-top:4px">兑换历史</div>
        ${histHtml}
      </div>
    </div>`;
}

badgeModal.backdrop.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.close !== undefined) return badgeModal.closeModal();
  if (t.dataset.redeem !== undefined) {
    const ladder = await db.getSetting('rewardLadder', []);
    const rw = ladder[+t.dataset.redeem];
    if (!rw) return;
    if (confirm(`用 ${rw.cost} 枚奖章兑换「${rw.name}」吗？`)) {
      if (await B.redeem(rw)) {
        await renderBadgeModal();
        R.toast(`🎉 已兑换「${rw.name}」，记得兑现自己哦！`);
      }
    }
    return;
  }
  if (t.dataset.fulfilled) {
    const row = await db.get('rewardDraws', t.dataset.fulfilled);
    if (row) { row.fulfilled = true; await db.put('rewardDraws', row); await renderBadgeModal(); }
  }
});

$('badgesBtn').addEventListener('click', async () => {
  await B.evaluate(); // 打开时也结算一次（跨周补发）
  await renderBadgeModal();
  badgeModal.backdrop.classList.add('show');
});

/* ═══════════ 已完成 / 归档（历史查看：可恢复或永久删除） ═══════════ */
const doneModal = makeModal();

async function renderDoneModal() {
  const tasks = (await db.getAll('tasks')).filter(t => t.status === 'done' || t.status === 'archived');
  tasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const rows = tasks.map(t => `
    <div class="done-item" style="--cat:var(--c-${t.categoryId})">
      <span class="d-dot"></span>
      <span class="d-title" title="${R.esc(t.title)}">${R.esc(t.title)}</span>
      <span class="d-date">${dateLabel(t.date)}</span>
      <span class="d-ops">
        <button data-op="restore" data-id="${t.id}">↩ 恢复</button>
        <button class="del" data-op="del" data-id="${t.id}">删除</button>
      </span>
    </div>`).join('');
  doneModal.backdrop.innerHTML = `
    <div class="modal" style="width:520px">
      <div class="modal-head">
        <div><h2>已完成 · 归档</h2><div class="sub">共 ${tasks.length} 条 · 打勾完成的任务都在这里</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div style="margin-top:12px">
        ${rows || '<div class="anno-empty">还没有完成的任务</div>'}
      </div>
    </div>`;
}

doneModal.backdrop.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-close]')) return doneModal.closeModal();
  const btn = t.closest('[data-op]');
  if (!btn) return;
  const { op, id } = btn.dataset;
  if (op === 'restore') {
    const task = await db.get('tasks', id);
    if (task) {
      task.status = 'todo'; task.updatedAt = Date.now();
      await db.put('tasks', task);
      await renderDoneModal();
      await refresh();
      R.toast('已恢复到待办');
    }
  } else if (op === 'del') {
    const task = await db.get('tasks', id);
    if (task && confirm(`永久删除「${task.title}」吗？`)) {
      await db.delete('tasks', id);
      await renderDoneModal();
      await refresh();
      R.toast('已删除');
    }
  }
});

$('doneBtn').addEventListener('click', async () => {
  await renderDoneModal();
  doneModal.backdrop.classList.add('show');
});

/* ═══════════ 语音/打字输入（识别 → 规则解析 → LLM 兜底 → 入库） ═══════════ */
const voicePill = $('voicePill');
const voiceSpan = voicePill.querySelector('span');
const voiceKbd = voicePill.querySelector('kbd');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, lastErr = null;

/* 任务入库 */
function makeTaskRecord(t) {
  return {
    id: uid('t-'), title: t.title, type: t.type,
    date: t.date, startTime: t.startTime || null, endTime: t.endTime || null,
    deadline: t.deadline || null, categoryId: R.normalizeCat(t.categoryId),
    routineId: t.routineId || null, priority: 0, tags: [], note: '',
    source: t.source || 'voice', status: 'todo',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

/* 可撤销提示（taskIds 支持单条或数组） */
function undoToast(msg, taskIds) {
  const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
  const el = document.createElement('div');
  el.className = 'anno-toast';
  el.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 18px;';
  el.innerHTML = `<span>${R.esc(msg)}</span>` +
    `<button style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px">撤销</button>`;
  el.querySelector('button').onclick = async () => {
    for (const id of ids) await db.delete('tasks', id);
    el.remove();
    await refresh();
    R.toast('已撤销');
  };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* 解析结果预览卡片（多任务时确认入库，PRD F1） */
const previewModal = makeModal();
function dateLabel(date) {
  const n = Math.round((parseDate(date) - parseDate(todayStr())) / 86400000);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === 2) return '后天';
  return dayHead(parseDate(date));
}
const TYPE_LABEL = { task: '待办', ddl: 'DDL', event: '日程' };

async function saveTasksWithPreview(tasks, source) {
  // 每条可直接编辑（标题/日期/时间/类别）后再确认入库；类别做兜底归一
  let items = tasks.map(t => ({ ...t, categoryId: R.normalizeCat(t.categoryId) }));
  const cats = R.catList();
  const catOpts = (cur) => cats.map(c => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${c.name}</option>`).join('');

  const render = () => {
    previewModal.backdrop.innerHTML = `
      <div class="modal" style="width:560px">
        <div class="modal-head">
          <div><h2>识别到 ${items.length} 条</h2><div class="sub">可直接编辑每条内容，确认后入库 · 不想要的点 ✕ 移掉</div></div>
          <button class="modal-close" data-close>✕</button>
        </div>
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
          ${items.map((t, i) => `
            <div class="pv-card pv-edit" style="--cat:var(--c-${t.categoryId})">
              <span class="pv-dot"></span>
              <div class="pv-main">
                <input type="text" class="pv-input pv-title-input" data-i="${i}" data-f="title" value="${R.esc(t.title)}" maxlength="60" placeholder="标题">
                <div class="pv-row">
                  <input type="date" class="pv-input" data-i="${i}" data-f="date" value="${t.date}">
                  <input type="time" class="pv-input" data-i="${i}" data-f="startTime" value="${t.startTime || ''}" placeholder="开始">
                  <input type="time" class="pv-input" data-i="${i}" data-f="endTime" value="${t.endTime || ''}" placeholder="结束">
                </div>
                <div class="pv-row">
                  <select class="pv-input" data-i="${i}" data-f="categoryId">${catOpts(t.categoryId)}</select>
                  <span class="pv-type">${TYPE_LABEL[t.type] || t.type}</span>
                </div>
              </div>
              <button class="pv-rm" data-rm="${i}" title="移掉这条">✕</button>
            </div>`).join('')}
        </div>
        <div class="f-btns"><button class="save" id="pvSave">确认</button><button class="cancel" data-close>取消</button></div>
      </div>`;
  };
  render();
  previewModal.backdrop.classList.add('show');

  // 编辑即时写入 items（text 走 input；date/time/select 走 change 兜底）
  const sync = (e) => {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const i = +el.dataset.i;
    const f = el.dataset.f;
    if (items[i]) items[i][f] = el.value;
    if (f === 'categoryId') {
      const card = el.closest('.pv-card');
      if (card) card.style.setProperty('--cat', `var(--c-${el.value})`);
    }
  };
  previewModal.backdrop.oninput = sync;
  previewModal.backdrop.onchange = sync;

  previewModal.backdrop.onclick = async (e) => {
    if (e.target === previewModal.backdrop || e.target.closest('[data-close]')) return previewModal.closeModal();
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      items.splice(+rm.dataset.rm, 1);
      if (!items.length) return previewModal.closeModal();
      render();
      return;
    }
    if (e.target.closest('#pvSave')) {
      const savedIds = [];
      let saved = 0;
      for (const t of items) {
        const title = (t.title || '').trim();
        if (!title) continue;
        const rec = makeTaskRecord({ ...t, title, date: t.date || todayStr(), source });
        await db.put('tasks', rec);
        savedIds.push(rec.id);
        saved++;
      }
      previewModal.closeModal();
      await refresh();
      if (saved) undoToast(`已添加 ${saved} 条`, savedIds);
    }
  };
}

/* 总调度（v3：AI 语义分析优先，规则做兜底）
   原因：语音识别返回的中文几乎不带标点，规则解析靠标点断句不可靠，整句会被当成一条任务 */
async function handleVoiceText(text) {
  const ruleParsed = parseInput(text, R.catList());
  if (ruleParsed.kind === 'command') {
    // 纯指令句本地就能判断，不浪费 AI 调用："我要创建日程"绝不能建成任务
    R.toast('请直接说内容，例如「今天完成作业A、作业B」「11月25号晚上7点LLM作业DDL」「每周二四六健身」');
    return;
  }
  let parsed = ruleParsed, via = 'rule';
  const cfg = await llmConfig();
  if (cfg.enabled && cfg.apiKey) {
    R.toast('正在用 AI 理解这句话…');
    try {
      const llm = await llmParse(text);
      if (llm) { parsed = llm; via = 'llm'; }
    } catch (err) {
      console.error('LLM 解析失败：', err);
      R.toast('AI 解析出错（' + err.message + '），已改用本地规则');
    }
  } else if (ruleParsed.kind === 'unknown') {
    R.toast('本地规则没认出来；想更聪明可在设置里开启 AI 解析');
  }
  if (parsed.kind === 'routine') {
    await renderRoutineModal();
    routineModal.backdrop.classList.add('show');
    openRoutineForm({ id: null, title: parsed.routine.name, daysOfWeek: parsed.routine.days, categoryId: parsed.routine.cat });
    editingRoutineId = null; // 语音解析是"新增"预填
    R.toast(`已识别习惯「${parsed.routine.name}」，确认后保存`);
    return;
  }
  if (parsed.kind === 'tasks') {
    await saveTasksWithPreview(parsed.tasks, via === 'llm' ? 'llm' : 'voice');
    return;
  }
  R.toast('没听懂这句话，试试「明天下午三点组会」或「11月25号交作业」');
  openTextParser(text);
}

/* 打字兜底弹层（任务 + 习惯都可解析） */
const textParser = makeModal();
function openTextParser(prefill) {
  const escQ = (s) => String(s || '').replace(/"/g, '&quot;');
  textParser.backdrop.innerHTML = `
    <div class="modal" style="width:480px">
      <div class="modal-head">
        <div><h2>打字输入</h2><div class="sub">一句话描述，自动解析成任务或习惯</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div style="margin-top:16px">
        <input type="text" id="tpInput" placeholder="如：明天下午三点组会，晚上健身" value="${escQ(prefill)}"
          style="width:100%;border:1.5px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--text);font-size:13.5px;padding:10px 12px;outline:none">
        <div class="settings-note">试试：「明天下午三点开组会」「11月25号交操作系统作业」「今天上午写作业，晚上健身」「每周一三五晚上健身」</div>
        <div class="f-btns"><button class="save" id="tpGo">解析并添加</button><button class="cancel" data-close>取消</button></div>
      </div>
    </div>`;
  textParser.backdrop.classList.add('show');
  const input = textParser.backdrop.querySelector('#tpInput');
  const go = () => {
    const val = input.value.trim();
    if (!val) return;
    textParser.closeModal();
    handleVoiceText(val);
  };
  textParser.backdrop.querySelector('#tpGo').onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  input.focus();
}
textParser.backdrop.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) textParser.closeModal();
});

/* 语音识别（Web Speech API）
   v2：continuous 模式 + 浏览器断开时自动续听 —— 说话中途停顿不会结束录音，
   只有用户点「完成」或超过 5 分钟上限才结束，结束并解析成功后也先弹卡片确认再入库 */
const MAX_LISTEN_MS = 5 * 60 * 1000; // 最长听 5 分钟
let listenTimer = null;
let stopRecording = null; // 当前录音会话的结束函数

function resetVoiceUI() {
  listening = false;
  voicePill.classList.remove('listening');
  voiceSpan.textContent = '点击说话 · 待办 / 日程 / 习惯都能说';
  voiceKbd.textContent = '语音';
}
function startListening() {
  if (listening) { if (stopRecording) stopRecording(); return; } // 录音中再点一下 = 「完成」
  if (!SR) { R.toast('当前浏览器不支持语音识别，用打字吧'); openTextParser(''); return; }
  rec = new SR();
  rec.lang = 'zh-CN';
  rec.interimResults = true;
  rec.continuous = true; // 允许中途停顿，一直听到用户主动结束
  let finalText = '';
  let userStopped = false;
  lastErr = null;
  listening = true;
  voicePill.classList.add('listening');
  voiceSpan.textContent = '聆听中… 慢慢说，说完点「完成」';
  voiceKbd.textContent = '完成';

  const finishRecording = () => {
    userStopped = true;
    clearTimeout(listenTimer);
    try { rec.stop(); } catch (e) {}
  };
  stopRecording = finishRecording;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    const shown = (finalText + interim).trim();
    if (shown) voiceSpan.textContent = shown;
  };
  rec.onerror = (e) => {
    lastErr = e.error;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      R.toast('麦克风权限被拒绝，可在地址栏权限设置中开启');
      finishRecording();
    } else if (e.error === 'no-speech' && !finalText) {
      finishRecording(); // 一个字都还没说就静音：结束本次，不用干等
    } else if (e.error !== 'aborted') {
      R.toast('语音识别出错，用打字兜底吧');
    }
  };
  rec.onend = () => {
    if (!listening) return;
    if (userStopped) {
      // 用户点了「完成」/ 超时 / 静音结束 → 收尾解析
      resetVoiceUI();
      const text = finalText.trim();
      if (text) handleVoiceText(text);
      else if (!lastErr || lastErr === 'no-speech') R.toast('没听清，再试一次？');
      return;
    }
    // 浏览器自己断了（长停顿触发）→ 无缝续听，已识别的文字都还在
    try { rec.start(); } catch (e) { resetVoiceUI(); R.toast('语音中断了，再试一次？'); }
  };
  listenTimer = setTimeout(() => { R.toast('已到 5 分钟上限，自动结束'); finishRecording(); }, MAX_LISTEN_MS);
  try { rec.start(); } catch (e) { resetVoiceUI(); R.toast('语音启动失败，用打字吧'); openTextParser(''); }
}
voicePill.addEventListener('click', startListening);

/* ═══════════ 设置 · 类别颜色（写 categories store） ═══════════ */
const settingsModal = makeModal();
const cssVar = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

async function renderSettingsModal() {
  const cats = R.catList();
  const llm = await llmConfig();
  const ladder = await db.getSetting('rewardLadder', []);
  const defs = await db.getAll('badgeDefs');
  const threshold = Math.round((await db.getSetting('completionThreshold', 0.95)) * 100);
  const notifyEnabled = await db.getSetting('notifyEnabled', true);
  const notifyTime = await db.getSetting('notifyTime', '22:00');
  const notifyPerm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const tierVal = (kind, tier, field) => {
    const d = defs.find(x => x.kind === kind && x.tier === tier && x[field]);
    return d ? d[field] : '';
  };
  const num = (attrs) =>
    `type="number" min="1" max="999" style="width:56px;border:1.5px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-size:12.5px;padding:4px 6px;outline:none" ${attrs}`;
  settingsModal.backdrop.innerHTML = `
    <div class="modal" style="width:440px">
      <div class="modal-head">
        <div><h2>设置</h2><div class="sub">类别与颜色 · 奖章规则 · AI 解析兜底</div></div>
        <button class="modal-close" data-close>✕</button>
      </div>
      ${cats.map(c => `
        <div class="cat-row" data-cat="${c.id}">
          <div class="cat-row-main">
            <span class="cat-dot" style="--cc:var(--c-${c.id})"></span>
            <input type="text" class="cat-name-input" data-cat-name="${c.id}" value="${R.esc(c.name)}" maxlength="12" title="点击修改类别名">
            <span class="cat-hex" id="hex-${c.id}">${cssVar('--c-' + c.id).toUpperCase()}</span>
            <input type="color" value="${cssVar('--c-' + c.id)}" data-cat="${c.id}">
            ${c.id === 'life' ? '' : `<button class="cat-del" data-cat-del="${c.id}" title="删除类别">✕</button>`}
          </div>
          <div class="cat-kw-row">
            <span class="cat-kw-label">关键词</span>
            <input type="text" class="cat-kw-input" data-cat-kw="${c.id}" value="${R.esc(c.keywords || '')}" placeholder="逗号分隔，如：考试、测验">
          </div>
        </div>`).join('')}
      <button class="add-cat" id="addCatBtn">＋ 新增类别</button>
      <div class="cat-add-form" id="catAddForm" style="display:none">
        <input type="text" id="newCatName" placeholder="类别名称，如：科研 / 娱乐" maxlength="12">
        <input type="color" id="newCatColor" value="#EF87A5">
        <button class="save" id="newCatSave">添加</button>
        <button class="cancel" id="newCatCancel">取消</button>
      </div>
      <button class="reset-colors">恢复默认颜色</button>
      <div class="settings-note">点击类别名可直接改名、关键词可自定义（用于语音/打字自动归类，逗号分隔）；颜色即时生效。除「生活杂事」作为兜底外，其余类别都可删除。</div>

      <div class="llm-section">
        <div class="llm-title">AI 解析兜底（通义千问 Qwen）</div>
        <div class="llm-row">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" data-set="llmEnabled" ${llm.enabled ? 'checked' : ''}> 启用：规则解析不出来时用大模型兜底
          </label>
        </div>
        <div class="llm-row">
          <div class="f-label">API Key（阿里云百炼 DashScope）</div>
          <input type="password" data-set="llmApiKey" value="${R.esc(llm.apiKey)}" placeholder="sk-…" autocomplete="off">
        </div>
        <div class="llm-row">
          <div class="f-label">模型</div>
          <input type="text" data-set="llmModel" value="${R.esc(llm.model)}" placeholder="qwen-plus">
        </div>
        <div class="settings-note">仅当你说的那句话规则解析不了时，才会把这句话的文本发给阿里云解析；其余数据全在本机。Key 存在本机 IndexedDB。</div>
      </div>

      <div class="llm-section">
        <div class="llm-title">奖章规则</div>
        <div class="llm-row" style="font-size:13px">
          当日完成率 ≥ <input ${num(`data-set-num="completionThreshold" value="${threshold}" min="50" max="100"`)} style="width:56px"> % 算「今日清零」
        </div>
        <div class="llm-row" style="font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          习惯奖章（连续全勤周数）：铜
          <input ${num(`data-tier="habit-bronze" value="${tierVal('habit','bronze','weeks')}"`)} style="width:48px"> 周 · 银
          <input ${num(`data-tier="habit-silver" value="${tierVal('habit','silver','weeks')}"`)} style="width:48px"> 周 · 金
          <input ${num(`data-tier="habit-gold" value="${tierVal('habit','gold','weeks')}"`)} style="width:48px"> 周
        </div>
        <div class="llm-row" style="font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          TODO 奖章（连续清零天数）：铜
          <input ${num(`data-tier="todo-bronze" value="${tierVal('todo','bronze','days')}"`)} style="width:48px"> 天 · 银
          <input ${num(`data-tier="todo-silver" value="${tierVal('todo','silver','days')}"`)} style="width:48px"> 天 · 金
          <input ${num(`data-tier="todo-gold" value="${tierVal('todo','gold','days')}"`)} style="width:48px"> 天
        </div>
        <div class="llm-row" style="font-size:13px">
          <div class="f-label">兑换阶梯（奖章数 → 奖励）</div>
          ${ladder.map((rw, i) => `
            <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
              <input ${num(`data-ladder="${i}-cost" value="${rw.cost}"`)} style="width:56px"> 枚 →
              <input type="text" data-ladder="${i}-name" value="${R.esc(rw.name)}" maxlength="20"
                style="flex:1;border:1.5px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-size:12.5px;padding:4px 8px;outline:none">
            </div>`).join('')}
        </div>
        <div class="settings-note">铜/银每段连续只发一次，金档每满一个周期多发一枚；兑换即消耗奖章。改完立即生效。</div>
      </div>

      <div class="llm-section">
        <div class="llm-title">每日提醒（桌面通知）</div>
        <div class="llm-row">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" data-set="notifyEnabled" ${notifyEnabled ? 'checked' : ''}> 每晚提醒「今日 To Do」未完成事项
          </label>
        </div>
        <div class="llm-row" style="display:flex;align-items:center;gap:10px">
          <span style="font-size:13px">提醒时间</span>
          <input type="time" data-set="notifyTime" value="${notifyTime}"
            style="border:1.5px solid var(--line);border-radius:9px;background:var(--card-2);color:var(--text);font-size:13px;padding:7px 10px;outline:none">
          <span style="font-size:12px;color:var(--text-2)">${notifyPerm === 'granted' ? '✓ 已授权' : notifyPerm === 'denied' ? '✕ 已被拒绝' : notifyPerm === 'unsupported' ? '浏览器不支持' : '未授权'}</span>
        </div>
        <div class="llm-row">
          <button class="cancel" id="notifyPermBtn" style="font-size:12px;padding:7px 14px;border-radius:9px;background:var(--card-2);color:var(--text-2)">${notifyPerm === 'granted' ? '重新授权（一般无需）' : '开启通知权限'}</button>
        </div>
        <div class="settings-note">到点检查今天还有没有没完成的事项，有才提醒；需要浏览器通知权限，且页面保持打开。</div>
      </div>

      <div class="llm-section">
        <div class="llm-title">数据管理</div>
        <div class="f-btns" style="margin-top:4px">
          <button class="cancel" id="dsClearTasks">清空任务与打卡</button>
          <button class="cancel" id="dsReset" style="color:var(--c-ddl)">恢复出厂设置</button>
        </div>
        <div class="settings-note">「清空任务与打卡」删除所有任务和打卡记录，保留习惯、类别、设置；「恢复出厂」删除全部本地数据并重建预置（含示例习惯与 AI 配置）。</div>
      </div>
    </div>`;
}
settingsModal.backdrop.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-close]')) return settingsModal.closeModal();

  // 类别：新增
  if (t.id === 'addCatBtn') {
    const form = settingsModal.backdrop.querySelector('#catAddForm');
    form.style.display = 'flex';
    form.querySelector('#newCatName').focus();
    return;
  }
  if (t.id === 'newCatCancel') {
    settingsModal.backdrop.querySelector('#catAddForm').style.display = 'none';
    return;
  }
  if (t.id === 'newCatSave') {
    const name = settingsModal.backdrop.querySelector('#newCatName').value.trim();
    if (!name) return R.toast('给类别起个名字吧');
    const color = settingsModal.backdrop.querySelector('#newCatColor').value;
    const id = 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    await db.put('categories', { id, name: name.slice(0, 12), icon: '🏷️', color, builtin: false });
    document.documentElement.style.setProperty('--c-' + id, color);
    await R.loadCats();
    await renderSettingsModal();
    await refresh();
    R.toast('已新增类别「' + name.slice(0, 12) + '」');
    return;
  }
  // 类别：删除（仅自定义；相关任务/习惯归入生活杂事）
  if (t.closest('[data-cat-del]')) {
    const id = t.closest('[data-cat-del]').dataset.catDel;
    const c = await db.get('categories', id);
    if (!c || c.id === 'life') return;
    const [tasks, routines] = await Promise.all([db.getAll('tasks'), db.getAll('routines')]);
    const used = tasks.filter(x => x.categoryId === id).length + routines.filter(x => x.categoryId === id).length;
    if (!confirm(`删除类别「${c.name}」？` + (used ? `\n${used} 个任务/习惯会归入「生活杂事」。` : ''))) return;
    for (const x of tasks) if (x.categoryId === id) { x.categoryId = 'life'; await db.put('tasks', x); }
    for (const x of routines) if (x.categoryId === id) { x.categoryId = 'life'; await db.put('routines', x); }
    await db.delete('categories', id);
    document.documentElement.style.removeProperty('--c-' + id);
    await R.loadCats();
    await renderSettingsModal();
    await refresh();
    R.toast('已删除类别「' + c.name + '」');
    return;
  }

  // 通知权限
  if (t.id === 'notifyPermBtn') {
    if (!('Notification' in window)) return R.toast('当前浏览器不支持桌面通知');
    if (Notification.permission === 'denied') return R.toast('通知权限被拒绝，请在浏览器地址栏权限设置中开启');
    await Notification.requestPermission();
    await renderSettingsModal();
    R.toast(Notification.permission === 'granted' ? '通知权限已开启' : '未授权');
    return;
  }

  if (t.classList.contains('reset-colors')) {
    for (const c of await db.getAll('categories')) {
      const def = DEFAULT_CATEGORIES.find(d => d.id === c.id);
      if (def) { c.color = def.color; await db.put('categories', c); }
    }
    await applyCatColors();
    await renderSettingsModal();
    await refresh();
    return;
  }
  if (t.id === 'dsClearTasks' && confirm('确定清空所有任务和打卡记录吗？（习惯、类别、设置保留）')) {
    await db.clear('tasks');
    await db.clear('habitLogs');
    settingsModal.closeModal();
    await refresh();
    R.toast('已清空任务与打卡记录');
    return;
  }
  if (t.id === 'dsReset' && confirm('恢复出厂会删除全部本地数据（任务、打卡进度、习惯、设置），确定吗？')) {
    await closeDB();
    const req = indexedDB.deleteDatabase('daodao-todo');
    req.onsuccess = req.onerror = req.onblocked = () => location.reload();
    setTimeout(() => location.reload(), 1500); // 兜底：万一被阻塞也强制刷新
    return;
  }
});

/* 颜色选择器提交时触发 input/change 事件（不是 click），在 input 上监听；LLM 配置同样持久化 */
settingsModal.backdrop.addEventListener('input', async (e) => {
  const t = e.target;
  if (t.type === 'color' && t.dataset.cat) {
    const c = await db.get('categories', t.dataset.cat);
    if (!c) return;
    c.color = t.value;
    await db.put('categories', c);
    document.documentElement.style.setProperty('--c-' + c.id, t.value);
    const hex = settingsModal.backdrop.querySelector('#hex-' + c.id);
    if (hex) hex.textContent = t.value.toUpperCase();
    await refresh();
    return;
  }
  if (t.dataset.set) {
    const key = t.dataset.set;
    const value = t.type === 'checkbox' ? t.checked : t.value.trim();
    await db.setSetting(key, value);
  }
  // 奖章规则：档位周数/天数
  if (t.dataset.tier) {
    const [kind, tier] = t.dataset.tier.split('-');
    const field = kind === 'habit' ? 'weeks' : 'days';
    const v = Math.max(1, parseInt(t.value, 10) || 1);
    for (const d of await db.getAll('badgeDefs')) {
      if (d.kind === kind && d.tier === tier) { d[field] = v; await db.put('badgeDefs', d); }
    }
  }
  // 奖章规则：兑换阶梯
  if (t.dataset.ladder) {
    const [i, f] = t.dataset.ladder.split('-');
    const ladder = await db.getSetting('rewardLadder', []);
    if (ladder[+i]) {
      ladder[+i][f] = f === 'cost' ? Math.max(1, parseInt(t.value, 10) || 1) : t.value.trim();
      await db.setSetting('rewardLadder', ladder);
    }
  }
  // 奖章规则：今日清零阈值（界面百分比 → 0~1 存储值）
  if (t.dataset.setNum) {
    const v = Math.min(1, Math.max(0.5, (parseFloat(t.value) || 95) / 100));
    await db.setSetting(t.dataset.setNum, v);
  }
});
settingsModal.backdrop.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.set && t.type === 'checkbox') {
    await db.setSetting(t.dataset.set, t.checked);
    // 打开"每日提醒"开关时顺带请求通知权限
    if (t.dataset.set === 'notifyEnabled' && t.checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }
  // 类别改名（blur / 回车提交）
  if (t.dataset.catName) {
    const c = await db.get('categories', t.dataset.catName);
    if (!c) return;
    const name = t.value.trim();
    if (!name) { t.value = c.name; return R.toast('类别名不能为空'); }
    c.name = name.slice(0, 12);
    await db.put('categories', c);
    await R.loadCats();
    R.toast('类别名已更新');
  }
  // 类别关键词修改（规则解析 / LLM 提示词会据此联动）
  if (t.dataset.catKw) {
    const c = await db.get('categories', t.dataset.catKw);
    if (!c) return;
    c.keywords = t.value.trim();
    await db.put('categories', c);
    await R.loadCats();
    R.toast('关键词已更新');
  }
});
settingsModal.backdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList?.contains('cat-name-input')) e.target.blur();
  if (e.key === 'Enter' && e.target.classList?.contains('cat-kw-input')) e.target.blur();
  if (e.key === 'Enter' && e.target.id === 'newCatName') settingsModal.backdrop.querySelector('#newCatSave').click();
});
$('settingsBtn').addEventListener('click', async () => {
  await renderSettingsModal();
  settingsModal.backdrop.classList.add('show');
});

/* ═══════════ 日历周导航 ═══════════ */
/* ═══════════ 日历导航：周/月切换 + 前后翻 + 回今天 ═══════════ */
function updateSegUI() {
  $('segWeek').classList.toggle('on', viewMode === 'week');
  $('segMonth').classList.toggle('on', viewMode === 'month');
}
$('segWeek').addEventListener('click', () => { if (viewMode !== 'week') { viewMode = 'week'; updateSegUI(); refresh(); } });
$('segMonth').addEventListener('click', () => { if (viewMode !== 'month') { viewMode = 'month'; updateSegUI(); refresh(); } });
$('calPrev').addEventListener('click', () => { viewMode === 'month' ? monthOffset-- : weekOffset--; refresh(); });
$('calNext').addEventListener('click', () => { viewMode === 'month' ? monthOffset++ : weekOffset++; refresh(); });
$('calTodayBtn').addEventListener('click', () => { weekOffset = 0; monthOffset = 0; refresh(); });

/* ═══════════ 自动主题（白天 07:00–20:00 / 夜间 20:00–次日 07:00） ═══════════ */
function autoTheme() {
  const h = new Date().getHours();
  return (h >= 20 || h < 7) ? 'night' : 'day';
}
function applyAutoTheme() {
  document.documentElement.dataset.theme = autoTheme();
}
function scheduleThemeSwitch() {
  const now = new Date();
  const candidates = [
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 0, 0),
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0),
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 7, 0, 0),
  ];
  const next = candidates.filter(d => d > now).sort((a, b) => a - b)[0];
  if (!next) return;
  setTimeout(() => { applyAutoTheme(); scheduleThemeSwitch(); }, next - now + 1000);
}

/* ═══════════ 每日提醒（桌面通知：每晚到点提醒「今日 To Do」未完成事项） ═══════════ */
async function checkEveningReminder() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!(await db.getSetting('notifyEnabled', true))) return;
  const time = String(await db.getSetting('notifyTime', '22:00'));
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return; // 还没到点
  const today = todayStr();
  if ((await db.getSetting('lastRemindDate', '')) === today) return; // 今天已提醒过
  const tasks = await db.getTasksByDate(today);
  const pending = tasks.filter(t => t.status !== 'done' && t.status !== 'archived');
  if (!pending.length) return; // 没未完成就不打扰
  await db.setSetting('lastRemindDate', today);
  const shown = pending.slice(0, 6).map(t => '• ' + t.title).join('\n');
  const more = pending.length > 6 ? `\n… 还有 ${pending.length - 6} 项` : '';
  try {
    new Notification('叨叨清单 · 今晚待办提醒', {
      body: `还有 ${pending.length} 项没完成：\n${shown}${more}`,
      tag: 'daodao-evening-reminder',
    });
  } catch (err) { console.error('通知发送失败：', err); }
}

/* ═══════════ 拖拽分隔条 ═══════════ */
const dragBar = $('dragBar');
const leftPanels = $('leftPanels');
dragBar.addEventListener('pointerdown', (e) => {
  dragBar.classList.add('active');
  dragBar.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const w = Math.min(Math.max(ev.clientX, 480), Math.min(window.innerWidth - 520, 860));
    leftPanels.style.width = w + 'px';
  };
  const up = () => {
    dragBar.classList.remove('active');
    db.setSetting('leftPanelWidth', parseInt(leftPanels.style.width, 10));
    dragBar.removeEventListener('pointermove', move);
    dragBar.removeEventListener('pointerup', up);
    R.updateNowLine(false);
  };
  dragBar.addEventListener('pointermove', move);
  dragBar.addEventListener('pointerup', up);
});

/* ═══════════ 吉祥物彩蛋 ═══════════ */
const CHEERS = ['今天也要加油鸭！', '打卡就有奖章哦～', '别忘了晚上的健身！', '叨叨一句，我来整理～'];
$('mascotBig').addEventListener('click', () => {
  const b = $('bubble');
  b.textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
});

/* ═══════════ 调试钩子：控制台里 window.__daodao.handleVoiceText('明天下午三点组会') 可直接测解析 ═══════════ */
window.__daodao = { handleVoiceText, openTextParser, refresh, llmParse };

/* ═══════════ 启动 ═══════════ */
async function init() {
  await migrateLocalStorage();
  await seedIfEmpty();
  if (new URLSearchParams(location.search).has('demo')) await seedDemo();
  // 一次性迁移：打卡去掉时间（既有习惯实例改为全天、清掉习惯上的 time 字段）
  if (!(await db.getSetting('routineNoTimeMigrated', false))) {
    for (const t of await db.getWhere('tasks', x => x.type === 'routine_instance')) {
      if (t.startTime || t.endTime) { t.startTime = null; t.endTime = null; await db.put('tasks', t); }
    }
    for (const r of await db.getAll('routines')) {
      if (r.time) { delete r.time; await db.put('routines', r); }
    }
    await db.setSetting('routineNoTimeMigrated', true);
  }
  // 一次性清理：暂停中的习惯，删掉它已生成的实例（页面不再残留暂停打卡的记录）
  if (!(await db.getSetting('routineInstancesCleaned', false))) {
    for (const r of (await db.getAll('routines')).filter(x => !x.active)) {
      await removeRoutineInstances(r.id);
    }
    await db.setSetting('routineInstancesCleaned', true);
  }
  // 兜底：给没有关键词的类别补上默认关键词（保证规则解析 / LLM 提示词与前端类别联动）
  for (const c of await db.getAll('categories')) {
    if (c.keywords === undefined) {
      c.keywords = DEFAULT_CATEGORY_KEYWORDS[c.id] || '';
      await db.put('categories', c);
    }
  }
  await R.loadCats();
  await applyCatColors();

  // 主题按时间自动（20:00–次日 07:00 夜间）；面板宽度恢复
  applyAutoTheme();
  scheduleThemeSwitch();
  const w = await db.getSetting('leftPanelWidth', null);
  if (w) leftPanels.style.width = w + 'px';

  // 面板头部日期
  const now = new Date();
  $('todayDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`;
  const wk = weekDates(0).map(dateStr);
  const short = (s) => s.slice(5).replace('-', '/');
  $('weekRange').textContent = `${short(wk[0])} – ${short(wk[6])}`;

  await refresh();
  try { await B.evaluate(); } catch (e) { console.error('奖章结算失败：', e); } // 启动补发（跨周/隔天）
  checkEveningReminder().catch(() => {}); // 打开页面即检查一次（若已过提醒时间且今天未提醒）
  setInterval(() => { applyAutoTheme(); R.updateNowLine(false); checkEveningReminder().catch(() => {}); }, 60000);
  window.addEventListener('resize', () => R.updateNowLine(false));
}
init().catch(err => {
  console.error('初始化失败：', err);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;' +
    'background:#EF6E5A;color:#fff;padding:14px 18px;border-radius:12px;font-size:13px;max-width:80vw;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:10px;align-items:flex-start';
  banner.id = 'initError';
  banner.innerHTML =
    `<span>初始化失败：${R.esc(err.message)}</span>` +
    `<span style="font-size:11.5px;opacity:.9;line-height:1.5">常见原因：① 没通过本地服务器打开（要用 http://localhost:8417，不能直接双击 index.html）；② 浏览器里残留了旧版本的数据。</span>` +
    `<div style="display:flex;gap:8px">` +
    `<button data-fix="reload" style="border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px">重新加载</button>` +
    `<button data-fix="reset" style="border:none;background:#fff;color:#EF6E5A;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600">清除本地数据并重载</button>` +
    `</div>`;
  document.body.appendChild(banner);
  banner.querySelector('[data-fix="reload"]').onclick = () => location.reload();
  banner.querySelector('[data-fix="reset"]').onclick = async () => {
    try { await closeDB(); } catch (e) {}
    try { indexedDB.deleteDatabase('daodao-todo'); } catch (e) {}
    try { localStorage.clear(); } catch (e) {}
    location.reload();
  };
});
