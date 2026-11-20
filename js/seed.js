/* 首次运行预置数据（PRD 5.2 类别 / 6.F6 预置习惯 / 6.F8 奖章规则表 v1 / 12 节定稿值）
   以及 ?demo=1 时的示例任务（仅任务表为空时注入，可整周删除） */

import { db, uid } from './db.js';
import { todayStr, weekDates, dateStr, todayIdxInWeek } from './util.js';

/* 各类别的默认关键词（规则解析与 LLM 提示词据此联动；用户可在设置里改） */
export const DEFAULT_CATEGORY_KEYWORDS = {
  ddl:   '作业,论文,实验报告,课设,报告,截止,提交,上交,交稿,交卷,DDL,deadline',
  meet:  '会议,组会,讲座,研讨,报告会,沙龙,峰会,答辩,面试,论坛,分享,宣讲,路演',
  class: '上课,课程,考试,早八,实验课,lecture',
  sport: '健身,运动,跑步,锻炼,瑜伽,普拉提,撸铁,游泳,打球,羽毛球,篮球,排球,乒乓球,网球,跳绳,骑行,爬山,散步,快走',
  study: '学习,复习,预习,背单词,单词,读书,看书,刷题,刷课,代码,编程,算法,简历,英语,四六级,考研,雅思,托福,文献,论文思路',
  life:  '取快递,生活,杂事,看牙,看病,聚会,聚餐,购物,打扫,缴费',
};

export const DEFAULT_CATEGORIES = [
  { id: 'ddl',    name: '课程 DDL', icon: '📕', color: '#EF6E5A', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.ddl },
  { id: 'meet',   name: '学术会议', icon: '📒', color: '#EFAF3C', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.meet },
  { id: 'class',  name: '日常上课', icon: '📗', color: '#55B37E', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.class },
  { id: 'sport',  name: '体育运动', icon: '🌸', color: '#EF87A5', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.sport },
  { id: 'study',  name: '学习打卡', icon: '📘', color: '#6B9CD8', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.study },
  { id: 'life',   name: '生活杂事', icon: '⬜', color: '#A59E96', builtin: true, keywords: DEFAULT_CATEGORY_KEYWORDS.life },
];

/* 首批习惯（PRD 12 节 #3 定稿；daysOfWeek 与 JS Date 对齐，0=周日） */
const ROUTINE_PRESETS = [
  { id: 'r-sport', title: '健身',     categoryId: 'sport', daysOfWeek: [1, 3, 5],       active: true, badgeCode: 'habit-sport' },
  { id: 'r-study', title: '学习打卡', categoryId: 'study', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], active: true, badgeCode: 'habit-study' },
  { id: 'r-web',   title: '个人网站', categoryId: 'study', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], active: true, badgeCode: 'habit-web' },
  { id: 'r-media', title: '自媒体',   categoryId: 'meet',  daysOfWeek: [0, 2, 4, 6],   active: true, badgeCode: 'habit-media' },
];

/* 习惯奖章（每个习惯专属名称，铜/银/金，规则 v2 见 PRD 6.F8⑤） */
const HABIT_BADGES = [
  { routineId: 'r-sport', name: '运动健将' },
  { routineId: 'r-study', name: '学海拾贝' },
  { routineId: 'r-web',   name: '建站达人' },
  { routineId: 'r-media', name: '笔耕不辍' },
];
const HABIT_TIERS = [
  { tier: 'bronze', suffix: '铜', weeks: 1, condition: '连续 1 周全勤' },
  { tier: 'silver', suffix: '银', weeks: 2, condition: '连续 2 周全勤' },
  { tier: 'gold',   suffix: '金', weeks: 4, condition: '连续 4 周全勤（之后每 4 周多发一枚）' },
];

/* TODO 奖章「今日清零」（规则 v2：连续 3/6/12 天清空每日清单） */
const TODO_BADGES = [
  { code: 'todo-clear-bronze', name: '今日清零 · 铜', kind: 'todo', tier: 'bronze', days: 3 },
  { code: 'todo-clear-silver', name: '今日清零 · 银', kind: 'todo', tier: 'silver', days: 6 },
  { code: 'todo-clear-gold',   name: '今日清零 · 金', kind: 'todo', tier: 'gold',   days: 12 },
];

