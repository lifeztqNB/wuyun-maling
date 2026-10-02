'use strict';

/**
 * main.js —— Electron 主进程
 *
 * 职责三件事：
 *   1. 开窗口（无边框标题栏 + 系统按钮叠加，做出 Codex 那种「一整块深色」的样子）
 *   2. 提供 IPC：配置、会话、模型测试、系统对话框
 *   3. 跑 Agent 循环，把过程事件实时推给渲染进程
 *
 * 所有「危险动作」都发生在这一侧，渲染进程只有一只很细的管子通过来（见 preload.js）。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const { Store, PROVIDER_PRESETS, DEFAULT_GATEWAY, deviceLabel } = require('./src/store');
const safety = require('./src/safety');
const { runAgent, buildSystemPrompt } = require('./src/agent');
const { listModels } = require('./src/llm');
const community = require('./src/community');

const IS_DEV = process.argv.includes('--dev');

/**
 * 产品名是「雾韵码灵」，但**数据目录刻意用 ASCII**（%APPDATA%\WuyunMaLing）。
 * 理由：配置目录一旦带中文，各种备份脚本、同步工具、命令行排查都容易踩编码坑，
 * 而且用户真要找它的时候，README 里写了路径也够用。展示名和落盘名分开是常规做法。
 */
app.setName('WuyunMaLing');
const APP_DISPLAY_NAME = '雾韵码灵';

/**
 * 命令行开关（都是可选的）：
 *   --data-dir=<dir>    把配置与会话放到指定目录（便携模式 / 自动化测试用）
 *   --shot=<png>        启动后截一张图存到该路径然后退出（开发验收用）
 *   --shot-script=<js>  截图前在渲染进程里跑一段 JS，用来摆出想要的状态
 *   --shot-delay=<ms>   截图前多等一会儿，默认 1500
 */
function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const DATA_DIR = argValue('data-dir');
if (DATA_DIR) {
  // 必须在 app ready 之前设置，否则不生效
  app.setPath('userData', path.resolve(DATA_DIR));
}

const SHOT_PATH = argValue('shot');
const SHOT_SCRIPT = argValue('shot-script');
const SHOT_DELAY = Number.parseInt(argValue('shot-delay') || '1500', 10);
const SHOT_SIZE = argValue('shot-size');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Store} */
let store = null;

/** 会话运行期状态：id -> { id, title, createdAt, updatedAt, workspace, messages, items } */
const runtime = new Map();
/** 当前正在跑的任务 */
let currentRun = null;
/** 等待用户点「允许 / 拒绝」的确认框：reqId -> resolve */
const pendingApprovals = new Map();

