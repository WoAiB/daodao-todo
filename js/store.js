/* 设置访问层：视觉稿时期的 localStorage 状态迁移到 IndexedDB，
   之后主题/类别色/面板宽度等一律走 settings 与 categories store */

import { db } from './db.js';

function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }

/** 一次性迁移旧视觉稿的 localStorage 数据（迁移后不删除，留作回滚备份） */
export async function migrateLocalStorage() {
  // 类别颜色 dd-cat-colors → categories.color
  const savedColors = lsJSON('dd-cat-colors', {});
  if (Object.keys(savedColors).length) {
    for (const c of await db.getAll('categories')) {
      if (savedColors[c.id]) { c.color = savedColors[c.id]; await db.put('categories', c); }
    }
  }
  // 主题 / 左面板宽度
  const theme = ls('dd-theme');
  if (theme && (await db.get('settings', 'theme')) === undefined) await db.setSetting('theme', theme);
  const w = ls('dd-left-w');
  if (w && (await db.get('settings', 'leftPanelWidth')) === undefined) await db.setSetting('leftPanelWidth', parseInt(w, 10));
  // 旧习惯数据 dd-routines → routines store
  const oldRoutines = lsJSON('dd-routines', null);
  if (Array.isArray(oldRoutines) && oldRoutines.length && (await db.count('routines')) === 0) {
    for (const r of oldRoutines) {
      await db.put('routines', {
        id: r.id, title: r.name, categoryId: r.cat, daysOfWeek: r.days,
        active: r.active !== false, badgeCode: null, createdAt: Date.now(),
      });
    }
  }
}

/** 从 categories store 读颜色，写到 CSS 变量 --c-<id> */
export async function applyCatColors() {
  for (const c of await db.getAll('categories')) {
    document.documentElement.style.setProperty('--c-' + c.id, c.color);
  }
}
