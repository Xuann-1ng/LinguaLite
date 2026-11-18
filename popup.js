/* 轻译 LinguaLite — popup 逻辑 */
const DEFAULTS = { to: 'auto', engine: 'auto', autoSelect: false, showBubble: true };

const $ = (s) => document.querySelector(s);
const LANG = window.LinguaLang;
const hasExt = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.storage;

function getSettings() {
  return new Promise((resolve) => {
    if (!hasExt) return resolve(Object.assign({}, DEFAULTS));
    chrome.storage.local.get(DEFAULTS, (v) => resolve(Object.assign({}, DEFAULTS, v || {})));
  });
}

function saveSettings(patch) {
  if (!hasExt) return;
  chrome.storage.local.set(patch);
}

function send(msg) {
  return new Promise((resolve) => {
    if (!hasExt) return resolve({ ok: false, error: '请把插件加载到 Chrome 后再试' });
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(res || { ok: false, error: '无响应' });
    });
  });
}

/* ---------------- 初始化 ---------------- */

(async function init() {
  const s = await getSettings();
  $('#to').value = s.to;
  if (!$('#to').value) $('#to').value = 'auto'; // 旧设置里存的语言已不存在时回到自动
  $('#engine').value = s.engine;
  $('#autoSel').checked = !!s.autoSelect;
  $('#showBubble').checked = s.showBubble !== false;
  syncLabels();
  updateHint();
  // 打开面板时顺手把当前标签页的内容脚本升到最新版：
  // 扩展更新后 Chrome 不会给已打开的页面重新注入，这一步让新设置立刻生效
  if (hasExt) ensureTab();
  refreshPageState();
})();

$('#reloadBtn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab && tab.id) {
    chrome.tabs.reload(tab.id);
    window.close();
  }
});

async function ensureTab() {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  const r = await send({ type: 'ensureContent', tabId: tab.id });
  if (r && r.ok) {
    $('#bar').hidden = true;
    return;
  }
  $('#barTxt').textContent = (r && r.error) || '此页面仍在用旧版本，刷新后生效';
  $('#bar').hidden = false;
}

$('#to').addEventListener('change', (e) => {
  saveSettings({ to: e.target.value });
  updateHint();
});
$('#engine').addEventListener('change', (e) => saveSettings({ engine: e.target.value }));
$('#autoSel').addEventListener('change', (e) => {
  applySetting({ autoSelect: e.target.checked });
});
$('#showBubble').addEventListener('change', (e) => {
  applySetting({ showBubble: e.target.checked });
});

/** 存到本地 + 直接推给当前标签页（storage 事件之外的第二条通路，切换立即生效） */
async function applySetting(patch) {
  saveSettings(patch);
  syncLabels();
  const tab = await activeTab();
  if (tab && tab.id && hasExt) {
    chrome.tabs.sendMessage(tab.id, { type: 'setSetting', patch }, () => void chrome.runtime.lastError);
  }
}

function syncLabels() {
  const bubble = $('#showBubble').checked;
  const auto = $('#autoSel').checked;
  $('#bubbleSub').textContent = bubble
    ? '选中后文字旁出现蓝色「译」按钮'
    : '已隐藏，不遮挡正文，改用右键菜单';
  $('#autoSub').textContent = auto
    ? '选中文字后立刻弹出译文卡片'
    : bubble
      ? '关闭时：选中后点蓝色「译」按钮'
      : '关闭时：选中后右键「双语对照翻译」';
  $('#bubbleLine').classList.toggle('muted', auto && !bubble);
}

/* ---------------- 语言自动识别 ---------------- */

/** 当前输入 + 当前设置下真实的目标语言：中文→英文，英文（及其它语言）→简体中文 */
function plannedTarget(text) {
  return LANG.targetFor($('#to').value, text);
}

let hintTimer = null;

function queueHint() {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateHint, 120);
}

/** 输入框下方那行「中文 → English」，只在「自动」时出现 */
function updateHint() {
  const box = $('#detect');
  const text = $('#src').value.trim();
  const auto = $('#to').value === 'auto';
  const p = auto && text ? LANG.plan('auto', text) : null;

  if (!p || p.src === 'unknown') {
    box.hidden = true;
    return;
  }
  $('#detectFrom').textContent = LANG.name(p.src);
  $('#detectTo').textContent = LANG.name(p.target);
  box.hidden = false;
}

/* ---------------- 文本框翻译 ---------------- */

async function doTranslate() {
  const text = $('#src').value.trim();
  const out = $('#out');
  if (!text) {
    $('#src').focus();
    return;
  }
  const btn = $('#go');
  btn.disabled = true;
  updateHint();
  out.hidden = false;
  out.querySelector('.out-txt').textContent = '翻译中…';
  out.querySelector('.out-txt').classList.add('loading');

  const res = await send({
    type: 'translate',
    texts: [text],
    to: plannedTarget(text),
    engine: $('#engine').value
  });

  const t = out.querySelector('.out-txt');
  t.classList.remove('loading');
  t.textContent = res.ok && res.results && res.results[0]
    ? res.results[0]
    : '翻译失败：' + (res.error || '未知错误');
  btn.disabled = false;
}

$('#go').addEventListener('click', doTranslate);
$('#src').addEventListener('input', queueHint);
$('#src').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    doTranslate();
  }
});

$('#copy').addEventListener('click', async () => {
  const text = $('#out').querySelector('.out-txt').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    const b = $('#copy');
    b.textContent = '已复制';
    setTimeout(() => (b.textContent = '复制'), 1200);
  } catch (e) {
    /* 忽略 */
  }
});

/* ---------------- 整页翻译 ---------------- */

async function activeTab() {
  if (!hasExt || !chrome.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function refreshPageState() {
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  try {
    const r = await new Promise((resolve) =>
      chrome.tabs.sendMessage(tab.id, { type: 'pageState' }, (res) => {
        void chrome.runtime.lastError;
        resolve(res);
      })
    );
    if (r && r.translated) setPageBtn(true);
  } catch (e) {
    /* 页面里没有内容脚本 */
  }
}

function setPageBtn(translated) {
  const b = $('#pageBtn');
  b.textContent = translated ? '还原本页' : '翻译本页';
  b.classList.toggle('on', !!translated);
}

$('#pageBtn').addEventListener('click', async () => {
  const btn = $('#pageBtn');
  const tab = await activeTab();
  if (!tab || !tab.id) {
    btn.textContent = '不支持此页';
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '处理中…';
  const res = await send({ type: 'togglePage', tabId: tab.id });
  btn.disabled = false;
  if (!res || !res.ok) {
    btn.textContent = old;
    btn.classList.add('on');
    btn.textContent = '此页不支持';
    setTimeout(() => (btn.textContent = old), 1600);
    return;
  }
  setPageBtn(!!(res.result && res.result.translated));
  // 翻译完自动关掉面板，把视线还给网页
  if (res.result && res.result.translated) setTimeout(() => window.close(), 500);
});
