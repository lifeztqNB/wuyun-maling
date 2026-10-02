'use strict';

/**
 * app.js —— 渲染进程
 *
 * 它自己不做任何「危险的事」：不读文件、不跑命令，只负责画界面 + 调 preload 暴露的那几个方法。
 * 会话的真实状态在主进程里，这里维护一份用于显示的副本，靠事件流增量更新；
 * 每轮跑完主进程会推一次全量 sync，用来纠正任何漏事件造成的偏差。
 */

const api = window.wuyun;
const MD = window.WuyunMD;

/* ============================================================
 * 状态
 * ============================================================ */

const S = {
  info: null,
  config: null,
  sessions: [],
  session: null, // { id, title, workspace, items: [] }
  running: false,
  filter: '',
  els: new Map(), // item.id -> DOM 元素
  usage: null,
  pendingApprovals: new Map(), // reqId -> element
  autoScroll: true,
};

/**
 * 账号状态。刻意和 S 分开放：S 是「会话 / 界面」状态，A 是「登录与额度」状态，
 * 两者生命周期不同（账号活在会话之上），混在一起以后想单独重置一个都做不到。
 */
const A = {
  state: null, // auth:state 的结果：{mode, loggedIn, user, quota, models, defaultModel, customReady}
  quotaTimer: null,
};

const $ = (id) => document.getElementById(id);

/**
 * 绑事件前先确认元素存在。
 *
 * 血泪教训：之前 `$('chipWorkspace').addEventListener(...)` 引用了一个 HTML 里
 * 根本不存在的 id，一个 null 就让整个界面启动即白屏 —— 而且报错信息只指向
 * 「读不到 addEventListener 的 null」，很难一眼看出是哪个元素。
 * 现在少写一个元素只会打一条警告，界面照常能用。
 */
function on(id, event, handler) {
  const node = $(id);
  if (!node) {
    console.warn(`[雾韵码灵] 界面上没有 #${id}，已跳过 ${event} 的绑定`);
    return null;
  }
  node.addEventListener(event, handler);
  return node;
}

/* ============================================================
 * 小工具
 * ============================================================ */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(msg, bad) {
  const t = el('div', `toast${bad ? ' bad' : ''}`, msg);
  $('toastRoot').appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  }, 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // file:// 下 clipboard API 偶尔不可用，退回老办法
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function dayGroup(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return '今天';
  if (ts >= startOfToday - 86400000) return '昨天';
  if (ts >= startOfToday - 86400000 * 7) return '最近七天';
  return '更早';
}

