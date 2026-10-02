'use strict';

/**
 * shoot.js（测试用的小工具，不是 test/shot.js）—— 拉真窗口截图
 *
 * 抽出来是因为有两个地方要用：`test/shot.js` 截开发版，`test/packaged.js`
 * 截打包后的 exe。这里面每一行都是踩出来的（看门狗、事件监听、退出方式），
 * 复制一份迟早会分叉，所以放一处。
 *
 * 核心约定：
 *   · 截图进程是**一次性**的（截完就退），所以可以硬终止
 *   · 判断「成功」只看 PNG 有没有落盘，不看退出码
 *   · 永远带看门狗：子进程卡住时连进程树一起杀，脚本不会无限期挂着
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** 默认输出目录：仓库外层（不污染仓库，也不需要 gitignore） */
const DEFAULT_OUT_DIR = path.join(ROOT, '..', '_shots');

/**
 * 截一张图。
 *
 * @param {object} o
 * @param {string} o.label       文件名后缀，产出 agent-<label>.png
 * @param {string} o.dataDir     该次运行的数据目录（**每次都要新的**，见 shot.js 的说明）
 * @param {string} [o.exe]       要启动的可执行文件，默认 node_modules 里的 electron
 * @param {string} [o.script]    截图前在渲染进程里跑的一段 JS（必须写成单行）
 * @param {number} [o.delay]     截图前等多久，默认 1600ms
 * @param {string} [o.size]      内容区尺寸 WxH，默认 1440x900
 * @param {string} [o.outDir]    输出目录
 * @returns {Promise<boolean>}   是否成功拿到 PNG
 */
function shoot({ label, dataDir, exe, script, delay = 1600, size = '1440x900', outDir = DEFAULT_OUT_DIR }) {
  // 不给 exe 就用仓库里的 Electron（跑源码）；给了就是打包后的可执行文件。
  const bin = exe || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

  fs.mkdirSync(outDir, { recursive: true });
  const png = path.join(outDir, `agent-${label}.png`);
  // 先删掉上一轮留下的同名文件。
  // 不删的话，「子进程根本没跑起来」和「跑起来了但没写出来」这两种失败
  // 都会被上一轮的旧图冒充成成功 —— 检查存在性就完全失去意义了。
  fs.rmSync(png, { force: true });

  const args = [`--data-dir=${dataDir}`, `--shot=${png}`, `--shot-delay=${delay}`, `--shot-size=${size}`];
  // 从源码跑时要额外告诉 Electron「跑哪个目录」；打包后的 exe 自己就是入口。
  if (!exe) args.unshift('.');
  if (script) args.push(`--shot-script=${script}`);

  // 关键：环境里若带着 ELECTRON_RUN_AS_NODE，Electron 会退化成普通 Node 跑，
  // 主进程里的 app / BrowserWindow 全是 undefined，报一个很难懂的错。
  // 自动化环境（CI、各种工具链）经常会带上这个变量，这里主动剥掉。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let settled = false;
    let code = null;
    let signal = null;
    const t0 = Date.now();
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));

    const finish = (note) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const ms = Date.now() - t0;
      const ok = fs.existsSync(png);
      const shotSize = (out.match(/SHOT_SAVED [^\n]*\s(\d+x\d+)/) || [, ''])[1];
      // 失败时把「退出码 / 信号 / 耗时 / 完整输出」都打出来。
      // 之前只打输出，而偶发失败时输出恰好是空的 —— 什么线索都没有，只能重跑。
      const why = ok
        ? ''
        : `exit=${code ?? 'null'} signal=${signal ?? 'null'} ${ms}ms\n${out.trim() || '（子进程没有任何输出）'}`;
      console.log(
        `  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${path.basename(png)}  ` +
          (ok ? `${(fs.statSync(png).size / 1024).toFixed(0)} KB  ${shotSize}` : why) +
          (note ? `  \x1b[33m(${note})\x1b[0m` : '')
      );
      if (process.env.SHOT_VERBOSE) {
        for (const line of out.split(/\r?\n/)) {
          if (/^SHOT_/.test(line)) console.log(`      ${line}`);
        }
      }
      resolve(ok);
    };

    // 看门狗：截图模式是一次性任务，子进程「截完图却退不掉」时不该让整个脚本
    // 无限期挂着（CI 上就是直接超时失败，什么信息都拿不到）。到点连进程树一起杀，
    // 只要 PNG 已经落盘就算这一张通过 —— 反正该截的东西已经截到了。
    const watchdog = setTimeout(() => {
      const waited = Math.round((Date.now() - t0) / 1000);
      try {
        execFileSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' });
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      finish(`子进程未自行退出（已等 ${waited}s，exit 事件未触发），已强制结束`);
    }, delay + 25000);
    watchdog.unref?.();

    if (process.env.SHOT_DEBUG) {
      for (const ev of ['spawn', 'exit', 'close', 'error']) {
        child.on(ev, (...a) => console.log(`      [debug] ${ev} pid=${child.pid} ${Date.now() - t0}ms ${a.join(' ')}`));
      }
    }

    child.on('close', (c, s) => {
      code = c;
      signal = s;
      finish(null);
    });

    // 也监听 'exit'，而且把它当准。
    //
    // 'close' 要等 stdio 全部关闭才触发；只要主进程派生出的子进程（渲染、GPU）
    // 还握着 stdout 的写端，'close' 就会一直等它们 —— 表现是「图截好了、
    // 主进程也退出了，脚本却还在等」，只能靠看门狗强杀。
    // 'exit' 在主进程结束时就触发，这里给它一点时间把 stdout 收干净就收工。
    child.on('exit', (c, s) => {
      code = c;
      signal = s;
      const t1 = Date.now();
      const poll = setInterval(() => {
        if (/SHOT_SAVED|SHOT_FAILED/.test(out) || Date.now() - t1 > 1200) {
          clearInterval(poll);
          finish(null);
        }
      }, 100);
    });
  });
}

module.exports = { shoot, ROOT, DEFAULT_OUT_DIR };
