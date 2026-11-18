/**
 * 布局回归：flex 行 / 网格 / 徽标里的译文是否还压着原文（GitHub 那种页面）。
 * 用法：node tools/check_layout.js
 * 会起本地静态服务 + 无头 Chrome，跑完打印审计结果并截图到 test/out/flex.png
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8799;
const CDP_PORT = 9444;
const PAGE = `http://127.0.0.1:${PORT}/test/flex.html`;
const OUT = path.join(ROOT, 'test', 'out', 'flex.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const file = path.join(ROOT, rel || 'index.html');
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error('连不上 Chrome 调试端口');
}

(async () => {
  if (!CHROME) throw new Error('找不到 Chrome / Edge');
  const srv = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-layout-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1080,1000',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let exitCode = 0;
  try {
    const page = await target();
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
    await send('Page.navigate', { url: PAGE });
    await sleep(1200);

    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
      return r && r.result ? r.result.value : undefined;
    };

    const ok = await evaluate('!!window.__lltReady && !!window.__lltToggle');
    if (!ok) throw new Error('页面没准备好');

    console.log('---- 翻译整页 ----');
    await evaluate('window.__lltToggle()');
    await sleep(600);

    const info = await evaluate('window.__lltAudit()');
    console.log(JSON.stringify(info, null, 2));

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot && shot.data) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log('截图:', path.relative(ROOT, OUT));
    }

    const pass =
      info.total >= 8 &&
      info.overlaps.length === 0 &&
      info.navUntouched &&
      info.navRowHeight <= 34 &&
      info.tabRowHeight <= 42 &&
      info.badgeHeight <= 20 &&
      info.badgeBelow &&
      info.badgeBelow.stacked === 1 &&
      info.clampTextVisible;

    // 还原整页，再验一次「局部双语对照」
    await evaluate('window.__lltToggle()');
    await sleep(400);
    const blocks = await evaluate('window.__lltBlocks()');
    console.log('局部对照:', JSON.stringify(blocks));
    const blocksOk =
      blocks && blocks.inCell === 1 && blocks.total === 1 && blocks.afterRestore === 0 && blocks.first === 1;
    console.log(blocksOk ? '✅ 局部对照通过' : '❌ 局部对照异常');

    console.log(pass && blocksOk ? '✅ 布局通过' : '❌ 布局有问题');
    exitCode = pass && blocksOk ? 0 : 1;
  } catch (e) {
    console.error('运行失败:', (e && e.message) || e);
    exitCode = 1;
  } finally {
    chrome.kill();
    srv.close();
  }
  process.exit(exitCode);
})();
