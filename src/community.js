'use strict';

/**
 * community.js —— 社区账号与额度的接口客户端
 *
 * 只用 Node 自带的 fetch，不引第三方 HTTP 库。
 *
 * 这一层刻意「薄」：它只负责发请求、把服务端的错误文案原样翻译成人话，
 * 不持有任何状态 —— 登录态存在 store 里，由 main.js 统一管。
 * 这样测试时可以直接拿假的 baseUrl 打本地服务，不用起整个应用。
 */

const { DEFAULT_SITE, DEFAULT_GATEWAY } = require('./store');

const TIMEOUT_MS = 15_000;

/** 把「站点接口地址」规范化：去掉尾斜杠，去掉用户可能多填的 /api */
function normalizeSite(url) {
  let s = String(url || '').trim();
  if (!s) return DEFAULT_SITE;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/api$/, '');
  return s;
}

/** 把「网关地址」规范化：去掉尾斜杠，补上 /v1 */
function normalizeGateway(url) {
  let s = String(url || '').trim();
  if (!s) return DEFAULT_GATEWAY;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/, '');
  if (!/\/v\d+$/.test(s)) s += '/v1';
  return s;
}

/**
 * 发一次 JSON 请求。
 *
 * 服务端约定：出错时返回 {ok:false, message, code}。
 * 这里把 message 抽出来抛成 Error，界面直接就能显示 —— 不把 HTTP 状态码
 * 摆到用户面前（「401」对用户没有任何信息量，「账号或密码不正确」才有）。
 */
async function request(baseUrl, path, { method = 'GET', body, token, headers = {} } = {}) {
  const url = `${normalizeSite(baseUrl)}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error('连接社区超时，请检查网络后重试');
    }
    throw new Error(`连不上社区服务器（${url}）`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!data || typeof data !== 'object') {
    // 拿到的多半是 nginx / CDN 的 HTML 错误页
    throw new Error(`社区返回了无法识别的响应（HTTP ${res.status}）`);
  }
  if (res.ok && data.ok !== false) {
    return data;
  }

  const msg = typeof data.message === 'string' && data.message ? data.message : `请求失败（HTTP ${res.status}）`;
  const err = new Error(msg);
  err.code = data.code || '';
  err.status = res.status;
  throw err;
}

/**
 * 登录。成功后服务端会下发：会话 token、用户信息、网关地址与可用模型、额度快照。
 *
 * 客户端不内置任何域名或模型名 —— 全部以服务端下发的为准，
 * 以后服务端换网关域名、加模型，都不需要发新版客户端。
 */
async function login({ account, password, deviceId, deviceName, version, siteBaseUrl }) {
  const data = await request(siteBaseUrl, '/api/desktop/login', {
    method: 'POST',
    body: { account, password, deviceId, deviceName, version },
    headers: deviceId ? { 'X-Device-Id': deviceId } : {},
  });

  if (!data.token) {
    throw new Error('社区没有返回登录凭证，请稍后再试');
  }
  return {
    token: data.token,
    user: data.user || {},
    gateway: {
      baseUrl: normalizeGateway(data.gateway && data.gateway.baseUrl),
      models: Array.isArray(data.gateway && data.gateway.models) ? data.gateway.models : [],
      defaultModel: (data.gateway && data.gateway.default) || '',
    },
    quota: data.quota || null,
  };
}

/** 拉最新额度（顺带刷新用户信息与网关配置） */
async function fetchQuota({ token, siteBaseUrl, deviceId }) {
  const data = await request(siteBaseUrl, '/api/desktop/quota', {
    token,
    headers: deviceId ? { 'X-Device-Id': deviceId } : {},
  });
  return {
    user: data.user || {},
    gateway: {
      baseUrl: normalizeGateway(data.gateway && data.gateway.baseUrl),
      models: Array.isArray(data.gateway && data.gateway.models) ? data.gateway.models : [],
      defaultModel: (data.gateway && data.gateway.default) || '',
    },
    quota: data.quota || null,
  };
}

/**
 * 退出登录。
 *
 * 尽力而为：即使服务端没删掉会话（断网、超时），本地也必须清干净 ——
 * 「点了退出却还留着登录态」比「服务端多一条废会话」严重得多。
 */
async function logout({ token, siteBaseUrl }) {
  if (!token) return;
  try {
    await request(siteBaseUrl, '/api/auth/logout', { method: 'POST', token });
  } catch {
    /* 忽略：本地清理由调用方负责 */
  }
}

module.exports = { login, fetchQuota, logout, normalizeSite, normalizeGateway };
