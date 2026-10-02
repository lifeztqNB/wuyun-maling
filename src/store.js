'use strict';

/**
 * store.js —— 配置与会话的本地持久化
 *
 * 全部落在 Electron 的 userData 目录下，不碰项目目录，也不碰注册表。
 * 写入一律「先写临时文件再 rename」，避免断电/崩溃时留下半个 JSON 把配置读废。
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'config.json';
const SESSIONS_FILE = 'sessions.json';
const MAX_SESSIONS = 200;

/** 社区网关默认地址。登录成功后会被服务端下发的地址覆盖（服务端换域名不用发新版）。 */
const DEFAULT_GATEWAY = 'https://api.wuyunsq.top/v1';

/** 社区站点的接口地址（登录用）。网关是 /v1，站点接口是 /api。 */
const DEFAULT_SITE = 'https://api.wuyunsq.top';

/**
 * 允许的推理强度取值。空串排第一，代表「不传这个参数」。
 *
 * 这个常量同时被 store（校验）和界面（下拉框）用，所以放这里当唯一事实来源 ——
 * 两边各写一份列表，早晚会出现「界面能选、保存后被静默丢弃」的怪事。
 */
const REASONING_EFFORTS = ['', 'low', 'medium', 'high'];

/** 推理强度的中文标签，界面直接拿去用 */
const REASONING_LABELS = {
  '': '默认',
  low: '低（快）',
  medium: '中',
  high: '高（慢但更稳）',
};

/** 常见服务商的预设，界面上点一下就能填好 base_url */
const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
];

/**
 * 两种用法：
 *   community —— 用社区账号登录，走社区网关，消耗每月额度（推荐，开箱即用）
 *   custom    —— 跳过登录，自己填接口地址与 API Key（走自己的额度/账单）
 *
 * 默认 community：装完就能用，不需要用户先搞一个 API Key。
 */
