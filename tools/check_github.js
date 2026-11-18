/**
 * 真实站点布局检查：在无头 Chrome 里打开一个 GitHub 仓库页，
 * 注入 lang.js + content.js（配一个假 chrome API，译文用等长中文占位），
 * 翻译整页后统计「译文压到别的文字」的处数并截图。
 * 用法：node tools/check_github.js [url]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = 9445;
const URL_ = process.argv[2] || 'https://github.com/microsoft/TypeScript';
const OUT = path.join(ROOT, 'test', 'out', 'github.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* 假扩展环境：译文用等长中文占位，足够验证换行 / 溢出 */
const STUB = `
window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => (window.__lltFns = window.__lltFns || []).push(fn) },
    sendMessage: (msg, cb) => setTimeout(() => {
      if (msg.type === 'translate') {
        cb({ ok: true, results: msg.texts.map((t) => {
          const n = String(t).trim().length;
          const base = '这是一段用于检查排版的中文译文，长度与原文大致相当，用来观察换行、溢出与对齐情况是否正常';
          let out = '';
          while (out.length < Math.max(4, Math.round(n * 0.7))) out += base;
          return out.slice(0, Math.max(4, Math.round(n * 0.7)));
        }) });
      } else cb({ ok: true });
    }, 5)
  },
  storage: {
    local: { get: (d, cb) => cb(Object.assign({}, d)), set: () => {}, onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {} }
  }
};
window.__lltToggle = () => new Promise((res) => (window.__lltFns || []).forEach((fn) => fn({ type: 'togglePage' }, {}, res)));
window.__lltAudit = function () {
  const trs = [...document.querySelectorAll('.llt-tr')];
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const own = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.llt-tr').forEach((n) => n.remove());
    return (c.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const overlaps = [];
  for (const tr of trs) {
    const r = tr.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    for (const el of document.querySelectorAll('body *')) {
      if (el === tr || el.contains(tr) || tr.contains(el)) continue;
      if (el.closest('#llt-host-9f3b')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0' || el.closest('[hidden]')) continue;
      if (parseFloat(cs.height) === 0) continue;
      // sr-only 这类「只看得到屏幕阅读器」的元素：被祖先裁成 1px，视觉上根本不存在
      if ((function (n) { for (let i = 0; i < 4 && n && n.tagName; i++) { const c = getComputedStyle(n); if (c.clip && c.clip !== 'auto') return true; if (c.clipPath && c.clipPath !== 'none') return true; n = n.parentElement; } return false; })(el)) continue;
      const t = own(el);
      if (!t) continue;
      const er = el.getBoundingClientRect();
      if (!er.width || !er.height) continue;
      if (hit(r, er)) { overlaps.push({ tr: tr.textContent.slice(0, 14), tag: el.tagName, id: el.id, cls: (el.className||'').toString().slice(0,40), other: t.slice(0, 24), rect: [Math.round(er.left),Math.round(er.top),Math.round(er.width),Math.round(er.height)] }); break; }
    }
  }
  const navs = [...document.querySelectorAll('nav')].map((n) => Math.round(n.getBoundingClientRect().height));
  return { url: location.href, total: trs.length, overlaps, navHeights: navs };
};
window.__lltReady = true;
`;

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-gh-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,1000',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let code = 0;
  try {
    let page = null;
    for (let i = 0; i < 50 && !page; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page');
      } catch (e) {
        /* 等端口 */
      }
      if (!page) await sleep(300);
    }
    if (!page) throw new Error('连不上调试端口');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
      }
    });
    const send = (method, params) =>
      new Promise((resolve) => {
        const myId = ++id;
        pending.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      });
    await new Promise((r) => ws.addEventListener('open', r));
    await send('Page.enable');
    await send('Runtime.enable');

    // 假扩展 API 必须在页面脚本之前装好
    await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    await send('Page.navigate', { url: URL_ });
    await sleep(6000);

    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r && r.result ? r.result.value : undefined;
    };

    console.log('页面:', await evaluate('document.title'));
    const before = await evaluate('JSON.stringify([...document.querySelectorAll("nav")].map(n=>Math.round(n.getBoundingClientRect().height)))');

    await evaluate(read('lang.js'));
    await evaluate(read('content.js'));
    await evaluate('window.__lltToggle()').catch(() => {});
    await sleep(1500);
    // 整页译文多，多等一会儿让分批翻完
    for (let i = 0; i < 20; i++) {
      const n = await evaluate('document.querySelectorAll(".llt-tr").length');
      await sleep(600);
      const n2 = await evaluate('document.querySelectorAll(".llt-tr").length');
      if (n2 && n2 === n) break;
    }

    const info = await evaluate('window.__lltAudit()');
    console.log('翻译前 nav 高度:', before);
    console.log('翻译后:', JSON.stringify({ total: info.total, overlaps: info.overlaps.length, navHeights: info.navHeights }, null, 1));
    if (info.overlaps.length) console.log('前 8 处重叠:', JSON.stringify(info.overlaps.slice(0, 8), null, 1));

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (shot && shot.data) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log('截图:', path.relative(ROOT, OUT));
    }
    code = info.overlaps.length === 0 && info.total > 10 ? 0 : 1;
    console.log(code === 0 ? '✅ 真实页面没有译文压字' : '❌ 仍有重叠，见截图');
  } catch (e) {
    console.error('运行失败:', (e && e.message) || e);
    code = 1;
  } finally {
    chrome.kill();
  }
  process.exit(code);
})();
