'use strict';

/**
 * preload.js —— 渲染进程与主进程之间唯一的通道
 *
 * 渲染进程没有 Node 权限（nodeIntegration: false），也开了 contextIsolation。
 * 它只能看到这里显式挂上去的这几个方法，别的什么也碰不到。
 * 所有真正的文件读写、命令执行都发生在主进程。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('wuyun', {
  /* 环境信息 */
  info: () => invoke('app:info'),

  /* 配置 */
  getConfig: () => invoke('config:get'),
  saveConfig: (patch) => invoke('config:save', patch),
  presets: () => invoke('presets:get'),

  /* 社区账号
   *
   * 注意这里**没有**任何「取 token」的方法，是故意的：token 只在主进程里，
   * 渲染进程拿着它也没用（发请求由主进程代劳），一旦界面被注入就等于白送登录态。 */
  authState: () => invoke('auth:state'),
  authLogin: (payload) => invoke('auth:login', payload),
  authLogout: () => invoke('auth:logout'),
  authQuota: () => invoke('auth:quota'),
  authModels: () => invoke('auth:models'),

  /* 会话 */
  listSessions: () => invoke('sessions:list'),
  getSession: (id) => invoke('sessions:get', id),
  createSession: (payload) => invoke('sessions:create', payload),
  deleteSession: (id) => invoke('sessions:delete', id),
  clearSessions: () => invoke('sessions:clear'),

  /* Agent */
  send: (payload) => invoke('agent:send', payload),
  retry: (payload) => invoke('agent:retry', payload),
  stop: () => invoke('agent:stop'),
  respondApproval: (payload) => invoke('approval:respond', payload),
  running: () => invoke('agent:running'),

  /* 模型连通性 */
  listModels: (payload) => invoke('models:list', payload),

  /* 系统集成 */
  pickWorkspace: () => invoke('dialog:pickWorkspace'),
  revealPath: (p) => invoke('shell:reveal', p),
  openPath: (p) => invoke('shell:openPath', p),

  /* 事件订阅（返回取消订阅函数） */
  onEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.off('agent:event', handler);
  },
  onMenu: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.off('menu:action', handler);
  },
});
