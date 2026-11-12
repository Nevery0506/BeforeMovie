'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  const S = { config: null, env: null, movie: null, cands: [], selResult: null, themeTouched: false, editPoster: null };

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    });
    (kids || []).forEach((c) => { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    if (tag === 'img') el.addEventListener('error', () => el.remove());
    return el;
  }
  const fmtDur = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '');
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  // ── 장르 → 테마 ──
  const THEME_BY_ID = { 878: 'sf', 14: 'sf', 27: 'horror', 53: 'horror', 9648: 'horror', 10749: 'romance', 28: 'action', 80: 'action', 10752: 'action', 37: 'action' };
  const THEME_BY_NAME = [[/SF|판타지|공상/i, 'sf'], [/공포|호러|스릴러|미스터리/, 'horror'], [/로맨스|멜로/, 'romance'], [/액션|범죄|전쟁|서부|무협/, 'action']];
  function themeFor(m) {
    for (const id of m.genreIds || []) if (THEME_BY_ID[id]) return THEME_BY_ID[id];
    for (const g of m.genres || []) for (const [re, t] of THEME_BY_NAME) if (re.test(g)) return t;
    return 'default';
  }

  // ── 휴대전화 리모컨 (인터넷 중계) ──
  const R = { relay: null, text: '리모컨 꺼짐', cls: '', show: null, showAt: 0, idleResult: null };
  function remoteStat(text, cls) {
    R.text = text; R.cls = cls || '';
    const el = $('remoteStat');
    if (el) { el.textContent = text; el.className = R.cls; }
  }
  const showRunning = () => !!R.show && Date.now() - R.showAt < 3500 && R.show.phase !== 'end';
  function publishState() {
    if (!R.relay) return;
    const running = showRunning();
    R.relay.send({
      kind: 'state', running, show: running ? R.show : null, result: running ? R.show.lastResult : R.idleResult,
      setup: { title: S.movie ? S.movie.title : '', trailersReady: S.cands.filter((c) => c.use && c.state === 'ready').length, plannedStart: startAt() },
    });
  }
  async function onRemote(cmd) {
    if (!cmd || !cmd.type) return;
    if (cmd.type === 'hello') { publishState(); return; }
    const delivered = await api.remoteCommand(cmd);
    if (!delivered) { R.idleResult = { id: cmd.id, ok: false, msg: '상영 화면이 켜져 있지 않습니다' }; publishState(); }
  }
  async function startRelay() {
    if (R.relay) { R.relay.close(); R.relay = null; }
    const r = S.config.remote || {};
    if (!r.enabled) { remoteStat('리모컨 꺼짐'); return; }
    if (!r.password || r.password.length < 8) { remoteStat('리모컨: 비밀번호 필요', 'bad'); return; }
    remoteStat('리모컨 연결 중…');
    try {
      R.relay = await window.PreShowRelay.connect({
        role: 'pc', password: r.password, brokers: r.brokers, onMessage: onRemote,
        onStatus: (n, total) => remoteStat(n ? '리모컨 대기 중 (중계 ' + n + '/' + total + ')' : '리모컨: 중계 서버 연결 안 됨', n ? 'ok' : 'bad'),
      });
    } catch (e) { remoteStat('리모컨 오류: ' + errText(e), 'bad'); }
  }
  api.on('show:status', (st) => { R.show = st; R.showAt = Date.now(); publishState(); });
  api.on('show:closed', () => { R.show = null; publishState(); });
  setInterval(() => { if (!showRunning()) publishState(); }, 2000);

  // ── 상태 표시 ──
  function renderEnv() {
    $('ver').textContent = '버전 ' + (S.env.version || '?');
    $('ver').title = S.env.root || '';
    const e = S.env;
    const st = $('status');
    st.innerHTML = '';
    st.appendChild(h('span', { class: navigator.onLine ? 'ok' : 'bad', text: navigator.onLine ? '인터넷 연결됨' : '인터넷 연결 안 됨' }));
    st.appendChild(h('span', { class: e.browser ? 'ok' : 'bad', text: e.browser ? e.browser + ' 확인됨' : 'Chrome 없음' }));
    st.appendChild(h('span', { id: 'remoteStat', class: R.cls, text: R.text }));

    const sel = $('disp');
    sel.innerHTML = '';
    e.displays.forEach((d) => sel.appendChild(h('option', { value: d.id, text: d.label })));
    const saved = S.config.displayId && e.displays.find((d) => d.id === String(S.config.displayId));
    const second = e.displays.find((d) => !d.primary);
    sel.value = saved ? saved.id : (second ? second.id : e.displays[0].id);
    renderChecks();
  }

  function renderChecks() {
    const e = S.env;
    const box = $('checks');
    box.innerHTML = '';
    const row = (label, state, cls) => box.appendChild(h('div', {}, [h('span', { text: label }), h('em', { class: cls || '', text: state })]));
    const audioOk = e.audio.every((a) => a.ok);
    row('안내방송·효과음 파일 (4개)', audioOk ? '확인' : '파일 없음', audioOk ? '' : 'bad');
    row('예고편 다운로드 도구', e.tools.ytdlp && e.tools.ffmpeg ? '확인' : '없음 · SETUP_FIRST.bat 실행', e.tools.ytdlp && e.tools.ffmpeg ? '' : 'bad');
    row('영화 정보 조회 키 (TMDB)', S.config.tmdbKey ? '입력됨' : '없음 · [설정]에서 입력', S.config.tmdbKey ? '' : 'warn');
    row('OTT를 열 브라우저', e.browser || '없음 · 기본 브라우저 사용', e.browser ? '' : 'warn');
    const ready = S.cands.filter((c) => c.use && c.state === 'ready').length;
    const loading = S.cands.filter((c) => c.state === 'downloading').length;
    row('예고편', loading ? '다운로드 중…' : (ready ? ready + '개 준비됨' : '없음 · 정보 화면만 표시'), loading || !ready ? 'warn' : '');
    $('stepInfo').textContent = '정보 화면 ' + S.config.options.infoSeconds + '초 ↔ 예고편 반복';
  }

  // ── 영화 검색 ──
  async function doSearch(q) {
    const hint = $('searchHint');
    const box = $('results');
    if (!q.trim()) return;
    hint.className = 'hint';
    hint.textContent = '검색 중…';
    box.innerHTML = '';
    try {
      const list = await api.searchMovies(q.trim());
      hint.textContent = list.length ? '검색 결과 ' + list.length + '건' : '검색 결과가 없습니다. 다른 제목으로 찾아보거나 직접 입력하세요.';
      list.forEach((r) => {
        const btn = h('button', { type: 'button', class: 'res', onclick: () => pickResult(r, btn) }, [
          h('div', { class: 'th' }, [r.poster ? h('img', { src: r.poster, alt: '' }) : null]),
          h('div', { class: 'tx' }, [
            h('b', { text: r.title }),
            h('span', { text: [r.year, r.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ') }),
            r.rating !== null ? h('em', { text: '★ ' + r.rating.toFixed(1) }) : null,
          ]),
        ]);
        box.appendChild(btn);
      });
    } catch (e) {
      hint.className = 'hint bad';
      hint.textContent = errText(e);
    }
  }

  async function pickResult(r, btn) {
    document.querySelectorAll('.res.sel').forEach((b) => b.classList.remove('sel'));
    btn.classList.add('sel');
    const hint = $('searchHint');
    hint.className = 'hint';
    hint.textContent = '「' + r.title + '」 정보를 가져오는 중…';
    try {
      const m = await api.movieDetails(r.id);
      hint.textContent = '선택됨: ' + m.title;
      setMovie(m, true);
    } catch (e) {
      hint.className = 'hint bad';
      hint.textContent = errText(e);
    }
  }

  // ── 영화 정보 표시 ──
  function setMovie(m, findTrailers) {
    S.movie = m;
    $('empty').classList.add('hide');
    $('detail').classList.remove('hide');
    renderMovie();
    if (!S.themeTouched) $('theme').value = themeFor(m);
    $('tq').value = m.title + ' 예고편';
    if (findTrailers) {
      S.cands = [];
      renderTrailers();
      autoTrailers();
    }
    validate();
  }

  function renderMovie() {
    const m = S.movie;
    const p = $('mPoster');
    p.innerHTML = '';
    p.appendChild(m.posterUrl ? h('img', { src: m.posterUrl, alt: m.title + ' 포스터' }) : h('span', { text: '포스터 없음' }));
    $('mTitle').textContent = m.title;
    $('mSub').textContent = [m.originalTitle && m.originalTitle !== m.title ? m.originalTitle : '', m.year, m.runtime ? m.runtime + '분' : '', m.certification].filter(Boolean).join(' · ');
    const chips = $('mChips');
    chips.innerHTML = '';
    (m.genres || []).forEach((g) => chips.appendChild(h('span', { text: g })));
    if (m.rating !== null && m.rating !== undefined && m.rating !== '') chips.appendChild(h('span', { class: 'rate', text: '★ ' + Number(m.rating).toFixed(1) }));
    $('mCredit').textContent = [m.director ? '감독 ' + m.director : '', (m.cast || []).length ? '출연 ' + m.cast.join(', ') : ''].filter(Boolean).join(' · ');
    $('mPlot').textContent = m.overview || '(줄거리 없음 — [정보 수정]에서 직접 넣을 수 있습니다)';
  }

  // ── 예고편 ──
  async function autoTrailers() {
    const note = $('trailerNote');
    note.classList.remove('hide');
    note.textContent = '공식 예고편을 찾는 중…';
    const movieAtStart = S.movie;
    try {
      const r = await api.findTrailers(S.movie);
      if (S.movie !== movieAtStart) return;
      S.cands = r.candidates.map((c) => Object.assign(c, { state: 'idle', use: false, percent: 0 }));
      const msgs = [];
      if (r.note) msgs.push(r.note);
      if (r.searchError) msgs.push('유튜브 검색을 하지 못했습니다: ' + r.searchError);
      note.textContent = msgs.join(' ');
      note.classList.toggle('hide', !msgs.length);
      renderTrailers();
      const auto = S.cands.find((c) => c.id === r.autoId);
      if (auto) download(auto);
    } catch (e) {
      note.textContent = '예고편을 찾지 못했습니다: ' + errText(e);
    }
  }

  function candRow(c) {
    const badges = h('div', { class: 'badges' }, [
      c.source === 'file' ? h('span', { text: 'PC 파일' }) : (c.official ? h('span', { class: 'off', text: '공식' }) : h('span', { class: 'unoff', text: c.verified ? '인증 채널 · 비공식 목록' : '비공식' })),
      c.source !== 'file' ? h('span', { text: c.korean ? '한글 예고편' : (c.needSubs ? '한국어 자막 입힘' : '한글자막 미확인') }) : null,
      c.teaser ? h('span', { text: '티저' }) : null,
      c.height ? h('span', { text: c.height + 'p' }) : null,
      c.duration ? h('span', { text: fmtDur(c.duration) }) : null,
    ]);
    const stateText = { idle: '', downloading: '다운로드 중 ' + Math.round(c.percent) + '%', ready: c.use ? '사용 중' : '다운로드 완료', error: c.error || '실패' }[c.state];
    const btns = h('div', { class: 'tbtns' });
    if (c.url) btns.appendChild(h('button', { type: 'button', class: 'btn ghost small', text: '원본 보기', onclick: () => api.openExternal(c.url) }));
    if (c.state === 'ready') {
      btns.appendChild(h('button', { type: 'button', class: 'btn ghost small', text: '미리보기', onclick: () => preview(c) }));
      btns.appendChild(h('button', { type: 'button', class: 'btn small ' + (c.use ? 'ghost' : 'outline'), text: c.use ? '사용 안 함' : '사용', onclick: () => { c.use = !c.use; renderTrailers(); } }));
    } else if (c.state !== 'downloading') {
      btns.appendChild(h('button', { type: 'button', class: 'btn outline small', text: c.state === 'error' ? '다시 시도' : '다운로드해서 사용', onclick: () => download(c) }));
    }
    const bar = h('div', { class: 'bar' + (c.state === 'ready' ? ' done' : '') }, [h('i', { style: 'width:' + (c.state === 'ready' ? 100 : c.percent) + '%' })]);
    return h('div', { class: 'tr' + (c.use && c.state === 'ready' ? ' use' : ''), 'data-id': c.id }, [
      h('div', { class: 'tthumb' }, [c.source !== 'file' && /^[\w-]{11}$/.test(c.id) ? h('img', { src: 'https://i.ytimg.com/vi/' + c.id + '/mqdefault.jpg', alt: '' }) : null]),
      h('div', { class: 'tmain' }, [h('b', { text: c.title }), c.channel ? h('div', { class: 'ch', text: c.channel }) : null, badges]),
      h('div', { class: 'tside' }, [btns, h('div', { class: 'tstate' + (c.state === 'ready' ? ' ok' : c.state === 'error' ? ' bad' : ''), text: stateText }), c.state === 'downloading' || c.state === 'ready' ? bar : null]),
    ]);
  }

  function renderTrailers() {
    const box = $('tlist');
    box.innerHTML = '';
    if (!S.cands.length) box.appendChild(h('div', { class: 'hint', text: '아직 예고편 후보가 없습니다.' }));
    S.cands.forEach((c) => box.appendChild(candRow(c)));
    renderChecks();
  }

  async function download(c) {
    if (c.state === 'downloading') return;
    c.state = 'downloading'; c.percent = 0; c.error = '';
    renderTrailers();
    try {
      const r = await api.downloadTrailer({ id: c.id, url: c.url, needSubs: !!c.needSubs || (!c.korean && S.movie && S.movie.originalLanguage && S.movie.originalLanguage !== 'ko') }, S.movie ? S.movie.id : 'manual');
      Object.assign(c, { state: 'ready', use: true, fileUrl: r.fileUrl, subUrl: r.subUrl, height: r.height, duration: r.duration || c.duration });
      if (r.subUrl) c.needSubs = true;
      if (r.height && r.height < 1080) c.lowRes = true;
    } catch (e) {
      c.state = 'error';
      c.error = errText(e).slice(0, 80);
    }
    renderTrailers();
  }

  function preview(c) {
    const v = $('preview');
    v.classList.remove('hide');
    v.querySelectorAll('track').forEach((t) => t.remove());
    v.src = c.fileUrl;
    if (c.subUrl) v.appendChild(h('track', { kind: 'subtitles', srclang: 'ko', src: c.subUrl, default: '' }));
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  api.on('trailer:progress', (d) => {
    const c = S.cands.find((x) => x.id === d.id);
    if (!c || c.state !== 'downloading') return;
    c.percent = d.percent;
    const row = document.querySelector('.tr[data-id="' + CSS.escape(c.id) + '"]');
    if (row) {
      const bar = row.querySelector('.bar i'); if (bar) bar.style.width = c.percent + '%';
      const st = row.querySelector('.tstate'); if (st) st.textContent = '다운로드 중 ' + Math.round(c.percent) + '%';
    }
  });

  $('tSearchForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = $('tq').value.trim();
    if (!q) return;
    const note = $('trailerNote');
    note.classList.remove('hide');
    note.textContent = '「' + q + '」 검색 중…';
    try {
      const list = await api.searchTrailers(q);
      let added = 0;
      list.forEach((c) => { if (!S.cands.find((x) => x.id === c.id)) { S.cands.push(Object.assign(c, { state: 'idle', use: false, percent: 0 })); added++; } });
      note.textContent = added ? added + '개의 영상을 목록 아래에 추가했습니다. [원본 보기]로 확인한 뒤 고르세요.' : '새로 추가할 영상이 없습니다.';
      renderTrailers();
    } catch (e) { note.textContent = '검색하지 못했습니다: ' + errText(e); }
  });

  $('tUrlForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const url = $('turl').value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    const c = { id: m ? m[1] : 'url-' + Date.now(), url, title: '직접 지정한 영상', channel: url, official: false, korean: false, source: 'url', state: 'idle', use: false, percent: 0 };
    S.cands.unshift(c);
    $('turl').value = '';
    download(c);
  });

  $('btnTFile').addEventListener('click', async () => {
    const f = await api.pickFile('video');
    if (!f) return;
    S.cands.unshift({ id: 'file-' + Date.now(), url: '', title: f.name, channel: f.file, source: 'file', state: 'ready', use: true, percent: 100, fileUrl: f.fileUrl, duration: null });
    renderTrailers();
  });

  // ── 상영 시각 ──
  function setStartIn(min) {
    const d = new Date(Date.now() + min * 60000);
    const p = (n) => String(n).padStart(2, '0');
    $('start').value = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    updateStartHint();
  }
  function startAt() {
    const v = $('start').value;
    if (!v) return null;
    const [hh, mm, ss] = v.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, ss || 0, 0);
    if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  function updateStartHint() {
    const t = startAt();
    const el = $('startHint');
    if (!t) { el.textContent = ''; return; }
    const sec = Math.round((t - Date.now()) / 1000);
    el.className = 'hint' + (sec < 75 ? ' bad' : sec < 180 ? ' warn' : '');
    if (sec < 0) el.textContent = '이미 지난 시각입니다';
    else if (sec >= 3600) el.textContent = Math.floor(sec / 3600) + '시간 ' + Math.floor((sec % 3600) / 60) + '분 뒤';
    else el.textContent = Math.floor(sec / 60) + '분 ' + (sec % 60) + '초 뒤' + (sec < 75 ? ' · 안내방송이 잘립니다' : '');
  }
  document.querySelectorAll('.quick [data-min]').forEach((b) => b.addEventListener('click', () => setStartIn(Number(b.dataset.min))));
  $('start').addEventListener('input', updateStartHint);
  setInterval(updateStartHint, 1000);

  // ── 시작 ──
  function validate() {
    const msg = $('startMsg');
    msg.classList.add('hide');
    return true;
  }
  function showMsg(text, warn) {
    const msg = $('startMsg');
    msg.textContent = text;
    msg.className = 'msg' + (warn ? ' warn' : '');
  }
  function payload(rehearsal) {
    const o = Object.assign({}, S.config.options);
    let t = startAt();
    if (rehearsal) { t = Date.now() + 112000; o.cutTrailer = true; o.infoSeconds = 10; }
    return {
      movie: S.movie, theme: $('theme').value, startAt: t, ottUrl: $('ott').value.trim(), displayId: $('disp').value, rehearsal: !!rehearsal, options: o,
      trailers: S.cands.filter((c) => c.use && c.state === 'ready').map((c) => ({ fileUrl: c.fileUrl, subUrl: c.subUrl || null, duration: c.duration || null, title: c.title })),
    };
  }
  async function start(rehearsal) {
    if (!S.movie) { showMsg('먼저 상영할 영화를 선택해 주세요.'); return; }
    const p = payload(rehearsal);
    if (!rehearsal) {
      if (!p.startAt) { showMsg('영화 상영 시각을 입력해 주세요.'); return; }
      const sec = (p.startAt - Date.now()) / 1000;
      if (sec < 15) { showMsg('상영 시각이 너무 가깝습니다. 시각을 다시 정해 주세요.'); return; }
      if (p.ottUrl && !/^https?:\/\//i.test(p.ottUrl)) { showMsg('OTT 주소는 https:// 로 시작해야 합니다.'); return; }
      if (S.cands.some((c) => c.state === 'downloading')) { showMsg('예고편 다운로드가 끝난 뒤 시작해 주세요.'); return; }
    }
    $('startMsg').classList.add('hide');
    S.config = await api.setConfig({ ottUrl: $('ott').value.trim(), displayId: $('disp').value });
    $('preview').pause();
    await api.startShow(p);
  }
  $('btnStart').addEventListener('click', () => start(false));
  $('btnRehearsal').addEventListener('click', () => start(true));
  api.on('show:closed', () => { updateStartHint(); });

  // ── 설정 창 ──
  function openSettings() {
    const c = S.config;
    $('sKey').value = c.tmdbKey || '';
    $('sInfo').value = c.options.infoSeconds;
    $('sVol').value = c.options.trailerVolume;
    $('sCut').checked = !!c.options.cutTrailer;
    $('sF11').checked = !!c.options.autoF11;
    $('sReduce').checked = !!c.options.reduceFx;
    $('sFlicker').checked = !!c.options.flicker;
    $('sPosterLight').checked = c.options.posterLight !== false;
    $('sAmbOff').checked = !!c.options.ambientOff;
    $('sAmbLevel').value = c.options.ambientLevel || 'mid';
    $('sRemote').checked = !!(c.remote && c.remote.enabled);
    $('sRemotePw').value = (c.remote && c.remote.password) || '';
    $('remoteMsg').className = 'hint';
    $('remoteMsg').textContent = '비밀번호를 아는 사람은 누구나 조종할 수 있으니 길게 정하세요.';
    $('modalSettings').classList.remove('hide');
    $('sKey').focus();
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettingsCancel').addEventListener('click', () => $('modalSettings').classList.add('hide'));
  $('btnSettingsSave').addEventListener('click', async () => {
    if ($('sRemote').checked && $('sRemotePw').value.trim().length < 8) {
      $('remoteMsg').className = 'hint bad';
      $('remoteMsg').textContent = '리모컨 비밀번호는 8자 이상이어야 합니다.';
      $('sRemotePw').focus();
      return;
    }
    const clamp = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    S.config = await api.setConfig({
      tmdbKey: $('sKey').value.trim(),
      remote: { enabled: $('sRemote').checked, password: $('sRemotePw').value.trim() },
      options: {
        infoSeconds: clamp($('sInfo').value, 10, 600, 50), trailerVolume: clamp($('sVol').value, 0, 100, 100),
        cutTrailer: $('sCut').checked, autoF11: $('sF11').checked, reduceFx: $('sReduce').checked, flicker: $('sFlicker').checked, posterLight: $('sPosterLight').checked, ambientOff: $('sAmbOff').checked, ambientLevel: $('sAmbLevel').value,
      },
    });
    $('modalSettings').classList.add('hide');
    renderChecks();
    startRelay();
  });
  $('btnKeyHelp').addEventListener('click', () => api.openExternal('https://www.themoviedb.org/settings/api'));
  $('btnUpdateTool').addEventListener('click', async () => {
    const m = $('toolMsg');
    m.className = 'hint';
    m.textContent = '업데이트 중…';
    try { await api.updateTool(); m.className = 'hint ok'; m.textContent = '최신 버전입니다.'; } catch (e) { m.className = 'hint bad'; m.textContent = errText(e); }
  });

  // ── 프로그램 업데이트 ──
  const U = { state: 'idle', latest: '' };
  function updMsg(text, cls) { const m = $('updMsg'); m.className = 'hint' + (cls ? ' ' + cls : ''); m.textContent = text; }
  async function updateCheck(silent) {
    if (U.state === 'busy') return;
    if (!silent) updMsg('확인 중…');
    try {
      const r = await api.updateCheck();
      U.latest = r.latest;
      if (r.available) {
        U.state = 'available';
        $('btnUpdate').textContent = r.latest + ' 버전으로 업데이트';
        $('btnUpdateTop').classList.remove('hide');
        $('btnUpdateTop').textContent = '새 버전 ' + r.latest + ' 업데이트';
        updMsg('새 버전이 있습니다. (지금 ' + r.current + ' → ' + r.latest + ')', 'warn');
      } else {
        U.state = 'idle';
        $('btnUpdate').textContent = '업데이트 확인';
        $('btnUpdateTop').classList.add('hide');
        if (!silent) updMsg('최신 버전입니다. (' + r.current + ')', 'ok');
      }
    } catch (e) { if (!silent) updMsg(errText(e), 'bad'); }
  }
  async function updateRun() {
    if (U.state === 'busy') return;
    U.state = 'busy';
    $('btnUpdate').disabled = true; $('btnUpdateTop').disabled = true;
    $('btnUpdateTop').textContent = '업데이트 받는 중…';
    updMsg('새 버전을 내려받는 중…');
    try {
      const r = await api.updateDownload();
      updMsg(r.latest + ' 버전을 받았습니다. 프로그램을 다시 시작합니다…', 'ok');
      $('btnUpdateTop').textContent = '다시 시작하는 중…';
      const ok = await api.updateRestart();
      if (!ok) { updMsg(r.latest + ' 버전을 받았습니다. 프로그램을 끄고 START.bat 으로 다시 켜면 적용됩니다.', 'ok'); $('btnUpdateTop').textContent = '끄고 다시 켜면 적용'; }
    } catch (e) {
      U.state = 'available';
      $('btnUpdate').disabled = false; $('btnUpdateTop').disabled = false;
      $('btnUpdateTop').textContent = '새 버전 ' + U.latest + ' 업데이트';
      updMsg('업데이트 실패: ' + errText(e), 'bad');
    }
  }
  api.on('update:progress', (bytes) => { if (U.state === 'busy') updMsg('새 버전을 내려받는 중… ' + (bytes / 1048576).toFixed(1) + 'MB'); });
  $('btnUpdate').addEventListener('click', () => (U.state === 'available' ? updateRun() : updateCheck(false)));
  $('btnUpdateTop').addEventListener('click', () => { if (S.cands.some((c) => c.state === 'downloading')) return; updateRun(); });

  // ── 영화 정보 직접 입력/수정 ──
  function openEdit(isNew) {
    const m = isNew ? {} : (S.movie || {});
    S.editNew = isNew;
    S.editPoster = null;
    $('eTitle').value = m.title || '';
    $('eOrig').value = m.originalTitle || '';
    $('eYear').value = m.year || '';
    $('eRuntime').value = m.runtime || '';
    $('eRating').value = m.rating !== null && m.rating !== undefined ? m.rating : '';
    $('eCert').value = m.certification || '';
    $('eGenres').value = (m.genres || []).join(', ');
    $('eDirector').value = m.director || '';
    $('eCast').value = (m.cast || []).join(', ');
    $('ePlot').value = m.overview || '';
    $('ePosterName').textContent = m.posterUrl ? '현재 포스터 사용 중' : '선택된 포스터 없음';
    $('modalEdit').classList.remove('hide');
    $('eTitle').focus();
  }
  $('btnManual').addEventListener('click', () => openEdit(true));
  $('btnEdit').addEventListener('click', () => openEdit(false));
  $('btnEditCancel').addEventListener('click', () => $('modalEdit').classList.add('hide'));
  $('btnPoster').addEventListener('click', async () => {
    const f = await api.pickFile('image');
    if (f) { S.editPoster = f; $('ePosterName').textContent = f.name; }
  });
  $('btnEditSave').addEventListener('click', () => {
    const title = $('eTitle').value.trim();
    if (!title) { $('eTitle').focus(); return; }
    const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    const base = S.editNew ? { id: 'manual-' + Date.now(), videos: [], genreIds: [], originalLanguage: '' } : S.movie;
    const rating = $('eRating').value === '' ? null : Math.max(0, Math.min(10, Number($('eRating').value)));
    const genres = list($('eGenres').value);
    const m = Object.assign({}, base, {
      title, originalTitle: $('eOrig').value.trim(), year: $('eYear').value.trim(), runtime: Number($('eRuntime').value) || null,
      rating, certification: $('eCert').value.trim(), genres, director: $('eDirector').value.trim(), cast: list($('eCast').value), overview: $('ePlot').value.trim(),
    });
    if (base.genres && genres.join() !== base.genres.join()) m.genreIds = [];
    if (S.editPoster) m.posterUrl = S.editPoster.fileUrl;
    $('modalEdit').classList.add('hide');
    const isNew = S.editNew;
    if (isNew) document.querySelectorAll('.res.sel').forEach((b) => b.classList.remove('sel'));
    setMovie(m, isNew);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hide'));
  });
  $('theme').addEventListener('change', () => { S.themeTouched = true; });
  $('searchForm').addEventListener('submit', (ev) => { ev.preventDefault(); S.themeTouched = false; doSearch($('q').value); });
  window.addEventListener('online', renderEnv);
  window.addEventListener('offline', renderEnv);

  // ── 시작 ──
  (async function init() {
    S.config = await api.getConfig();
    S.env = await api.envInfo();
    $('ott').value = S.config.ottUrl || '';
    renderEnv();
    setStartIn(15);
    startRelay();
    setTimeout(() => updateCheck(true), 1500);
    if (!S.config.tmdbKey) {
      $('searchHint').className = 'hint warn';
      $('searchHint').textContent = '영화 정보를 자동으로 가져오려면 [설정]에서 TMDB 키를 먼저 입력하세요. 키 없이 쓰려면 아래 [영화 정보 직접 입력]을 누르세요.';
    }
    $('q').focus();
  })();
})();
