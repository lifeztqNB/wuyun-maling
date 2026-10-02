'use strict';

/**
 * shot.js —— 自动截图验收
 *
 * 起一个临时数据目录（不碰你真实的配置），塞一份演示会话，然后拉起真正的
 * Electron 窗口截图。跑完自己清理。
 *
 * 跑法： node test/shot.js
 * 产物： _shots/agent-*.png
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { shoot, ROOT } = require('./lib/shoot');

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const now = Date.now();
const ago = (s) => now - s * 1000;

/* ---------- 演示会话 ---------- */

const DEMO_ITEMS = [
  {
    id: 'i1',
    type: 'user',
    text: '帮我把 src/utils/format.js 里的日期格式化改成本地时区，然后跑一下测试。',
    at: ago(96),
  },
  {
    id: 'i2',
    type: 'assistant',
    text: '我先看一下这个文件现在是怎么写的。\n\n计划：\n\n1. 读 `src/utils/format.js`，确认现在的实现\n2. 把 UTC 取值换成本地时区\n3. 跑测试验证',
    reasoning: '用户要的是时区修正，属于小改动，应该用 edit_file 而不是整篇重写。先读文件确认实际写法。',
    at: ago(92),
  },
  {
    id: 'i3',
    type: 'tool',
    toolCallId: 'c1',
    name: 'read_file',
    args: { path: 'src/utils/format.js' },
    status: 'ok',
    durationMs: 3,
    content:
      '# src/utils/format.js（第 1-12 行，共 12 行）\n' +
      ' 1 | import { pad } from "./pad";\n' +
      ' 2 | \n' +
      ' 3 | export function formatDate(d) {\n' +
      ' 4 |   const dt = new Date(d);\n' +
      ' 5 |   return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;\n' +
      ' 6 | }\n' +
      ' 7 | \n' +
      ' 8 | export function formatTime(d) {\n' +
      ' 9 |   const dt = new Date(d);\n' +
      '10 |   return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;\n' +
      '11 | }\n' +
      '12 | ',
    meta: { kind: 'read', path: 'src/utils/format.js', lines: 12, from: 1, to: 12 },
    at: ago(88),
  },
  {
    id: 'i4',
    type: 'assistant',
    text: '找到了 —— 用的是 `getUTC*` 系列，所以拿到的永远是 UTC 时间。换成 `get*` 就是本地时区。',
    at: ago(80),
  },
  {
    id: 'i5',
    type: 'tool',
    toolCallId: 'c2',
    name: 'edit_file',
    args: {
      path: 'src/utils/format.js',
      old_string: 'getUTCFullYear()',
      new_string: 'getFullYear()',
      replace_all: true,
    },
    status: 'ok',
    durationMs: 2,
    content: '已修改 src/utils/format.js（3 处，+3 −3）',
    meta: {
      kind: 'edit',
      path: 'src/utils/format.js',
      times: 3,
      stat: { add: 3, del: 3 },
      diff:
        '--- a/src/utils/format.js\n' +
        '+++ b/src/utils/format.js\n' +
        '@@ -2,11 +2,11 @@\n' +
        ' import { pad } from "./pad";\n' +
        ' \n' +
        ' export function formatDate(d) {\n' +
        '   const dt = new Date(d);\n' +
        '-  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;\n' +
        '+  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;\n' +
        ' }\n' +
        ' \n' +
        ' export function formatTime(d) {\n' +
        '   const dt = new Date(d);\n' +
        '-  return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;\n' +
        '+  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;\n' +
        ' }',
    },
    at: ago(72),
  },
  {
    id: 'i6',
    type: 'tool',
    toolCallId: 'c3',
    name: 'run_command',
    args: { command: 'npm test -- format' },
    status: 'ok',
    durationMs: 1842,
    content: '$ npm test -- format\n（powershell，退出码 0，耗时 1842 ms）\n\n--- stdout ---\n> wuyun-community@1.2.0 test\n> vitest run format\n\n RUN  v2.1.2\n\n ✓ src/utils/format.test.js (4 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.84s\n',
    meta: {
      kind: 'command',
      command: 'npm test -- format',
      shell: 'powershell',
      cwd: '.',
      exitCode: 0,
      durationMs: 1842,
      timedOut: false,
      stdout:
        '> wuyun-community@1.2.0 test\n' +
        '> vitest run format\n\n' +
        ' RUN  v2.1.2\n\n' +
        ' ✓ src/utils/format.test.js (4 tests) 38ms\n\n' +
        ' Test Files  1 passed (1)\n' +
        '      Tests  4 passed (4)\n' +
        '   Duration  1.84s\n',
      stderr: '',
      error: false,
    },
    at: ago(64),
  },
  {
    id: 'i7',
    type: 'assistant',
    text:
      '改完了，测试全绿。\n\n' +
      '**改动**：`src/utils/format.js` 里三处 `getUTC*` 换成 `get*`，现在按本机时区输出。\n\n' +
      '**验证**：`npm test -- format` → 4 个用例全部通过。\n\n' +
      '有个地方要提醒你：`formatDate` 之前返回的是 UTC 日期，如果历史数据里有按 UTC 存的日期字符串，这次改动会让它们差一天。要不要我顺手加个兼容读取？',
    at: ago(58),
  },
  {
    id: 'i8',
    type: 'notice',
    level: 'info',
    text: '上下文较长，已丢弃最早的 2 轮对话以腾出空间。',
    at: ago(56),
  },
];

