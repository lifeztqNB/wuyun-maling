'use strict';

/**
 * packaged.js —— 打包产物冒烟测试
 *
 * 光看 dist/ 里躺着一个 .exe 不算数。真正要验的是：**打包后的应用能不能起来**。
 * 开发时跑得好、打包后白屏的原因太多了（文件没进 asar、路径变成 asar 内路径、
 * 图标缺失、数据目录权限……），所以这里直接拉起 dist/win-unpacked 里的 exe，
 * 用截图模式各截一张登录页和主界面，再顺手检查几个关键文件有没有进包。
 *
 * 跑法： node test/packaged.js       （需要先 npm run dist）
 * 产物： ../_shots/packaged-*.png
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { shoot, ROOT, DEFAULT_OUT_DIR } = require('./lib/shoot');

const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');

/** 打包后的 exe 名字跟着 productName 走（中文），所以按目录扫而不是写死 */
function findExe() {
  if (!fs.existsSync(UNPACKED)) return null;
  const hit = fs.readdirSync(UNPACKED).filter((n) => n.toLowerCase().endsWith('.exe'));
  return hit.length ? path.join(UNPACKED, hit[0]) : null;
}

/** 演示用配置：和 test/shot.js 里同一套路数（siteBaseUrl 指向死端口，避免打到线上） */
function writeConfig(dir, { mode = 'custom', loggedIn = false } = {}) {
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        mode,
        community: {
          token: loggedIn ? 'demo-token-not-real' : '',
          username: loggedIn ? 'wuyun_demo' : '',
          nickname: loggedIn ? '雾韵演示号' : '',
          avatarUrl: '',
          siteBaseUrl: 'http://127.0.0.1:9',
          gatewayBaseUrl: 'https://api.wuyunsq.top/v1',
          models: [{ id: 'wyzx-omni', name: '智象全模态', desc: '' }],
          defaultModel: 'wyzx-omni',
          quota: loggedIn
            ? {
                period: '2026-10',
                allowanceMicros: 5000000,
                usedMicros: 1760000,
                remainingMicros: 3240000,
                percent: 65,
                exhausted: false,
                allowanceText: '5.00 元',
                usedText: '1.76 元',
                remainingText: '3.24 元',
                calls: 128,
                tokens: 486230,
                resetsAt: '2026-10-31 16:00:00',
                resetsAtLocal: '2026-11-01 00:00',
              }
            : null,
          quotaFetchedAt: loggedIn ? Date.now() : 0,
        },
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-demo-not-a-real-key',
        model: mode === 'community' ? '' : 'deepseek-chat',
        temperature: 0.2,
        maxTokens: 0,
        maxSteps: 25,
        stream: true,
        shell: 'powershell',
        approvalMode: 'auto',
        workspace: os.tmpdir(),
        extraHeaders: {},
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'window.json'), JSON.stringify({ width: 1360, height: 900 }), 'utf8');
  return dir;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wuyun-pkg-${tag}-`));
}

/**
 * 列出 asar 里的所有文件路径。
 *
 * 不能直接在大文件里搜「renderer/app.js」这种字符串 —— asar 的索引是一棵嵌套的
 * JSON 树（`{"renderer":{"files":{"app.js":{...}}}}`），完整路径在文件里根本不连续，
 * 搜字符串会把「明明打进去了」报成缺失。老老实实按格式解析头。
 *
 * 格式：前 16 字节是四个 UInt32（其中第 3 个是补过 4 字节对齐的 JSON 长度、
 * 第 4 个是 JSON 的真实长度），之后是 JSON 索引，再往后才是各个文件的原始内容。
 * 一定要按「真实长度」截，按对齐后的长度读会把后面的内容一起读进来，JSON.parse 直接报错。
 */
function asarFiles(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const padded = head.readUInt32LE(8);
    const actual = head.readUInt32LE(12);
    const buf = Buffer.alloc(padded);
    fs.readSync(fd, buf, 0, padded, 16);
    const header = JSON.parse(buf.subarray(0, actual).toString('utf8'));

    const out = [];
    const walk = (node, prefix) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (v && v.files) walk(v, p);
        else out.push(p);
      }
    };
    walk(header, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** 检查 asar 里有没有关键资源（文件没进包是打包后白屏的头号原因） */
function checkAsar() {
  const asar = path.join(UNPACKED, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) return ['找不到 resources/app.asar'];

  let files;
  try {
    files = asarFiles(asar);
  } catch (err) {
    return [`asar 索引解析失败：${err.message}`];
  }

  const want = [
    'main.js',
    'preload.js',
    'renderer/index.html',
    'renderer/logo.png',
    'renderer/logo-sm.png',
    'renderer/app.js',
    'renderer/style.css',
    'renderer/markdown.js',
    'src/agent.js',
    'src/community.js',
    'src/store.js',
  ];
  const missing = want.filter((w) => !files.includes(w));
  // 顺手把不该进包的东西也报出来（test / docs / build 都是构建资源，不该占体积）
  const leaked = files.filter((f) => /^(test|docs|build|dist|scripts)\//.test(f));
  return [
    ...missing.map((w) => `asar 里没有 ${w}`),
    ...leaked.slice(0, 5).map((f) => `asar 里多了不该有的 ${f}`),
  ];
}

(async () => {
  const exe = findExe();
  if (!exe) {
    console.error(`\n找不到打包产物：${UNPACKED}\n先跑 npm run dist（或 npm run dist:dir）\n`);
    process.exit(1);
  }

  console.log(`\n\x1b[1m打包产物冒烟测试\x1b[0m  ${path.relative(ROOT, exe)}`);

  const missing = checkAsar();
  if (missing.length) {
    for (const m of missing) console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  } else {
    console.log('  \x1b[32m✓\x1b[0m asar 里的关键文件齐全');
  }

  // 1) 登录页（社区模式 + 未登录）
  const ok1 = await shoot({
    label: 'packaged-login',
    dataDir: writeConfig(tmpDir('login'), { mode: 'community' }),
    exe,
    delay: 2600, // 打包后首启动要解 asar、建数据目录，比开发版慢
    outDir: DEFAULT_OUT_DIR,
  });

  // 2) 主界面 + 额度条（社区模式 + 已登录）
  const ok2 = await shoot({
    label: 'packaged-main',
    dataDir: writeConfig(tmpDir('main'), { mode: 'community', loggedIn: true }),
    exe,
    delay: 2600,
    outDir: DEFAULT_OUT_DIR,
  });

  console.log('');
  process.exit(missing.length || !ok1 || !ok2 ? 1 : 0);
})();
