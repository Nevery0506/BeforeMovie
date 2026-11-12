'use strict';
// GitHub 저장소에서 새 버전을 확인하고 내려받습니다.
// 내려받은 파일은 update_pending 폴더에 풀어 두고, 프로그램을 다시 켤 때 START.bat이 app 폴더에 덮어씁니다.
// (실행 중인 파일을 직접 바꾸지 않기 위해서입니다. runtime, data 폴더와 음성 파일은 건드리지 않습니다.)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';

function repoInfo(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return { version: pkg.version || '0.0.0', repo: pkg.preshowRepo || '', branch: pkg.preshowBranch || 'main' };
  } catch (e) { return { version: '0.0.0', repo: '', branch: 'main' }; }
}

// "1.10.0" 과 "1.9.1" 을 숫자로 비교 (a가 더 새 버전이면 양수)
function compare(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

async function check(appDir) {
  const info = repoInfo(appDir);
  if (!info.repo) throw new Error('업데이트 저장소가 설정되어 있지 않습니다.');
  const url = (process.env.PRESHOW_UPDATE_RAW || 'https://raw.githubusercontent.com/' + info.repo + '/' + info.branch + '/app/package.json') + '?t=' + Date.now();
  let r;
  try { r = await fetch(url, { headers: { 'cache-control': 'no-cache' } }); } catch (e) { throw new Error('인터넷 연결을 확인해 주세요. (업데이트 서버에 연결할 수 없습니다)'); }
  if (r.status === 404) throw new Error('업데이트 저장소에서 프로그램을 찾지 못했습니다.');
  if (!r.ok) throw new Error('업데이트 확인 실패 (' + r.status + ')');
  let latest;
  try { latest = JSON.parse(await r.text()).version; } catch (e) { throw new Error('업데이트 정보를 읽지 못했습니다.'); }
  return { current: info.version, latest, available: compare(latest, info.version) > 0 };
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: 'ignore' }); } catch (e) { reject(e); return; }
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' 실패 (코드 ' + code + ')'))));
  });
}

// 새 버전을 내려받아 root/update_pending 에 풀어 둡니다.
async function download(appDir, root, onProgress) {
  const info = repoInfo(appDir);
  if (!info.repo) throw new Error('업데이트 저장소가 설정되어 있지 않습니다.');
  const work = path.join(root, 'data', 'update_tmp');
  const pending = path.join(root, 'update_pending');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(pending, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const url = process.env.PRESHOW_UPDATE_ZIP || 'https://codeload.github.com/' + info.repo + '/zip/refs/heads/' + info.branch;
  let r;
  try { r = await fetch(url); } catch (e) { throw new Error('인터넷 연결을 확인해 주세요. (내려받기 실패)'); }
  if (!r.ok || !r.body) throw new Error('내려받기 실패 (' + r.status + ')');
  const zip = path.join(work, 'update.zip');
  const out = fs.createWriteStream(zip);
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
    if (onProgress) onProgress(got);
  }
  await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
  if (got < 100000) throw new Error('내려받은 파일이 너무 작습니다. 잠시 뒤 다시 시도해 주세요.');

  // 압축 풀기 (윈도우 10 이상에 들어 있는 tar 사용)
  const ex = path.join(work, 'x');
  fs.mkdirSync(ex, { recursive: true });
  if (isWin) await run('tar', ['-xf', zip, '-C', ex], work);
  else await run('unzip', ['-q', zip, '-d', ex], work);

  const top = fs.readdirSync(ex).map((n) => path.join(ex, n)).find((p) => fs.statSync(p).isDirectory());
  if (!top) throw new Error('내려받은 파일의 구조가 올바르지 않습니다.');
  const newApp = path.join(top, 'app');
  for (const must of ['package.json', 'main.js', path.join('ui', 'show.html')]) {
    if (!fs.existsSync(path.join(newApp, must))) throw new Error('내려받은 파일이 온전하지 않습니다 (' + must + ' 없음).');
  }
  const latest = JSON.parse(fs.readFileSync(path.join(newApp, 'package.json'), 'utf8')).version;

  fs.mkdirSync(pending, { recursive: true });
  fs.renameSync(newApp, path.join(pending, 'app'));
  for (const extra of ['remote', 'README.txt', 'SETUP_FIRST.bat', 'UPDATE_TRAILER_TOOL.bat']) {
    const src = path.join(top, extra);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(pending, extra));
  }
  fs.writeFileSync(path.join(pending, 'READY'), latest, 'utf8');
  fs.rmSync(work, { recursive: true, force: true });
  return { latest };
}

// START.bat 으로 다시 켭니다(다시 켜질 때 update_pending 이 적용됨).
function relaunch(root) {
  const bat = path.join(root, 'START.bat');
  if (!isWin || !fs.existsSync(bat)) return false;
  spawn('cmd.exe', ['/c', 'START.bat'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

module.exports = { check, download, relaunch, compare, repoInfo };