const DEMO_MESSAGES = [
  { role: 'user', content: DEMO_ITEMS[0].text },
  { role: 'assistant', content: DEMO_ITEMS[1].text },
  { role: 'user', content: '继续' },
  { role: 'assistant', content: DEMO_ITEMS[6].text },
];

/* ---------- 数据目录 ---------- */

/** 演示用的社区额度快照（结构与 /api/desktop/quota 的返回一致，数值是编的） */
const DEMO_QUOTA = {
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
};

/** 与 inc/desktop.php 里 desktop_gateway_models() 下发的一致（只含文本类） */
const DEMO_MODELS = [
  { id: 'wyzx-omni', name: '智象全模态', desc: '全模态理解与生成，支持图文混合输入' },
  { id: 'wyzx-text', name: '智象文本', desc: '通用文本对话与长文写作' },
];

/**
 * 写一份演示用的配置（假 Key / 假 token，纯为了截图时有东西可显示）。
 *
 * 默认写成 mode=custom：这样启动后直接进主界面，不会被登录页盖住。
 * 要截登录页或额度弹窗时再显式传 community。
 *
 * community.siteBaseUrl 刻意指向一个没人监听的端口 —— 不然启动时的额度刷新
 * 会真的打到线上，服务端一看是假 token 回 401，客户端会「很正确地」自动登出，
 * 截图就变成登录页了。指向死端口则是一个网络错误，不会触发登出。
 */
function writeConfig(dir, workspace, { mode = 'custom', loggedIn = false } = {}) {
  const community = {
    token: loggedIn ? 'demo-token-not-real' : '',
    username: loggedIn ? 'wuyun_demo' : '',
    nickname: loggedIn ? '雾韵演示号' : '',
    avatarUrl: '',
    siteBaseUrl: 'http://127.0.0.1:9',
    gatewayBaseUrl: 'https://api.wuyunsq.top/v1',
    models: DEMO_MODELS,
    defaultModel: 'wyzx-omni',
    quota: loggedIn ? DEMO_QUOTA : null,
    quotaFetchedAt: loggedIn ? Date.now() : 0,
  };

  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        mode,
        community,
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-demo-not-a-real-key',
        // community 模式下留空 = 跟随服务端下发的默认模型
        model: mode === 'community' ? '' : 'deepseek-chat',
        temperature: 0.2,
        maxTokens: 0,
        maxSteps: 25,
        stream: true,
        shell: 'powershell',
        approvalMode: 'auto',
        workspace,
        extraHeaders: {},
      },
      null,
      2
    ),
    'utf8'
  );
}

/** 带演示会话的数据目录（对话相关的截图都用这个）。 */
function makeDataDir(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuyun-shot-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wuyun-shot-ws-'));

  writeConfig(dir, workspace, opts);

  const session = {
    id: 'sdemo0001',
    title: '日期格式化改成本地时区',
    createdAt: ago(120),
    updatedAt: ago(50),
    workspace,
    messages: DEMO_MESSAGES,
    items: DEMO_ITEMS,
  };

  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([session], null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'window.json'), JSON.stringify({ width: 1360, height: 900 }), 'utf8');

  return { dir, workspace };
}

/** 只有配置、没有会话的数据目录（截空白态用）。 */
function makeBlankDir(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuyun-shot-blank-'));
  writeConfig(dir, fs.mkdtempSync(path.join(os.tmpdir(), 'wuyun-shot-ws-')), opts);
  return dir;
}

