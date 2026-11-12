'use strict';
// 상영 시각에 OTT 주소를 Chrome으로 열고 바로 전체화면으로 만듭니다.
//
// 윈도우에서는 도우미 스크립트(ott.ps1)가
//   1) 카운트다운이 시작될 때 미리 켜져서 준비해 두고,
//   2) 상영 시각에 신호를 받으면 곧바로 브라우저를 띄우고,
//   3) 새로 뜬 창이 나타나는 즉시 전체화면(F11)으로 바꾼 뒤, 실제로 전체화면이 됐는지 확인합니다.
// 도우미가 동작하지 않으면 예전 방식(전체화면 옵션을 붙여 그냥 열기)으로 대신합니다.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const PS1 = path.join(__dirname, 'ott.ps1');

function candidates() {
  if (!isWin) return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const env = process.env;
  const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA'], env['PROGRAMW6432']].filter(Boolean);
  const list = [];
  roots.forEach((r) => list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')));
  roots.forEach((r) => list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  return list;
}

function findBrowser() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p)) return { path: p, name: /msedge/i.test(p) ? 'Edge' : 'Chrome', proc: /msedge/i.test(p) ? 'msedge' : 'chrome' }; } catch (e) { /* 다음 후보 */ }
  }
  return null;
}

// ── 도우미(미리 준비) ──
let helper = null; // { child, ready, launched, dead, url }

function killHelper() {
  if (helper && helper.child && !helper.dead) { try { helper.child.kill(); } catch (e) { /* 무시 */ } }
  helper = null;
}

function startHelper(url, bounds, noWait) {
  const b = findBrowser();
  if (!isWin || !b || !fs.existsSync(PS1)) return null;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Exe', b.path, '-Url', url, '-Proc', b.proc];
  if (bounds) args.push('-X', String(bounds.x), '-Y', String(bounds.y), '-W', String(bounds.width), '-H', String(bounds.height));
  if (noWait) args.push('-NoWait');
  const h = { child: null, ready: false, launched: false, dead: false, url, browser: b.name };
  try {
    h.child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) { return null; }
  h.child.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('READY')) h.ready = true;
    if (s.includes('LAUNCHED')) h.launched = true;
  });
  h.child.on('error', () => { h.dead = true; });
  h.child.on('exit', () => { h.dead = true; });
  return h;
}

// 카운트다운이 시작될 때 불러 둡니다. (같은 주소로 이미 준비돼 있으면 그대로 둠)
function prepare(url, bounds, autoFull) {
  if (!autoFull || !url) return false;
  if (helper && !helper.dead && helper.url === url) return true;
  killHelper();
  helper = startHelper(url, bounds, false);
  return !!helper;
}

function openPlain(url, bounds, fullFlag, shell) {
  const b = findBrowser();
  if (!b) { shell.openExternal(url); return { ok: true, browser: '기본 브라우저', mode: 'default' }; }
  const args = ['--new-window'];
  if (fullFlag) args.push('--start-fullscreen');
  if (bounds) args.push('--window-position=' + bounds.x + ',' + bounds.y, '--window-size=' + bounds.width + ',' + bounds.height);
  args.push(url);
  spawn(b.path, args, { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, browser: b.name, mode: 'plain' };
}

function openOtt(url, bounds, autoFull, shell) {
  if (!autoFull || !isWin) { killHelper(); return openPlain(url, bounds, false, shell); }

  let h = helper && !helper.dead && helper.url === url ? helper : null;
  helper = null;
  if (h && h.ready) {
    try { h.child.stdin.write('go\n'); } catch (e) { h = null; }  // 준비된 도우미에 신호 → 즉시 실행
  } else {
    if (h) { try { h.child.kill(); } catch (e) { /* 무시 */ } }
    h = startHelper(url, bounds, true);                             // 준비가 안 됐으면 지금 바로 실행
  }
  if (!h) return openPlain(url, bounds, true, shell);

  // 도우미가 브라우저를 띄우지 못하면 예전 방식으로 대신 엽니다.
  setTimeout(() => {
    if (!h.launched) {
      try { h.child.kill(); } catch (e) { /* 무시 */ }
      try { openPlain(url, bounds, true, shell); } catch (e) { /* 무시 */ }
    }
  }, 4000);
  return { ok: true, browser: h.browser, mode: 'helper' };
}

module.exports = { findBrowser, openOtt, prepare, killHelper };
