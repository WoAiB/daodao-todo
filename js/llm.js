/* LLM 兜底解析：规则解析不出来时，把这句话发给通义千问（OpenAI 兼容接口）解析。
   仅发送当次识别的文字，其余数据都在本机；API Key 存在本机 IndexedDB settings。 */

import { db } from './db.js';
import { todayStr, dateStr } from './util.js';
import { DEFAULT_CATEGORIES } from './seed.js';

const TASK_TYPES = ['task', 'ddl', 'event'];

export async function llmConfig() {
  const [enabled, apiKey, model, baseUrl] = await Promise.all([
    db.getSetting('llmEnabled', false),
    db.getSetting('llmApiKey', ''),
    db.getSetting('llmModel', 'qwen-plus'),
    db.getSetting('llmBaseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
  ]);
  return { enabled: !!enabled, apiKey, model, baseUrl };
}

const SYSTEM_PROMPT = (today, weekday, cats) => {
  /* 示例里的"下周三"动态换算成真实日期，避免模型抄旧日期 */
  const now = new Date();
  const cur = now.getDay(); // 0=周日
  const daysToNextMon = cur === 0 ? 1 : 8 - cur;
  const nextWed = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToNextMon + 2);
  const wed = dateStr(nextWed); // 本地时区格式化，不能用 toISOString（UTC 会偏一天）

  const list = (cats && cats.length) ? cats : DEFAULT_CATEGORIES;
  const catIds = list.map(c => c.id).join('|');
  const catLine = list.map(c => `${c.id}=${c.name}${c.keywords ? '（关键词：' + c.keywords + '）' : ''}`).join('；');
  const fallbackId = list.some(c => c.id === 'life') ? 'life' : list[0].id;

  return `你是「叨叨清单」待办工具的语音输入解析器。用户用一句话（语音识别的结果，常常没有任何标点、多件事连着说）提出三类需求之一，你负责判断类型并解析。今天是 ${today}（周${weekday}）。只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记。

三类需求：
A. 今日待办："今天我要完成X、Y、Z" → 把 X、Y、Z 拆成多条今天的普通 task，绝不能把原话整句当成一条任务；
B. 日历日程：提到具体日期/星期 + 上课、考试、DDL、开会等 → 拆成带日期时间的 event 或 ddl，可以一条句子里有多件；"同一天/当天"沿用上一句的日期；
C. 重复习惯："每天/每周X/工作日做某事" → routine。

输出格式（三选一）：
1. {"type":"routine","title":"简短习惯名","daysOfWeek":[0-6 的数字数组，0=周日],"categoryId":"${catIds}"}
2. {"type":"tasks","tasks":[{"title":"简短任务名","date":"YYYY-MM-DD","startTime":"HH:MM 或 null","endTime":"HH:MM 或 null","taskType":"task|ddl|event","categoryId":"${catIds}","deadline":"YYYY-MM-DD 或 null"}]}
3. 实在解析不了：{"type":"unknown"}

可用类别（categoryId 只能从下列 id 里选；名字后的关键词仅供判断参考）：
${catLine}
判断依据：根据内容含义选择最匹配的 categoryId；实在拿不准就归到「${fallbackId}」。

规则：
- 相对日期（明天/下周三/11月25号）换算成具体 YYYY-MM-DD；"也就是11月25号"是对前面日期的确认，取同一日期；"同一天/当天"沿用上一句；
- 模糊时间（月底/放假前）估一个合理的未来日期；
- "上午"09:00、"下午"15:00、"晚上"19:00、"中午"12:00；说了几点用具体时间；
- 要交/截止/DDL → taskType="ddl"，deadline=截止日；上课/考试/开会/外出 → "event"；今天要做的普通事 → "task"；
- title 简短（≤15字）且不含日期时间词；
- 只表达意图没有实际内容的话（如"我要创建日程"）→ unknown。

示例（${wed} 是"下周三"换算后的日期，仅供演示，实际输出以今天 ${today} 重新换算；示例里的 categoryId 若不在可用类别里，请改用含义最接近的 id）：
"今天我要完成高数作业背50个单词取快递"
→ {"type":"tasks","tasks":[{"title":"高数作业","date":"${today}","startTime":null,"endTime":null,"taskType":"task","categoryId":"ddl"},{"title":"背50个单词","date":"${today}","startTime":null,"endTime":null,"taskType":"task","categoryId":"study"},{"title":"取快递","date":"${today}","startTime":null,"endTime":null,"taskType":"task","categoryId":"life"}]}
"下周三也就是11月25号有一个LLM作业的DDL在晚上7点同一天数据挖掘考试在晚上7点到8点"
→ {"type":"tasks","tasks":[{"title":"LLM作业","date":"${wed}","startTime":"19:00","endTime":null,"taskType":"ddl","categoryId":"ddl","deadline":"${wed}"},{"title":"数据挖掘考试","date":"${wed}","startTime":"19:00","endTime":"20:00","taskType":"event","categoryId":"class","deadline":null}]}
"我每周二周四周六需要去健身时间不确定"
→ {"type":"routine","title":"健身","daysOfWeek":[2,4,6],"categoryId":"sport"}
"我要创建日程"
→ {"type":"unknown"}`;
};