/* ---------- 主流程 ---------- */

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`找不到 Electron：${ELECTRON}\n先跑 npm install`);
    process.exit(1);
  }

  console.log('\n\x1b[1m截图验收\x1b[0m');

  /**
   * ⚠️ 每张截图都必须用一个**全新的数据目录**，不能复用。
   *
   * 血泪教训：之前 02~05 共用同一个 --data-dir，结果 02 干净退出，
   * 03/04/05 全部「截完图却退不掉」，只能靠看门狗强杀。规律非常整齐 ——
   * 某个数据目录**第一次**被用时一切正常，**第二次**用同一个目录就必挂。
   *
   * 根因在主进程：`app.requestSingleInstanceLock()` 是按 userData 路径加锁的。
   * 截图模式用的是 `process.exit(0)` 硬退（见 main.js 的说明），它会跳过 Electron
   * 的正常收尾，于是下一次用同一个 userData 启动时就会撞上上一个进程留下的
   * 陈旧锁，进程从此卡在那里退不掉。
   *
   * 顺带一提，这样改本身也更对：每张截图都在一个干净的数据目录里跑，
   * 上一张留下的 window.json / sessions.json 不会串到下一张。
   */
  const freshDir = (opts) => makeDataDir(opts).dir;

  /**
   * SHOT_ONLY=06-login 可以只跑其中一张。
   * 改一处界面就重跑全部 8 张很浪费时间（每张都要起一个 Electron），
   * 排查某一张时更需要能单独把它跑起来看完整输出。
   */
  const only = process.env.SHOT_ONLY ? process.env.SHOT_ONLY.split(',').map((s) => s.trim()) : null;
  const want = (label) => !only || only.some((o) => label.startsWith(o) || o === label);

  const steps = [];
  const step = (label, fn) => steps.push({ label, fn });

  // 1) 空白状态（没有会话）
  step('01-empty', () => shoot({ label: '01-empty', dataDir: makeBlankDir(), delay: 1400 }));

  // 2) 有内容的会话
  step('02-conversation', () => shoot({ label: '02-conversation', dataDir: freshDir(), delay: 1800 }));

  // 3) 审批卡片：直接调渲染进程的调试把手把卡片画出来。
  //    脚本必须写成单行：带换行的命令行参数在 Windows 上传给 Electron 时会被截断。
  step('03-approval', () =>
    shoot({ label: '03-approval', dataDir: freshDir(),
      script:
        "window.__wuyun.showApproval({reqId:'demo-req-1',toolCallId:'demo-call-1',name:'run_command'," +
        "args:{command:'rm -rf build && npm run build'}," +
        "title:'rm -rf build && npm run build'," +
        "reasons:['递归或强制删除（rm -rf）']}); 'approval='+document.querySelectorAll('.approval').length",
      delay: 1700,
    })
  );

  // 4) 设置弹窗（自定义接口）
  step('04-settings', () =>
    shoot({ label: '04-settings', dataDir: freshDir(),
      script: "window.__wuyun.openSettings(); " +
        "'mode='+(window.__wuyun.S.config||{}).mode+' modal='+document.querySelector('.modal-root').className",
      delay: 1700,
    })
  );

  // 5) 把一张工具卡片展开，展示终端输出
  step('05-terminal', () =>
    shoot({ label: '05-terminal', dataDir: freshDir(),
      script:
        "var c=[...document.querySelectorAll('.tool')].find(function(n){return n.textContent.indexOf('run_command')>=0});" +
        "if(c){c.querySelector('.tool-head').click()} 'expanded='+document.querySelectorAll('.tool-body:not([hidden])').length",
      delay: 1700,
    })
  );

  // 6) 登录页（社区模式 + 未登录）
  step('06-login', () => shoot({ label: '06-login', dataDir: makeBlankDir({ mode: 'community' }), delay: 1600 }));

  // 7) 额度弹窗 + 顶部额度条（社区模式 + 已登录）
  step('07-quota', () =>
    shoot({ label: '07-quota', dataDir: freshDir({ mode: 'community', loggedIn: true }),
      script: "window.__wuyun.openAccount(); " +
        "'modal='+document.querySelector('.modal-root').className+' quota='+!!(window.__wuyun.A.state||{}).quota",
      delay: 1700,
    })
  );

  // 8) 社区模式下的设置页（只有模型下拉，没有 base_url / API Key 可填）
  step('08-settings-community', () =>
    shoot({ label: '08-settings-community', dataDir: freshDir({ mode: 'community', loggedIn: true }),
      script: "window.__wuyun.openSettings(); " +
        "'mode='+(window.__wuyun.S.config||{}).mode+' modal='+document.querySelector('.modal-root').className",
      delay: 1700,
    })
  );

  for (const s of steps) {
    if (want(s.label)) await s.fn();
  }

  console.log('');
})();
