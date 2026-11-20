/* 奖章引擎（规则 v2）：
   习惯奖章 = 连续全勤 1/2/4 周（铜/银/金，金档每 4 周多发一枚）
   TODO 奖章「今日清零」= 连续 3/6/12 天清空每日清单（金档每 12 天多发一枚）
   奖励 = 消耗式兑换阶梯（5/10/15/20 枚） */

import { db, uid } from './db.js';
import { dateStr, weekDates } from './util.js';

/* ═══════════ 连续周期计算 ═══════════ */

/** 某习惯在某周（传入该周周一 Date）是否全勤：所有安排日都有 done 日志 */
function weekFull(routine, doneDates, monday) {
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (routine.daysOfWeek.includes(d.getDay()) && !doneDates.has(dateStr(d))) return false;
  }
  return true;
}

/**
 * 习惯连续全勤周数：从最近一个已完结的周（上周）往前数，遇到非全勤周即断。
 * 本周未结束不计入。返回 { weeks, streakStart }（streakStart = 连续段首周周一；无连续时为 null）
 */
export function habitWeekStreak(routine, logs) {
  if (!routine.daysOfWeek?.length) return { weeks: 0, streakStart: null };
  const doneDates = new Set(
    logs.filter(l => l.routineId === routine.id && l.done).map(l => l.date));
  const thisMonday = weekDates(0)[0];
  let weeks = 0, streakStart = null;
  for (let off = -1; off >= -260; off--) { // 上限 5 年，防御性兜底
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() + off * 7);
    if (weekFull(routine, doneDates, monday)) {
      weeks++;
      streakStart = dateStr(monday);
    } else break;
  }
  return { weeks, streakStart };
}

/** 某日清单是否"清空"：有任务且完成率 ≥ 阈值（archived 除外）；空日返回 null（跳过） */
function dayCleared(tasks, threshold) {
  const live = tasks.filter(t => t.status !== 'archived');
  if (!live.length) return null;
  return live.filter(t => t.status === 'done').length / live.length >= threshold;
}

/**
 * TODO 连续清零天数：从昨天往前逐日判断（今天未结束，不算也不断；空日跳过）。
 * 返回 { days, streakStart }
 */
export async function todoClearStreak() {
  const threshold = await db.getSetting('completionThreshold', 0.95);
  let days = 0, streakStart = null;
  const d = new Date();
  for (let i = 1; i <= 730; i++) { // 上限 2 年
    d.setDate(d.getDate() - 1);
    const cleared = dayCleared(await db.getTasksByDate(dateStr(d)), threshold);
    if (cleared === null) continue;   // 空日：不续不断
    if (cleared) { days++; streakStart = dateStr(d); }
    else break;
  }
  return { days, streakStart };
}

/* ═══════════ 发章结算 ═══════════ */

async function award(def, streakStart, reached, earned, fresh) {
  const key = `${def.code}:${streakStart}:${reached}`; // 同一连续段的同一节点只发一次
  if (earned.some(b => b.key === key)) return;
  const badge = {
    id: uid('b-'), key, code: def.code, name: def.name,
    tier: def.tier, kind: def.kind, routineId: def.routineId || null,
    streakStart, reached, earnedAt: Date.now(),
  };
  await db.put('badges', badge);
  earned.push(badge);
  fresh.push(badge);
}

/** 某规则在当前连续周期应发的次数：铜/银每段一次，金档每满 N 再发一枚 */
function tierTimes(tier, current, need) {
  return tier === 'gold' ? Math.floor(current / need) : (current >= need ? 1 : 0);
}

/**
 * 结算发章：检查所有习惯 + TODO 是否到达未发放节点。
 * 返回本次新发的奖章数组（供 UI 弹提示）。
 */
export async function evaluate() {
  const [routines, logs, defs, earned] = await Promise.all([
    db.getAll('routines'), db.getAll('habitLogs'),
    db.getAll('badgeDefs'), db.getAll('badges'),
  ]);
  const fresh = [];

  for (const r of routines.filter(r => r.active)) {
    const { weeks, streakStart } = habitWeekStreak(r, logs);
    if (!weeks || !streakStart) continue;
    for (const def of defs.filter(d => d.kind === 'habit' && d.routineId === r.id)) {
      const times = tierTimes(def.tier, weeks, def.weeks);
      for (let k = 1; k <= times; k++) await award(def, streakStart, k * def.weeks, earned, fresh);
    }
  }

  const { days, streakStart } = await todoClearStreak();
  if (days && streakStart) {
    for (const def of defs.filter(d => d.kind === 'todo')) {
      const times = tierTimes(def.tier, days, def.days);
      for (let k = 1; k <= times; k++) await award(def, streakStart, k * def.days, earned, fresh);
    }
  }
  return fresh;
}

/* ═══════════ 余额与兑换 ═══════════ */

/** 奖章余额 = 已获得总数 − 累计已消耗 */
export async function badgeBalance() {
  const [total, spent] = await Promise.all([db.count('badges'), db.getSetting('badgeSpent', 0)]);
  return total - spent;
}

/** 消耗式兑换：扣减余额，写兑换历史。余额不足返回 false。 */
export async function redeem(reward) {
  if ((await badgeBalance()) < reward.cost) return false;
  const spent = await db.getSetting('badgeSpent', 0);
  await db.setSetting('badgeSpent', spent + reward.cost);
  await db.put('rewardDraws', {
    id: uid('rd-'), reward: reward.name, cost: reward.cost,
    redeemedAt: Date.now(), fulfilled: false,
  });
  return true;
}

/** 兑换历史（新→旧） */
export function redeemHistory() {
  return db.getAll('rewardDraws').then(a => a.sort((x, y) => y.redeemedAt - x.redeemedAt));
}