function shortPath(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/** 社区 logo（界面里只有这一处图片来源，换 logo 只需要换 renderer/logo*.png） */
function logoImg(cls, big) {
  const img = document.createElement('img');
  // 注意要判空：img.className = null 会把 class 属性写成字符串 "null"
  if (cls) img.className = cls;
  img.src = big ? 'logo.png' : 'logo-sm.png';
  img.alt = '';
  img.draggable = false;
  return img;
}

/* ============================================================
 * 社区账号与额度
 * ============================================================ */

async function refreshAuth() {
  A.state = await api.authState();
  return A.state;
}

/** 只有「社区模式 + 没登录」才需要先登录。跳过登录的人不该再被拦。 */
function needsLogin() {
  const st = A.state || {};
  return st.mode === 'community' && !st.loggedIn;
}

/**
 * 当前通道能不能干活。
 *
 * 注意不能再看 config.baseUrl —— 社区模式下 baseUrl 本来就是空的
 * （地址由服务端下发），拿它判断会得出「没配置」的错误结论。
 */
function connectionReady() {
  const cfg = S.config || {};
  if (cfg.mode === 'community') return !!(A.state && A.state.loggedIn);
  return !!(cfg.baseUrl && cfg.model);
}

function notReadyHint() {
  const cfg = S.config || {};
  return cfg.mode === 'community'
    ? '还没有登录社区账号，点左下角的账号卡片登录'
    : '还没有配置接口，先填好接口地址和模型名';
}

function firstChar(s) {
  const t = String(s || '').trim();
  return t ? t.slice(0, 1).toUpperCase() : '灵';
}

/** 侧栏账号卡片 + 顶部额度条，两处都靠这个函数刷新 */
function renderAuthChrome() {
  const st = A.state || {};
  const user = st.user || {};
  const name = user.nickname || user.username || '';
  const loggedIn = !!st.loggedIn;

  $('acctAva').textContent = loggedIn ? firstChar(name) : '灵';
  $('acctName').textContent = loggedIn ? name : '未登录';
  $('acctSub').textContent = loggedIn
    ? `社区账号 · ${quotaShort()}`
    : st.mode === 'custom'
      ? '自定义接口 · 点击管理'
      : '点击登录社区账号';

  renderQuota();
}

function quotaShort() {
  const q = (A.state || {}).quota;
  if (!q) return '额度待同步';
  if (q.exhausted) return '额度已用完';
  return `额度剩余 ${q.percent}%`;
}

/**
 * 顶部额度条。
 *
 * 显示的是【剩余】百分比，和 Codex 一致 —— 「还剩 12%」比「已用 88%」
 * 更能让人一眼判断「今天还能不能放开用」。
 * 剩余量低是坏事，所以颜色是 绿 → 黄 → 红。
 */
function renderQuota() {
  const pill = $('pillQuota');
  if (!pill) return;

  const st = A.state || {};
  const q = st.quota;
  // 自定义接口走用户自己的账单，显示社区额度只会让人以为「我还能白嫖」
  if (st.mode !== 'community' || !st.loggedIn || !q) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;

  const pct = Math.max(0, Math.min(100, Number(q.percent) || 0));
  const level = pct <= 10 ? 'bad' : pct <= 30 ? 'warn' : '';

  $('quotaPct').textContent = `${pct}%`;
  const fill = $('quotaFill');
  fill.style.width = `${pct}%`;
  fill.className = level;
  pill.classList.toggle('empty', pct <= 0);
  pill.title = `本月额度剩余 ${pct}%（${q.remainingText} / ${q.allowanceText}）\n${q.resetsAtLocal} 重置\n点击查看详情`;
}

/** 拉一次最新额度。silent=false 时会把失败原因弹出来（用户手动点刷新时用）。 */
async function refreshQuota({ silent = true } = {}) {
  const st = A.state || {};
  if (st.mode !== 'community' || !st.loggedIn) return;

  const res = await api.authQuota();
  if (!res.ok) {
    if (res.loggedOut) {
      // 服务端已经不认这个会话了（过期 / 被停用 / 在别处退出登录）。
      // 本地必须跟着登出，否则界面一直显示「已登录」但每个请求都失败，
      // 用户完全看不懂发生了什么。
      await refreshAuth();
      renderAuthChrome();
      renderHeader();
      showLogin();
      toast('登录状态已失效，请重新登录', true);
    } else if (!silent) {
      toast(`额度刷新失败：${res.message}`, true);
    }
    return;
  }
  await refreshAuth();
  renderAuthChrome();
  renderHeader();
}

/** 每 5 分钟对一次额度：同一账号可能在网页端、另一台电脑上也在用，额度会被别人扣掉。 */
const QUOTA_REFRESH_MS = 5 * 60 * 1000;

function startQuotaTimer() {
  if (A.quotaTimer) clearInterval(A.quotaTimer);
  A.quotaTimer = setInterval(() => {
    if (S.running) return; // 正在跑任务时不打扰
    refreshQuota().catch(() => {});
  }, QUOTA_REFRESH_MS);
}

/* ---------- 登录页 ---------- */

function showLogin() {
  $('loginErr').hidden = true;
  // 工作区切换按钮对还没登录的人没有意义（那时候也没有工作区可用），
  // 留在标题栏上只会让人以为「这里是不是该点一下」
  $('btnWorkspaceTop').hidden = true;
  $('loginScreen').hidden = false;
  $('loginPassword').value = '';
  setTimeout(() => $('loginAccount').focus(), 80);
}

function hideLogin() {
  $('loginScreen').hidden = true;
  $('btnWorkspaceTop').hidden = false;
}

function loginError(msg) {
  const box = $('loginErr');
  box.textContent = msg;
  box.hidden = false;
}

async function doLogin() {
  const account = $('loginAccount').value.trim();
  const password = $('loginPassword').value;
  if (!account) return loginError('请填写社区账号');
  if (!password) return loginError('请填写密码');

  const btn = $('btnLogin');
  btn.disabled = true;
  btn.textContent = '正在登录…';
  $('loginErr').hidden = true;

  try {
    const res = await api.authLogin({ account, password });
    if (!res.ok) {
      loginError(res.message || '登录失败');
      return;
    }
    $('loginPassword').value = '';
    await afterAuthChange();
    const who = A.state?.user?.nickname || A.state?.user?.username || '社区账号';
    toast(`已登录：${who} · ${quotaShort()}`);
  } catch (err) {
    loginError(err?.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

/** 跳过登录：切到自定义接口，直接进主界面，把设置打开让人填地址 */
async function doSkip() {
  S.config = await api.saveConfig({ mode: 'custom' });
  hideLogin();
  await afterAuthChange();
  toast('已跳过登录，请填写你自己的接口地址');
  openSettings();
}

/** 登录态变了（登录 / 退出 / 跳过）之后统一收尾 */
async function afterAuthChange() {
  S.config = await api.getConfig();
  await refreshAuth();
  renderAuthChrome();
  renderHeader();
  startQuotaTimer();
}

function bindLogin() {
  on('btnLogin', 'click', doLogin);
  on('btnSkip', 'click', doSkip);

  // Enter 直接登录（这个页面刻意没用 <form>，见 index.html 里的说明）
  for (const id of ['loginAccount', 'loginPassword']) {
    on(id, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        doLogin();
      }
    });
  }
  on('loginAccount', 'input', () => {
    $('loginErr').hidden = true;
  });
  on('loginPassword', 'input', () => {
    $('loginErr').hidden = true;
  });
}

/* ============================================================
 * 侧栏
 * ============================================================ */

function renderSessions() {
  const list = $('sessionList');
  list.textContent = '';

  const kw = S.filter.trim().toLowerCase();
  const items = S.sessions.filter((s) => !kw || (s.title || '').toLowerCase().includes(kw));

  if (!items.length) {
    list.appendChild(el('div', 'side-empty', kw ? '没有匹配的任务' : '还没有任务'));
    return;
  }

  let lastGroup = null;
  for (const s of items) {
    const g = dayGroup(s.updatedAt || s.createdAt || Date.now());
    if (g !== lastGroup) {
      lastGroup = g;
      list.appendChild(el('div', 'side-group', g));
    }

    const row = el('button', `side-item${S.session && S.session.id === s.id ? ' active' : ''}`);
    row.appendChild(el('span', 'side-item-title', s.title || '未命名任务'));
    row.appendChild(el('span', 'side-item-sub', `${fmtTime(s.updatedAt || s.createdAt)} · ${s.messageCount || 0} 条`));

    const del = el('span', 'side-item-del', '×');
    del.title = '删除这个任务';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.deleteSession(s.id);
      if (S.session && S.session.id === s.id) S.session = null;
      await refreshSessions();
      if (!S.session) await newTask(false);
      toast('已删除');
    });
    row.appendChild(del);

    row.addEventListener('click', () => openSession(s.id));
    list.appendChild(row);
  }
}

async function refreshSessions() {
  S.sessions = await api.listSessions();
  renderSessions();
}

/* ============================================================
 * 会话
 * ============================================================ */

async function openSession(id) {
  if (S.running) {
    toast('任务正在运行，先停止再切换', true);
    return;
  }
  const s = await api.getSession(id);
  if (!s) {
    toast('会话不存在', true);
    return;
  }
  S.session = s;
  S.usage = null;
  renderAll();
}

async function newTask(focus = true) {
  if (S.running) {
    toast('任务正在运行，先停止再新建', true);
    return;
  }
  const s = await api.createSession({ workspace: S.config?.workspace });
  S.session = s;
  S.usage = null;
  await refreshSessions();
  renderAll();
  if (focus) $('input').focus();
}

/* ============================================================
 * 渲染：整体
 * ============================================================ */

function renderAll() {
  renderSessions();
  renderHeader();
  renderTranscript();
}

function renderHeader() {
  const cfg = S.config || {};
  const st = A.state || {};
  $('taskTitle').textContent = S.session?.title || '新任务';

  // 社区模式下模型名由服务端下发（config.model 为空时用服务端默认），
  // 所以不能只看 config.model，否则登录后这里会一直显示「未配置模型」。
  const modelPill = $('pillModel');
  const modelName = cfg.model || (st.mode === 'community' ? st.defaultModel : '') || '';
  if (modelName) {
    modelPill.textContent = modelName;
    modelPill.classList.remove('warn');
  } else {
    modelPill.textContent = needsLogin() ? '未登录' : '未配置模型';
    modelPill.classList.add('warn');
  }

  const ws = S.session?.workspace || cfg.workspace || '';
  $('tbWorkspaceLabel').textContent = shortPath(ws);

  const mode = cfg.approvalMode || 'auto';
  $('chipMode').textContent = S.info?.modeLabels?.[mode] || mode;
  $('chipShell').textContent = cfg.shell === 'cmd' ? 'CMD' : cfg.shell === 'bash' ? 'Bash' : 'PowerShell';

  renderQuota();
  renderUsage();
}

