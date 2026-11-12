'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog, shell, powerSaveBlocker, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

// 인터넷 요청: 윈도우의 프록시·보안 프로그램 설정을 따르는 방식(net.fetch)을 먼저 쓰고,
// 그것이 실패하면 기본 방식(fetch)으로 한 번 더 시도합니다.
global.preshowFetch = async (url, opts) => {
  let first = null;
  try { if (app.isReady()) return await net.fetch(String(url), opts); } catch (e) { first = e; }
  try { return await fetch(url, opts); } catch (e) { e.first = first; throw e; }
};
const tmdb = require('./lib/tmdb');
const trailers = require('./lib/trailers');
const browser = require('./lib/browser');
const updater = require('./lib/updater');

// USB 폴더 안에서만 읽고 쓰도록 경로를 고정합니다.
const ROOT = process.env.PRESHOW_ROOT || path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const CONFIG_FILE = path.join(DATA, 'config.json');
// 내려받은 포스터·예고편은 임시 파일입니다. 프로그램을 끌 때 지우고,
// 비정상 종료로 남았을 수 있으니 켤 때도 한 번 지웁니다. (설정 파일은 남깁니다)
function clearCache() {
  try { fs.rmSync(CACHE, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); } catch (e) { /* 다음 실행 때 다시 시도 */ }
}
clearCache();
fs.mkdirSync(CACHE, { recursive: true });
app.setPath('userData', path.join(DATA, 'electron'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// PC 종류(x64 / ARM64)에 맞는 도구 폴더를 고릅니다. ARM64용이 없으면 x64용을 씁니다(윈도우 11이 대신 실행해 줌).
function pickBinDir() {
  const arm = path.join(ROOT, 'runtime', 'bin-arm64');
  if (process.arch === 'arm64' && fs.existsSync(path.join(arm, 'yt-dlp.exe'))) return arm;
  return path.join(ROOT, 'runtime', 'bin');
}
trailers.init(pickBinDir(), path.join(__dirname, 'assets', 'channels.json'));

const DEFAULTS = {
  tmdbKey: '', ottUrl: '', displayId: null,
  remote: { enabled: false, password: '', brokers: [] },
  options: { reduceFx: false, autoF11: true, cutTrailer: false, infoSeconds: 50, trailerVolume: 100, flicker: true, posterLight: true, ambientOff: false, ambientLevel: 'mid' },
};

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, j, { options: Object.assign({}, DEFAULTS.options, j.options || {}), remote: Object.assign({}, DEFAULTS.remote, j.remote || {}) });
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function saveConfig(c) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8');
}

// 포스터에서 가장 눈에 띄는 색을 뽑아 [r,g,b]로 돌려줍니다(조명 색으로 사용). 무채색 포스터면 null.
function posterColor(posterUrl) {
  try {
    if (!posterUrl || !/^file:/i.test(posterUrl)) return null;
    let img = nativeImage.createFromPath(fileURLToPath(posterUrl));
    if (img.isEmpty()) return null;
    img = img.resize({ width: 48 });
    const px = img.toBitmap(); // BGRA
    const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let count = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      const b = px[i] / 255, g = px[i + 1] / 255, r = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      count++;
      if (max < 0.22 || d / (max || 1) < 0.28) continue; // 너무 어둡거나 회색인 점은 제외
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const sat = d / max;
      const w = sat * sat * max;
      const k = buckets[Math.floor(h / 30) % 12];
      k.w += w; k.r += r * w; k.g += g * w; k.b += b * w;
    }
    const top = buckets.reduce((a, c) => (c.w > a.w ? c : a), buckets[0]);
    if (!count || top.w / count < 0.012) return null;
    let r = top.r / top.w, g = top.g / top.w, b = top.b / top.w;
    // 조명으로 쓰기 좋게 채도와 밝기를 끌어올립니다.
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    const ns = Math.max(sat, 0.62), nv = Math.min(0.98, Math.max(max, 0.85));
    const fix = (c) => { const rel = max - min ? (max - c) / (max - min) : 0; return Math.round(255 * nv * (1 - ns * rel)); };
    return [fix(r), fix(g), fix(b)];
  } catch (e) { return null; }
}