function normalize(obj, cats) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'unknown' || !obj.type) return null;
  const list = (cats && cats.length) ? cats : DEFAULT_CATEGORIES;
  const ids = new Set(list.map(c => c.id));
  const fallbackId = ids.has('life') ? 'life' : list[0].id;
  const validCat = (id) => ids.has(id) ? id : fallbackId;

  if (obj.type === 'routine') {
    const days = Array.isArray(obj.daysOfWeek)
      ? [...new Set(obj.daysOfWeek.map(Number).filter(d => d >= 0 && d <= 6))].sort() : null;
    if (!days || !days.length) return null;
    const time = /^\d{2}:\d{2}$/.test(obj.time || '') ? obj.time : null; // "时间不确定" → 不预设
    const cat = validCat(obj.categoryId);
    return { kind: 'routine', routine: { name: (obj.title || '新习惯').slice(0, 12), days, time, cat } };
  }

  if (obj.type === 'tasks' && Array.isArray(obj.tasks) && obj.tasks.length) {
    const tasks = obj.tasks.map(t => {
      if (!t || !t.title) return null;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : todayStr();
      const ok = (v) => /^\d{2}:\d{2}$/.test(v || '') ? v : null;
      const type = TASK_TYPES.includes(t.taskType) ? t.taskType : 'task';
      return {
        title: String(t.title).slice(0, 30),
        date,
        startTime: ok(t.startTime), endTime: ok(t.endTime),
        type,
        categoryId: validCat(t.categoryId),
        deadline: type === 'ddl' && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline || '') ? t.deadline : (type === 'ddl' ? date : null),
      };
    }).filter(Boolean);
    if (!tasks.length) return null;
    return { kind: 'tasks', tasks };
  }
  return null;
}

/** 调 LLM 解析；返回与 parseInput 相同结构，失败/未配置返回 null（throw 仅在网络错误时） */
export async function llmParse(text) {
  const cfg = await llmConfig();
  if (!cfg.enabled || !cfg.apiKey) return null;

  let cats = await db.getAll('categories');
  if (!cats || !cats.length) cats = DEFAULT_CATEGORIES;

  const now = new Date();
  const resp = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(todayStr(), '日一二三四五六'[now.getDay()], cats) },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  content = content.replace(/```json|```/g, '').trim();
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) { console.warn('[LLM] 返回内容里没有 JSON：', content.slice(0, 200)); return null; }
  try { return normalize(JSON.parse(m[0]), cats); } catch (e) { console.warn('[LLM] JSON 解析失败：', m[0].slice(0, 200)); return null; }
}