function renderUsage() {
  const u = S.usage;
  $('pillUsage').textContent = u && u.total_tokens ? `${u.total_tokens.toLocaleString()} tokens` : '';
}

/**
 * 把主界面拉到「有一个可用的会话」的状态。
 *
 * 抽出来是因为有三条路都会走到这里：正常启动、登录成功、跳过登录。
 * 之前这段逻辑只在 boot 里，登录后想复用就得整页重载 —— 那样窗口会闪一下，
 * 而且正在看的会话会丢。
 */
async function ensureSession() {
  await refreshSessions();
  const running = await api.running();
  if (running?.sessionId) {
    await openSession(running.sessionId);
    setRunning(true);
    return;
  }
  if (S.sessions.length) await openSession(S.sessions[0].id);
  else await newTask(false);
}

/* ============================================================
 * 渲染：对话流
 * ============================================================ */

function renderTranscript() {
  const box = $('transcript');
  box.textContent = '';
  S.els.clear();

  const items = S.session?.items || [];
  if (!items.length) {
    box.appendChild(buildEmpty());
    return;
  }

  const stream = el('div', 'stream');
  for (const it of items) stream.appendChild(renderItem(it));
  box.appendChild(stream);
  scrollToEnd(true);
}

function buildEmpty() {
  const wrap = el('div', 'empty');
  const mark = el('div', 'empty-mark');
  mark.appendChild(logoImg(null, true));
  wrap.appendChild(mark);
  wrap.appendChild(el('h1', null, '让码灵帮你把事做完'));
  wrap.appendChild(
    el('p', null, '它会真实地读写工作区里的文件、执行命令，并把每一步都摊开给你看。')
  );

  const sugg = el('div', 'sugg');
  const examples = [
    ['看看这个项目', '把这个项目的目录结构梳理一遍，告诉我它是干什么的、入口在哪。'],
    ['跑一遍测试', '找出这个项目的测试命令并执行，把失败的用例和原因列出来。'],
    ['修一个 bug', '搜索代码里所有 TODO 注释，挑一个最容易修的改掉，并说明你改了什么。'],
    ['写点东西', '在当前目录新建一个 README.md，用中文介绍这个项目，写完读一遍确认。'],
  ];
  for (const [label, prompt] of examples) {
    const b = el('button', 'sugg-item');
    b.appendChild(el('b', null, `${label} — `));
    b.appendChild(document.createTextNode(prompt));
    b.addEventListener('click', () => {
      $('input').value = prompt;
      autoGrow();
      $('input').focus();
    });
    sugg.appendChild(b);
  }
  wrap.appendChild(sugg);
  return wrap;
}

/** 把一条 item 渲染成 DOM */
function renderItem(item) {
  let node;
  switch (item.type) {
    case 'user':
      node = el('div', 'msg-user', item.text);
      break;
    case 'assistant':
      node = renderAssistant(item);
      break;
    case 'tool':
      node = renderTool(item);
      break;
    case 'notice':
      node = renderNotice(item);
      break;
    default:
      node = el('div');
  }
  node.dataset.itemId = item.id;
  S.els.set(item.id, node);
  return node;
}

function renderAssistant(item) {
  const wrap = el('div', 'msg-assistant');

  if (item.reasoning) {
    const d = el('details', 'reasoning');
    d.appendChild(el('summary'));
    const body = el('div');
    body.textContent = item.reasoning;
    d.appendChild(body);
    wrap.appendChild(d);
  }

  const body = el('div', 'md');
  body.innerHTML = MD.render(item.text || '');
  wrap.appendChild(body);
  return wrap;
}

function renderNotice(item) {
  const n = el('div', `notice ${item.level || ''}`);
  const ico = item.level === 'error' ? '✕' : item.level === 'warn' ? '⚠' : '·';
  n.appendChild(el('span', 'n-ico', ico));
  n.appendChild(el('span', null, item.text));
  return n;
}

/* ---------- 工具卡片 ---------- */

function toolIcon(item) {
  if (item.status === 'running') return '◐';
  if (item.status === 'error') return '✕';
  if (item.status === 'denied') return '⊘';
  return '●';
}

function toolTarget(item) {
  const a = item.args || {};
  switch (item.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_path':
      return a.path || '';
    case 'list_dir':
      return a.path || '.';
    case 'search_files':
      return `${a.pattern || ''}${a.glob ? `  (${a.glob})` : ''}`;
    case 'run_command':
      return a.command || '';
    default:
      return '';
  }
}

function toolStat(item) {
  if (item.status === 'running') return '执行中…';
  if (item.status === 'denied') return '已拒绝';
  const s = item.meta && item.meta.stat;
  if (s) {
    const parts = [];
    if (s.add) parts.push(`<span class="add">+${s.add}</span>`);
    if (s.del) parts.push(`<span class="del">−${s.del}</span>`);
    if (parts.length) return parts.join(' ');
  }
  if (item.meta && item.meta.kind === 'command') {
    const c = item.meta.exitCode;
    return c === 0 ? `退出码 0` : `退出码 ${c ?? '—'}`;
  }
  if (typeof item.durationMs === 'number' && item.durationMs > 400) return `${item.durationMs} ms`;
  return '';
}

function renderTool(item) {
  const card = el('div', `tool ${item.status || ''}`);

  const head = el('button', 'tool-head');
  head.appendChild(el('span', 'tool-ico', toolIcon(item)));
  head.appendChild(el('span', 'tool-name', item.name));
  head.appendChild(el('span', 'tool-target', toolTarget(item)));
  const stat = el('span', 'tool-stat');
  stat.innerHTML = toolStat(item);
  head.appendChild(stat);
  head.appendChild(el('span', 'tool-caret', '▾'));
  card.appendChild(head);

  const body = el('div', 'tool-body');
  card.appendChild(body);

  fillToolBody(body, item);

  // 默认展开规则：
  //   · 还没跑完 / 出错 / 被拒绝 → 展开（要让人看见过程和问题）
  //   · 有 diff 的（改文件、写文件）→ 展开（diff 本身就是用户最想看的结果）
  //   · 其余成功的（读文件、搜索、跑成功的命令）→ 收起，避免刷屏
  let open = item.status !== 'ok' || !!(item.meta && item.meta.diff);
  body.hidden = !open;
  head.querySelector('.tool-caret').textContent = open ? '▾' : '▸';

  head.addEventListener('click', () => {
    open = !open;
    body.hidden = !open;
    head.querySelector('.tool-caret').textContent = open ? '▾' : '▸';
  });

  return card;
}

