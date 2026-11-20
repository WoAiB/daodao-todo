/* 日期与通用工具（周一为一周起点） */

export const pad2 = (n) => String(n).padStart(2, '0');

export function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function todayStr() { return dateStr(new Date()); }

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 本周（或偏移 offset 周）的周一~周日 Date[] */
export function weekDates(offset = 0) {
  const now = new Date();
  const diffToMon = (now.getDay() + 6) % 7; // 0=周日 → 转成周一起点
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMon + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

/** 今天在本周的序号（0=周一 … 6=周日） */
export function todayIdxInWeek() { return (new Date().getDay() + 6) % 7; }

/** 与 JS Date 对齐的星期名（0=周日），供习惯频率使用 */
export const WD_JS = ['日', '一', '二', '三', '四', '五', '六'];

/** 日历表头用："周二 11/18" */
export function dayHead(d) {
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `周${wd} ${d.getMonth() + 1}/${d.getDate()}`;
}

/** 距今天还有几天（负数=已过期） */
export function daysUntil(dateString) {
  const t = parseDate(todayStr());
  const d = parseDate(dateString);
  return Math.round((d - t) / 86400000);
}

export function ddlText(deadline) {
  const n = daysUntil(deadline);
  if (n < 0) return `逾期 ${-n} 天`;
  if (n === 0) return '就是今天！';
  return `还有 ${n} 天`;
}

/** 'HH:MM' → 分钟数 */
export function toMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** 分钟数 → 'HH:MM' */
export function fmtMin(m) {
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** 任务所属时段分组 */
export function periodOf(startTime) {
  if (!startTime) return '全天';
  const h = +startTime.slice(0, 2);
  if (h < 12) return '上午';
  if (h < 18) return '下午';
  return '晚上';
}
