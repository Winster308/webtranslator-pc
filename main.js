'use strict';
/**
 * WebTranslator 电脑版入口 —— 双模式：
 *   Electron 模式：`electron .`（或 npm start）→ 原生桌面窗口
 *   浏览器模式：`node main.js` → 启动内置服务器并自动打开系统浏览器
 */
const { startServer } = require('./server');

async function main() {
  const { url, port, authToken, theme } = await startServer(0);
  console.log(`[WebTranslator] 本地服务已启动: ${url}`);

  // 检测是否运行在 Electron 中
  let electronApi = null;
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.app && e.BrowserWindow) electronApi = e;
  } catch (e) { /* 非 Electron 环境 */ }

  if (electronApi) {
    const { app, BrowserWindow, session, dialog, ipcMain, Notification, Menu } = electronApi;
    const { shell } = electronApi;

    // 移除默认菜单与加速键：否则 Ctrl+R(刷新)/Ctrl+W(关窗)/Ctrl+Q(退出) 等会干扰使用
    // （例如在设置弹窗里按 Ctrl 组合键导致页面刷新/窗口关闭）
    Menu.setApplicationMenu(null);

    // 系统通知（renderer 经 preload 桥调用）
    ipcMain.on('notify', (e, payload) => {
      try {
        if (Notification && Notification.isSupported()) {
          new Notification({ title: String(payload?.title || 'WebTranslator'), body: String(payload?.body || '') }).show();
        }
      } catch (err) { /* 通知失败不影响功能 */ }
    });

    // 兼容虚拟机/远程桌面：禁用硬件加速（软件渲染更稳）。
    // ★ 注意：不能加 disable-gpu-compositing —— 它会阻止 compositor 合成，
    //   导致 ready-to-show 永不触发、窗口永远不显示（实测踩坑）
    app.disableHardwareAcceleration();

    // 单实例锁：重复启动时聚焦已有窗口，避免多个实例/多个服务器
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    let win = null;

    app.whenReady().then(() => {
      win = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        title: 'WebTranslator 电脑版',
        autoHideMenuBar: true,
        backgroundColor: '#0d1117',
        show: false, // 等页面就绪再显示，避免白屏/闪烁
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: require('path').join(__dirname, 'preload.js'),
          additionalArguments: [`--api-url=${url}`, `--auth-token=${authToken || ''}`, `--theme=${theme || 'dark'}`],
        },
      });
      win.once('ready-to-show', () => win.show());
      // 彻底隐藏菜单栏（避免顶部横条）
      win.setMenuBarVisibility(false);
      win.setAutoHideMenuBar(true);
      win.center();
      // ★ 双保险：无论 ready-to-show 是否触发，5 秒后强制显示窗口（避免窗口"消失"）
      setTimeout(() => {
        if (win && !win.isVisible()) {
          console.warn('[WebTranslator] ready-to-show 未触发，强制显示窗口');
          win.show();
        }
      }, 5000);
      // ★ 页面用本地文件加载（不走网络），从根本上杜绝"一直转圈"；
      //    API 请求通过 preload 注入的 window.apiBase 指向本地服务
      win.loadFile(require('path').join(__dirname, 'renderer', 'index.html'));
      // 加载超时保护：8 秒未就绪（杀软拦截/端口异常）则明确提示
      setTimeout(() => {
        if (win && !win.webContents.isLoading() && !win.isVisible()) {
          dialog.showErrorBox('页面加载超时',
            `本地页面迟迟未就绪。\n\n请在浏览器中手动打开:\n${url}\n\n或将本程序目录加入杀毒软件白名单后重启。`);
        }
      }, 8000);
      // 页面加载失败兜底：明确提示用户手动打开
      win.webContents.on('did-fail-load', (e, code, desc, validatedURL) => {
        if (code === -3) return; // ERR_ABORTED（正常导航中断）
        console.error(`[WebTranslator] 页面加载失败 (${code}): ${desc}`);
        dialog.showErrorBox('页面加载失败',
          `本地页面加载失败（错误码 ${code}）。\n\n请在浏览器中手动打开:\n${url}\n\n或重启本程序。`);
      });
      // 外部链接用系统浏览器打开；blob/file（本地网站预览）允许新窗口
      win.webContents.setWindowOpenHandler(({ url: u }) => {
        if (u.startsWith('blob:') || u.startsWith('file:')) return { action: 'allow' };
        if (u.startsWith('http')) shell.openExternal(u);
        return { action: 'deny' };
      });
      // a[download] 下载 → 弹系统保存对话框
      session.defaultSession.on('will-download', (event, item) => {
        event.preventDefault();
        const defaultName = item.getFilename();
        dialog.showSaveDialog(win, { defaultPath: defaultName }).then((r) => {
          if (!r.canceled && r.filePath) item.setSavePath(r.filePath);
          item.resume();
        });
      });
      win.on('closed', () => app.quit());
    });
    // 重复启动（再次双击）→ 聚焦已有窗口
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    app.on('window-all-closed', () => app.quit());
  } else {
    // 浏览器模式：自动打开默认浏览器
    const { exec } = require('child_process');
    try {
      exec(`start "" "${url}"`, { windowsHide: true });
    } catch (e) {
      console.log(`请在浏览器打开: ${url}`);
    }
    console.log(`[WebTranslator] 浏览器模式，按 Ctrl+C 退出。服务端口: ${port}`);
  }
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