function fillToolBody(body, item) {
  body.textContent = '';
  const meta = item.meta || {};

  // 命令：终端块
  if (item.name === 'run_command') {
    const pre = el('pre', 'term');
    const cmdLine = el('div');
    cmdLine.appendChild(el('span', 'p-cmd', `$ ${item.args?.command || ''}`));
    pre.appendChild(cmdLine);

    const m = meta.kind === 'command' ? meta : null;
    const info = m
      ? `${m.shell || ''} · 退出码 ${m.exitCode ?? '—'}${m.timedOut ? ' · 已超时' : ''}${m.durationMs != null ? ` · ${m.durationMs} ms` : ''}`
      : '';
    if (info) pre.appendChild(el('div', 'p-dim', info));

    const out = m?.stdout || (item.status === 'running' ? '' : item.content || '');
    if (out) {
      const o = el('div', null, out.replace(/\n+$/, ''));
      if (m && m.exitCode !== 0) o.className = 'p-err';
      pre.appendChild(o);
    }
    if (m?.stderr) pre.appendChild(el('div', 'p-err', m.stderr.replace(/\n+$/, '')));
    if (!out && !m?.stderr) {
      pre.appendChild(el('div', 'p-dim', item.status === 'running' ? '等待输出…' : '（无输出）'));
    }
    body.appendChild(pre);
    return;
  }

  // 写文件 / 改文件：diff
  if (meta.diff) {
    body.appendChild(renderDiff(meta.diff));
    return;
  }

  // 读 / 搜 / 列目录：等宽文本
  if (item.content) {
    const pre = el('pre', 'term');
    pre.textContent = item.content;
    if (item.status === 'error') pre.classList.add('p-err');
    body.appendChild(pre);
  }
}

/** 把统一 diff 文本渲染成带行号的红绿块 */
function renderDiff(diffText) {
  const wrap = el('div', 'diff');
  let oldNo = 0;
  let newNo = 0;

  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue;

    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      const row = el('div', 'ln hunk');
      row.appendChild(el('span', 'gut', ''));
      row.appendChild(el('span', 'txt', raw));
      wrap.appendChild(row);
      continue;
    }

    const mark = raw[0];
    const text = raw.slice(1);
    let gut = '';
    let cls = 'ln';

    if (mark === '+') {
      cls += ' add';
      gut = String(newNo++);
    } else if (mark === '-') {
      cls += ' del';
      gut = String(oldNo++);
    } else {
      gut = String(oldNo);
      oldNo++;
      newNo++;
    }

    const row = el('div', cls);
    row.appendChild(el('span', 'gut', gut));
    row.appendChild(el('span', 'txt', text));
    wrap.appendChild(row);
  }
  return wrap;
}

/** 增量更新已存在的 item 元素 */
function updateItem(item) {
  const old = S.els.get(item.id);
  const fresh = renderItem(item);
  if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
  else return false;
  return true;
}

/* ============================================================
 * 事件流
 * ============================================================ */

function appendItem(item) {
  if (!S.session) return;
  S.session.items.push(item);

  const box = $('transcript');
  let stream = box.querySelector('.stream');
  if (!stream) {
    box.textContent = '';
    stream = el('div', 'stream');
    box.appendChild(stream);
  }
  stream.appendChild(renderItem(item));
  scrollToEnd();
}

/** 只在用户本来就贴着底部时才自动滚，避免打断向上翻看的阅读 */
function scrollToEnd(force) {
  const box = $('transcript');
  if (!box) return;
  if (force || S.autoScroll) box.scrollTop = box.scrollHeight;
}

function setRunning(v) {
  S.running = v;
  $('runbar').classList.toggle('on', v);
  $('chipStop').hidden = !v;
  $('btnSend').disabled = v;
  if (!v) $('statusText').textContent = '';
}

/** assistant 气泡的增量刷新做节流：每个动画帧最多重渲染一次 */
const pendingBubbles = new Set();
let rafScheduled = false;

function scheduleBubbleRefresh(id) {
  pendingBubbles.add(id);
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    for (const bid of pendingBubbles) {
      const item = S.session?.items.find((i) => i.id === bid);
      if (item) updateItem(item);
    }
    pendingBubbles.clear();
    scrollToEnd();
  });
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'run_start':
      setRunning(true);
      $('statusText').textContent = '启动中…';
      break;

    case 'step_start':
      $('statusText').textContent = `第 ${ev.step} 步`;
      break;

    case 'item_added':
      appendItem(ev.item);
      if (ev.item.type === 'user') {
        S.autoScroll = true;
        scrollToEnd(true);
      }
      break;

    case 'item_delta': {
      const item = S.session?.items.find((i) => i.id === ev.id);
      if (!item) break;
      item[ev.field] = (item[ev.field] || '') + ev.delta;
      scheduleBubbleRefresh(ev.id);
      break;
    }

    case 'item_updated': {
      const idx = S.session?.items.findIndex((i) => i.id === ev.item.id);
      if (idx != null && idx >= 0) S.session.items[idx] = ev.item;
      updateItem(ev.item);
      scrollToEnd();
      break;
    }

    case 'approval':
      showApproval(ev);
      break;

    case 'usage':
      S.usage = ev.usage;
      renderUsage();
      break;

    case 'session_meta':
      if (S.session) S.session.title = ev.title;
      $('taskTitle').textContent = ev.title;
      refreshSessions();
      break;

    case 'run_end':
      setRunning(false);
      S.autoScroll = true;
      refreshSessions();
      // 一轮任务结束是额度变化最确定的时刻，顺手对一次账
      refreshQuota().catch(() => {});
      break;

    case 'sync':
      if (S.session && S.session.id === ev.sessionId) {
        S.session.items = ev.items;
        renderTranscript();
      }
      break;

    default:
      break;
  }
}

/* ============================================================
 * 审批
 * ============================================================ */

