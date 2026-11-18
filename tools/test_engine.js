/**
 * 本地联调脚本：在 Node 里加载 background.js，直接跑真实翻译通道。
 * 用法：node tools/test_engine.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const langCode = fs.readFileSync(path.join(__dirname, '..', 'lang.js'), 'utf8');

const noop = () => {};
const chromeStub = {
  runtime: {
    onMessage: { addListener: noop },
    onInstalled: { addListener: noop },
    onStartup: { addListener: noop }
  },
  contextMenus: { removeAll: noop, create: noop, onClicked: { addListener: noop } },
  commands: { onCommand: { addListener: noop } },
  storage: { local: { get: () => Promise.resolve({}), set: noop } },
  tabs: { sendMessage: () => Promise.reject(new Error('no tab')), query: () => Promise.resolve([]) },
  scripting: { insertCSS: () => Promise.resolve(), executeScript: () => Promise.resolve() }
};

const ctx = {
  chrome: chromeStub,
  fetch,
  AbortController,
  JSON,
  Promise,
  Array,
  Error,
  String,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  console
};
vm.createContext(ctx);
// 模拟 Worker 的全局对象，顺便把共用的 lang.js 先灌进去（background.js 里 importScripts 被跳过）
ctx.self = ctx;
vm.runInContext(langCode, ctx);
vm.runInContext(
  code + '\n;globalThis.__t = { translate, edgeTranslate, tencentTranslate, googleTranslate, chunkTexts };',
  ctx
);

const { translate, chunkTexts } = ctx.__t;
const LANG = ctx.LinguaLang;

if (LANG) {
  // 语种判定（离线，不发请求）
  const cases = [
    ['这个浏览器自带的翻译太难用了，我宁愿换个插件。', 'zh'],
    ['用 Chrome 打开这个页面，然后点「翻译本页」。', 'zh'],
    ['The built-in translation rewrites the whole page.', 'en'],
    ['これはテストです。', 'ja'],
    ['안녕하세요 반갑습니다', 'ko'],
    ['Привет, как дела', 'ru'],
    ['12345 — !!!', 'unknown']
  ];
  console.log('---- 语种判定 ----');
  let bad = 0;
  for (const [text, want] of cases) {
    const got = LANG.detect(text);
    const target = LANG.targetFor('auto', text);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${got.padEnd(8)} → ${target.padEnd(8)} ${text.slice(0, 24)}`);
  }
  console.log(bad ? `判定失败 ${bad} 条` : '判定全部通过');
  console.log('------------------');
}

(async () => {
  const samples = [
    "Chrome's built-in translation is jarring: it rewrites the whole page and you can't get the original back easily.",
    'Second paragraph to check batching works properly.'
  ];

  for (const engine of ['edge', 'tencent', 'google', 'auto']) {
    const t0 = Date.now();
    try {
      const out = await translate(samples, 'zh-Hans', engine);
      console.log(`[${engine}] ${Date.now() - t0}ms`);
      out.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    } catch (e) {
      console.log(`[${engine}] FAIL ${Date.now() - t0}ms -> ${e.message}`);
    }
  }

  // 中译英 + 繁体
  for (const to of ['en', 'zh-Hant', 'ja']) {
    try {
      const out = await translate(['这个浏览器自带的翻译太难用了，我宁愿换个插件。'], to, 'auto');
      console.log(`[zh->${to}]`, out[0]);
    } catch (e) {
      console.log(`[zh->${to}] FAIL ${e.message}`);
    }
  }

  // to = 'auto'：中文自动译英文，英文自动译中文（判定在界面上做，这里复现同一条链路）
  for (const text of [
    '这个浏览器自带的翻译太难用了，我宁愿换个插件。',
    'The built-in translation rewrites the whole page, which is hard to live with.'
  ]) {
    try {
      const target = LANG.targetFor('auto', text);
      const out = await translate([text], target, 'auto');
      console.log(`[auto ${LANG.detect(text)} → ${target}]`, out[0]);
    } catch (e) {
      console.log('[auto] FAIL', e.message);
    }
  }

  // 分批逻辑
  const many = Array.from({ length: 45 }, (_, i) => 'Paragraph number ' + (i + 1) + ' for chunk testing.');
  const chunks = chunkTexts(many);
  console.log('chunks:', chunks.map((c) => c.length).join('/'));
  const big = await translate(many, 'zh-Hans', 'edge');
  console.log('批量 45 段 ->', big.length, '条；示例:', big[44]);
})();
