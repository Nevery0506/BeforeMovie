'use strict';
// 예고편 후보 찾기와 다운로드 (yt-dlp + ffmpeg 사용)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
let BIN = '';
let CHANNELS = { korean: [], global: [] };

function init(binDir, channelsFile) {
  BIN = binDir;
  try { CHANNELS = JSON.parse(fs.readFileSync(channelsFile, 'utf8')); } catch (e) { /* 기본값 사용 */ }
}

function tool(name) {
  const p = path.join(BIN, isWin ? name + '.exe' : name);
  if (fs.existsSync(p)) return p;
  return isWin ? null : name; // 윈도우가 아니면(개발용) PATH에서 찾음
}

function toolsStatus() {
  return { ytdlp: !!tool('yt-dlp'), ffmpeg: !!tool('ffmpeg') };
}

function run(cmd, args, onLine, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
    } catch (e) { reject(e); return; }
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch (e) { /* 무시 */ } }, timeoutMs) : null;
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        buf += s;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        parts.forEach((l) => l && onLine(l));
      }
    });
    let ebuf = '';
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      err += s;
      if (onLine) {
        ebuf += s;
        const parts = ebuf.split(/\r?\n|\r/);
        ebuf = parts.pop();
        parts.forEach((l) => l && onLine(l));
      }
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf && onLine) onLine(buf);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim().split('\n').pop() || '실행 실패') + ' (코드 ' + code + ')'));
    });
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s.\-_·,]/g, '');

// 채널이 공식 목록에 있는지: 'kr' | 'global' | null
function channelKind(channel) {
  const c = norm(channel);
  if (!c) return null;
  const hit = (list) => (list || []).some((n) => {
    const k = norm(n);
    return k && (c === k || (k.length >= 8 && c.includes(k)));
  });
  if (hit(CHANNELS.korean)) return 'kr';
  if (hit(CHANNELS.global)) return 'global';
  return null;
}

const hasHangul = (s) => /[가-힣]/.test(s || '');
const ytUrl = (id) => 'https://www.youtube.com/watch?v=' + id;

function fromTmdb(movie) {
  return (movie.videos || [])
    .filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
    .map((v) => ({
      id: v.key, url: ytUrl(v.key), title: v.name || '예고편', channel: '', duration: null,
      official: !!v.official, korean: v.lang === 'ko' || hasHangul(v.name), teaser: v.type === 'Teaser',
      source: 'tmdb',
    }));
}

async function search(query, count) {
  const y = tool('yt-dlp');
  if (!y) throw new Error('예고편 도구(yt-dlp)가 없습니다. SETUP_FIRST.bat을 먼저 실행해 주세요.');
  const out = await run(y, ['ytsearch' + (count || 12) + ':' + query, '--flat-playlist', '-J', '--no-warnings', '--socket-timeout', '15', '--encoding', 'utf-8'], null, 45000);
  const j = JSON.parse(out);
  return (j.entries || [])
    .filter((e) => e && e.id && (!e.duration || (e.duration >= 20 && e.duration <= 420)))
    .map((e) => {
      const kind = channelKind(e.channel || e.uploader);
      const title = e.title || '';
      return {
        id: e.id, url: ytUrl(e.id), title, channel: e.channel || e.uploader || '', duration: e.duration || null,
        official: !!kind, verified: !!e.channel_is_verified,
        korean: kind === 'kr' || hasHangul(title), teaser: /티저|teaser/i.test(title),
        source: 'search',
      };
    });
}

function score(c) {
  return (c.official ? 100 : 0) + (c.korean ? 60 : 0) + (c.teaser ? 0 : 15) + (c.source === 'tmdb' ? 5 : 0) + (c.verified ? 8 : 0)
    + (/예고편|trailer/i.test(c.title) ? 6 : 0);
}

// 영화에 맞는 예고편 후보를 모아 정렬하고, 자동 선택할 후보를 고릅니다.
async function find(movie) {
  const map = new Map();
  const add = (list) => list.forEach((c) => {
    const old = map.get(c.id);
    if (!old) map.set(c.id, c);
    else map.set(c.id, Object.assign({}, old, c, { official: old.official || c.official, korean: old.korean || c.korean, source: old.source }));
  });
  add(fromTmdb(movie));
  let searchError = null;
  const foreign = movie.originalLanguage && movie.originalLanguage !== 'ko';
  const queries = [movie.title + ' 공식 예고편'];
  if (foreign) queries.push(movie.title + ' 메인 예고편 한글자막');
  for (const q of queries) {
    try { add(await search(q, 10)); } catch (e) { searchError = e.message; }
  }
  // 검색 결과 중 제목과 관련 없는 것은 뒤로
  const key = norm(movie.title).slice(0, 6);
  const okey = norm(movie.originalTitle).slice(0, 8);
  const list = [...map.values()].map((c) => {
    const t = norm(c.title);
    const related = c.source === 'tmdb' || (key && t.includes(key)) || (okey && t.includes(okey));
    return Object.assign(c, { related, score: score(c) + (related ? 0 : -200) });
  }).sort((a, b) => b.score - a.score);

  const good = list.filter((c) => c.related && c.official);
  let auto = null;
  let note = '';
  if (!foreign) {
    auto = good[0] || null;
    if (!auto) note = '공식 예고편을 찾지 못했습니다. 아래 목록에서 직접 골라 주세요.';
  } else {
    auto = good.find((c) => c.korean) || null;
    if (!auto && good[0]) {
      auto = Object.assign(good[0], { needSubs: true });
      note = '한글자막이 들어간 공식 예고편을 찾지 못해, 공식 원어 예고편에 유튜브 한국어 자막을 입혀 사용합니다. 재생해서 확인해 주세요.';
    }
    if (!auto) note = '공식 예고편을 찾지 못했습니다. 아래 목록에서 직접 골라 주세요.';
  }
  return { candidates: list, autoId: auto ? auto.id : null, note, searchError };
}