function showApproval(ev) {
  const box = $('transcript');
  let stream = box.querySelector('.stream');
  if (!stream) {
    box.textContent = '';
    stream = el('div', 'stream');
    box.appendChild(stream);
  }

  const card = el('div', 'approval');

  const head = el('div', 'ap-head');
  head.appendChild(el('span', 'ap-ico', '⚠'));
  head.appendChild(el('span', null, '这一步需要你确认后才会执行'));
  card.appendChild(head);

  const body = el('div', 'ap-body');
  const cmd = el('div', 'ap-cmd');
  cmd.textContent = ev.title || JSON.stringify(ev.args, null, 2);
  body.appendChild(cmd);

  if (ev.reasons?.length) {
    const ul = el('ul', 'ap-reasons');
    for (const r of ev.reasons) ul.appendChild(el('li', null, r));
    body.appendChild(ul);
  }

  const actions = el('div', 'ap-actions');
  const mk = (label, cls, answer) => {
    const b = el('button', `btn ${cls}`, label);
    b.addEventListener('click', async () => {
      await api.respondApproval({ reqId: ev.reqId, approved: answer.approved, remember: answer.remember });
      actions.remove();
      const done = el('div', 'ap-reasons', answer.approved ? '✓ 已允许' : '✕ 已拒绝');
      done.style.color = answer.approved ? '#7ee08a' : '#ff9b93';
      body.appendChild(done);
      S.pendingApprovals.delete(ev.reqId);
    });
    return b;
  };
  actions.appendChild(mk('允许一次', 'primary', { approved: true }));
  actions.appendChild(mk('本会话始终允许', '', { approved: true, remember: true }));
  actions.appendChild(mk('拒绝', 'danger', { approved: false }));

  body.appendChild(actions);
  card.appendChild(body);

  stream.appendChild(card);
  S.pendingApprovals.set(ev.reqId, card);
  S.autoScroll = true;
  scrollToEnd(true);
  $('statusText').textContent = '等待确认';
}

/* ============================================================
 * 发送 / 停止
 * ============================================================ */

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  if (S.running) {
    toast('任务正在运行中', true);
    return;
  }
  if (!connectionReady()) {
    toast(notReadyHint(), true);
    if (needsLogin()) showLogin();
    else openSettings();
    return;
  }
  if (!S.session) await newTask(false);

  input.value = '';
  autoGrow();
  S.autoScroll = true;
  setRunning(true);

  const res = await api.send({ sessionId: S.session.id, text });
  if (res && res.ok === false && res.reason !== 'NO_CONFIG') {
    setRunning(false);
    toast('没能启动任务', true);
  }
}

async function stop() {
  const ok = await api.stop();
  if (ok) $('statusText').textContent = '正在停止…';
}

/* ============================================================
 * 输入框
 * ============================================================ */

function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

function bindComposer() {
  const input = $('input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  on('btnSend', 'click', send);
  on('chipStop', 'click', stop);

  on('transcript', 'scroll', () => {
    const box = $('transcript');
    S.autoScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  });

  // 代码块的复制按钮（事件委托，因为卡片是动态生成的）
  on('transcript', 'click', async (e) => {
    const btn = e.target.closest('.codeblock-copy');
    if (!btn) return;
    const pre = btn.closest('.codeblock')?.querySelector('pre');
    if (!pre) return;
    const ok = await copyText(pre.textContent);
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => (btn.textContent = '复制'), 1200);
  });

  // 权限模式 / shell 快捷切换
  on('chipMode', 'click', async () => {
    const modes = S.info?.modes || ['read-only', 'auto', 'full'];
    const cur = S.config.approvalMode || 'auto';
    const next = modes[(modes.indexOf(cur) + 1) % modes.length];
    S.config = await api.saveConfig({ approvalMode: next });
    renderHeader();
    toast(`权限模式：${S.info?.modeLabels?.[next] || next}`);
  });

  on('chipShell', 'click', async () => {
    const order = ['powershell', 'cmd', 'bash'];
    const cur = S.config.shell || 'powershell';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    S.config = await api.saveConfig({ shell: next });
    renderHeader();
    toast(`命令解释器：${next}`);
  });

  const pickWs = async () => {
    if (S.running) return toast('任务运行中不能换工作区', true);
    const p = await api.pickWorkspace();
    if (!p) return;
    S.config = await api.saveConfig({ workspace: p });
    if (S.session) {
      const s = await api.createSession({ workspace: p });
      S.session = s;
      await refreshSessions();
    }
    renderAll();
    toast('工作区已切换');
  };
  on('btnWorkspaceTop', 'click', pickWs);
}

/* ============================================================
 * 设置弹窗
 * ============================================================ */

function closeModal() {
  const root = $('modalRoot');
  root.classList.remove('open');
  root.textContent = '';
}

function openModal(title, bodyNode, footNode) {
  const root = $('modalRoot');
  root.textContent = '';
  root.classList.add('open');

  const mask = el('div', 'modal-mask');
  mask.addEventListener('click', closeModal);

  const modal = el('div', 'modal');
  const head = el('div', 'modal-head');
  head.appendChild(el('span', null, title));
  const x = el('button', 'mh-x', '×');
  x.addEventListener('click', closeModal);
  head.appendChild(x);

  const body = el('div', 'modal-body');
  if (bodyNode) body.appendChild(bodyNode);

  modal.appendChild(head);
  modal.appendChild(body);
  if (footNode) {
    const foot = el('div', 'modal-foot');
    foot.appendChild(footNode);
    modal.appendChild(foot);
  }
  root.appendChild(mask);
  root.appendChild(modal);
  return { modal, body };
}

function field(label, control, hint) {
  const f = el('div', 'field');
  f.appendChild(el('label', null, label));
  f.appendChild(control);
  if (hint) f.appendChild(el('div', 'hint', hint));
  return f;
}

/**
 * 给并排的输入框各配一行小标题。
 *
 * 之前「温度 / 最大步数」两个数字框并排摆着，却只在上面写了一行总标题，
 * 得对着下面的说明文字去猜哪个是哪个。并排的控件必须各自有标签。
 */
function captioned(caption, control) {
  const w = el('div', 'sub-field');
  w.appendChild(el('span', 'sub-label', caption));
  w.appendChild(control);
  return w;
}

function textInput(value, placeholder, type) {
  const i = document.createElement('input');
  i.type = type || 'text';
  i.value = value || '';
  i.placeholder = placeholder || '';
  i.spellcheck = false;
  return i;
}

/**
 * 接入方式横幅：一眼看清现在走哪条通道，并且就地能切过去。
 *
 * 设置页里两种通道要填的东西完全不同（社区模式没有 base_url / API Key 可填），
 * 所以必须先让人知道自己在哪一边，否则会对着空白的接口地址框发懵。
 */
