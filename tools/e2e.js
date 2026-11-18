/**
 * 端到端自测：用 CDP 驱动装了插件的 Chrome，走完「划词 → 气泡 → 译文卡片」全流程。
 * 用法：先起本地服务器（python -m http.server 8765），再 node tools/e2e.js
 */
const fs = require('fs');
const path = require('path');

const PORT = 9333;
const URL = 'http://127.0.0.1:8765/test/e2e.html';
const SHOT = path.join(__dirname, '..', '..', 'shots', 'e2e.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

(async () => {
  let page = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      page = list.find((t) => t.type === 'page' && t.url.includes('e2e.html'));
      if (page) break;
    } catch (e) {
      /* chrome 还没起来 */
    }
    await sleep(400);
  }
  if (!page) throw new Error('找不到页面目标，Chrome 是否启动？');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');

  // 启动时页面可能比扩展先加载，重新导航一次确保内容脚本注入
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : undefined;
  };

  let log = '';
  for (let i = 0; i < 60; i++) {
    log = (await evaluate("(document.getElementById('log')||{}).textContent || ''")) || '';
    if (log.includes('3.') || log.includes('X.')) break;
    await sleep(500);
  }

  console.log('---- 页面日志 ----');
  console.log(log.trim());
  console.log('------------------');

  const data = await send('Page.captureScreenshot', { format: 'png' });
  if (data && data.data) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(data.data, 'base64'));
    console.log('截图已保存:', SHOT);
  }
  ws.close();
  process.exit(log.includes('3.') ? 0 : 1);
})().catch((e) => {
  console.error('E2E 失败:', e.message);
  process.exit(1);
});