const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

async function download(cand, destDir, onProgress) {
  const y = tool('yt-dlp');
  const ff = tool('ffmpeg');
  if (!y) throw new Error('예고편 도구(yt-dlp)가 없습니다. SETUP_FIRST.bat을 먼저 실행해 주세요.');
  fs.mkdirSync(destDir, { recursive: true });
  // 파일 이름은 우리가 정합니다(경로에 한글이 있어도 결과 파일을 확실히 찾기 위해).
  const token = String(cand.id || 'video').replace(/[^\w-]/g, '_').slice(0, 40) || 'video';
  fs.readdirSync(destDir).filter((f) => f.startsWith(token + '.')).forEach((f) => { try { fs.unlinkSync(path.join(destDir, f)); } catch (e) { /* 무시 */ } });
  const meta = {};
  const args = [cand.url, '-f', FORMAT, '--merge-output-format', 'mp4', '--no-playlist', '--newline', '--no-warnings', '--progress',
    '--encoding', 'utf-8', '--socket-timeout', '20', '--retries', '5', '-o', path.join(destDir, token + '.%(ext)s'),
    '--progress-template', 'download:PROG %(progress._percent_str)s',
    '--print', 'after_move:META %(height)s|%(duration)s'];
  if (ff && path.isAbsolute(ff)) args.push('--ffmpeg-location', path.dirname(ff));
  await run(y, args, (line) => {
    line = line.trim();
    if (line.startsWith('PROG')) {
      const p = parseFloat(line.replace(/[^\d.]/g, ''));
      if (!isNaN(p) && onProgress) onProgress(Math.min(99, p));
    } else if (line.startsWith('META ')) {
      const parts = line.slice(5).split('|');
      meta.height = parseInt(parts[0], 10) || null;
      meta.duration = parseFloat(parts[1]) || null;
    }
  });
  const made = fs.readdirSync(destDir).filter((f) => f.startsWith(token + '.') && /\.(mp4|webm|mkv|m4v|mov)$/i.test(f) && !/\.part$/i.test(f));
  if (!made.length) throw new Error('다운로드한 파일을 찾을 수 없습니다.');
  meta.file = path.join(destDir, made.find((f) => /\.mp4$/i.test(f)) || made[0]);

  // 한국어 자막(필요한 경우만) — 실패해도 계속 진행
  let subFile = null;
  if (cand.needSubs) {
    try {
      const base = path.join(destDir, token);
      const sargs = [cand.url, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ko', '--convert-subs', 'vtt',
        '--no-playlist', '--no-warnings', '--encoding', 'utf-8', '-o', base + '.%(ext)s'];
      if (ff && path.isAbsolute(ff)) sargs.push('--ffmpeg-location', path.dirname(ff));
      await run(y, sargs, null, 60000);
      if (fs.existsSync(base + '.ko.vtt')) subFile = base + '.ko.vtt';
    } catch (e) { subFile = null; }
  }

  // 음량 맞춤(영상은 그대로, 소리만 다시 인코딩) — 실패해도 계속 진행
  if (ff) {
    try {
      if (!/\.mp4$/i.test(meta.file)) throw new Error('mp4 아님');
      const tmp = path.join(destDir, token + '_norm.mp4');
      await run(ff, ['-y', '-v', 'error', '-i', meta.file, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', tmp], null, 180000);
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 10000) { fs.unlinkSync(meta.file); fs.renameSync(tmp, meta.file); }
    } catch (e) { /* 원본 그대로 사용 */ }
  }
  if (onProgress) onProgress(100);
  return { file: meta.file, height: meta.height, duration: meta.duration, subFile };
}

async function updateTool() {
  const y = tool('yt-dlp');
  if (!y) throw new Error('yt-dlp가 없습니다.');
  return run(y, ['-U'], null, 120000);
}

module.exports = { init, toolsStatus, find, search, download, updateTool, channelKind };