function buildModeBanner(st, isCommunity) {
  const loggedIn = !!st.loggedIn;
  const banner = el('div', `mode-banner${isCommunity && loggedIn ? ' on' : ''}`);
  banner.appendChild(el('span', 'mb-dot'));

  const txt = el('span');
  txt.appendChild(document.createTextNode('接入方式：'));
  if (isCommunity) {
    txt.appendChild(el('b', null, '社区账号'));
    txt.appendChild(
      document.createTextNode(loggedIn ? `（${st.user?.nickname || st.user?.username || '已登录'}）` : '（未登录）')
    );
  } else {
    txt.appendChild(el('b', null, '自定义接口'));
  }
  banner.appendChild(txt);

  const btn = el('button', 'btn ghost mb-right', isCommunity ? '改用自定义接口' : '登录社区账号');
  btn.addEventListener('click', async () => {
    closeModal();
    if (isCommunity) {
      // 只是切「走哪条通道」，本地已有的自定义配置原样留着，随时能切回来
      S.config = await api.saveConfig({ mode: 'custom' });
      await afterAuthChange();
      toast('已切换到自定义接口，请填写接口地址');
      openSettings();
    } else {
      showLogin();
    }
  });
  banner.appendChild(btn);
  return banner;
}

/** 社区模式的字段。返回一个「取值函数」，保存时调用它拿 patch。 */
function communityFields(body, cfg, st) {
  if (!st.loggedIn) {
    const box = el('div', 'mode-banner');
    box.appendChild(el('span', 'mb-dot'));
    box.appendChild(el('span', null, '还没登录。登录后模型与额度由社区自动下发。'));
    const b = el('button', 'btn primary mb-right', '去登录');
    b.addEventListener('click', () => {
      closeModal();
      showLogin();
    });
    box.appendChild(b);
    body.appendChild(box);
    return () => ({});
  }

  const models = Array.isArray(st.models) ? st.models : [];
  const idOf = (m) => (typeof m === 'string' ? m : m && m.id);
  const nameOf = (m) => (typeof m === 'string' ? m : (m && (m.name || m.id)) || '');

  const sel = document.createElement('select');
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = st.defaultModel ? `跟随社区默认（${st.defaultModel}）` : '跟随社区默认';
  sel.appendChild(auto);
  for (const m of models) {
    const o = document.createElement('option');
    o.value = idOf(m);
    o.textContent = `${nameOf(m)}  ·  ${idOf(m)}`;
    if (cfg.model === idOf(m)) o.selected = true;
    sel.appendChild(o);
  }
  // 以前在自定义模式下填过的模型名（比如 deepseek-chat）会留在 config.model 里，
  // 得让人看见它、并且能改掉，而不是悄悄被忽略
  if (cfg.model && !models.some((m) => idOf(m) === cfg.model)) {
    const o = document.createElement('option');
    o.value = cfg.model;
    o.textContent = `${cfg.model}（社区不认这个名字）`;
    o.selected = true;
    sel.appendChild(o);
  }

  body.appendChild(
    field('模型', sel, '列表由社区下发，不用手填。填了社区不认识的名字，请求会被网关直接拒绝。')
  );
  return () => ({ model: sel.value.trim() });
}

/** 自定义模式的字段。返回取值函数。 */
function customFields(body, cfg) {
  /* —— 接口地址 —— */
  const baseUrl = textInput(cfg.baseUrl, 'https://api.deepseek.com/v1');
  /* —— API Key —— */
  const keyWrap = el('div', 'input-row');
  const apiKey = textInput(cfg.apiKey, 'sk-…', 'password');
  const toggleKey = el('button', 'btn ghost', '显示');
  toggleKey.style.flex = 'none';
  toggleKey.addEventListener('click', () => {
    const showing = apiKey.type === 'text';
    apiKey.type = showing ? 'password' : 'text';
    toggleKey.textContent = showing ? '显示' : '隐藏';
  });
  keyWrap.appendChild(apiKey);
  keyWrap.appendChild(toggleKey);
  /* —— 模型 —— */
  const modelWrap = el('div', 'input-row');
  const model = textInput(cfg.model, 'deepseek-chat');
  const listBtn = el('button', 'btn ghost', '拉取列表');
  listBtn.style.flex = 'none';
  const datalist = document.createElement('datalist');
  datalist.id = 'modelList';
  model.setAttribute('list', 'modelList');
  listBtn.addEventListener('click', async () => {
    listBtn.disabled = true;
    listBtn.textContent = '拉取中…';
    try {
      const ids = await api.listModels({ baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() });
      datalist.textContent = '';
      for (const id of ids) {
        const o = document.createElement('option');
        o.value = id;
        datalist.appendChild(o);
      }
      toast(`拿到 ${ids.length} 个模型，点输入框可以选`);
    } catch (err) {
      toast(`拉取失败：${err.message}`, true);
    } finally {
      listBtn.disabled = false;
      listBtn.textContent = '拉取列表';
    }
  });
  modelWrap.appendChild(model);
  modelWrap.appendChild(listBtn);
  modelWrap.appendChild(datalist);

  /* —— 服务商预设（点一下填好地址和模型）—— */
  const presetWrap = el('div', 'presets');
  for (const p of S.info?.presets || []) {
    const b = el('button', `preset${cfg.baseUrl === p.baseUrl ? ' on' : ''}`, p.label);
    b.addEventListener('click', () => {
      if (p.baseUrl) {
        baseUrl.value = p.baseUrl;
        if (p.model) model.value = p.model;
      }
      for (const sib of presetWrap.children) sib.classList.remove('on');
      b.classList.add('on');
    });
    presetWrap.appendChild(b);
  }

  body.appendChild(field('快速选择服务商', presetWrap, '点一下自动填好接口地址和模型名，密钥还是要自己填。'));
  body.appendChild(
    field(
      '接口地址（base_url）',
      baseUrl,
      '要带上 /v1。任何「OpenAI 兼容」的端点都可以，包括本地 Ollama：http://127.0.0.1:11434/v1'
    )
  );
  body.appendChild(field('API Key', keyWrap, '只存在本机（应用数据目录里的 config.json），不会上传到任何地方。'));
  body.appendChild(
    field('模型名', modelWrap, '模型必须支持 function calling（工具调用），否则 Agent 没法读写文件。')
  );

  /* —— 连通性检查 —— */
  const testResult = el('div', 'test-result');
  const testBtn = el('button', 'btn', '测试连接');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.className = 'test-result';
    testResult.textContent = '正在连接…';
    try {
      const ids = await api.listModels({ baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() });
      testResult.className = 'test-result ok';
      const want = model.value.trim();
      const has = ids.includes(want);
      testResult.textContent = `连接成功，可用模型 ${ids.length} 个。${
        want ? (has ? `「${want}」在列表里 ✓` : `注意：列表里没有「${want}」，可能名字写错了`) : ''
      }`;
    } catch (err) {
      testResult.className = 'test-result bad';
      testResult.textContent = err.message || String(err);
    } finally {
      testBtn.disabled = false;
    }
  });
  const testField = field('连通性检查', testBtn);
  testField.appendChild(testResult);
  body.appendChild(testField);

  return () => ({
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
  });
}