/* 奖章规则版本：badgeDefs 里存量版本不符时清空重种（v1 扭蛋规则 → v2 阶梯兑换） */
const BADGE_RULES_VERSION = 2;

/* 默认设置（规则 v2 定稿值 + LLM 兜底配置） */
export const DEFAULT_SETTINGS = {
  rewardLadder: [           // 奖章消耗式兑换阶梯
    { cost: 5,  name: '一个礼物' },
    { cost: 10, name: '一顿好吃的' },
    { cost: 15, name: '蹦迪' },
    { cost: 20, name: '一次旅行' },
  ],
  badgeSpent: 0,           // 累计已消耗奖章数（余额 = 已获得 − 已消耗）
  completionThreshold: 0.95,
  deferExempt: true,       // 顺延任务不计入完成率（#4）
  reminderMorning: '08:30',
  reminderEvening: '21:00',
  notifyEnabled: true,     // 每晚桌面通知提醒未完成事项
  notifyTime: '22:00',
  // AI 解析兜底（通义千问，规则解析不了时才调用；仅发送那句话的文本）
  // ⚠️ 这里不要填真实 Key：请在应用内「设置 → AI 解析兜底」里填，Key 存在本机 IndexedDB，
  //    不会进入 Git / GitHub。公开仓库默认留空即可；想本地固化默认值就用 gitignore 的 config.local.js。
  llmEnabled: true,
  llmApiKey: '',
  llmModel: 'qwen-plus',
};

/* 本地个性化覆盖：被 gitignore 的 config.local.js 可定义 window.__DAODAO_LOCAL__ = { settings: {...} }，
   用于覆盖"首次运行"的默认值（自己的 API Key、奖励阶梯、提醒时间等），不会提交到 GitHub。
   settings 之外的字段本工具暂时不覆盖（类别/习惯等可在应用内设置并持久化）。 */
const LOCAL_OVERRIDES = (typeof window !== 'undefined' && window.__DAODAO_LOCAL__) || {};
function effectiveSettings() {
  return { ...DEFAULT_SETTINGS, ...(LOCAL_OVERRIDES.settings || {}) };
}

export async function seedIfEmpty() {
  if ((await db.count('categories')) === 0) {
    await Promise.all(DEFAULT_CATEGORIES.map(c => db.put('categories', c)));
  }
  if ((await db.count('routines')) === 0) {
    await Promise.all(ROUTINE_PRESETS.map(r =>
      db.put('routines', { ...r, createdAt: Date.now() })));
  }
  // 奖章规则：为空，或是旧版本（v1 扭蛋规则）→ 清空重种 v2
  const existingDefs = await db.getAll('badgeDefs');
  const stale = existingDefs.length > 0 && existingDefs.some(d => d.rulesVersion !== BADGE_RULES_VERSION);
  if ((await db.count('badgeDefs')) === 0 || stale) {
    await db.clear('badgeDefs');
    const defs = [];
    for (const hb of HABIT_BADGES) {
      for (const t of HABIT_TIERS) {
        defs.push({
          code: `${hb.routineId}-${t.tier}`,
          name: `${hb.name} · ${t.suffix}`,
          kind: 'habit', tier: t.tier, routineId: hb.routineId,
          weeks: t.weeks, repeatable: true, condition: t.condition,
          rulesVersion: BADGE_RULES_VERSION,
        });
      }
    }
    for (const b of TODO_BADGES) {
      defs.push({
        ...b, repeatable: true,
        condition: `连续 ${b.days} 天清空每日清单（之后每 ${b.days} 天多发一枚）`,
        rulesVersion: BADGE_RULES_VERSION,
      });
    }
    await Promise.all(defs.map(d => db.put('badgeDefs', d)));
  }
  // v1 的扭蛋奖池占位数据废弃；旧设置键清理
  if ((await db.count('rewardPool')) > 0) await db.clear('rewardPool');
  for (const k of ['badgesPerDraw', 'drawCap']) await db.delete('settings', k);
  for (const [k, v] of Object.entries(effectiveSettings())) {
    if ((await db.get('settings', k)) === undefined) await db.setSetting(k, v);
  }
}

