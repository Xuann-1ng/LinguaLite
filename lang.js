/**
 * 轻译 LinguaLite — 语种判定（popup 面板与 content 脚本共用的唯一实现）
 *
 * 只回答一个问题：这段文字该翻成什么语言？
 *   · 输入中文       → 译成英文
 *   · 输入其它语言   → 译成简体中文（英 / 日 / 韩 / 俄 / 阿 / 泰 都一样）
 *
 * 判定在界面上做，算好的目标语言再随消息发给后台；
 * 后台（Service Worker）不引这个文件——新版 Chrome 把它当 ES module，importScripts 不可用。
 *
 * 纯本地字符统计，不发网络请求、不依赖接口，粘贴几万字也是毫秒级。
 * 注意：本文件必须排在 content.js / popup.js 之前加载（manifest 里已保证顺序）。
 */
(function (root) {
  'use strict';

  /* 各书写系统的主字符区，按判定优先级排列 */
  const SCRIPTS = [
    ['kana', /[\u3040-\u30FF]/], // 日文假名
    ['hangul', /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/], // 韩文
    ['han', /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/], // 汉字
    ['cyrillic', /[\u0400-\u04FF]/], // 西里尔
    ['arabic', /[\u0600-\u06FF\u0750-\u077F]/], // 阿拉伯
    ['thai', /[\u0E00-\u0E7F]/], // 泰文
    ['latin', /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/] // 拉丁
  ];

  const ASCII_LETTER = /[A-Za-z]/;
  const CJK_THRESHOLD = 0.2; // 汉字占比超过两成即视为中文（"用 Chrome 打开这个页面" 也算）

  const NAME = {
    zh: '中文',
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
    ru: 'Русский',
    pt: 'Português',
    it: 'Italiano',
    ar: 'العربية',
    th: 'ไทย',
    vi: 'Tiếng Việt',
    tr: 'Türkçe',
    id: 'Indonesia',
    hi: 'हिन्दी',
    nl: 'Nederlands',
    unknown: '未知'
  };

  /** 逐字符统计各书写系统的字数 */
  function countByScript(text) {
    const n = { kana: 0, hangul: 0, han: 0, cyrillic: 0, arabic: 0, thai: 0, latin: 0 };
    const s = String(text == null ? '' : text);
    for (const ch of s) {
      const code = ch.codePointAt(0);
      // ASCII 里的数字、标点、空白一律跳过，省掉后面的正则
      if (code < 0x80 && !ASCII_LETTER.test(ch)) continue;
      for (let i = 0; i < SCRIPTS.length; i++) {
        if (SCRIPTS[i][1].test(ch)) {
          n[SCRIPTS[i][0]]++;
          break;
        }
      }
    }
    return n;
  }

  /**
   * 判定文本语种，返回 'zh' / 'en' / 'ja' / 'ko' / 'ru' / 'ar' / 'th' / 'unknown'。
   * 只区分到「对选择目标语言有意义」的粒度，不再细分英/法/德（都翻中文）。
   */
  function detect(text) {
    const n = countByScript(text);
    const total = n.kana + n.hangul + n.han + n.cyrillic + n.arabic + n.thai + n.latin;
    if (!total) return 'unknown';

    const ratio = (k) => n[k] / total;

    // 假名出现且占比不小 → 日文（中文里不会有假名）
    if (n.kana && n.kana / (n.kana + n.han || 1) >= 0.15) return 'ja';
    if (ratio('hangul') >= 0.3) return 'ko';
    if (ratio('han') >= CJK_THRESHOLD) return 'zh';
    if (ratio('cyrillic') >= 0.4) return 'ru';
    if (ratio('arabic') >= 0.4) return 'ar';
    if (ratio('thai') >= 0.4) return 'th';
    if (n.latin) return 'en';
    return 'unknown';
  }

  /**
   * 算出真正的目标语言：
   *   to 是具体语种 → 原样返回；to === 'auto' → 中文译英、其它译简中。
   */
  function targetFor(to, text) {
    if (to && to !== 'auto') return to;
    return detect(text) === 'zh' ? 'en' : 'zh-Hans';
  }

  /** 一次性拿到「源语种 + 目标语种」，给界面显示方向用 */
  function plan(to, text) {
    const src = detect(text);
    return { src, target: to && to !== 'auto' ? to : src === 'zh' ? 'en' : 'zh-Hans' };
  }

  /** 把多段文字拼成一段样本（整页翻译时用来判定整页语种，封顶 4000 字） */
  function sample(texts, limit) {
    const max = limit || 4000;
    const parts = [];
    let len = 0;
    const list = texts || [];
    for (let i = 0; i < list.length; i++) {
      const s = String(list[i] == null ? '' : list[i]);
      if (!s) continue;
      parts.push(s);
      len += s.length;
      if (len >= max) break;
    }
    return parts.join(' ').slice(0, max);
  }

  /** 语种代码 → 显示名 */
  function name(code) {
    return NAME[code] || code || '';
  }

  root.LinguaLang = { detect, targetFor, plan, sample, name, NAME };
})(typeof self !== 'undefined' ? self : globalThis);