let setupWin = null;
let showWin = null;
let showData = null;
let blockerId = null;

const fileUrl = (p) => (p ? pathToFileURL(p).href : null);

function createSetup() {
  setupWin = new BrowserWindow({
    width: 1500, height: 920, minWidth: 1180, minHeight: 720, backgroundColor: '#0A0507', title: '프리쇼 세팅',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  setupWin.removeMenu();
  setupWin.maximize();
  setupWin.loadFile(path.join(__dirname, 'ui', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; if (showWin) { try { showWin.destroy(); } catch (e) { /* 무시 */ } } });
  setupWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function closeShow(afterOtt) {
  if (afterOtt !== true) { try { browser.killHelper(); } catch (e) { /* 무시 */ } }
  if (blockerId !== null) { try { powerSaveBlocker.stop(blockerId); } catch (e) { /* 무시 */ } blockerId = null; }
  if (showWin) { const w = showWin; showWin = null; try { w.destroy(); } catch (e) { /* 무시 */ } }
  if (setupWin) {
    // OTT가 열린 뒤에는 세팅 창이 영화를 가리지 않도록 최소화해 둡니다.
    if (afterOtt === true) setupWin.minimize(); else setupWin.show();
    setupWin.webContents.send('show:closed');
  }
}

function targetDisplay(id) {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

function startShow(payload) {
  if (showWin) closeShow();
  const d = targetDisplay(payload.displayId);
  showData = payload;
  showData._bounds = d.bounds;
  showWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, fullscreen: true, backgroundColor: '#000000', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  showWin.removeMenu();
  showWin.loadFile(path.join(__dirname, 'ui', 'show.html'));
  showWin.once('ready-to-show', () => { showWin.show(); showWin.focus(); });
  showWin.on('closed', () => { if (showWin) { showWin = null; closeShow(false); } });
  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (setupWin && screen.getAllDisplays().length < 2) setupWin.minimize();
}

app.whenReady().then(() => {
  createSetup();

  ipcMain.handle('config:get', () => loadConfig());
  ipcMain.handle('config:set', (e, patch) => {
    const c = loadConfig();
    const next = Object.assign({}, c, patch, { options: Object.assign({}, c.options, (patch && patch.options) || {}), remote: Object.assign({}, c.remote, (patch && patch.remote) || {}) });
    saveConfig(next);
    return next;
  });

  ipcMain.handle('env:info', () => {
    const b = browser.findBrowser();
    return {
      displays: screen.getAllDisplays().map((d, i) => ({
        id: String(d.id), label: '모니터 ' + (i + 1) + ' · ' + d.size.width + '×' + d.size.height + (d.id === screen.getPrimaryDisplay().id ? ' (주 화면)' : ''),
        primary: d.id === screen.getPrimaryDisplay().id,
      })),
      browser: b ? b.name : null,
      tools: trailers.toolsStatus(),
      audio: ['announcement.wav', 'beep.wav', 'beep_hi.wav', 'beep_go.wav'].map((n) => ({ name: n, ok: fs.existsSync(path.join(__dirname, 'assets', 'audio', n)) })),
      root: ROOT,
      version: app.getVersion(),
    };
  });

  // 프로그램 업데이트
  ipcMain.handle('update:check', () => updater.check(__dirname));
  ipcMain.handle('update:download', async (e) => {
    let last = 0;
    return updater.download(__dirname, ROOT, (bytes) => {
      const now = Date.now();
      if (now - last > 300 && !e.sender.isDestroyed()) { last = now; e.sender.send('update:progress', bytes); }
    });
  });
  ipcMain.handle('update:restart', () => {
    const ok = updater.relaunch(ROOT);
    if (ok) setTimeout(() => app.quit(), 300);
    return ok;
  });

  ipcMain.handle('movie:search', (e, q) => tmdb.search(q, loadConfig().tmdbKey));
  ipcMain.handle('movie:details', async (e, id) => {
    const m = await tmdb.details(id, loadConfig().tmdbKey, CACHE);
    m.posterUrl = fileUrl(m.posterFile);
    return m;
  });

  ipcMain.handle('trailer:find', (e, movie) => trailers.find(movie));
  ipcMain.handle('trailer:search', (e, q) => trailers.search(q, 15));
  ipcMain.handle('trailer:download', async (e, cand, movieId) => {
    const dir = path.join(CACHE, String(movieId || 'manual'), 'trailers');
    const r = await trailers.download(cand, dir, (p) => { if (!e.sender.isDestroyed()) e.sender.send('trailer:progress', { id: cand.id, percent: p }); });
    return Object.assign({}, r, { fileUrl: fileUrl(r.file), subUrl: fileUrl(r.subFile) });
  });
  ipcMain.handle('trailer:updateTool', () => trailers.updateTool());

  ipcMain.handle('dialog:pick', async (e, kind) => {
    const filters = kind === 'image'
      ? [{ name: '이미지', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
      : [{ name: '동영상', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov'] }];
    const r = await dialog.showOpenDialog(setupWin, { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    return { file: r.filePaths[0], fileUrl: fileUrl(r.filePaths[0]), name: path.basename(r.filePaths[0]) };
  });

  ipcMain.handle('open:external', (e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });

  ipcMain.handle('show:start', (e, payload) => { startShow(payload); return true; });
  ipcMain.handle('show:data', () => {
    let subs = { lines: [] };
    try { subs = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'subtitles.json'), 'utf8')); } catch (err) { /* 자막 없이 진행 */ }
    const d = showData || {};
    const light = d.options && d.options.posterLight !== false && d.movie ? posterColor(d.movie.posterUrl) : null;
    return Object.assign({}, showData, { subtitles: subs.lines || [], annScenes: subs.scenes || [], posterColor: light });
  });
  ipcMain.handle('show:close', () => { closeShow(false); });
  // 리모컨: 상영 화면의 상태는 세팅 창으로, 리모컨 명령은 상영 화면으로 전달합니다.
  ipcMain.on('show:status', (e, st) => { if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('show:status', st); });
  ipcMain.handle('remote:cmd', (e, cmd) => {
    if (!showWin || showWin.isDestroyed()) return false;
    showWin.webContents.send('remote:cmd', cmd);
    return true;
  });
  // 카운트다운이 시작되면 OTT를 열 준비를 미리 해 둡니다(상영 시각에 지체 없이 열기 위해).
  ipcMain.handle('show:prepareOtt', () => {
    const d = showData || {};
    if (d.rehearsal || !d.ottUrl) return false;
    try { return browser.prepare(d.ottUrl, d._bounds, d.options && d.options.autoF11); } catch (err) { return false; }
  });
  ipcMain.handle('show:finish', () => {
    // 상영 시각: OTT를 열고, 잠시 뒤 프리쇼 화면을 닫습니다.
    const d = showData || {};
    let result = { ok: false };
    if (!d.rehearsal && d.ottUrl) {
      try { result = browser.openOtt(d.ottUrl, d._bounds, d.options && d.options.autoF11, shell); } catch (err) { result = { ok: false, error: err.message }; }
      if (showWin) { try { showWin.setAlwaysOnTop(false); showWin.blur(); } catch (err) { /* 무시 */ } }
    }
    const opened = !!result.ok;
    setTimeout(() => closeShow(opened), d.rehearsal ? 2500 : 9000);
    return result;
  });
});

app.on('window-all-closed', () => app.quit());
app.on('quit', clearCache);
