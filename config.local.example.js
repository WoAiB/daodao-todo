/* ============================================================
   示例：本地个性化配置
   ------------------------------------------------------------
   使用方法：把这个文件复制一份，改名为 config.local.js（注意去掉 .example），
   再按需修改里面的值即可。config.local.js 已被 .gitignore 忽略，不会提交到 GitHub。

   可覆盖的 settings 字段（与 js/seed.js 的 DEFAULT_SETTINGS 一致）：
   - llmEnabled / llmApiKey / llmModel : AI 解析兜底开关与通义千问 Key
   - rewardLadder : 奖章兑换阶梯（数组，元素 { cost, name }）
   - completionThreshold : 完成率阈值（0~1，默认 0.95）
   - notifyEnabled / notifyTime : 每晚提醒开关与时间
   ============================================================ */
window.__DAODAO_LOCAL__ = {
  settings: {
    // llmApiKey: 'sk-你的key',
    // rewardLadder: [
    //   { cost: 5,  name: '一杯奶茶' },
    //   { cost: 10, name: '一顿火锅' },
    // ],
    // notifyTime: '21:30',
  },
};