/* ── ?demo=1 示例数据：日期相对当前周动态生成 ── */

function makeTask(t) {
  return {
    id: uid('t-'), type: 'task', priority: 0, tags: [], note: '',
    source: 'demo', status: 'todo',
    createdAt: Date.now(), updatedAt: Date.now(),
    ...t,
  };
}

export async function seedDemo() {
  if ((await db.count('tasks')) > 0) return;
  const week = weekDates(0).map(dateStr);
  const today = todayStr();
  const ti = todayIdxInWeek();

  const tasks = [
    // ── 今天（对照原视觉稿） ──
    makeTask({ title: '操作系统作业初稿', categoryId: 'ddl', date: today, type: 'ddl', deadline: week[2], status: 'done' }),
    makeTask({ title: '投三份简历', categoryId: 'life', date: today, startTime: '10:00', type: 'task', status: 'done' }),
    makeTask({ title: '产品组会', categoryId: 'meet', date: today, startTime: '15:00', endTime: '16:30', type: 'event', status: 'done' }),
    makeTask({ title: '取快递', categoryId: 'life', date: today, type: 'task' }),
    makeTask({ title: '健身 · 胸 + 三头', categoryId: 'sport', date: today, type: 'routine_instance', routineId: 'r-sport' }),
    makeTask({ title: '学习打卡', categoryId: 'study', date: today, type: 'routine_instance', routineId: 'r-study' }),
    // ── 本周其他天 ──
    makeTask({ title: '个人网站 · 画首页设计稿', categoryId: 'study', date: week[Math.min(ti + 1, 6)], type: 'task' }),
    makeTask({ title: '操作系统作业', categoryId: 'ddl', date: week[2], type: 'ddl', deadline: week[2] }),
    makeTask({ title: '数据库实验报告', categoryId: 'class', date: week[4], type: 'task' }),
    makeTask({ title: '健身 · 背 + 二头', categoryId: 'sport', date: week[5], type: 'routine_instance', routineId: 'r-sport' }),
    makeTask({ title: '学术论坛 · 分享会', categoryId: 'meet', date: week[6], startTime: '14:00', endTime: '16:00', type: 'event' }),
    // ── 日历时间轴课程/日程 ──
    makeTask({ title: '上课 · 操作系统', categoryId: 'class', date: week[0], startTime: '10:00', endTime: '11:30', type: 'event' }),
    makeTask({ title: '上课 · 数据库', categoryId: 'class', date: week[2], startTime: '10:00', endTime: '11:30', type: 'event' }),
    makeTask({ title: '导师 1v1', categoryId: 'meet', date: week[2], startTime: '14:00', endTime: '15:00', type: 'event' }),
    makeTask({ title: '上课 · 算法导论', categoryId: 'class', date: week[3], startTime: '16:00', endTime: '17:30', type: 'event' }),
    makeTask({ title: '看牙医', categoryId: 'life', date: week[5], startTime: '15:00', endTime: '16:00', type: 'event' }),
  ];
  await Promise.all(tasks.map(t => db.put('tasks', t)));

  /* 习惯打卡记录：让习惯卡片有进度（健身 2/3、学习 4/7…） */
  const logs = [];
  const addLog = (routineId, date, done = true) =>
    logs.push({ id: uid('hl-'), routineId, date, done });
  const past = Math.max(ti, 1); // 本周已过去的日子
  for (let i = 0; i < past; i++) addLog('r-study', week[i]);
  addLog('r-study', today);
  if (ti >= 1) addLog('r-sport', week[1]);
  if (ti >= 3) addLog('r-sport', week[3]);
  for (let i = 0; i < past; i += 2) addLog('r-media', week[i]);
  if (ti >= 2) addLog('r-web', week[2]);
  await Promise.all(logs.map(l => db.put('habitLogs', l)));
}
