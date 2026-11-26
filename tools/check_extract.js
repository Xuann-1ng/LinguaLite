/**
 * 正文提取回归：整页翻译后，每一种「真实页面写法」的正文都要有译文，且译文真的画出来了。
 * 用例内联在本文件里（不依赖 test/ 下的临时页面），直接跑：
 *   node tools/check_extract.js
 *
 * 覆盖的写法：普通段落 / display:contents 包装 / 单列 grid / flex column /
 * 单行 flex（应整行一段）/ 首屏外 content-visibility / 滚动淡入 opacity:0 /
 * 0 高度包装层 / 整篇 flex column 长文 / 20 段长文。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 8794;
const CDP_PORT = 9454;
const FIXTURE_PATH = '/__fixture/extract.html';
const PAGE = `http://127.0.0.1:${PORT}${FIXTURE_PATH}`;
const OUT = path.join(ROOT, 'test', 'out', 'extract.png');

/** 期望每个区块的译文条数（h2 标题也算一段） */
const EXPECT = { s1: 4, s2: 4, s3: 5, s4: 4, s5: 2, s6: 4, s7: 21, s8: 4, s9: 3, s10: 7 };

const FIXTURE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>轻译 · 正文提取回归</title>
    <style>
      body { margin: 0; font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2328; }
      section { max-width: 760px; margin: 24px auto; padding: 0 16px; }
      h2 { font-size: 15px; color: #666; border-top: 1px dashed #ddd; padding-top: 12px; }
      p { margin: 0 0 12px; }
      .contents { display: contents; }
      .grid1 { display: grid; grid-template-columns: 1fr; }
      .flexcol { display: flex; flex-direction: column; }
      .row { display: flex; gap: 8px; align-items: center; }
      .cvwrap { content-visibility: auto; contain-intrinsic-size: 1200px; }
      .fade p { opacity: 0; transition: opacity .4s; }
    </style>
  </head>
  <body>
    <section id="s1">
      <h2>1. 普通段落</h2>
      <p>Plain paragraph one with enough English words to be picked up by the extractor.</p>
      <p>Plain paragraph two with enough English words to be picked up by the extractor.</p>
      <p>Plain paragraph three with enough English words to be picked up by the extractor.</p>
    </section>

    <section id="s2">
      <h2>2. display:contents 包装</h2>
      <div class="contents">
        <p>Contents paragraph one, wrapped in a display contents container.</p>
        <p>Contents paragraph two, wrapped in a display contents container.</p>
        <p>Contents paragraph three, wrapped in a display contents container.</p>
      </div>
    </section>

    <section id="s3">
      <h2>3. 单列网格装多段正文（每段一行）</h2>
      <div class="grid1">
        <p>Grid row one is a short sentence.</p>
        <p>Grid row two is a short sentence.</p>
        <p>Grid row three is a short sentence.</p>
        <p>Grid row four is a short sentence.</p>
      </div>
    </section>

    <section id="s4">
      <h2>4. flex column 装多段正文</h2>
      <div class="flexcol">
        <p>Flex column paragraph one, article body inside a flex column.</p>
        <p>Flex column paragraph two, article body inside a flex column.</p>
        <p>Flex column paragraph three, article body inside a flex column.</p>
      </div>
    </section>

    <section id="s5">
      <h2>5. 真正的单行 flex（标签行，应当整行一段）</h2>
      <div class="row" id="tagRow">
        <span>Tag one</span><span>Tag two</span><span>Tag three</span>
      </div>
    </section>

    <div style="height: 320vh"></div>

    <section id="s6" class="cvwrap">
      <h2>6. content-visibility:auto 的长区块（首屏外）</h2>
      <p>Lazy paragraph one, inside a content visibility auto wrapper far below the fold.</p>
      <p>Lazy paragraph two, inside a content visibility auto wrapper far below the fold.</p>
      <p>Lazy paragraph three, inside a content visibility auto wrapper far below the fold.</p>
    </section>

    <section id="s8">
      <h2>8. 滚动淡入（首屏外段落 opacity:0）</h2>
      <div class="fade">
        <p>Fade-in paragraph one, still transparent before the scroll reveal animation runs.</p>
        <p>Fade-in paragraph two, still transparent before the scroll reveal animation runs.</p>
        <p>Fade-in paragraph three, still transparent before the scroll reveal animation runs.</p>
      </div>
    </section>

    <section id="s9">
      <h2>9. 0 高度包装层（height:0）</h2>
      <div style="height: 0; overflow: visible">
        <p>Zero height paragraph one, inside a collapsed wrapper that still paints its children.</p>
        <p>Zero height paragraph two, inside a collapsed wrapper that still paints its children.</p>
      </div>
    </section>

    <section id="s10">
      <h2>10. 整篇文章包在 flex column 里（公众号 / 知乎常见）</h2>
      <article class="flexcol" id="articleBox"></article>
    </section>

    <section id="s7">
      <h2>7. 长文章（20 段，每段单独 div）</h2>
      <article id="longArticle"></article>
    </section>

    <script>
      const art = document.getElementById('longArticle');
      for (let i = 1; i <= 20; i++) {
        const d = document.createElement('div');
        d.className = 'para';
        d.textContent = 'Long article paragraph ' + i + ', written to look like real content on a real page, with a couple of clauses.';
        art.appendChild(d);
      }
      const box = document.getElementById('articleBox');
      for (let i = 1; i <= 6; i++) {
        const p = document.createElement('p');
        p.textContent = 'Flex column article paragraph ' + i + ', the whole article body is a flex column container.';
        box.appendChild(p);
      }

      const msgListeners = [];
      window.chrome = {
        runtime: {
          lastError: null,
          onMessage: { addListener: (fn) => msgListeners.push(fn) },
          sendMessage: (msg, cb) => {
            setTimeout(() => {
              cb(msg.type === 'translate' ? { ok: true, results: msg.texts.map((t) => '【译】' + t) } : { ok: true });
            }, 20);
          }
        },
        storage: { local: { get: (d, cb) => cb(Object.assign({}, d)) }, onChanged: { addListener: () => {} } }
      };
      window.__lltToggle = () =>
        new Promise((resolve) => msgListeners.forEach((fn) => fn({ type: 'togglePage' }, {}, resolve)));
      window.__lltUnitCount = () => (window.__lltDebug ? window.__lltDebug.collect().length : -1);

      /** 每个译文块是否真的画出来了、落在哪个区块 */
      window.__lltRender = function () {
        return [...document.querySelectorAll('.llt-tr')].map((n) => {
          const r = n.getBoundingClientRect();
          const sec = n.closest('section');
          return { sec: sec ? sec.id : '-', w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 20 && r.height > 4 };
        });
      };
    </script>
    <script src="/lang.js"></script>
    <script src="/content.js"></script>
  </body>
</html>`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      if ('/' + rel === FIXTURE_PATH) {
        res.setHeader('Content-Type', MIME['.html']);
        return res.end(FIXTURE);
      }
      const file = path.join(ROOT, rel);
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

(async () => {
  const srv = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'llt-extract-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,1100',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let exitCode = 0;
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page');
      } catch (e) {
        /* 等 */
      }
      if (!page) await sleep(300);
    }
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
    await sleep(1500);

    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails;
        throw new Error((ex.exception && ex.exception.description) || ex.text);
      }
      return r && r.result ? r.result.value : undefined;
    };

    const before = await evaluate('window.__lltUnitCount()');
    const res = await evaluate('window.__lltToggle()');
    await sleep(900);
    const rendered = await evaluate('window.__lltRender()');

    const got = {};
    rendered.forEach((r) => (got[r.sec] = (got[r.sec] || 0) + 1));
    const invisible = rendered.filter((r) => !r.visible);

    console.log('提取段落数:', before);
    console.log('译文块数:', rendered.length, '翻译返回:', JSON.stringify(res));
    console.log('各区块译文数:', JSON.stringify(got));
    console.log('没画出来的译文:', invisible.length ? JSON.stringify(invisible) : '无');

    const missing = Object.entries(EXPECT).filter(([k, v]) => (got[k] || 0) < v);
    console.log(missing.length ? '❌ 区块覆盖不足: ' + JSON.stringify(missing) : '✅ 各区块全部覆盖');
    if (invisible.length) console.log('❌ 有译文没渲染出来');

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (shot && shot.data) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log('截图:', path.relative(ROOT, OUT));
    }

    // 局部特写：contents / 单列网格 / flex column 三个区块，方便人眼检查排版
    const clip = await evaluate(`(() => {
      const a = document.getElementById('s2').getBoundingClientRect();
      const b = document.getElementById('s4').getBoundingClientRect();
      return { x: a.left - 8, y: a.top + window.scrollY - 8, width: a.width + 16, height: b.bottom - a.top + 16, scale: 2 };
    })()`);
    const zoom = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale }
    });
    if (zoom && zoom.data) {
      const out2 = path.join(ROOT, 'test', 'out', 'extract-zoom.png');
      fs.writeFileSync(out2, Buffer.from(zoom.data, 'base64'));
      console.log('特写:', path.relative(ROOT, out2));
    }

    exitCode = missing.length === 0 && invisible.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('失败:', (e && e.message) || e);
    exitCode = 1;
  } finally {
    chrome.kill();
    srv.close();
  }
  process.exit(exitCode);
})();