function defaultConfig(workspace) {
  return {
    mode: 'community',

    // 社区账号（mode=community 时使用）
    community: {
      token: '',
      username: '',
      nickname: '',
      avatarUrl: '',
      siteBaseUrl: DEFAULT_SITE,
      gatewayBaseUrl: DEFAULT_GATEWAY,
      models: [],
      defaultModel: '',
      quota: null,
      quotaFetchedAt: 0,
    },

    // 自定义接口（mode=custom 时使用）
    baseUrl: '',
    apiKey: '',
    model: '',

    temperature: 0.2,
    maxTokens: 0, // 0 = 不传，交给服务端默认
    /**
     * 推理强度（OpenAI 的 reasoning_effort）。
     *
     * 空串 = 不传这个参数，完全交给服务端/模型自己的默认行为 —— 这是最安全的默认值：
     * 只有部分模型（o 系列、gpt-5 系列、社区的 wyzx 系列……）认这个参数，
     * 对不认的端点传了它，轻则忽略，重则直接 400。所以「不传」才是默认。
     */
    reasoningEffort: '',
    maxSteps: 25,
    stream: true,
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    approvalMode: 'auto',
    workspace: workspace || process.cwd(),
    extraHeaders: {},

    // 设备标识：只生成一次，之后固定。服务端用它给会话写一个可读的设备描述，
    // 也用于限流维度；不含任何硬件指纹，就是一个随机串。
    deviceId: '',
  };
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写：先写 .tmp 再 rename，避免写到一半崩了留下坏文件 */
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.configPath = path.join(dir, CONFIG_FILE);
    this.sessionsPath = path.join(dir, SESSIONS_FILE);
    fs.mkdirSync(dir, { recursive: true });

    const base = defaultConfig();
    const saved = readJson(this.configPath, {});
    this.config = { ...base, ...saved };
    // community 必须逐键合并，不能整体覆盖：
    // 老版本配置里没有 models/defaultModel 这些新键，整体覆盖会让它们变 undefined，
    // 表现为「升级后模型列表空了」这种莫名其妙的 bug。
    this.config.community = { ...base.community, ...(saved.community || {}) };
    if (!this.config.mode) this.config.mode = base.mode;

    // 设备标识只生成一次，之后固定不变
    if (!this.config.deviceId) {
      this.config.deviceId = randomDeviceId();
      writeJson(this.configPath, this.config);
    }

    this.sessions = readJson(this.sessionsPath, []);
    if (!Array.isArray(this.sessions)) this.sessions = [];
  }

  /* ---------- 配置 ---------- */

  getConfig() {
    return { ...this.config, community: { ...this.config.community } };
  }

  /** 只允许改白名单里的键，避免前端塞进来奇怪的东西 */
  saveConfig(patch) {
    const allowed = [
      'mode',
      'baseUrl',
      'apiKey',
      'model',
      'temperature',
      'maxTokens',
      'reasoningEffort',
      'maxSteps',
      'stream',
      'shell',
      'approvalMode',
      'workspace',
      'extraHeaders',
    ];
    for (const k of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
        this.config[k] = patch[k];
      }
    }
    if (this.config.mode !== 'custom') this.config.mode = 'community';
    this.config.temperature = clamp(Number(this.config.temperature), 0, 2, 0.2);
    this.config.maxSteps = clamp(Number.parseInt(this.config.maxSteps, 10), 1, 200, 25);
    this.config.maxTokens = clamp(Number.parseInt(this.config.maxTokens, 10), 0, 200_000, 0);
    // 白名单校验：只认这几个值，其余（包括 undefined）一律当成「不传」。
    // 不能让界面塞进来任意字符串 —— 它会被原样写进请求体发给上游。
    this.config.reasoningEffort = REASONING_EFFORTS.includes(this.config.reasoningEffort)
      ? this.config.reasoningEffort
      : '';
    this.config.stream = this.config.stream !== false;
    writeJson(this.configPath, this.config);
    return this.getConfig();
  }

  /* ---------- 社区账号 ---------- */

  getCommunity() {
    return { ...this.config.community };
  }

  /**
   * 更新社区账号信息（登录成功、刷新额度都走这里）。
   *
   * token 允许传空串以外的值；传 null/undefined 表示「不改这一项」——
   * 否则刷新额度时忘了带 token，就会把登录态清掉。
   */
  saveCommunity(patch) {
    const allowed = [
      'token',
      'username',
      'nickname',
      'avatarUrl',
      'siteBaseUrl',
      'gatewayBaseUrl',
      'models',
      'defaultModel',
      'quota',
      'quotaFetchedAt',
    ];
    for (const k of allowed) {
      if (patch && patch[k] !== undefined && patch[k] !== null) {
        this.config.community[k] = patch[k];
      }
    }
    writeJson(this.configPath, this.config);
    return this.getCommunity();
  }

  /** 退出登录：只清登录态与额度缓存，不动自定义接口的配置 */
  clearCommunityAuth() {
    const c = this.config.community;
    this.config.community = {
      ...c,
      token: '',
      username: '',
      nickname: '',
      avatarUrl: '',
      quota: null,
      quotaFetchedAt: 0,
    };
    writeJson(this.configPath, this.config);
    return this.getCommunity();
  }

  /* ---------- 会话 ---------- */

  listSessions() {
    // 只把列表需要的字段发出去，messages 太重了
    return this.sessions
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getSession(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  upsertSession(session) {
    if (!session || !session.id) return null;
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    const record = {
      id: session.id,
      title: session.title || '未命名任务',
      createdAt: session.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages: Array.isArray(session.messages) ? session.messages : [],
      workspace: session.workspace,
    };
    if (idx === -1) this.sessions.unshift(record);
    else this.sessions[idx] = { ...this.sessions[idx], ...record };
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_SESSIONS);
    }
    writeJson(this.sessionsPath, this.sessions);
    return record;
  }

  deleteSession(id) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length !== before) writeJson(this.sessionsPath, this.sessions);
    return this.sessions.length !== before;
  }

  clearSessions() {
    this.sessions = [];
    writeJson(this.sessionsPath, this.sessions);
  }
}

function clamp(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 随机设备标识。
 *
 * 刻意不用任何硬件信息（MAC、主板序列号、机器码）——那些既是隐私问题，
 * 也会因为换网卡、装虚拟机、改注册表而漂移，反而不如一个稳定的随机串可靠。
 * 服务端只拿它区分「同一账号的不同设备」，不需要它全局唯一。
 */
function randomDeviceId() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `wm-${hex()}${hex()}-${hex()}${hex()}`;
}

/** 本机可读的设备名（只用于在服务端显示成「雾韵码灵/0.2.0 (Windows 11)」） */
function deviceLabel() {
  const os = require('os');
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const host = (os.hostname() || '').split('.')[0];
  return `${platform}${host ? ' · ' + host : ''}`.slice(0, 40);
}

module.exports = {
  Store,
  defaultConfig,
  PROVIDER_PRESETS,
  DEFAULT_GATEWAY,
  DEFAULT_SITE,
  REASONING_EFFORTS,
  REASONING_LABELS,
  deviceLabel,
};
