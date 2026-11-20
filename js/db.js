/* 数据层：IndexedDB 封装，落地 PRD 第 9 节数据模型 */

const DB_NAME = 'daodao-todo';
const DB_VERSION = 1;

/* object stores 定义（keyPath + 索引） */
const STORES = {
  tasks:     { keyPath: 'id', indexes: [{ name: 'date', keyPath: 'date' }, { name: 'status', keyPath: 'status' }] },
  categories:{ keyPath: 'id' },
  routines:  { keyPath: 'id' },
  habitLogs: { keyPath: 'id', indexes: [{ name: 'routine_date', keyPath: ['routineId', 'date'] }] },
  badges:    { keyPath: 'id' },
  badgeDefs: { keyPath: 'code' },
  rewardPool:{ keyPath: 'id' },
  rewardDraws:{ keyPath: 'id' },
  settings:  { keyPath: 'key' },
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (!d.objectStoreNames.contains(name)) {
          const os = d.createObjectStore(name, { keyPath: def.keyPath });
          (def.indexes || []).forEach(ix => os.createIndex(ix.name, ix.keyPath));
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 关闭连接（恢复出厂前需要，否则删库会被阻塞） */
export async function closeDB() {
  if (!dbPromise) return;
  const d = await dbPromise;
  d.close();
  dbPromise = null;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function op(store, mode, fn) {
  return openDB().then(d => reqAsPromise(fn(d.transaction(store, mode).objectStore(store))));
}

export const db = {
  add:    (store, val)  => op(store, 'readwrite', os => os.add(val)),
  put:    (store, val)  => op(store, 'readwrite', os => os.put(val)),
  get:    (store, key)  => op(store, 'readonly',  os => os.get(key)),
  getAll: (store)       => op(store, 'readonly',  os => os.getAll()),
  delete: (store, key)  => op(store, 'readwrite', os => os.delete(key)),
  count:  (store)       => op(store, 'readonly',  os => os.count()),
  clear:  (store)       => op(store, 'readwrite', os => os.clear()),

  /** 全表内存过滤（单机数据量小，够用） */
  async getWhere(store, pred) {
    return (await db.getAll(store)).filter(pred);
  },

  /* ── 便捷查询 ── */
  getTasksByDate(date) {
    return db.getWhere('tasks', t => t.date === date && t.status !== 'archived');
  },
  getTasksBetween(d1, d2) {
    return db.getWhere('tasks', t => t.date >= d1 && t.date <= d2 && t.status !== 'archived');
  },
  getHabitLog(routineId, date) {
    return db.getWhere('habitLogs', l => l.routineId === routineId && l.date === date).then(a => a[0] || null);
  },

  /* ── 设置项 ── */
  async getSetting(key, def) {
    const row = await db.get('settings', key);
    return row ? row.value : def;
  },
  setSetting(key, value) {
    return db.put('settings', { key, value });
  },
};

/** 短随机 id */
export const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
