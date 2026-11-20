/* 规则解析（PRD F1 + 附录）：
   一句话 → Routine（每天/每周X/工作日/每周末）
          → 任务列表（今天/明天/周X/X月X号 + 上午下午晚上X点 + 类型/类别关键词）
   解析不了 → 返回 unknown，由上层走 LLM 兜底 */

import { todayStr, dateStr, pad2 } from './util.js';
import { DEFAULT_CATEGORIES } from './seed.js';

/* 未显式传入类别时，用内置类别兜底（保证解析可独立运行） */
const FALLBACK_CATS = DEFAULT_CATEGORIES.map(c => ({ id: c.id, name: c.name, keywords: c.keywords }));

/* ── 中文数字 ── */
export function cnNum(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return +s;
  const m = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (m[s[1]] || 0);
  if (s.length === 2 && s[1] === '十') return (m[s[0]] || 1) * 10;
  if (s.length === 3 && s[1] === '十') return (m[s[0]] || 1) * 10 + (m[s[2]] || 0);
  return m[s] ?? null;
}

const WD_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

/* 纯指令句：只是说"我要创建日程/帮我记一下待办"这类意图，没有实际内容。
   这类话绝不能当成任务存进去（v2 修复：用户说"我要创建日程"结果被建成一条任务）。 */
const EMPTY_CMD_RE = /^(?:我)?(?:想要?|要|想|麻烦|帮我?|请|得)?(?:创建|新建|添加|增?加|记录?|建|设置|说)(?:一下|一个|一条|个|条|些)?(?:新的)?(?:日程|待办|任务|事项|提醒|计划|清单|习惯|打卡|安排)?[哈吧呀呢啊哦了的]*$/;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); };

/* ── 日期识别 ── */
export function parseDateExpr(t) {
  const words = [];
  const eat = (re) => { const m = t.match(re); if (m) { words.push(m[0]); return m; } return null; };
  let m, date = null;

  if (eat(/大后天/)) date = addDays(3);
  else if (eat(/后天/)) date = addDays(2);
  else if (eat(/明晚/)) date = addDays(1);
  else if (eat(/明天|明日/)) date = addDays(1);
  else if (eat(/今天|今晚|今日/)) date = addDays(0);
  else if (m = eat(/下(?:周|星期|礼拜)([一二三四五六日天])/)) {
    // 下周X = 下个日历周的周X
    const target = WD_MAP[m[1]];
    const now = new Date();
    const cur = now.getDay(); // 0=周日
    const daysToNextMon = cur === 0 ? 1 : 8 - cur;
    date = addDays(daysToNextMon + (target === 0 ? 6 : target - 1));
  }
  else if (m = eat(/下(?:个)?周末/)) {
    const cur = new Date().getDay();
    const daysToNextMon = cur === 0 ? 1 : 8 - cur;
    date = addDays(daysToNextMon + 5); // 下周六
  }
  else if (m = eat(/(?:这|本|这个)?周末/)) {
    const cur = new Date().getDay();
    date = addDays(cur === 0 ? 0 : (6 - cur + 7) % 7); // 最近未来周六（周日当天即当天）
  }
  else if (m = eat(/(?:本)?(?:周|星期|礼拜)([一二三四五六日天])/)) {
    // 周X = 最近未来（含今天）
    const target = WD_MAP[m[1]];
    const cur = new Date().getDay();
    date = addDays((target - cur + 7) % 7);
  }
  else if (m = eat(/(\d{1,2})月(\d{1,2})[号日]?/)) {
    const mo = +m[1], da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const now = new Date();
      let y = now.getFullYear();
      if (new Date(y, mo - 1, da) < new Date(y, now.getMonth(), now.getDate())) y++;
      date = dateStr(new Date(y, mo - 1, da));
    }
  }
  else if (m = eat(/下个?月(\d{1,2})[号日]/)) {
    const da = +m[1];
    const now = new Date();
    if (da >= 1 && da <= 31) {
      const nextMo = new Date(now.getFullYear(), now.getMonth() + 1, da);
      date = dateStr(nextMo);
    }
  }
  else if (m = eat(/([一二三四五六七八九十]{1,3})月([一二三四五六七八九十\d]{1,3})[号日]?/)) {
    const mo = cnNum(m[1]), da = cnNum(m[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const now = new Date();
      let y = now.getFullYear();
      if (new Date(y, mo - 1, da) < new Date(y, now.getMonth(), now.getDate())) y++;
      date = dateStr(new Date(y, mo - 1, da));
    }
  }
  return date ? { date, words } : null;
}

