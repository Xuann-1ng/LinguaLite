/**
 * 轻译 LinguaLite — background service worker
 *
 * 免费翻译通道（全部无需 API Key / 注册）：
 *   1) 微软 Edge 免鉴权端点  edge.microsoft.com/translate/translatetext
 *      —— 原名 /translate/auth 取票接口已于 2026-07 下线，改用单步端点
 *   2) 腾讯交互翻译 TranSmart  transmart.qq.com/api/imt （国内直连友好）
 *   3) 谷歌网页翻译端点        translate.googleapis.com/translate_a/single （境外/代理环境）
 *
 * engine = "auto" 时按 1 → 2 → 3 依次尝试，任一成功即返回。
 *
 * to 由调用方（lang.js 在面板 / 内容脚本里算好）传进来：
 * 中文 → 英文，其它语言 → 简体中文。这里只做兜底，收到 'auto' 就按简体中文。
 */

const DEFAULTS = { to: 'auto', engine: 'auto', autoSelect: false, showBubble: true };

const TEN_LANG = {
  'zh-Hans': 'zh',
  'zh-Hant': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  th: 'th',
  vi: 'vi',
  tr: 'tr'
};

const GOOGLE_LANG = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };

const BATCH_ITEMS = 20;
const BATCH_CHARS = 4500;

/** 与 content.js 里的 V 保持一致 */
const CONTENT_VERSION = '1.4.1';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || 12000);
  return fetch(url, Object.assign({}, opts, { signal: ac.signal })).finally(() =>
    clearTimeout(timer)
  );
}

function chunkTexts(texts) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length >= BATCH_ITEMS || (chars + t.length > BATCH_CHARS && cur.length)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 通道一：微软 Edge 免鉴权端点                                          */
/* ------------------------------------------------------------------ */

async function edgeTranslate(texts, to) {
  const out = [];
  for (const chunk of chunkTexts(texts)) {
    const url =
      'https://edge.microsoft.com/translate/translatetext?api-version=3.0&to=' + encodeURIComponent(to);
    const res = await fetchT(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) throw new Error('微软通道 ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== chunk.length) throw new Error('微软通道返回异常');
    for (const item of data) {
      const tr = item && item.translations && item.translations[0];
      out.push((tr && tr.text) || '');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 通道二：腾讯交互翻译                                                  */
/* ------------------------------------------------------------------ */

async function tencentTranslate(texts, to) {
  const target = TEN_LANG[to];
  if (!target) throw new Error('腾讯通道不支持该目标语言');
  const out = [];
  for (const chunk of chunkTexts(texts)) {
    const res = await fetchT('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        header: {
          fn: 'auto_translation',
          client_key: 'browser-chrome-131.0.0-Windows 10-lingualite'
        },
        type: 'plain',
        model_category: 'normal',
        source: { lang: 'auto', text_list: chunk },
        target: { lang: target }
      })
    });
    if (!res.ok) throw new Error('腾讯通道 ' + res.status);
    const data = await res.json();
    const list = data && data.auto_translation;
    if (!Array.isArray(list) || list.length !== chunk.length) throw new Error('腾讯通道返回异常');
    out.push(...list);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 通道三：谷歌网页翻译端点                                              */
/* ------------------------------------------------------------------ */

async function googleTranslate(texts, to) {
  const tl = GOOGLE_LANG[to] || to;
  const out = [];
  for (const text of texts) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(tl) +
      '&dt=t&q=' +
      encodeURIComponent(text);
    const res = await fetchT(url, {}, 10000);
    if (!res.ok) throw new Error('谷歌通道 ' + res.status);
    const data = await res.json();
    const segs = (data && data[0]) || [];
    out.push(segs.map((s) => (s && s[0]) || '').join('').trim());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

const CHANNELS = [
  { id: 'edge', name: '微软', fn: edgeTranslate },
  { id: 'tencent', name: '腾讯', fn: tencentTranslate },
  { id: 'google', name: '谷歌', fn: googleTranslate }
];

async function translate(texts, to, engine) {
  const list = (texts || []).map((t) => String(t == null ? '' : t));
  if (!list.length) return [];

  // 方向由上游判定（lang.js）；万一收到 'auto'，按「译成简体中文」兜底
  const target = to && to !== 'auto' ? to : 'zh-Hans';

  const order =
    engine && engine !== 'auto'
      ? CHANNELS.filter((c) => c.id === engine).concat(CHANNELS.filter((c) => c.id !== engine))
      : CHANNELS;

  const errors = [];
  for (const ch of order) {
    try {
      const results = await ch.fn(list, target);
      if (results.length === list.length) return results;
      errors.push(ch.name + '：返回条数不一致');
    } catch (e) {
      errors.push(ch.name + '：' + ((e && e.message) || e));
    }
  }
  throw new Error('所有通道都失败了（' + errors.join('；') + '）');
}

/* ------------------------------------------------------------------ */
/* 标签页通信（安装后无需刷新页面也能用）                                 */
/* ------------------------------------------------------------------ */

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    // lang.js 必须在 content.js 之前注入：语种判定是共用的
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lang.js', 'content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

function togglePageOnTab(tabId) {
  return sendToTab(tabId, { type: 'togglePage' }).catch(() => {
    throw new Error('这个页面不允许插件运行（系统页 / 应用商店页等）');
  });
}

/**
 * 保证标签页里跑的是当前版本的内容脚本。
 * 扩展更新后，已打开的页面里仍是旧脚本（Chrome 不会自动重新注入），
 * 这里主动探测版本，不一致就重新注入一次，让新设置、新功能立即生效。
 */
async function ensureContent(tabId) {
  const ask = async () => {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'hello' });
      return (r && r.v) || null;
    } catch (e) {
      return null;
    }
  };

  let v = await ask();
  if (v === CONTENT_VERSION) return { ok: true, v, reloaded: false };

  try {
    await chrome.scripting
      .insertCSS({ target: { tabId }, files: ['content.css'] })
      .catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lang.js', 'content.js'] });
  } catch (e) {
    return { ok: false, error: '这个页面不允许插件运行' };
  }

  v = await ask();
  return { ok: v === CONTENT_VERSION, v, reloaded: true };
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'translate') {
    translate(msg.texts, msg.to, msg.engine)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  if (msg.type === 'togglePage') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: '找不到标签页' });
      return;
    }
    togglePageOnTab(tabId)
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  if (msg.type === 'ensureContent') {
    const tabId = msg.tabId;
    if (!tabId) {
      sendResponse({ ok: false, error: '找不到标签页' });
      return;
    }
    ensureContent(tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'getSettings') {
    chrome.storage.local.get(DEFAULTS).then((v) => sendResponse({ ok: true, settings: v }));
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 右键菜单 + 快捷键                                                    */
/* ------------------------------------------------------------------ */

/**
 * 只有一项：双语对照翻译。
 * 有选区 → 只给选中的段落加译文（局部对照）；无选区 → 整页双语翻译 / 还原。
 * 两种情况都是「原文保留 + 译文并排」，所以合并成一个入口。
 */
const MENU_ID = 'llt-bilingual';

function buildMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '双语对照翻译',
      contexts: ['page', 'selection']
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenu);
chrome.runtime.onStartup.addListener(buildMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id || info.menuItemId !== MENU_ID) return;
  if (info.selectionText && info.selectionText.trim()) {
    sendToTab(tab.id, { type: 'translateBlocks' }).catch(() => {});
  } else {
    togglePageOnTab(tab.id).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) togglePageOnTab(tab.id).catch(() => {});
});
