/* 标注模式（给页面提修改意见用，视觉稿评审工具） */

(function () {
  'use strict';
  const KEY = 'dd-annotations';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  };
  let pins = store.get();
  let annotating = false;

  const layer = document.createElement('div');
  layer.id = 'annoLayer';
  document.body.appendChild(layer);

  const btn = document.createElement('button');
  btn.className = 'anno-btn';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span>标注</span>`;
  document.body.appendChild(btn);

  const badge = document.createElement('span');
  badge.style.cssText = 'margin-left:2px;font-size:11px;background:rgba(255,255,255,.25);border-radius:9px;padding:0 6px;';
  btn.appendChild(badge);

  const hint = document.createElement('div');
  hint.className = 'anno-hint';
  hint.textContent = '标注模式：点击页面任意位置插上图钉，写下修改意见 · 按 Esc 退出';
  document.body.appendChild(hint);

  const panel = document.createElement('div');
  panel.className = 'anno-panel';
  document.body.appendChild(panel);

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'anno-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function describeTarget(el) {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `<${tag}${id}${cls}>${txt ? ' 「' + txt + '」' : ''}`;
  }

  function renderPins() {
    layer.querySelectorAll('.anno-pin').forEach(p => p.remove());
    pins.forEach(p => {
      const el = document.createElement('div');
      el.className = 'anno-pin';
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.textContent = p.n;
      el.title = p.text;
      el.addEventListener('click', (e) => { e.stopPropagation(); openEditor(p, el); });
      layer.appendChild(el);
    });
    badge.textContent = pins.length || '';
    badge.style.display = pins.length ? '' : 'none';
  }

  let editor = null;
  function closeEditor() { if (editor) { editor.remove(); editor = null; } }
  function openEditor(pin) {
    closeEditor();
    editor = document.createElement('div');
    editor.className = 'anno-editor';
    const left = Math.min(Math.max(pin.x + 16, 10), window.innerWidth - 275);
    const top = Math.min(Math.max(pin.y - 10, 10), window.innerHeight - 190);
    editor.style.left = left + 'px'; editor.style.top = top + 'px';
    editor.innerHTML = `
      <textarea placeholder="这里想怎么改？">${pin.text || ''}</textarea>
      <div class="target">位置 ${Math.round(pin.xpct)}%, ${Math.round(pin.ypct)}% · ${pin.target}</div>
      <div class="btns"><button class="save">保存</button><button class="del">删除</button></div>`;
    editor.addEventListener('click', e => e.stopPropagation());
    const ta = editor.querySelector('textarea');
    editor.querySelector('.save').onclick = () => {
      pin.text = ta.value.trim();
      if (!pin.text) return toast('写点内容再保存呀');
      store.set(pins); renderPins(); renderPanel(); closeEditor();
    };
    editor.querySelector('.del').onclick = () => {
      pins = pins.filter(x => x.n !== pin.n); renumber();
      store.set(pins); renderPins(); renderPanel(); closeEditor();
    };
    document.body.appendChild(editor);
    ta.focus();
  }
  function renumber() { pins.forEach((p, i) => p.n = i + 1); }

  function renderPanel() {
    const items = pins.map(p => `
      <div class="anno-item" data-n="${p.n}">
        <span class="no">${p.n}</span>
        <div class="txt">${p.text.replace(/</g, '&lt;')}<div class="tgt">${p.target.replace(/</g, '&lt;')}</div></div>
        <button class="rm" title="删除">×</button>
      </div>`).join('');
    panel.innerHTML = `
      <h3>我的标注 <span class="cnt">共 ${pins.length} 条</span></h3>
      ${items || '<div class="anno-empty">还没有标注，进入标注模式后点击页面添加</div>'}
      <div class="anno-actions">
        <button class="primary" id="annoCopy">复制给 AI</button>
        <button id="annoExport">导出 JSON</button>
        <button id="annoClear">清空</button>
      </div>`;
    panel.querySelectorAll('.rm').forEach(b => b.onclick = () => {
      const n = +b.closest('.anno-item').dataset.n;
      pins = pins.filter(p => p.n !== n); renumber();
      store.set(pins); renderPins(); renderPanel();
    });
    panel.querySelector('#annoCopy').onclick = copyText;
    panel.querySelector('#annoExport').onclick = exportJson;
    panel.querySelector('#annoClear').onclick = () => {
      if (!pins.length) return;
      if (confirm('确定清空全部标注吗？')) {
        pins = []; store.set(pins); renderPins(); renderPanel();
      }
    };
  }

  function asText() {
    return pins.map(p =>
      `【标注${p.n}】位置约 ${Math.round(p.xpct)}%,${Math.round(p.ypct)}%（${p.target}）\n意见：${p.text}`
    ).join('\n\n') || '（无标注）';
  }
  function copyText() {
    if (!pins.length) return toast('还没有标注哦');
    const done = () => toast('已复制！粘贴给 AI 即可');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(asText()).then(done).catch(() => fallbackCopy(done));
    } else fallbackCopy(done);
  }
  function fallbackCopy(done) {
    const ta = document.createElement('textarea');
    ta.value = asText(); document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请用「导出 JSON」'); }
    ta.remove();
  }
  function exportJson() {
    if (!pins.length) return toast('还没有标注哦');
    const data = pins.map(p => ({
      n: p.n, text: p.text,
      position: { xPct: Math.round(p.xpct), yPct: Math.round(p.ypct) },
      target: p.target, createdAt: p.at
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `daodao-标注-${d.getMonth() + 1}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出到下载文件夹');
  }

  function setMode(on) {
    annotating = on;
    btn.classList.toggle('on', on);
    document.body.classList.toggle('annotating', on);
    btn.querySelector('span').textContent = on ? '退出标注' : '标注';
    if (!on) closeEditor();
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMode(!annotating);
    if (pins.length) { renderPanel(); panel.classList.toggle('show'); }
    else if (annotating) toast('进入标注模式，点击页面任意位置');
  });
  document.addEventListener('click', (e) => {
    if (!annotating) return;
    if (e.target.closest('.anno-btn, .anno-panel, .anno-editor, .anno-pin')) return;
    const pin = {
      n: pins.length + 1, text: '',
      x: e.clientX, y: e.clientY,
      xpct: e.clientX / window.innerWidth * 100,
      ypct: e.clientY / window.innerHeight * 100,
      target: describeTarget(e.target),
      at: new Date().toISOString()
    };
    pins.push(pin);
    store.set(pins); renderPins(); renderPanel();
    panel.classList.add('show');
    const pinEl = [...layer.querySelectorAll('.anno-pin')].pop();
    openEditor(pin, pinEl);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setMode(false); closeEditor(); }
    if (e.key === 'Enter' && editor && e.target.tagName !== 'TEXTAREA') {
      editor.querySelector('.save').click();
    }
  });

  renderPins();
  renderPanel();
})();