/* ── 时间识别（含时段默认值） ── */
const PERIOD_DEFAULT = {
  '凌晨': '06:00', '早上': '09:00', '早晨': '09:00', '上午': '09:00',
  '中午': '12:00', '下午': '15:00', '傍晚': '17:00',
  '晚上': '19:00', '每晚': '19:00', '夜里': '21:00', '今晚': '19:00', '明晚': '19:00',
};
const NUM = '([一二三四五六七八九十两]+|\\d+)'; // 中文数字和阿拉伯数字不能连着匹配（"三19点"会被黏成一个数）

export function parseTimeExpr(t) {
  const words = [];
  const mer = t.match(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|每晚|夜里|今晚|明晚)/);
  const meridiem = mer ? mer[1] : null;
  if (mer) words.push(mer[1]);

  const parseClock = (hStr, minStr) => {
    let h = cnNum(hStr), min = 0;
    if (h == null) return null;
    if (minStr === '半') min = 30;
    else if (minStr) { const v = cnNum(minStr); if (v != null) min = v; }
    // 时段修正
    if (meridiem) {
      if (/下午|傍晚|晚上|每晚|夜里|今晚|明晚/.test(meridiem) && h < 12) h += 12;
      else if (meridiem === '中午' && h < 11) h += 12;
    }
    if (h > 23 || min > 59) return null;
    return pad2(h) + ':' + pad2(min);
  };

  // 时间段：X点到Y点（含 半/分）
  let startTime = null, endTime = null, hasClock = false;
  const range = t.match(new RegExp(NUM + '点(半|[一二三四五六七八九十\\d]{1,3}分)?\\s*(?:到|至|-|—|~)\\s*' + NUM + '点(半|[一二三四五六七八九十\\d]{1,3}分)?'));
  if (range) {
    const s = parseClock(range[1], range[2]);
    const e = parseClock(range[3], range[4]);
    if (s && e) {
      startTime = s; endTime = e; hasClock = true;
      words.push(range[0]);
    }
  }
  if (!startTime) {
    const single = t.match(new RegExp(NUM + '点(半|[一二三四五六七八九十\\d]{1,3}分)?'));
    if (single) {
      const s = parseClock(single[1], single[2]);
      if (s) { startTime = s; hasClock = true; words.push(single[0]); }
    }
  }
  if (!startTime && meridiem) startTime = PERIOD_DEFAULT[meridiem] || null;
  return { startTime, endTime, words, hasClock };
}

/* ── 类型与类别推断 ── */
const DDL_RE = /提交|上交|截止|交稿|交卷|DDL|ddl|deadline|Deadline|交(?=[^，。；、]{0,12}(作业|报告|论文|实验|代码|材料|项目|设计|PPT|ppt))|(?:要|得|该|需|就|记得)交/;
const EVENT_RE = /开会|组会|会议|答辩|面试|分享会|论坛|讲座|面谈|约了|约个|看牙|看病|看医生|复诊|体检|聚会|聚餐|比赛|上课|考试|抢票|取票|赶车|接人|接机/;

export function inferType(t, hasClock) {
  if (DDL_RE.test(t)) return 'ddl';
  if (EVENT_RE.test(t)) return 'event';
  if (hasClock) return 'event';
  return 'task';
}

/** 根据当前类别（keywords + 名字）动态匹配：长词优先、类别名优先；都不中则归兜底 */
export function inferCategory(t, cats) {
  const list = (cats && cats.length) ? cats : FALLBACK_CATS;
  const entries = [];
  for (const c of list) {
    for (const k of String(c.keywords || '').split(/[,，、\s]+/).filter(Boolean)) {
      entries.push({ kw: k, id: c.id, isName: false });
    }
    if (c.name) entries.push({ kw: c.name, id: c.id, isName: true }); // 类别名也参与匹配，改名即联动
  }
  entries.sort((a, b) => b.kw.length - a.kw.length || (b.isName - a.isName));
  for (const e of entries) {
    if (e.kw && t.includes(e.kw)) return e.id;
  }
  const fallback = list.find(c => c.id === 'life') || list[0];
  return fallback ? fallback.id : 'life';
}

/* ── 标题清洗 ──
   循环剥前缀/标点直到稳定（"我、、、需要去健身"要剥三轮：我 → 、、、 → 需要去） */
