/**
 * 轻译 LinguaLite — content script
 * 1) 划词翻译：选中文字 → 小气泡 → 点击出译文卡片
 * 2) 整页双语：Alt+T 或插件面板，按段落插入译文，可一键还原
 */

(() => {
  const V = '1.4.1';
  // 同版本重复注入直接退出；旧版本残留则接管（清掉旧 UI 重来）
  if (window.__lltVersion === V) return;
  const staleHost = document.getElementById('llt-host-9f3b');
  if (staleHost) staleHost.remove();
  window.__lltVersion = V;
  window.__lltLoaded = true;

  const LANG = self.LinguaLang;
  const DEFAULTS = { to: 'auto', engine: 'auto', autoSelect: false, showBubble: true };
  const HOST_ID = 'llt-host-9f3b';

  let settings = Object.assign({}, DEFAULTS);

  try {
    chrome.storage.local.get(DEFAULTS, (v) => {
      settings = Object.assign({}, DEFAULTS, v || {});
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      Object.keys(changes).forEach((k) => {
        settings[k] = changes[k].newValue;
      });
    });
  } catch (e) {
    /* 非扩展环境 */
  }

  /* ------------------------------------------------------------------ */
  /* UI（Shadow DOM，避免被网站样式污染）                                  */
  /* ------------------------------------------------------------------ */

  const CSS = `
    *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    .bubble{position:fixed;display:flex;align-items:center;justify-content:center;width:30px;height:30px;
      border-radius:9px;background:#1f6feb;color:#fff;font-size:13px;font-weight:600;cursor:pointer;
      box-shadow:0 6px 18px rgba(16,40,80,.28);user-select:none;transition:transform .12s ease,background .12s}
    .bubble:hover{transform:translateY(-1px);background:#2f7ef5}
    .bubble[hidden]{display:none}

    .card{position:fixed;width:352px;max-width:calc(100vw - 24px);display:none;flex-direction:column;
      background:#fff;color:#161b22;border:1px solid rgba(15,23,42,.10);border-radius:14px;
      box-shadow:0 18px 48px rgba(15,23,42,.20);overflow:hidden;font-size:14px}
    .card.show{display:flex}
    .card .hd{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-bottom:1px solid #eef1f6;
      font-size:12px;color:#5b6673;background:#fbfcfe}
    .card .hd .tag{font-weight:600;color:#1f6feb}
    .card .hd .sp{flex:1}
    .card .x{width:22px;height:22px;line-height:20px;text-align:center;border-radius:6px;color:#8b95a1;cursor:pointer;font-size:15px}
    .card .x:hover{background:#eef1f6;color:#3a4552}
    .card .bd{padding:12px 14px;max-height:46vh;overflow:auto;line-height:1.7;white-space:pre-wrap;word-break:break-word}
    .card .bd.muted{color:#8b95a1}
    .card .ft{display:flex;gap:8px;justify-content:flex-end;padding:8px 10px;border-top:1px solid #eef1f6;background:#fbfcfe}
    .btn{border:1px solid #dde3ea;background:#fff;color:#37424f;border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer}
    .btn:hover{background:#f2f6fc;border-color:#c9d6e8}
    .btn.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
    .btn.primary:hover{background:#2f7ef5}

    .spin{display:inline-block;width:12px;height:12px;border:2px solid #c8d3e2;border-top-color:#1f6feb;
      border-radius:50%;animation:lltsp .7s linear infinite;vertical-align:-1px;margin-right:6px}
    @keyframes lltsp{to{transform:rotate(360deg)}}

    .toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(22,27,34,.93);
      color:#fff;font-size:13px;padding:9px 18px;border-radius:999px;max-width:82vw;text-align:center;
      box-shadow:0 10px 30px rgba(0,0,0,.24);display:none}
    .toast.show{display:block}

    /* 跟随页面明暗，而不是操作系统主题 */
    :host([data-theme="dark"]) .card{background:#1b2027;color:#e7ecf2;border-color:rgba(255,255,255,.10)}
    :host([data-theme="dark"]) .card .hd,
    :host([data-theme="dark"]) .card .ft{background:#20262e;border-color:rgba(255,255,255,.08);color:#9aa7b6}
    :host([data-theme="dark"]) .card .x:hover{background:#2a323c;color:#e7ecf2}
    :host([data-theme="dark"]) .btn{background:#242b34;border-color:#333c48;color:#d7dee7}
    :host([data-theme="dark"]) .btn:hover{background:#2c3540}
    :host([data-theme="dark"]) .btn.primary{background:#2f7ef5;border-color:#2f7ef5;color:#fff}
    :host([data-theme="dark"]) .spin{border-color:#39434f;border-top-color:#5a9bff}
  `;

  let host = null;
  let ui = null;
  let hideTimer = null;
  let toastTimer = null;
  let suppressUntil = 0;

  /** 判断页面底色是深还是浅（决定卡片用白底还是深底） */
  function pageIsDark() {
    const lum = (el) => {
      if (!el) return null;
      const c = getComputedStyle(el).backgroundColor;
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      if (p.length < 3) return null;
      if (p.length > 3 && p[3] === 0) return null;
      return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    };
    let v = lum(document.body);
    if (v == null) v = lum(document.documentElement);
    return v != null && v < 110;
  }

  function syncTheme() {
    if (host) host.setAttribute('data-theme', pageIsDark() ? 'dark' : 'light');
  }

  function ensureUI() {
    if (host) return ui;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      CSS +
      '</style>' +
      '<div class="bubble" hidden>译</div>' +
      '<div class="card"><div class="hd"><span class="tag">译</span><span class="lang"></span>' +
      '<span class="sp"></span><span class="x" title="关闭">✕</span></div>' +
      '<div class="bd"></div>' +
      '<div class="ft"><button class="btn copy">复制译文</button><button class="btn primary close">关闭</button></div>' +
      '</div>' +
      '<div class="toast"></div>';

    (document.body || document.documentElement).appendChild(host);
    syncTheme();

    ui = {
      bubble: shadow.querySelector('.bubble'),
      card: shadow.querySelector('.card'),
      lang: shadow.querySelector('.lang'),
      body: shadow.querySelector('.bd'),
      copy: shadow.querySelector('.copy'),
      toast: shadow.querySelector('.toast')
    };

    ui.bubble.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    ui.bubble.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = ui.bubble.__text || '';
      const rect = ui.bubble.__rect || null;
      suppressUntil = Date.now() + 400;
      hideBubble();
      if (text) openCard(rect, text);
    });

    shadow.querySelector('.x').addEventListener('click', closeCard);
    shadow.querySelector('.close').addEventListener('click', closeCard);
    ui.copy.addEventListener('click', () => {
      const text = ui.body.__result || '';
      if (text) copyText(text, ui.copy);
    });

    return ui;
  }

  /* ------------------------------------------------------------------ */
  /* 划词翻译                                                            */
  /* ------------------------------------------------------------------ */

  function showBubble(rect, text) {
    ensureUI();
    ui.bubble.__text = text;
    ui.bubble.__rect = rect;
    const size = 30;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 贴着选区右下方：既不盖住行首文字，也正好落在鼠标松开的位置
    let left = rect.right - size - 2;
    let top = rect.bottom + 6;
    if (top + size > vh - 6) top = rect.top - size - 6 > 6 ? rect.top - size - 6 : Math.max(6, vh - size - 6);
    left = Math.min(Math.max(6, left), vw - size - 6);
    ui.bubble.style.left = left + 'px';
    ui.bubble.style.top = top + 'px';
    ui.bubble.hidden = false;
    clearTimeout(hideTimer);
  }

  function hideBubble() {
    if (!ui) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (ui) ui.bubble.hidden = true;
    }, 120);
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (host && e.composedPath && e.composedPath().includes(host)) return;
      if (Date.now() < suppressUntil) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? String(sel).trim() : '';
        if (!text || text.length > 3000 || !sel.rangeCount) {
          hideBubble();
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
          hideBubble();
          return;
        }
        if (settings.autoSelect) {
          hideBubble();
          openCard(rect, text);
        } else if (settings.showBubble === false) {
          // 用户关掉了「译」按钮：划词不打扰，改用右键菜单 / Alt+T
          if (ui) ui.bubble.hidden = true;
        } else {
          showBubble(rect, text);
        }
      }, 12);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!host) return;
      if (e.composedPath && e.composedPath().includes(host)) return;
      if (ui && ui.card.classList.contains('show')) closeCard();
      ui && (ui.bubble.hidden = true);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && host) {
        closeCard();
        if (ui) ui.bubble.hidden = true;
      }
    },
    true
  );

  /* ------------------------------------------------------------------ */
  /* 译文卡片                                                            */
  /* ------------------------------------------------------------------ */

  function placeCard(rect) {
    const card = ui.card;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = card.offsetWidth || 352;
    const h = card.offsetHeight || 160;
    let left;
    let top;
    if (rect) {
      left = rect.left;
      top = rect.bottom + 12;
      if (top + h > vh - 10) top = Math.max(10, rect.top - h - 12);
    } else {
      left = (vw - w) / 2;
      top = Math.max(10, (vh - h) / 2);
    }
    left = Math.min(Math.max(8, left), vw - w - 8);
    top = Math.min(Math.max(8, top), vh - h - 8);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  async function openCard(rect, text) {
    ensureUI();
    syncTheme();
    const target = targetOf([text]);
    ui.lang.textContent = '→ ' + LANG.name(target);
    ui.body.classList.add('muted');
    ui.body.innerHTML = '<span class="spin"></span>翻译中…';
    ui.body.__result = '';
    ui.card.classList.add('show');
    requestAnimationFrame(() => placeCard(rect));

    const res = await sendTranslate([text], target);
    if (!ui.card.classList.contains('show')) return;
    ui.body.classList.remove('muted');
    if (res.ok && res.results && res.results[0]) {
      ui.body.textContent = res.results[0];
      ui.body.__result = res.results[0];
      requestAnimationFrame(() => placeCard(rect));
    } else {
      ui.body.textContent = '翻译失败：' + (res.error || '未知错误') + '\n换个通道试试（插件面板里可切换）。';
      ui.body.classList.add('muted');
      requestAnimationFrame(() => placeCard(rect));
    }
  }

  function closeCard() {
    if (ui) ui.card.classList.remove('show');
  }

  function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = old), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, cb) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      cb();
    } catch (e) {
      /* 忽略 */
    }
    ta.remove();
  }

  /* ------------------------------------------------------------------ */
  /* 轻提示                                                              */
  /* ------------------------------------------------------------------ */

  function toast(msg, sticky) {
    ensureUI();
    clearTimeout(toastTimer);
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    if (!sticky) toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200);
  }

  function hideToast() {
    if (ui) ui.toast.classList.remove('show');
  }

  /* ------------------------------------------------------------------ */
  /* 与后台通信                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 设置里的 to 可能是 "auto"：一批文字只判定一次方向，
   * 中文 → 英文，英文（及其它语言）→ 简体中文。
   */
  function targetOf(texts) {
    return LANG.targetFor(settings.to, LANG.sample(texts, 4000));
  }

  function sendTranslate(texts, to) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'translate', texts, to: to || targetOf(texts), engine: settings.engine },
          (res) => {
            const err = chrome.runtime.lastError;
            if (err) return resolve({ ok: false, error: err.message });
            resolve(res || { ok: false, error: '后台无响应' });
          }
        );
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 整页双语翻译                                                        */
  /* ------------------------------------------------------------------ */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'KBD', 'SAMP', 'TEMPLATE'
  ]);

  /* 导航栏 / 工具条 / 按钮这类「控件文字」不翻：它们是固定高度的行内布局，
     译文塞进去只会把一行挤歪（GitHub 的仓库导航、标签栏、计数徽标就是这个毛病） */
  const UI_TAGS = new Set(['NAV', 'BUTTON', 'SUMMARY', 'LABEL', 'MENU', 'SELECT']);
  const UI_ROLES = new Set([
    'navigation', 'banner', 'toolbar', 'tablist', 'tab', 'menu', 'menubar',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'button', 'switch', 'searchbox'
  ]);

  function isUiChrome(el) {
    if (UI_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute && el.getAttribute('role');
    return !!(role && UI_ROLES.has(String(role).toLowerCase()));
  }

  /**
   * 视觉上根本看不见的元素：sr-only（只给屏幕阅读器）、被 clip 裁掉的。
   * 它们照样有文字，但原文看不到，译文插进去就在页面上凭空堆出一片碎片。
   *
   * 两条不能伸手的边界（踩过坑）：
   * 1) display:contents：自己不成盒子、尺寸恒为 0，但里面的段落正常渲染。
   * 2) 尺寸只对「自己就是文字」的元素判。整块容器可能是 0 高包装层（动画起始态、
   *    float 包裹层），按尺寸判会把里面所有正文一次丢光。
   * 3) opacity:0 不参与判断：滚动淡入的站点在首屏外的段落就是 opacity:0，
   *    判成隐藏的话整页只能翻出眼前这几段。
   */
  function isVisuallyHidden(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return true;
    if (cs.display === 'contents') return false;
    if (cs.clip && cs.clip !== 'auto') return true;
    if (cs.clipPath && cs.clipPath !== 'none' && /inset\(/.test(cs.clipPath)) return true;
    if (el.children.length) return false;
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  }

  const HAS_WORD = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  const MAX_UNITS = 600;

  function isBlock(el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    // 我们自己插入的译文块不算「块级子元素」，否则原文段落会失去段落身份
    if (el.classList && el.classList.contains('llt-tr')) return false;
    const d = getComputedStyle(el).display;
    if (!d || d === 'none') return false;
    // display:contents 是「透明盒子」：自己不成盒子，但里面的内容是正常块级。
    // 以前当成内联元素跳过，整个正文块就再也走不进扫描，一个字都翻不到。
    if (d === 'contents') return true;
    return !/^inline($|-)/.test(d);
  }

  /* flex / grid 会把子项强制「块化」：一行里的标签、计数器、时间戳在 computed style
     里全是 block。若不特殊处理，这一行会被拆成三段各自翻译，译文重复又多又乱。 */
  const TEXTISH = new Set([
    'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'BIG', 'SUB', 'SUP',
    'A', 'ABBR', 'TIME', 'SVG', 'IMG', 'BR', 'LABEL', 'CITE', 'Q', 'DFN', 'VAR', 'BDI', 'BDO'
  ]);

  /**
   * 这一行是不是「一行碎片文字」（标签 + 计数 + 时间）：整行当一段来翻。
   * 必须确认真的是「一行」——单列 grid / flex-column 里的段落是一层一层排下去的，
   * 只看「子项都很矮」会把整篇文章并成一大段（发出去还容易被通道截断）。
   */
  function isFlattenedRow(el) {
    if (!isRowBox(el)) return false;
    const kids = [...el.children].filter((c) => !(c.classList && c.classList.contains('llt-tr')));
    if (!kids.length) return false;
    const heights = kids.map((c) => c.getBoundingClientRect().height);
    // 子项都是「一行高」的小格子：GitHub 文件列表的提交行就是
    // 头像组 + 提交信息 + 短哈希 + 时间 + 提交数，各翻一条会碎成一堆
    if (!kids.every((c, i) => TEXTISH.has(c.tagName) || heights[i] <= 48)) return false;
    // 容器只有一行高，说明子项是并排的；容器高出一大截说明是竖着叠的，不能并
    const box = el.getBoundingClientRect();
    const tallest = heights.reduce((m, h) => Math.max(m, h), 0);
    return box.height <= Math.max(tallest, 24) * 1.6 + 8;
  }

  /** 取段落文本：排除已插入的译文，避免把中文再翻一遍 */
  function unitText(el) {
    // display:contents 没有盒子，innerText 不可靠，而且块级子节点会被粘成一句
    // （<p>a</p><p>b</p> → "ab"），这里逐个子节点取文再用空格接上
    if (getComputedStyle(el).display === 'contents') {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.llt-tr').forEach((n) => n.remove());
      const parts = [];
      clone.childNodes.forEach((n) => {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      });
      return parts.join(' ').trim();
    }
    if (!el.querySelector('.llt-tr')) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.llt-tr').forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 元素在页面上是否真的占位置（display:contents 自己没有盒子，看父级有没有排版） */
  function hasBox(el) {
    if (el.getClientRects().length) return true;
    if (getComputedStyle(el).display === 'contents') {
      const p = el.parentElement;
      return !!(p && p.getClientRects().length);
    }
    return false;
  }

  /** 从任意节点往外找最近的「块级」祖先（段落级别） */
  function blockAncestorOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== document.documentElement) {
      if (el === document.body) return el;
      if (isBlock(el)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  /** 扫描某个根节点下的「段落级」文本块 */
  function scanBlocks(root) {
    const units = [];
    const scan = (el) => {
      if (!el || SKIP_TAGS.has(el.tagName) || el.id === HOST_ID) return;
      if (el.classList && el.classList.contains('llt-tr')) return;
      if (isUiChrome(el)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (isVisuallyHidden(el)) return;
      // 透明盒子（display:contents）：自己没有盒子，里面的段落是正常块级，
      // 必须往里走；直接当内联元素跳过会把整块正文丢掉
      if (cs.display === 'contents' && el !== root && el.children.length) {
        for (const c of el.children) scan(c);
        return;
      }
      if (el.tagName !== 'BODY' && !isBlock(el)) {
        // 内联容器：交给父级块处理；若它本身是扫描根，则往下找
        if (el === root) for (const c of el.children) scan(c);
        return;
      }
      let hasBlockChild = false;
      if (!isFlattenedRow(el)) {
        for (const c of el.children) {
          if (isBlock(c)) {
            hasBlockChild = true;
            break;
          }
        }
      }
      if (hasBlockChild) {
        for (const c of el.children) scan(c);
        return;
      }
      if (el.tagName === 'BODY') return;
      if (!hasBox(el)) return;
      const text = unitText(el);
      if (text.length < 2 || !HAS_WORD.test(text)) return;
      units.push({ el, text });
    };
    if (root) scan(root);
    return units;
  }

  function collectUnits() {
    return scanBlocks(document.body).filter((u) => u.el.dataset.lltDone !== '1');
  }

  // 调试出口（tools/diag_extract.js 用；正式功能不依赖它）
  try {
    window.__lltDebug = { collect: collectUnits, scan: scanBlocks, isBlock, isVisuallyHidden, isUiChrome };
  } catch (e) {
    /* 忽略 */
  }

  /** 只取与当前选区相交的段落 */
  function collectSelectionUnits() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (range.collapsed) return [];
    const root = blockAncestorOf(range.commonAncestorContainer);
    return scanBlocks(root).filter((u) => {
      try {
        return range.intersectsNode(u.el);
      } catch (e) {
        return false;
      }
    });
  }

  let uid = 0;

  function displayOf(el) {
    return getComputedStyle(el).display || '';
  }

  /** 横排容器（flex 行 / 网格）：块级译文塞进去就是同一行里的又一个盒子，原文必然被挤歪 */
  function isRowBox(el) {
    const cs = getComputedStyle(el);
    const d = cs.display;
    if (/^(inline-)?grid$/.test(d)) return true;
    if (/^(inline-)?flex$/.test(d)) {
      const dir = cs.flexDirection || 'row';
      return dir === 'row' || dir === 'row-reverse';
    }
    return false;
  }

  /** 普通文档流容器：块级内容放进去会老老实实占一行，不会被挤成一行里的一列 */
  function isFlowBox(el) {
    if (!el || el === document.documentElement) return false;
    const d = displayOf(el);
    if (!d || d === 'none' || d === 'contents' || d === 'ruby') return false;
    if (/^inline/.test(d)) return false;
    return !isRowBox(el);
  }

  /** 网格列数（computed 值是逐条轨道列出的，如 "760px" / "380px 380px"） */
  function gridColumns(el) {
    const tpl = (getComputedStyle(el).gridTemplateColumns || '').trim();
    if (!tpl || tpl === 'none') return 1;
    return tpl.split(/\s+/).filter(Boolean).length;
  }

  /**
   * 这个容器能不能「竖着」接纳一个新的块——也就是译文插进去会不会把原文挤歪。
   * 文档流 / 单列网格 / flex-column 都是竖着排的，插进去就落在原文下方。
   * 横排行（flex-row、多列网格）不行；display:contents 自己没有盒子，
   * 要往上看到它的父级是不是竖着排。
   */
  function isStackingParent(el, depth) {
    if (!el || el === document.documentElement || (depth || 0) > 6) return false;
    const cs = getComputedStyle(el);
    const d = cs.display;
    if (d === 'contents') {
      const gp = el.parentElement;
      return !gp || gp === document.body || isFlowBox(gp) || isStackingParent(gp, (depth || 0) + 1);
    }
    if (/^(inline-)?grid$/.test(d)) return gridColumns(el) === 1;
    if (/^(inline-)?flex$/.test(d)) return cs.flexDirection === 'column';
    return isFlowBox(el);
  }

  /** 矮的固定高度盒子（计数胶囊、徽标、图标按钮）：撑不开，译文塞进去就溢出来 */
  function isTightBox(el) {
    if (/^(TD|TH)$/.test(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (cs.height === 'auto') return false;
    const h = parseFloat(cs.height);
    if (!h) return false;
    return h <= 48 && (cs.overflowY !== 'visible' || cs.display !== 'block');
  }

  /**
   * 译文该插在哪里。
   * 普通段落直接 appendChild 就行；但原文本身是 flex 行、内联元素、或者固定高度的
   * 小盒子时，译文会变成同一行里的兄弟盒子，把原文和计数器挤歪——GitHub 的仓库导航、
   * Code/Branches 标签栏、Latest 徽标都是这个原因。
   * 这类情况改成「插到原文后面」：往外找到最近一个普通文档流容器，插在原文节点的后面，
   * 译文就落在整行下方，行高和对齐都不动。
   * 表格单元格例外：必须留在里面，否则表格会错行。
   */
  function translationAnchor(el, clipped) {
    // 1) 原文自己就能装块级内容 → 塞进去（段落、列表项、表格单元格都走这里，和以前一致）
    if (!clipped && isFlowBox(el) && !isTightBox(el) && !/^(TD|TH)$/.test(el.tagName)) {
      const p = el.parentElement;
      if (!p || isStackingParent(p) || p === document.body) return { host: el, after: null };
    }
    if (/^(TD|TH)$/.test(el.tagName)) return { host: el, after: null };

    // 2) 否则插到原文后面：往外找能竖着接纳块级内容的父级
    let cur = el;
    for (let i = 0; i < 10 && cur; i++) {
      const p = cur.parentElement;
      if (!p || p === document.documentElement) break;
      if (/^(TD|TH)$/.test(cur.tagName)) return { host: cur, after: null };
      if (isStackingParent(p) || p === document.body) return { host: p, after: cur };
      cur = p;
    }
    return { host: el.parentNode || el, after: null };
  }

  function insertTranslation(el, text) {
    if (!text) return;
    const id = 'n' + ++uid;
    const node = document.createElement('div');
    node.className = 'llt-tr';
    node.setAttribute('data-llt', '1');
    node.setAttribute('data-llt-id', id);
    node.textContent = text;
    // 被截断/限高（如 -webkit-line-clamp 标题）的元素，插到它后面，避免译文被裁掉
    const clipped = el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2;
    const anchor = translationAnchor(el, clipped);
    try {
      if (anchor.after) {
        // 同一落点上可能已经排了别人的译文：接在它们后面，保持原文顺序
        let ref = anchor.after;
        while (
          ref.nextSibling &&
          ref.nextSibling.nodeType === 1 &&
          ref.nextSibling.classList &&
          ref.nextSibling.classList.contains('llt-tr')
        ) {
          ref = ref.nextSibling;
        }
        anchor.host.insertBefore(node, ref.nextSibling);
      } else {
        anchor.host.appendChild(node);
      }
    } catch (e) {
      el.appendChild(node);
    }
    el.dataset.lltDone = '1';
    el.dataset.lltId = id;
  }

  /** 还原单个段落（译文可能在元素内部，也可能在元素后面） */
  function removeTranslation(el) {
    const id = el.dataset.lltId;
    if (id) {
      document.querySelectorAll('.llt-tr[data-llt-id="' + id + '"]').forEach((n) => n.remove());
    } else {
      el.querySelectorAll('.llt-tr').forEach((n) => n.remove());
    }
    delete el.dataset.lltDone;
    delete el.dataset.lltId;
  }

  function restorePage() {
    document.querySelectorAll('.llt-tr').forEach((n) => n.remove());
    document.querySelectorAll('[data-llt-done]').forEach((n) => {
      delete n.dataset.lltDone;
      delete n.dataset.lltId;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 局部双语对照（右键：只翻选中的段落，原文保留）                          */
  /* ------------------------------------------------------------------ */

  let blockBusy = false;

  async function translateBlocks() {
    if (blockBusy) return { busy: true };
    let units = collectSelectionUnits();
    if (!units.length) {
      toast('选中的位置没有可翻译的段落');
      return { count: 0, translated: false };
    }
    if (units.length > MAX_UNITS) units = units.slice(0, MAX_UNITS);

    // 已经翻过的段落 → 这次当作「还原」
    const already = units.filter((u) => u.el.dataset.lltDone === '1');
    if (already.length) {
      already.forEach((u) => removeTranslation(u.el));
      toast('已还原 ' + already.length + ' 段');
      return { count: already.length, translated: false };
    }

    blockBusy = true;
    let done = 0;
    const target = targetOf(units.map((u) => u.text));
    const BATCH = 12;
    try {
      for (let i = 0; i < units.length; i += BATCH) {
        const batch = units.slice(i, i + BATCH);
        if (units.length > BATCH) {
          toast('正在翻译 ' + Math.min(i + BATCH, units.length) + ' / ' + units.length + ' 段…', true);
        }
        const res = await sendTranslate(batch.map((u) => u.text), target);
        if (!res.ok) {
          toast('翻译中断：' + (res.error || '通道异常'));
          break;
        }
        res.results.forEach((t, j) => {
          if (batch[j]) insertTranslation(batch[j].el, t);
        });
        done += batch.length;
      }
      if (done) toast('已为选中的 ' + done + ' 段加上译文 → ' + LANG.name(target) + ' · 再点一次可还原');
    } finally {
      blockBusy = false;
    }
    return { count: done, translated: done > 0 };
  }

  let translating = false;

  async function togglePage() {
    if (translating) return { translated: true, busy: true };
    const existing = document.querySelectorAll('.llt-tr').length;
    if (existing) {
      restorePage();
      hideToast();
      toast('已还原原文');
      return { translated: false, count: 0 };
    }

    const units = collectUnits().slice(0, MAX_UNITS);
    if (!units.length) {
      toast('这一页没找到可翻译的正文');
      return { translated: false, count: 0 };
    }

    translating = true;
    const target = targetOf(units.map((u) => u.text));
    const BATCH = 12;
    let done = 0;
    try {
      for (let i = 0; i < units.length; i += BATCH) {
        const batch = units.slice(i, i + BATCH);
        toast('正在翻译 ' + Math.min(i + BATCH, units.length) + ' / ' + units.length + ' 段 → ' + LANG.name(target) + '…', true);
        const res = await sendTranslate(batch.map((u) => u.text), target);
        if (!res.ok) {
          toast('翻译中断：' + (res.error || '通道异常'));
          break;
        }
        res.results.forEach((t, j) => {
          if (batch[j]) insertTranslation(batch[j].el, t);
        });
        done += batch.length;
      }
      toast('已翻译 ' + done + ' 段 → ' + LANG.name(target) + ' · 按 Alt+T 或再点一次可还原');
    } finally {
      translating = false;
    }
    return { translated: done > 0, count: done };
  }

  /* ------------------------------------------------------------------ */
  /* 消息监听                                                            */
  /* ------------------------------------------------------------------ */

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      // 已被新版本接管：旧实例闭嘴，免得两个实例同时响应同一条指令
      if (window.__lltVersion !== V) return;
      if (msg.type === 'togglePage') {
        togglePage()
          .then((r) => sendResponse(Object.assign({ ok: true }, r)))
          .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
      }
      if (msg.type === 'translateSelection' && msg.text) {
        openCard(null, String(msg.text).trim());
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'translateBlocks') {
        translateBlocks()
          .then((r) => sendResponse(Object.assign({ ok: true }, r)))
          .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
      }
      if (msg.type === 'ping') {
        sendResponse({ ok: true });
      }
      if (msg.type === 'hello') {
        sendResponse({ ok: true, v: V });
      }
      if (msg.type === 'setSetting' && msg.patch) {
        Object.assign(settings, msg.patch);
        if (settings.showBubble === false && ui) ui.bubble.hidden = true;
        sendResponse({ ok: true });
      }
      if (msg.type === 'pageState') {
        sendResponse({ ok: true, translated: document.querySelectorAll('.llt-tr').length > 0 });
      }
    });
  } catch (e) {
    /* 非扩展环境 */
  }
})();