let itemSeq = 0;
const nextItemId = () => `i${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

/* ============================================================
 * 窗口
 * ============================================================ */

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');

function loadWindowState() {
  const fallback = { width: 1280, height: 840 };
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch {
    /* 首次启动没有这个文件 */
  }
  return fallback;
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const maximized = win.isMaximized();
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify({ ...b, maximized }), 'utf8');
  } catch {
    /* 忽略 */
  }
}

/** 自动化截图：摆状态 → 截一张 → 退出。只在带 --shot 时走这条路。 */
async function captureAndQuit(target) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 等字体和首屏渲染稳定，否则截出来可能是「还没排好版」的样子
    await wait(SHOT_DELAY);

    // 截图尺寸单独指定：这样即使显示器很小，也能拿到完整布局的画面
    if (SHOT_SIZE) {
      const [w, h] = SHOT_SIZE.split('x').map((n) => Number.parseInt(n, 10));
      if (w > 0 && h > 0) {
        win.setContentSize(w, h);
        await wait(700);
      }
    }

    if (SHOT_SCRIPT) {
      // 把脚本的返回值打出来。摆状态的脚本一旦没生效（比如调了个不存在的方法、
      // 或者某个元素没找到），截图只会安静地少一块东西，看不出是哪一步断了。
      const ret = await win.webContents.executeJavaScript(SHOT_SCRIPT, true);
      if (ret !== undefined && ret !== null) {
        console.log(`SHOT_SCRIPT_RESULT ${JSON.stringify(ret)}`);
      }
      await wait(900);
    }

    // ⚠️ 强制重绘一帧，这一步不能省。
    //
    // capturePage() 抓的是「最近一次已经合成好的帧」。脚本刚改完 DOM 时，
    // 那一帧往往还没生成 —— 于是截图里独独少了刚加的那块东西
    // （实测：额度弹窗明明已经 open，图里却没有），而且只在机器忙的时候偶发，
    // 单独重跑又好了，极难查。invalidate() 会把这一帧排上队。
    //
    // 别用 requestAnimationFrame 等帧：窗口一旦被系统判定为「被遮挡」，
    // rAF 回调就永远不会触发，进程会卡死在那里（截图不写、也不退出，
    // 只能靠外面的看门狗强杀）。
    win.webContents.invalidate();
    await wait(700);

    // 抓图前再报一次关键状态。
    // 这样「DOM 回退了」和「抓到的是旧帧」这两种完全不同的失败就能分开了 ——
    // 只看 PNG 是分不出来的（图里少一块，两种原因长得一模一样）。
    const state = await win.webContents.executeJavaScript(
      'JSON.stringify({' +
        "modal:(document.querySelector('.modal-root')||{className:''}).className," +
        "login:!document.getElementById('loginScreen').hidden," +
        "expanded:[].filter.call(document.querySelectorAll('.tool-body'),function(n){return !n.hidden}).length" +
        '})',
      true
    );
    console.log(`SHOT_STATE ${state}`);

    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workAreaSize;
    console.log(`SHOT_INFO display=${wa.width}x${wa.height} window=${JSON.stringify(win.getBounds())}`);

    const img = await win.webContents.capturePage();
    const out = path.resolve(target);
    fs.writeFileSync(out, img.toPNG());
    console.log(`SHOT_SAVED ${out} ${img.getSize().width}x${img.getSize().height}`);
  } catch (err) {
    console.error('SHOT_FAILED', err && err.message);
  } finally {
    // 先 destroy 掉窗口：它会立刻拆掉渲染进程，不留给 SIGKILL 之后的孤儿。
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* 窗口可能已经在关的路上了 */
    }

    // ⚠️ 这里**不能**用 process.exit()，也不能用 app.exit()。
    //
    // app.exit(0)：只要这一轮跑过 executeJavaScript，它就会启动一个走不完的关闭
    // 流程 —— 既不结束进程，还会把 Node 事件循环一起停掉，连「兜底再退一次」
    // 这种写法都不会触发。
    //
    // process.exit(0)：会走 C 的 exit() → atexit 链 → Chromium 的收尾流程，
    // 而那一套约有一半概率卡住（实测：exit 事件 27 秒都不触发，只能靠外部强杀，
    // 且与是哪一张截图无关，纯看运气）。卡住的是原生代码里的同步等待，
    // 进程内任何定时兜底都救不了 —— 只能从外面杀，或者干脆不走这条路。
    //
    // process.kill(自己, SIGKILL) 在 Windows 上就是 TerminateProcess：
    // 直接终止，不跑任何收尾，不会卡。
    //
    // 截图模式本来就是一次性任务，没有需要优雅收尾的状态（该写的东西在
    // 上面 capturePage 之后就写完了），硬终止是最合适的做法。
    try {
      process.kill(process.pid, 'SIGKILL');
    } catch {
      process.exit(0);
    }
  }
}

function createWindow() {
  const st = loadWindowState();
  const dark = true; // 界面本身就是深色，标题栏跟着走

  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    title: APP_DISPLAY_NAME,
    // 任务栏 / 窗口图标。
    // 打包后不传：build/ 是构建资源目录，不会进 app.asar，路径必然失效；
    // 而且 exe 本身已经带了图标，Windows 会直接用它。
    icon: app.isPackaged ? undefined : path.join(__dirname, 'build', 'icon.ico'),
    // 无边框 + 系统按钮叠加：既有 Codex 那种一体化深色观感，又保留 Windows 原生按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b0c',
      symbolColor: '#9a9aa2',
      height: 40,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 截图模式下必须关掉后台节流。
      //
      // 窗口一旦被系统判定成「被遮挡」，Chromium 就会把页面当作不可见、停止出帧。
      // 后果有两个，都很隐蔽：capturePage() 只会返回一张旧图（脚本刚摆好的状态
      // 不出现在图里），而 requestAnimationFrame 回调永远不会触发 —— 拿 rAF 等帧
      // 会把进程直接卡死。实测截图窗口比屏幕大（1440x900 对 1366x728），
      // 被判定遮挡的概率相当高，而且时好时坏。
      //
      // 正常使用时保持默认：窗口最小化后不该继续烧 CPU。
      backgroundThrottling: !SHOT_PATH,
    },
  });

  if (st.maximized) win.maximize();

  win.once('ready-to-show', async () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
    if (SHOT_PATH) await captureAndQuit(SHOT_PATH);
  });

  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('close', saveWindowState);

  // 站内链接一律交给系统浏览器，不要在应用窗口里打开网页
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ============================================================
 * 事件下发
 * ============================================================ */

function emit(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
}

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
}

/* ============================================================
 * 会话
 * ============================================================ */

function makeTitle(text) {
  const firstLine = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '新任务';
  const clean = firstLine.trim().replace(/\s+/g, ' ');
  return clean.length > 28 ? `${clean.slice(0, 28)}…` : clean;
}

function ensureSession(id) {
  if (runtime.has(id)) return runtime.get(id);
  const rec = store.getSession(id);
  if (!rec) return null;
  const s = {
    id: rec.id,
    title: rec.title,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    workspace: rec.workspace,
    messages: Array.isArray(rec.messages) ? rec.messages : [],
    items: Array.isArray(rec.items) ? rec.items : [],
  };
  runtime.set(id, s);
  return s;
}

function persist(session) {
  store.upsertSession(session);
}

function newSession({ workspace }) {
  const config = store.getConfig();
  const ws = safety.normalizeRoot(workspace || config.workspace);
  const s = {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: '新任务',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspace: ws,
    messages: [],
    items: [],
  };
  runtime.set(s.id, s);
  persist(s);
  return s;
}

/* ============================================================
 * Agent 运行
 * ============================================================ */

function buildApprovalRequester(sessionId) {
  return (req) =>
    new Promise((resolve) => {
      const reqId = nextItemId();
      pendingApprovals.set(reqId, { resolve, sessionId, key: req.key });
      emit({
        type: 'approval',
        sessionId,
        reqId,
        toolCallId: req.id,
        name: req.name,
        args: req.args,
        title: req.title,
        reasons: req.reasons,
      });
      // 用户直接关掉窗口时不至于永远挂着
      const timer = setTimeout(() => {
        if (pendingApprovals.has(reqId)) {
          pendingApprovals.delete(reqId);
          resolve(false);
        }
      }, 5 * 60 * 1000);
      timer.unref?.();
    });
}

/**
 * 把「界面上的配置」折算成「真正要连的那个端点」。
 *
 * 两种模式的差别只集中在 baseUrl / apiKey / model 这三个字段，
 * 其余（温度、步数、权限模式、shell……）完全共用。在这里一次性折算好，
 * Agent 与 llm 那两层就完全不需要知道「模式」这个概念存在。
 *
 * community：用社区登录会话 token 当 API Key 直连社区网关，消耗每月额度。
 * custom   ：用户自己填接口地址与 Key，走自己的账单。
 */
function resolveConnection(config) {
  if (config.mode === 'community') {
    const c = config.community || {};
    // 只有「确实是社区下发的模型名」才认。
    //
    // 不能直接拿 config.model 用：它是两种模式共用的一个字段，用户以前在
    // 自定义模式下填过 deepseek-chat，登录社区后这个值还在，直接透传过去
    // 会被网关判成「模型不存在」——而用户看到的只是一个莫名其妙的报错。
    const known = (c.models || []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
    const picked = config.model && known.includes(config.model) ? config.model : '';
    return {
      baseUrl: c.gatewayBaseUrl || DEFAULT_GATEWAY,
      apiKey: c.token || '',
      model: picked || c.defaultModel || '',
      channel: 'community',
      ready: !!c.token,
    };
  }
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    channel: 'custom',
    ready: !!(config.baseUrl && config.model),
  };
}

/** 没配好时给用户的提示。两种模式该说的话不一样，硬凑一句会让人摸不着头脑。 */
function notReadyNotice(config) {
  if (config.mode === 'community') {
    return '还没有登录社区账号。点左下角的「设置」登录，或者改成「跳过登录」自己填接口。';
  }
  return '还没有配置模型。点左下角的「设置」，填好接口地址和模型名再开始。';
}

async function runSession(session, { userText } = {}) {
  if (currentRun) throw new Error('上一个任务还在执行，请先点停止。');

  const config = store.getConfig();
  const conn = resolveConnection(config);
  const workspace = safety.normalizeRoot(session.workspace || config.workspace);

  if (!conn.ready) {
    const item = {
      id: nextItemId(),
      type: 'notice',
      level: 'warn',
      text: notReadyNotice(config),
      at: Date.now(),
    };
    session.items.push(item);
    persist(session);
    emit({ type: 'item_added', sessionId: session.id, item });
    return { ok: false, reason: 'NO_CONFIG' };
  }

  // 交给 Agent 的是一份「折算好」的配置，它只认 baseUrl/apiKey/model
  const effectiveConfig = {
    ...config,
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    model: conn.model,
  };

  if (userText) {
    const userItem = { id: nextItemId(), type: 'user', text: userText, at: Date.now() };
    session.items.push(userItem);
    session.messages.push({ role: 'user', content: userText });
    const userCount = session.items.filter((i) => i.type === 'user').length;
    if (userCount === 1) session.title = makeTitle(userText);
    emit({ type: 'item_added', sessionId: session.id, item: userItem });
    emit({ type: 'session_meta', sessionId: session.id, title: session.title });
  }

  // 系统提示词每次重建：工作区、权限模式、shell 都可能刚被改过
  const systemPrompt = buildSystemPrompt({
    workspace,
    shell: config.shell,
    approvalMode: config.approvalMode,
  });
  if (session.messages[0]?.role === 'system') session.messages[0] = { role: 'system', content: systemPrompt };
  else session.messages.unshift({ role: 'system', content: systemPrompt });

  const controller = new AbortController();
  const sessionAllowlist = new Set();
  currentRun = { sessionId: session.id, controller, allowlist: sessionAllowlist };
  emit({ type: 'run_start', sessionId: session.id, workspace });

  /** 当前正在累积的 assistant 气泡 */
  let bubble = null;
  const openBubble = () => {
    if (bubble) return bubble;
    bubble = { id: nextItemId(), type: 'assistant', text: '', reasoning: '', at: Date.now() };
    session.items.push(bubble);
    emit({ type: 'item_added', sessionId: session.id, item: bubble });
    return bubble;
  };

  const onEvent = (ev) => {
    switch (ev.type) {
      case 'step_start':
        emit({ type: 'step_start', sessionId: session.id, step: ev.step, maxSteps: ev.maxSteps });
        break;

      case 'assistant_delta': {
        const b = openBubble();
        b.text += ev.delta;
        emit({ type: 'item_delta', sessionId: session.id, id: b.id, field: 'text', delta: ev.delta });
        break;
      }

      case 'reasoning_delta': {
        const b = openBubble();
        b.reasoning += ev.delta;
        emit({ type: 'item_delta', sessionId: session.id, id: b.id, field: 'reasoning', delta: ev.delta });
        break;
      }

      case 'assistant_message': {
        // 模型可能整段一次性给出（非流式），这时上面的 delta 事件不会触发
        const content = ev.message?.content || '';
        const reasoning = ev.message?.reasoning_content || '';
        if (content && !bubble) {
          const b = openBubble();
          b.text = content;
          emit({ type: 'item_delta', sessionId: session.id, id: b.id, field: 'text', delta: content });
        } else if (bubble && content && !bubble.text) {
          bubble.text = content;
          emit({ type: 'item_delta', sessionId: session.id, id: bubble.id, field: 'text', delta: content });
        }
        if (reasoning && bubble && !bubble.reasoning) {
          bubble.reasoning = reasoning;
          emit({ type: 'item_delta', sessionId: session.id, id: bubble.id, field: 'reasoning', delta: reasoning });
        }
        break;
      }

      case 'tool_start': {
        const item = {
          id: nextItemId(),
          type: 'tool',
          toolCallId: ev.id,
          name: ev.name,
          args: ev.args,
          rawArgs: ev.rawArgs,
          status: 'running',
          content: '',
          meta: null,
          at: Date.now(),
        };
        session.items.push(item);
        emit({ type: 'item_added', sessionId: session.id, item });
        break;
      }

      case 'tool_end': {
        const item = [...session.items].reverse().find((i) => i.type === 'tool' && i.toolCallId === ev.id);
        if (item) {
          item.status = ev.denied ? 'denied' : ev.ok ? 'ok' : 'error';
          item.content = ev.content;
          item.meta = ev.meta || null;
          item.durationMs = ev.durationMs;
          emit({ type: 'item_updated', sessionId: session.id, item });
        }
        break;
      }

      case 'compacted': {
        const item = {
          id: nextItemId(),
          type: 'notice',
          level: 'info',
          text: `上下文过长，已丢弃最早的 ${ev.dropped} 轮对话以腾出空间。`,
          at: Date.now(),
        };
        session.items.push(item);
        emit({ type: 'item_added', sessionId: session.id, item });
        break;
      }

      case 'usage':
        emit({ type: 'usage', sessionId: session.id, usage: ev.usage });
        break;

      case 'error': {
        const item = { id: nextItemId(), type: 'notice', level: 'error', text: ev.message, at: Date.now() };
        session.items.push(item);
        emit({ type: 'item_added', sessionId: session.id, item });
        break;
      }

      case 'aborted': {
        const item = { id: nextItemId(), type: 'notice', level: 'info', text: '已停止。', at: Date.now() };
        session.items.push(item);
        emit({ type: 'item_added', sessionId: session.id, item });
        break;
      }

      case 'done':
      case 'step_end':
      default:
        break;
    }
  };

  let result;
  try {
    result = await runAgent({
      messages: session.messages,
      config: effectiveConfig,
      workspace,
      approvalMode: config.approvalMode,
      sessionAllowlist,
      onEvent,
      requestApproval: buildApprovalRequester(session.id),
      signal: controller.signal,
    });
  } catch (err) {
    const item = {
      id: nextItemId(),
      type: 'notice',
      level: 'error',
      text: `运行出错：${err?.message || String(err)}`,
      at: Date.now(),
    };
    session.items.push(item);
    emit({ type: 'item_added', sessionId: session.id, item });
    result = { error: err };
  } finally {
    currentRun = null;
    session.updatedAt = Date.now();
    persist(session);
    emit({ type: 'run_end', sessionId: session.id, steps: result?.steps ?? 0, usage: result?.usage ?? null });
    // 兜底同步一次，防止渲染侧因为丢事件而和真实状态不一致
    emit({ type: 'sync', sessionId: session.id, items: session.items });
  }

  return { ok: !result?.error, steps: result?.steps ?? 0 };
}

/* ============================================================
 * IPC
 * ============================================================ */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    productName: APP_DISPLAY_NAME,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    userData: app.getPath('userData'),
    defaultShell: require('./src/tools').defaultShell(),
    presets: PROVIDER_PRESETS,
    modes: safety.MODES,
    modeLabels: safety.MODE_LABELS,
  }));

  ipcMain.handle('presets:get', () => PROVIDER_PRESETS);

  ipcMain.handle('config:get', () => store.getConfig());
  ipcMain.handle('config:save', (_e, patch) => store.saveConfig(patch || {}));

  /* ---------- 社区账号 ---------- */

  /**
   * 账号状态。渲染进程启动时拉一次决定显示登录页还是主界面。
   *
   * 只回「够用」的字段：token 本身不回给渲染进程 —— 渲染进程没有任何理由
   * 拿到它，一旦界面被 XSS 注入就等于把登录态送出去。要发请求让主进程发。
   */
  ipcMain.handle('auth:state', () => {
    const config = store.getConfig();
    const c = config.community;
    return {
      mode: config.mode,
      loggedIn: !!c.token,
      user: c.token
        ? { username: c.username, nickname: c.nickname, avatarUrl: c.avatarUrl }
        : null,
      quota: c.quota,
      quotaFetchedAt: c.quotaFetchedAt,
      gatewayBaseUrl: c.gatewayBaseUrl,
      models: c.models,
      defaultModel: c.defaultModel,
      // 自定义模式下的配置情况，界面用它决定「跳过登录」后要不要提示去填
      customReady: !!(config.baseUrl && config.model),
    };
  });

  ipcMain.handle('auth:login', async (_e, payload) => {
    const { account, password } = payload || {};
    const acc = String(account || '').trim();
    const pwd = String(password || '');
    if (!acc) return { ok: false, message: '请填写账号' };
    if (!pwd) return { ok: false, message: '请填写密码' };

    const config = store.getConfig();
    try {
      const res = await community.login({
        account: acc,
        password: pwd,
        deviceId: config.deviceId,
        deviceName: deviceLabel(),
        version: app.getVersion(),
        siteBaseUrl: config.community.siteBaseUrl,
      });

      store.saveCommunity({
        token: res.token,
        username: (res.user && res.user.username) || acc,
        nickname: (res.user && res.user.nickname) || acc,
        avatarUrl: (res.user && res.user.avatarUrl) || '',
        gatewayBaseUrl: res.gateway.baseUrl,
        models: res.gateway.models,
        defaultModel: res.gateway.defaultModel,
        quota: res.quota,
        quotaFetchedAt: Date.now(),
      });

      // config.model 是两种模式共用的一个字段。以前在自定义模式下填过
      // deepseek-chat 之类名字的话，登录社区后它会留着，然后设置页里就显示成
      // 「社区不认这个名字」——虽然不会真的出错（resolveConnection 会兜底），
      // 但让人一上来就看见一个报错一样的选项，体验很糟。这里直接清掉，
      // 让它跟随社区下发的默认模型。
      const known = (res.gateway.models || []).map((m) => (typeof m === 'string' ? m : m && m.id));
      const patch = { mode: 'community' };
      if (config.model && !known.includes(config.model)) patch.model = '';

      // 登录后自动切到社区模式：用户点了「登录」就是想用社区通道
      store.saveConfig(patch);
      return { ok: true, state: store.getCommunity(), user: res.user };
    } catch (err) {
      return { ok: false, message: err?.message || '登录失败' };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    const config = store.getConfig();
    await community.logout({
      token: config.community.token,
      siteBaseUrl: config.community.siteBaseUrl,
    });
    store.clearCommunityAuth();
    return { ok: true };
  });

  /** 刷新额度。界面在每次任务结束后、以及点额度条时调用。 */
  ipcMain.handle('auth:quota', async () => {
    const config = store.getConfig();
    const c = config.community;
    if (!c.token) return { ok: false, message: '未登录' };
    try {
      const res = await community.fetchQuota({
        token: c.token,
        siteBaseUrl: c.siteBaseUrl,
        deviceId: config.deviceId,
      });
      store.saveCommunity({
        username: (res.user && res.user.username) || c.username,
        nickname: (res.user && res.user.nickname) || c.nickname,
        avatarUrl: (res.user && res.user.avatarUrl) || c.avatarUrl,
        gatewayBaseUrl: res.gateway.baseUrl,
        models: res.gateway.models,
        defaultModel: res.gateway.defaultModel,
        quota: res.quota,
        quotaFetchedAt: Date.now(),
      });
      return { ok: true, quota: res.quota };
    } catch (err) {
      const message = err?.message || '刷新失败';
      // 会话被服务端清掉（退出登录/被停用/过期）时，本地也要跟着登出，
      // 否则界面会一直显示「已登录」但所有请求都 401，用户完全看不懂。
      if (err?.status === 401) {
        store.clearCommunityAuth();
        return { ok: false, message, loggedOut: true };
      }
      return { ok: false, message };
    }
  });

  /** 社区模式下可用模型的列表（给设置里的下拉框） */
  ipcMain.handle('auth:models', () => {
    const c = store.getCommunity();
    return { models: c.models || [], defaultModel: c.defaultModel || '', gatewayBaseUrl: c.gatewayBaseUrl };
  });

  ipcMain.handle('sessions:list', () => store.listSessions());

  ipcMain.handle('sessions:get', (_e, id) => {
    const s = ensureSession(id);
    if (!s) return null;
    return { id: s.id, title: s.title, workspace: s.workspace, items: s.items, createdAt: s.createdAt };
  });

  ipcMain.handle('sessions:create', (_e, payload) => {
    const s = newSession(payload || {});
    return { id: s.id, title: s.title, workspace: s.workspace, items: s.items, createdAt: s.createdAt };
  });

  ipcMain.handle('sessions:delete', (_e, id) => {
    runtime.delete(id);
    return store.deleteSession(id);
  });

  ipcMain.handle('sessions:clear', () => {
    runtime.clear();
    store.clearSessions();
    return true;
  });

  ipcMain.handle('agent:send', async (_e, payload) => {
    const { sessionId, text } = payload || {};
    if (!String(text || '').trim()) return { ok: false, reason: 'EMPTY' };
    const session = ensureSession(sessionId);
    if (!session) return { ok: false, reason: 'NO_SESSION' };
    return runSession(session, { userText: String(text) });
  });

  ipcMain.handle('agent:retry', async (_e, payload) => {
    const { sessionId } = payload || {};
    const session = ensureSession(sessionId);
    if (!session) return { ok: false, reason: 'NO_SESSION' };

    // 从后往前删，直到删掉最后一条 user 消息为止，保证 messages 与 items 一致
    while (session.items.length && session.items[session.items.length - 1].type !== 'user') session.items.pop();
    while (session.messages.length && session.messages[session.messages.length - 1].role !== 'user') session.messages.pop();
    if (!session.items.length || !session.messages.length) return { ok: false, reason: 'NOTHING_TO_RETRY' };

    emit({ type: 'sync', sessionId: session.id, items: session.items });
    return runSession(session, {});
  });

  ipcMain.handle('agent:stop', () => {
    if (!currentRun) return false;
    currentRun.controller.abort();
    return true;
  });

  ipcMain.handle('agent:running', () => (currentRun ? { sessionId: currentRun.sessionId } : null));

  ipcMain.handle('approval:respond', (_e, payload) => {
    const { reqId, approved, remember } = payload || {};
    const pending = pendingApprovals.get(reqId);
    if (!pending) return false;
    pendingApprovals.delete(reqId);
    if (remember && approved) {
      // 记住这次放行：同一条命令 / 同一个删除目标，本会话内不再问
      const key = pending.key;
      if (key && currentRun && currentRun.allowlist) currentRun.allowlist.add(key);
    }
    pending.resolve(!!approved);
    return true;
  });

  ipcMain.handle('models:list', async (_e, payload) => {
    const cfg = store.getConfig();
    const baseUrl = payload?.baseUrl ?? cfg.baseUrl;
    const apiKey = payload?.apiKey ?? cfg.apiKey;
    if (!baseUrl) throw new Error('请先填写接口地址（base_url）');
    const models = await listModels({ baseUrl, apiKey, extraHeaders: cfg.extraHeaders });
    return models;
  });

  ipcMain.handle('dialog:pickWorkspace', async () => {
    const cfg = store.getConfig();
    const res = await dialog.showOpenDialog(win, {
      title: '选择工作区目录',
      defaultPath: cfg.workspace || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选这个目录',
    });
    if (res.canceled || !res.filePaths?.length) return null;
    return safety.normalizeRoot(res.filePaths[0]);
  });

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (!p) return false;
    try {
      shell.showItemInFolder(p);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('shell:openPath', async (_e, p) => {
    if (!p) return false;
    const err = await shell.openPath(p);
    return err || true;
  });
}

/* ============================================================
 * 菜单
 * ============================================================ */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新任务', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-task') },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '聚焦输入框', accelerator: 'CmdOrCtrl+L', click: () => sendMenu('focus-input') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ============================================================
 * 生命周期
 * ============================================================ */

// 只允许开一个实例：第二个实例启动时把已有窗口顶到前面
//
// 截图模式（--shot）例外，不参与互斥。原因：单实例锁是按 userData 路径加的，
// 而截图模式是用 process.exit(0) 硬退的（见 captureAndQuit 的说明），硬退会跳过
// Electron 的正常收尾、留下陈旧锁；下一次拿同一个 --data-dir 启动就会撞上它，
// 进程从此卡死退不掉（表现：截图存好了，脚本却一直等）。
// 截图本来就是一次性进程，没有「第二个实例顶窗口」的需求，直接跳过最省事。
const gotLock = SHOT_PATH ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    store = new Store(app.getPath('userData'));
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