export function cleanTitle(seg, removeWords) {
  let s = seg;
  for (const w of removeWords) s = s.split(w).join('');
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/提前[一两二三四五六七八九十\d]+天(提醒)?/g, '')
      .replace(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今晚|明晚)/g, '')
      .replace(/^[，。、,;；!！?？\s]+/, '')
      .replace(/[，。、,;；!！?？\s]+$/, '')
      .replace(/^(也就是|然后|还有|以及|另外|接着|其次|就是|同时)/, '')
      .replace(/^(我想要去|我需要去|我想要|我需要|我要去|我想去|我要|我想|我(?!们)|需要去|需要|想要|记得|帮我|麻烦|请(?=[^，。、]{2,})|打算|准备|得去|要去)/, '')
      .replace(/^(有一个|有个|一场|一个|一次)/, '')
      .replace(/^(去|做|搞|弄|完成)(?=[^，。、]{2,})/, '')
      .replace(/^(交|上交|提交|要交|该交)(?=[^，。、]{2,})/, '')
      .replace(/^(同一天|同日|当天)/, '')
      .replace(/^的时候(有|要|是|在)?/, '')
      .replace(/(的时候|的时候有|的时候)$/, '')
      .replace(/时间不确定|时间不定|时间待定|时间随便/g, '')
      .replace(/[在于是也]$/, '')
      .replace(/^[在于是]+/, '');
    if (s === before) break;
  }
  return s.slice(0, 30).trim();
}

/* ── Routine 识别（v3：支持「每周二、周四、周六」「每周二四六」「每周2、4、6」「每天周二周四周六」，
   且"每周三19点"里的 19 不会被当成周几、"每周2次"不会误判成习惯） ── */
const WD_RUN_CN = /每(?:周|星期|礼拜)((?:[一二三四五六日天][、,，和\s]*(?:周|星期|礼拜)*)+)(?![次遍回趟])/;
const WD_RUN_DIG = /每(?:周|星期|礼拜)(\d(?:[、,，和]\s*(?:周|星期|礼拜)?\d)*)(?![次遍回趟\d点时:：])/;
const WD_ONE = /(?:周|星期|礼拜)([一二三四五六日天]+)(?![次遍回趟])/g;
const wdOf = (toks) => [...toks]
  .map(c => {
    if (/\d/.test(c)) return +c;
    if (c === '日' || c === '天') return 0;
    const i = '一二三四五六'.indexOf(c);
    return i >= 0 ? i + 1 : -1; // 顿号/周/星期等非周几字符 → -1 过滤掉（不能 +1，否则变 0=周日）
  })
  .filter(i => i >= 0 && i <= 6);

export function parseRoutine(raw, cats) {
  const t = raw.replace(/\s/g, '');
  // 必须有"重复"意图，避免把"下周三开会"这类单次安排误判成习惯
  if (!/每天|每日|天天|工作日|每周末|每(?:周|星期|礼拜)/.test(t)) return null;

  let days = null;
  const freqChunks = []; // 匹配到的频率串，命名时整段剥掉
  if (/工作日/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/每周末/.test(t)) days = [0, 6];
  else {
    let toks = null;
    const runCn = t.match(WD_RUN_CN);          // "每周二、周四、周六" / "每周二四六"
    const runDig = runCn ? null : t.match(WD_RUN_DIG); // "每周2、4、6"（语音识别常给数字）
    if (runCn) { toks = runCn[1]; freqChunks.push(runCn[0]); }
    else if (runDig) { toks = runDig[1]; freqChunks.push(runDig[0]); }
    else {
      const ones = [...t.matchAll(WD_ONE)];    // "每天周二、周四、周六"：逐个"周X"提及
      if (ones.length) { toks = ones.map(m => m[1]).join(''); freqChunks.push(...ones.map(m => m[0])); }
    }
    const wd = toks ? wdOf(toks) : [];
    days = wd.length ? [...new Set(wd)].sort((a, b) => a - b)
      : (/每天|每日|天天/.test(t) ? [0, 1, 2, 3, 4, 5, 6] : null);
  }
  if (!days || !days.length) return null;

  const tm = parseTimeExpr(t);
  const time = tm.startTime || null; // "健身时间不确定" → 不预设时间

  const cat = inferCategory(t, cats);

  // 先剥掉频率描述（含整个"每周X、X、X"串）再清洗，避免星期字/数字残留
  let t2 = t;
  for (const c of freqChunks) t2 = t2.split(c).join('');
  t2 = t2.replace(/每天|每日|天天|工作日|每周末|每(?:周|星期|礼拜)|每/g, '');
  let name = cleanTitle(t2, tm.words);
  if (!name) name = '新习惯';
  return { name, days, time, cat };
}