function openSettings() {
  const cfg = { ...(S.config || {}) };
  const st = A.state || {};
  const isCommunity = cfg.mode === 'community';
  const body = el('div');

  body.appendChild(buildModeBanner(st, isCommunity));
  const collectChannel = isCommunity ? communityFields(body, cfg, st) : customFields(body, cfg);

  /* —— 生成参数 —— */
  const row = el('div', 'row');
  const temp = textInput(cfg.temperature ?? 0.2, '0.2', 'number');
  temp.step = '0.1';
  temp.min = '0';
  temp.max = '2';
  const steps = textInput(cfg.maxSteps ?? 25, '25', 'number');
  steps.min = '1';
  steps.max = '200';
  row.appendChild(captioned('温度', temp));
  row.appendChild(captioned('最大步数', steps));
  body.appendChild(field('生成参数', row, '温度越低越稳定。最大步数限制一次任务里最多调用多少轮工具。'));

  /* —— 流式 —— */
  const streamWrap = el('label', 'switch');
  const streamCb = document.createElement('input');
  streamCb.type = 'checkbox';
  streamCb.checked = cfg.stream !== false;
  streamWrap.appendChild(streamCb);
  streamWrap.appendChild(el('span', null, '流式输出（逐字显示，推荐开启）'));
  body.appendChild(field('', streamWrap));

  /* —— shell —— */
  const shellSel = document.createElement('select');
  for (const [v, label] of [
    ['powershell', 'PowerShell（推荐，Windows 默认）'],
    ['cmd', 'CMD'],
    ['bash', 'Bash（需要装 Git Bash）'],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (cfg.shell === v) o.selected = true;
    shellSel.appendChild(o);
  }
  body.appendChild(field('执行命令用哪个 shell', shellSel));

  /* —— 权限模式 —— */
  const modeWrap = el('div', 'mode-row');
  const modeDesc = {
    'read-only': '只能读文件和搜索，不写不改不执行命令。',
    auto: '常规读写和命令直接执行，破坏性操作弹窗确认。',
    full: '全部直接执行，不再弹窗。仍受工作区限制。',
  };
  let pickedMode = cfg.approvalMode || 'auto';
  for (const m of S.info?.modes || []) {
    const b = el('button', `mode-opt${pickedMode === m ? ' on' : ''}`);
    b.appendChild(el('b', null, S.info?.modeLabels?.[m] || m));
    b.appendChild(el('span', null, modeDesc[m] || ''));
    b.addEventListener('click', () => {
      pickedMode = m;
      for (const sib of modeWrap.children) sib.classList.remove('on');
      b.classList.add('on');
    });
    modeWrap.appendChild(b);
  }
  body.appendChild(field('权限模式', modeWrap));

  /* —— 工作区 —— */
  const wsWrap = el('div', 'input-row');
  const ws = textInput(cfg.workspace, 'C:\\path\\to\\project');
  const wsBtn = el('button', 'btn ghost', '选择…');
  wsBtn.style.flex = 'none';
  wsBtn.addEventListener('click', async () => {
    const p = await api.pickWorkspace();
    if (p) ws.value = p;
  });
  wsWrap.appendChild(ws);
  wsWrap.appendChild(wsBtn);
  body.appendChild(
    field('工作区目录', wsWrap, 'Agent 只能在这个目录里读写文件。改完之后新任务才会用新目录。')
  );

  /* —— 底部按钮 —— */
  const foot = el('div');
  foot.style.display = 'flex';
  foot.style.gap = '8px';
  const cancel = el('button', 'btn', '取消');
  cancel.addEventListener('click', closeModal);
  const save = el('button', 'btn primary', '保存');
  save.addEventListener('click', async () => {
    S.config = await api.saveConfig({
      ...collectChannel(),
      temperature: Number(temp.value),
      maxSteps: Number(steps.value),
      stream: streamCb.checked,
      shell: shellSel.value,
      approvalMode: pickedMode,
      workspace: ws.value.trim(),
    });
    closeModal();
    renderHeader();
    toast('已保存');
  });
  foot.appendChild(cancel);
  foot.appendChild(save);

  openModal('设置', body, foot);
}

/* ============================================================
 * 账号 / 额度弹窗
 * ============================================================ */

/** 额度详情块。percent 是【剩余】百分比，和顶部那条额度条口径一致。 */
function buildQuotaBox(q) {
  const box = el('div', 'qbox');
  if (!q) {
    box.appendChild(el('div', 'qline', '还没有拿到额度数据。'));
    return box;
  }

  const pct = Math.max(0, Math.min(100, Number(q.percent) || 0));
  const level = pct <= 10 ? 'bad' : pct <= 30 ? 'warn' : '';

  const top = el('div', 'qbox-top');
  top.appendChild(el('b', null, `${pct}%`));
  top.appendChild(el('span', null, q.exhausted ? '本月额度已用完' : '本月额度剩余'));
  box.appendChild(top);

  const big = el('div', 'qbig');
  const fill = el('i');
  fill.style.width = `${pct}%`;
  fill.className = level;
  big.appendChild(fill);
  box.appendChild(big);

  for (const t of [
    `剩余 ${q.remainingText} / 共 ${q.allowanceText}`,
    `已用 ${q.usedText} · ${q.calls} 次调用 · ${Number(q.tokens || 0).toLocaleString()} tokens`,
    `下次重置：${q.resetsAtLocal}（北京时间）`,
  ]) {
    box.appendChild(el('div', 'qline', t));
  }

  if (q.exhausted) {
    box.appendChild(
      el('div', 'qline', '额度用完就停，不会去扣社区余额。等下个月 1 日自动满血。')
    );
  }
  return box;
}

function openAccount() {
  const st = A.state || {};
  const user = st.user || {};
  const name = user.nickname || user.username || '';
  const loggedIn = !!st.loggedIn;
  const body = el('div');

  /* —— 头部 —— */
  const head = el('div', 'acct-head');
  head.appendChild(el('div', 'acct-ava-lg', loggedIn ? firstChar(name) : '灵'));
  const ht = el('div', 'acct-head-txt');
  ht.appendChild(el('b', null, loggedIn ? name : '未登录'));
  ht.appendChild(
    el(
      'span',
      null,
      loggedIn
        ? `@${user.username || ''}${user.role ? ` · ${user.role}` : ''}`
        : st.mode === 'custom'
          ? '自定义接口'
          : '社区账号'
    )
  );
  head.appendChild(ht);
  body.appendChild(head);

  /* —— 额度 —— */
  let qbox = null;
  if (loggedIn) {
    qbox = buildQuotaBox(st.quota);
    body.appendChild(qbox);
  } else {
    body.appendChild(
      el(
        'div',
        'qline',
        st.mode === 'custom'
          ? '当前走自定义接口：请求直接发给你自己填的端点，不经过社区，也不消耗社区额度。'
          : '登录社区账号后每月自动获得额度，每月 1 日重置为 100%，不用自己准备 API Key。'
      )
    );
  }

  /* —— 底部按钮 —— */
  const foot = el('div');
  foot.style.display = 'flex';
  foot.style.gap = '8px';

  if (loggedIn) {
    const refresh = el('button', 'btn', '刷新额度');
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = '刷新中…';
      await refreshQuota({ silent: false });
      if (!(A.state || {}).loggedIn) {
        // 会话已经在服务端失效，这个弹窗的内容全过期了，重画一个
        closeModal();
        openAccount();
        return;
      }
      const fresh = buildQuotaBox(A.state.quota);
      if (qbox) qbox.replaceWith(fresh);
      qbox = fresh;
      refresh.disabled = false;
      refresh.textContent = '刷新额度';
    });

    const out = el('button', 'btn danger', '退出登录');
    out.addEventListener('click', async () => {
      out.disabled = true;
      await api.authLogout();
      closeModal();
      await afterAuthChange();
      showLogin();
      toast('已退出登录');
    });

    foot.appendChild(refresh);
    foot.appendChild(out);
  } else {
    const go = el('button', 'btn primary', '登录社区账号');
    go.addEventListener('click', () => {
      closeModal();
      showLogin();
    });
    const set = el('button', 'btn', '打开设置');
    set.addEventListener('click', () => {
      closeModal();
      openSettings();
    });
    foot.appendChild(go);
    foot.appendChild(set);
  }

  openModal('账号与额度', body, foot);
}

