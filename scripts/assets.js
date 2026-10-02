#!/usr/bin/env node
'use strict';

/**
 * assets.js —— 图片资源的「文本 ⇄ 二进制」转换
 *
 * ============ 为什么图片要以 base64 文本形式提交 ============
 *
 * 这个仓库是通过 GitHub 的接口（只能提交文本内容）发布和维护的，
 * 二进制文件没法原样传上去。为了不因为「少两个 png」导致仓库克隆下来跑不起来，
 * 界面 logo 和打包图标就以 base64 文本存在 assets/ 下，构建/启动前还原成真文件。
 *
 * 还原出来的文件是**产物**，已经在 .gitignore 里排除，不要手工去改它们 ——
 * 改了下次跑脚本就被覆盖了。
 *
 * 用法：
 *   node scripts/assets.js           还原（默认，npm start / npm run dist 会自动跑）
 *   node scripts/assets.js --encode  反向：把当前真文件重新编码回 assets/
 *                                    （换了 logo 之后用这个更新文本版本）
 *   node scripts/assets.js --verify  校验 assets/ 里的文本与当前真文件是否一致
 *                                    （改了真文件却忘了 --encode 时能查出来）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** [文本源, 还原目标] */
const ASSETS = [
  ['assets/logo-256.png.b64', 'renderer/logo.png'],
  ['assets/logo-64.png.b64', 'renderer/logo-sm.png'],
  ['assets/icon.ico.b64', 'build/icon.ico'],
];

const mode = process.argv.includes('--encode')
  ? 'encode'
  : process.argv.includes('--verify')
    ? 'verify'
    : 'decode';

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/\s+/g, '');
}

function decodeAll() {
  let changed = 0;
  for (const [src, dst] of ASSETS) {
    const srcPath = path.join(ROOT, src);
    const dstPath = path.join(ROOT, dst);
    if (!fs.existsSync(srcPath)) {
      console.error(`  缺少资源文件：${src}`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(readText(srcPath), 'base64');
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.writeFileSync(dstPath, buf);
    console.log(`  ${src} -> ${dst}  (${(buf.length / 1024).toFixed(1)} KB)`);
    changed++;
  }
  return changed;
}

function encodeAll() {
  for (const [src, dst] of ASSETS) {
    const dstPath = path.join(ROOT, dst);
    if (!fs.existsSync(dstPath)) {
      console.error(`  没有 ${dst}，没法反向编码`);
      process.exitCode = 1;
      continue;
    }
    const buf = fs.readFileSync(dstPath);
    // 76 列换行：一行几十万字符的话，任何 diff / 代码审阅工具都会卡死
    const text = buf.toString('base64').replace(/(.{76})/g, '$1\n');
    fs.writeFileSync(path.join(ROOT, src), `${text}\n`);
    console.log(`  ${dst} -> ${src}  (${(buf.length / 1024).toFixed(1)} KB)`);
  }
}

function verifyAll() {
  let bad = 0;
  for (const [src, dst] of ASSETS) {
    const srcPath = path.join(ROOT, src);
    const dstPath = path.join(ROOT, dst);
    if (!fs.existsSync(srcPath) || !fs.existsSync(dstPath)) {
      console.log(`  \x1b[33m?\x1b[0m ${dst} 或 ${src} 不存在，跳过`);
      continue;
    }
    const real = fs.readFileSync(dstPath);
    const back = Buffer.from(readText(srcPath), 'base64');
    const same = real.equals(back);
    if (!same) bad++;
    console.log(
      `  ${same ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${dst}  ${(real.length / 1024).toFixed(1)} KB` +
        (same ? '' : `  与 ${src} 不一致（真文件改过？跑一下 --encode）`)
    );
  }
  return bad;
}

if (mode === 'encode') {
  encodeAll();
} else if (mode === 'verify') {
  process.exitCode = verifyAll() ? 1 : 0;
} else if (decodeAll() === 0) {
  console.error('\n没有任何资源被还原，构建/启动会缺少 logo。\n');
  process.exit(1);
}

