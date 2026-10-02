#!/usr/bin/env node
'use strict';

/**
 * dist.js —— 打包入口
 *
 * 为什么不直接在 package.json 里写 `set VAR=xxx && electron-builder`：
 * npm script 在 Windows 上走 cmd、在 macOS / Linux 上走 sh，同一句环境变量写法
 * 两边不通用。用 Node 先把变量设好再调 CLI，三个平台一致。
 *
 * 为什么要设镜像：electron-builder 打包时会去下载 NSIS、winCodeSign、app-builder
 * 这些构建依赖，默认源在 GitHub，国内基本拉不动（表现为卡在某个 download 上很久
 * 然后失败，报错还很难看懂）。npmmirror 有完整镜像。
 *
 * 但镜像只在「本地」用：GitHub Actions 的机器本来就在墙外，绕道 npmmirror
 * 反而更慢、更不稳。所以 CI 里保持官方源（runner 会设 CI=true）。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

if (!process.env.CI) {
  // 两个都要：前者是 NSIS / winCodeSign / app-builder，后者是 Electron 自身的发行包。
  // electron-builder 的 electronDownload.mirror 如果没配，会退回来读 ELECTRON_MIRROR。
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
  process.env.ELECTRON_MIRROR =
    process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
}

const root = path.join(__dirname, '..');

// 图标是 assets/*.b64 还原出来的（npm 的 predist 钩子会自动跑）。
// 直接 `node scripts/dist.js` 的话就绕过了钩子，这里明确提示一句，
// 否则 electron-builder 只会报「icon 不存在」，看不出该干什么。
if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) {
  console.error('\n缺少 build/icon.ico，先跑：npm run assets\n');
  process.exit(1);
}

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');

const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});

// spawnSync 在信号终止时 status 是 null，别把 null 当成 0 传出去
process.exit(r.status === null ? 1 : r.status);