function openAbout() {
  const v = S.info?.versions || {};
  const st = A.state || {};
  const cfg = S.config || {};
  const body = el('div');
  const lines = [
    ['应用', `${S.info?.productName || '雾韵码灵'} ${S.info?.version || '0.1.0'}`],
    ['定位', '跑在本机的 AI 编程助手：读写文件、执行命令'],
    [
      '接入方式',
      cfg.mode === 'community'
        ? `社区账号${st.loggedIn ? `（${st.user?.nickname || st.user?.username || ''}）` : '（未登录）'}`
        : '自定义接口',
    ],
    ['平台', `${S.info?.platform} / ${S.info?.arch}`],
    ['Electron', v.electron || '—'],
    ['Chromium', v.chrome || '—'],
    ['Node', v.node || '—'],
    ['数据目录', S.info?.userData || '—'],
  ];
  for (const [k, val] of lines) {
    const f = el('div', 'field');
    f.appendChild(el('label', null, k));
    const d = el('div');
    d.style.fontFamily = 'var(--mono)';
    d.style.fontSize = '12px';
    d.style.color = 'var(--fg-mut)';
    d.style.wordBreak = 'break-all';
    d.textContent = val;
    f.appendChild(d);
    body.appendChild(f);
  }
  const foot = el('button', 'btn', '关闭');
  foot.addEventListener('click', closeModal);
  openModal('关于', body, foot);
}

/* ============================================================
 * 启动
 * ============================================================ */

async function boot() {
  S.info = await api.info();
  S.config = await api.getConfig();
  await refreshAuth();

  on('pillModel', 'click', openSettings);
  on('pillQuota', 'click', openAccount);
  on('btnAccount', 'click', openAccount);
  on('btnSettings', 'click', openSettings);
  on('btnAbout', 'click', openAbout);
  on('btnNew', 'click', () => newTask());

  on('searchBox', 'input', (e) => {
    S.filter = e.target.value;
    renderSessions();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 登录页不给 Esc 关掉：关掉之后是一个「什么都没配好」的主界面，
      // 用户会以为程序坏了。要走就走「跳过登录」那条明路。
      if (!$('loginScreen').hidden) return;
      if ($('modalRoot').classList.contains('open')) closeModal();
      else if (S.running) stop();
    }
  });

  bindComposer();
  bindLogin();

  api.onMenu((action) => {
    if (action === 'new-task') newTask();
    else if (action === 'settings') openSettings();
    else if (action === 'focus-input') $('input').focus();
  });

  api.onEvent(handleEvent);

  // 主界面先备好，登录页只是盖在它上面。
  // 这样登录成功后不需要重载页面 —— 重载会闪一下，正在看的会话也会丢。
  await ensureSession();
  renderAuthChrome();
  renderHeader();
  autoGrow();
  startQuotaTimer();

  if (needsLogin()) {
    showLogin();
    return;
  }

  $('input').focus();

  if (!connectionReady()) {
    setTimeout(() => {
      toast(notReadyHint());
      openSettings();
    }, 350);
  } else {
    // 启动时对一次额度，否则顶部显示的是上次退出时的旧数值
    refreshQuota().catch(() => {});
  }
}

/**
 * 调试把手：给自动化截图和现场排查用。
 * 渲染进程本身没有任何特权（不碰文件、不碰命令），这里暴露的都是它本来就能做的事，
 * 所以不构成额外的攻击面。
 */
window.__wuyun = {
  S,
  A,
  handleEvent,
  showApproval,
  openSettings,
  openAbout,
  openAccount,
  showLogin,
  hideLogin,
  renderAll,
  renderAuthChrome,
  renderHeader,
  refreshAuth,
  refreshQuota,
  toast,
  MD,
};

boot().catch((err) => {
  document.body.innerHTML = `<pre style="color:#ff9b93;padding:24px;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap">
启动失败：${MD ? MD.esc(err.message || String(err)) : String(err)}
${MD ? MD.esc(err.stack || '') : ''}</pre>`;
});
