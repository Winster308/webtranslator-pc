'use strict';
/** preload：把本地 API 服务地址与安全令牌安全暴露给页面（contextBridge，不开放 Node 能力）。 */
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find(a => a.startsWith('--api-url='));
const apiUrl = arg ? arg.slice('--api-url='.length) : '';
const tArg = process.argv.find(a => a.startsWith('--auth-token='));
const authToken = tArg ? tArg.slice('--auth-token='.length) : '';
const thArg = process.argv.find(a => a.startsWith('--theme='));
const themePreload = thArg ? thArg.slice('--theme='.length) : '';

contextBridge.exposeInMainWorld('apiBase', apiUrl);
contextBridge.exposeInMainWorld('authToken', authToken);
contextBridge.exposeInMainWorld('themePreload', themePreload);
contextBridge.exposeInMainWorld('notify', (title, body) => { ipcRenderer.send('notify', { title, body }); });
