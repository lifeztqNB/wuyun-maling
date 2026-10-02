'use strict';

/**
 * ui.js —— 界面静态检查
 *
 * 起因是一个真实的坑：`renderer/app.js` 里绑了一个 HTML 中并不存在的元素 id，
 * 一个 null 就让整个界面启动即白屏，而报错只写着「读不到 addEventListener 的 null」，
 * 完全看不出是哪个元素。
 *
 * 这个检查就是把这个坑钉死：凡是 JS 里按 id 取的元素，HTML 里必须真的存在。
 * 顺带检查 CSS 里定义的类名有没有被 HTML/JS 用到（防止样式腐化）。
 *
 * 跑法： node test/ui.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const APP_RAW = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const MARKDOWN = fs.readFileSync(path.join(ROOT, 'renderer', 'markdown.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

/**
 * 剥掉注释再做静态检查。
 *
 * 不剥会出假阳性：上面 app.js 的注释里就写着 `$('chipWorkspace')` 作为「反面教材」，
 * 检查器一度把它当成真实引用而报错。检查器必须分析代码，不是文本。
 * 顺手也跳过字符串字面量，避免把字符串里的 // 当行注释。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i++; continue; }
    // 字符串里：原样保留，处理转义
    out += c;
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
    if (c === state) state = 'code';
    i++;
  }
  return out;
}

const APP = stripComments(APP_RAW);

let fail = 0;

function ok(name) {
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function bad(name, detail) {
  fail++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}

console.log('\n\x1b[1m界面静态检查\x1b[0m');

/* ---------- 1. JS 引用的 id 必须存在 ---------- */

const htmlIds = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const refs = new Map(); // id -> 出现位置
for (const m of APP.matchAll(/\$\('([^']+)'\)/g)) refs.set(m[1], '$(...)');
for (const m of APP.matchAll(/\bon\('([^']+)'/g)) refs.set(m[1], 'on(...)');
for (const m of APP.matchAll(/getElementById\('([^']+)'\)/g)) refs.set(m[1], 'getElementById');

const missing = [...refs.keys()].filter((id) => !htmlIds.has(id));
if (missing.length) {
  bad(
    `${refs.size} 个 id 引用全部存在`,
    `HTML 里找不到：${missing.map((i) => `#${i}（来自 ${refs.get(i)}）`).join('、')}`
  );
} else {
  ok(`${refs.size} 个 id 引用全部存在`);
}

/* ---------- 2. 反向检查：HTML 里的 id 有没有从来没用过 ---------- */

const unusedIds = [...htmlIds].filter((id) => !refs.has(id) && !HTML.includes(`for="${id}"`));
// 纯样式钩子（比如 composerHint）允许只出现在 HTML 里，不算错，只是提示
if (unusedIds.length) {
  console.log(`  \x1b[33m·\x1b[0m 仅用于样式、JS 未引用的 id：${unusedIds.join('、')}`);
} else {
  ok('没有闲置的 id');
}

/* ---------- 3. app.js 里不能出现裸的 addEventListener 于可能为 null 的 $() ---------- */

const risky = [...APP.matchAll(/\$\('([^']+)'\)\.addEventListener/g)].map((m) => m[1]);
if (risky.length) {
  bad(
    '没有「直接对 $() 结果绑事件」的写法',
    `这些地方一旦元素缺失就会白屏，请改用 on('id', ...)：${risky.map((i) => `#${i}`).join('、')}`
  );
} else {
  ok('事件绑定都走了带存在性检查的 on()');
}

/* ---------- 4. 关键元素确实在 HTML 里 ---------- */

const REQUIRED = [
  'input',
  'btnSend',
  'chipStop',
  'chipMode',
  'chipShell',
  'transcript',
  'sessionList',
  'taskTitle',
  'pillModel',
  'tbWorkspaceLabel',
  'modalRoot',
  'toastRoot',
  'runbar',
  'statusText',
];
const gone = REQUIRED.filter((id) => !htmlIds.has(id));
if (gone.length) bad('关键界面元素齐全', `缺少：${gone.join('、')}`);
else ok(`关键界面元素齐全（${REQUIRED.length} 个）`);

/* ---------- 5. CSS 类名使用情况（只报信息，不判失败） ---------- */

const cssClasses = new Set([...CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const usedInCode = new Set();
for (const src of [HTML, APP, MARKDOWN]) {
  for (const m of src.matchAll(/class(?:Name)?\s*[=:]\s*(['"`])([^'"`]*)\1/g)) {
    for (const c of m[2].split(/\s+/)) if (c) usedInCode.add(c);
  }
  // el('div', 'tool running') 这类
  for (const m of src.matchAll(/\bel\([^,]+,\s*[`'"]([^`'"]*)[`'"]/g)) {
    for (const c of m[1].split(/\s+/)) if (c) usedInCode.add(c);
  }
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) usedInCode.add(m[1]);
}
// 模板字符串里拼出来的动态类名（tool ok / error / denied 等）
const DYNAMIC = new Set(['running', 'ok', 'error', 'denied', 'add', 'del', 'hunk', 'warn', 'info', 'bad', 'on', 'active', 'open']);
const orphan = [...cssClasses].filter((c) => !usedInCode.has(c) && !DYNAMIC.has(c) && !HTML.includes(c) && !APP.includes(c));
if (orphan.length) {
  console.log(`  \x1b[33m·\x1b[0m CSS 里可能没被用到的类（${orphan.length} 个）：${orphan.slice(0, 18).join('、')}${orphan.length > 18 ? ' …' : ''}`);
} else {
  ok('CSS 类名没有明显腐化');
}

/* ---------- 6. CSP 与外部资源 ---------- */

if (/<(script|link)[^>]+(https?:)?\/\//i.test(HTML)) {
  bad('没有引用任何外部资源', 'index.html 里出现了外链，离线环境会白屏');
} else {
  ok('没有引用任何外部资源（完全离线可用）');
}

if (!HTML.includes('Content-Security-Policy')) {
  bad('设置了 CSP', 'index.html 缺少 Content-Security-Policy');
} else {
  ok('设置了 CSP');
}

console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log('\x1b[32m全部通过\x1b[0m');
else console.log(`\x1b[31m失败 ${fail} 项\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