/* ── 分句 ── */
export function splitSegments(text) {
  return text.split(/[，。；,;、\n！？!?]+/).map(s => s.trim()).filter(s => s.length >= 2);
}

/* 模糊时间词：规则啃不动的日期表述 → 整句交给 LLM 兜底，避免静默错存成"今天" */
const VAGUE_TIME_RE = /月底|月初|中旬|下旬|下个月|下月|这个月|月底前|年底|春节|寒假|暑假|放假|开学|考试周|期中|期末|节前|过两天|过几天/;

/* ── 单句 → 任务 ──
   ownDate：这句自己的日期（或"同一天"继承来的）；fallbackDate：上文日期上下文 */
function parseOneTask(seg, ownDate, fallbackDate, cats) {
  const t = seg.replace(/\s/g, '');
  // 频率描述混进任务列表时跳过（应走 Routine 流程）
  if (/每(天|日|周|星期|礼拜)|天天|工作日/.test(t)) return null;
  // 纯噪声（一个汉字都没有，如语音识别乱码）→ 丢弃，让上层走 LLM 兜底
  if (!/[一-鿿]/.test(t)) return null;

  const d = parseDateExpr(t);
  // 句子里有模糊时间表述但这句没解析出日期 → 不猜"今天"，返回 'vague' 让整句走 LLM
  if (!d && VAGUE_TIME_RE.test(t)) return 'vague';
  const tm = parseTimeExpr(t);
  const date = d ? d.date : (ownDate || fallbackDate || todayStr());
  const type = inferType(t, !!(tm && tm.hasClock));
  const deadline = type === 'ddl' ? date : null;
  const words = [...(d ? d.words : []), ...(tm ? tm.words : [])];
  let title = cleanTitle(seg, words);
  // 双日期句（"下周三也就是11月25号"）：标题里还剩第二个日期 → 一并剥掉，避免残句当任务
  if (title) {
    const d2 = parseDateExpr(title);
    if (d2) title = cleanTitle(seg, [...words, ...d2.words]);
  }
  // 纯日期残段（"25号"）也不是任务
  if (!title || title.length < 2 || /^[0-9一二三四五六七八九十]+\s*[号日]$/.test(title)) return null;
  // "创建日程"这类纯指令残段不是任务（返回 'cmd' 信号，全是指令段时上层按 command 处理）
  if (EMPTY_CMD_RE.test(title)) return 'cmd';
  // 纯上下文连接段（"然后在同一天"）也不是任务
  if (/^(同一天|同日|当天|还有|以及|同时|也是)$/.test(title)) return null;
  return {
    title, date,
    startTime: tm ? tm.startTime : null,
    endTime: tm ? tm.endTime : null,
    type, categoryId: inferCategory(t, cats), deadline,
  };
}

/* ── 总入口 ── */
export function parseInput(text, cats) {
  const t = (text || '').replace(/\s/g, '');
  if (!t) return { kind: 'unknown' };

  // 整句只是"我要创建日程"这类指令 → 不建任何东西，上层提示用户说具体内容
  if (EMPTY_CMD_RE.test(t.replace(/[，。、,;；!！?？]/g, ''))) return { kind: 'command' };

  const routine = parseRoutine(t, cats);
  if (routine) return { kind: 'routine', routine };

  const segs = splitSegments(text);
  const tasks = [];
  let cmdSegs = 0; // 整句里被识别为纯指令段的数量
  let contextDate = null; // 跨句日期上下文："在下周三，也就是11月25号，…同一天…"
  for (const seg of segs) {
    let ownDate = null;
    if (/同(一)?天|同日|当天/.test(seg)) ownDate = contextDate; // "同一天"继承上一句日期
    else {
      const d = parseDateExpr(seg);
      if (d) ownDate = d.date;
    }
    const task = parseOneTask(seg, ownDate, contextDate, cats);
    if (task === 'vague') return { kind: 'unknown' }; // 有一句模糊时间 → 整句交给 LLM，避免丢句
    if (task === 'cmd') { cmdSegs++; continue; }
    if (task) tasks.push(task);
    if (ownDate) contextDate = ownDate; // 纯日期段（"在下周三"）也要把日期带给后面的句子
  }
  if (tasks.length) return { kind: 'tasks', tasks };
  if (cmdSegs) return { kind: 'command' }; // 说了"我要创建日程"但没说内容
  return { kind: 'unknown' };
}
