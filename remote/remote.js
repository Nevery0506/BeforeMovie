'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const brokers = params.getAll('broker'); // 시험용: ?broker=ws://… (보통은 비워 둠)
  const store = {
    get() { try { return localStorage.getItem('preshow.pw') || ''; } catch (e) { return ''; } },
    set(v) { try { if (v) localStorage.setItem('preshow.pw', v); else localStorage.removeItem('preshow.pw'); } catch (e) { /* 무시 */ } },
  };

  let relay = null;
  let state = null;
  let stateAt = 0;
  let relayN = 0;
  const pending = new Map();
  let closeArmed = 0;
  let queue = [];           // 돌려가며 표시할 공지 목록
  let volTouch = 0;         // 음량 막대를 만진 시각 (직후에는 PC 값으로 덮어쓰지 않음)
  try { queue = JSON.parse(localStorage.getItem('preshow.queue') || '[]').filter((x) => typeof x === 'string').slice(0, 10); } catch (e) { queue = []; }
  const saveQueue = () => { try { localStorage.setItem('preshow.queue', JSON.stringify(queue)); } catch (e) { /* 무시 */ } };

  function renderQueue() {
    const ol = $('nlist');
    ol.innerHTML = '';
    queue.forEach((text, i) => {
      const li = document.createElement('li');
      const sp = document.createElement('span'); sp.textContent = text;
      const del = document.createElement('button'); del.type = 'button'; del.textContent = '×'; del.setAttribute('aria-label', (i + 1) + '번 공지 삭제');
      del.addEventListener('click', () => { queue.splice(i, 1); saveQueue(); renderQueue(); });
      li.appendChild(sp); li.appendChild(del); ol.appendChild(li);
    });
    ol.classList.toggle('hide', !queue.length);
    $('everyRow').classList.toggle('hide', queue.length < 2);
    $('btnNotice').textContent = queue.length ? '공지 올리기 (' + queue.length + '개)' : '공지 올리기';
  }

  const PHASE = { 'loop-info': '영화 정보 화면', trailer: '예고편 재생 중', hold: '정보 화면 (안내방송 대기)', announce: '안내방송 중', countdown: '카운트다운', end: '상영 시작됨', '': '준비 중' };
  const THEME = { default: '기본', sf: 'SF / 판타지', horror: '공포 / 스릴러', romance: '로맨스 / 멜로', action: '액션 / 범죄' };
  const p2 = (n) => String(n).padStart(2, '0');
  const mmss = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(s % 60); };
  const hms = (ms) => { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };

  function toast(text, cls, ms) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'on ' + (cls || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ''; }, ms || 2600);
  }
  function pill(el, text, cls) { el.textContent = text; el.className = 'pill ' + (cls || ''); }

  function fact(dl, k, v) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function render() {
    const fresh = state && Date.now() - stateAt < 7000;
    pill($('conn'), relayN ? '중계 연결됨' : '중계 연결 안 됨', relayN ? 'ok' : 'bad');
    const dl = $('facts');
    dl.innerHTML = '';
    $('trBarBox').classList.add('hide');

    if (!fresh) {
      pill($('pcPill'), 'PC 응답 없음', 'bad');
      $('phase').textContent = relayN ? '상영 PC를 기다리는 중' : '인터넷 연결을 확인하세요';
      $('title').textContent = '';
      $('clockLabel').textContent = '상영 프로그램이 꺼져 있거나, 비밀번호가 다르거나, PC 인터넷이 끊겼습니다.';
      $('clock').textContent = '--:--';
      $('controls').classList.add('dim');
      return;
    }

    if (!state.running) {
      const su = state.setup || {};
      pill($('pcPill'), 'PC 연결됨', 'ok');
      $('phase').textContent = '세팅 중 (상영 화면 꺼짐)';
      $('title').textContent = su.title || '아직 영화를 선택하지 않았습니다';
      $('clockLabel').textContent = '세팅 화면에 입력된 상영 시각';
      $('clock').textContent = su.plannedStart ? hms(su.plannedStart).slice(0, 5) : '--:--';
      fact(dl, '준비된 예고편', (su.trailersReady || 0) + '개');
      fact(dl, '안내', 'PC에서 [전체화면으로 시작]을 누르면 조종할 수 있습니다');
      $('controls').classList.add('dim');
      return;
    }

    const sh = state.show;
    $('controls').classList.remove('dim');
    pill($('pcPill'), sh.rehearsal ? '리허설 중' : '상영 화면 켜짐', sh.rehearsal ? 'warn' : 'ok');
    $('phase').textContent = PHASE[sh.phase] || sh.phase || '';
    $('title').textContent = sh.title || '';
    $('clockLabel').textContent = '상영 시작까지';
    $('clock').textContent = mmss(sh.remaining);
    fact(dl, '상영 시각', hms(sh.startAt));
    if (sh.trailer) {
      fact(dl, '재생 중인 예고편', (sh.trailer.title || '예고편') + ' · ' + mmss(sh.trailer.cur) + ' / ' + mmss(sh.trailer.dur));
      $('trBarBox').classList.remove('hide');
      $('trBar').style.width = (sh.trailer.dur ? Math.min(100, (sh.trailer.cur / sh.trailer.dur) * 100) : 0) + '%';
    }
    fact(dl, '다음 순서', sh.phase === 'announce' ? '카운트다운' : sh.phase === 'countdown' ? '영화 상영' : sh.phase === 'trailer' ? '영화 정보 화면' : (sh.next || '-'));
    fact(dl, '준비된 예고편', (sh.trailers || 0) + '개 · 자동 재생 ' + (sh.autoTrailer ? '켜짐' : '꺼짐'));
    fact(dl, '화면 테마', THEME[sh.theme] || sh.theme || '-');
    const nt = sh.notice;
    fact(dl, '표시 중인 공지', !nt ? '없음' : nt.items.length > 1 ? nt.items.length + '개 돌려가며 표시 (' + nt.every + '초마다) · 지금 ' + (nt.index + 1) + '번: ' + nt.items[nt.index] : nt.items[0]);
    fact(dl, '예고편 소리', sh.muted ? '꺼짐' : (sh.volume + '%'));
    if (Date.now() - volTouch > 2500 && typeof sh.volume === 'number') { $('vol').value = sh.volume; $('volNum').textContent = sh.volume + '%'; }
    $('btnMute').textContent = sh.muted ? '소리 켜기 (지금 꺼짐)' : '소리 끄기';
    $('btnMute').classList.toggle('active', !!sh.muted);
    $('btnMute').setAttribute('aria-pressed', sh.muted ? 'true' : 'false');
    if (document.activeElement !== $('auto')) $('auto').checked = !!sh.autoTrailer;
    const late = sh.phase === 'announce' || sh.phase === 'countdown';
    $('btnTrailer').disabled = late || !sh.trailers || sh.phase === 'trailer';
    $('btnInfo').disabled = sh.phase !== 'trailer';
    $('btnAnnounce').disabled = late;
  }

  function onState(body) {
    if (!body || body.kind !== 'state') return;
    state = body;
    stateAt = Date.now();
    const r = body.result;
    if (r && r.id && pending.has(r.id)) {
      clearTimeout(pending.get(r.id));
      pending.delete(r.id);
      toast(r.msg || (r.ok ? '완료' : '실패'), r.ok ? 'ok' : 'bad');
    }
    render();
  }

  async function send(cmd) {
    if (!relay) return;
    cmd.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const n = await relay.send(cmd);
    if (!n) { toast('중계 서버에 연결되어 있지 않습니다', 'bad'); return; }
    pending.set(cmd.id, setTimeout(() => { pending.delete(cmd.id); toast('PC에서 응답이 없습니다', 'bad'); }, 6000));
  }

  async function connect(pw) {
    if (relay) { relay.close(); relay = null; }
    state = null; relayN = 0;
    $('login').classList.add('hide');
    $('main').classList.remove('hide');
    render();
    try {
      relay = await window.PreShowRelay.connect({
        role: 'remote', password: pw, brokers, onMessage: onState,
        onStatus: (n) => { const was = relayN; relayN = n; render(); if (n && !was) relay && relay.send({ type: 'hello' }); },
      });
    } catch (e) {
      toast(e.message || '연결하지 못했습니다', 'bad', 5000);
      logout();
    }
  }
  function logout() {
    if (relay) { relay.close(); relay = null; }
    $('main').classList.add('hide');
    $('login').classList.remove('hide');
    pill($('conn'), '연결 안 됨', '');
  }

  // ── 버튼 ──
  $('btnLogin').addEventListener('click', () => {
    const pw = $('pw').value.trim();
    if (pw.length < 8) { toast('비밀번호는 8자 이상입니다', 'bad'); return; }
    store.set(pw);
    connect(pw);
  });
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLogin').click(); });
  $('btnLogout').addEventListener('click', () => { store.set(''); $('pw').value = ''; logout(); });

  document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => send({ type: 'shift', minutes: Number(b.dataset.shift) })));
  $('btnSetTime').addEventListener('click', () => {
    const v = $('newTime').value;
    if (!v) { toast('시각을 먼저 고르세요', 'bad'); return; }
    const [hh, mm, ss] = v.split(':').map(Number);
    send({ type: 'setStart', hh, mm, ss: ss || 0 });
  });
  $('btnTrailer').addEventListener('click', () => send({ type: 'playTrailer' }));
  $('btnInfo').addEventListener('click', () => send({ type: 'showInfo' }));
  $('auto').addEventListener('change', () => send({ type: 'autoTrailer', on: $('auto').checked }));
  $('btnAnnounce').addEventListener('click', () => send({ type: 'announceNow' }));
  $('btnAddNotice').addEventListener('click', () => {
    const text = $('notice').value.trim();
    if (!text) { toast('공지 내용을 먼저 입력하세요', 'bad'); return; }
    if (queue.length >= 10) { toast('공지는 10개까지 넣을 수 있습니다', 'bad'); return; }
    queue.push(text); saveQueue(); renderQueue();
    $('notice').value = '';
  });
  $('btnNotice').addEventListener('click', () => {
    const text = $('notice').value.trim();
    // 목록이 있으면 목록(+입력칸에 남은 문구)을, 없으면 입력칸의 문구 하나를 올립니다.
    const items = queue.length ? queue.concat(text ? [text] : []) : (text ? [text] : []);
    if (!items.length) { toast('공지 내용을 입력하세요', 'bad'); return; }
    send({ type: 'notice', items: items.slice(0, 10), seconds: Number($('noticeSec').value), every: Number($('noticeEvery').value) });
  });
  let volTimer = null;
  $('vol').addEventListener('input', () => {
    volTouch = Date.now();
    $('volNum').textContent = $('vol').value + '%';
    clearTimeout(volTimer);
    volTimer = setTimeout(() => send({ type: 'volume', value: Number($('vol').value) }), 250);
  });
  $('btnMute').addEventListener('click', () => send({ type: 'mute', on: !(state && state.show && state.show.muted) }));
  $('btnNoticeClear').addEventListener('click', () => send({ type: 'noticeClear' }));
  $('presets').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') $('notice').value = e.target.textContent; });
  $('btnClose').addEventListener('click', () => {
    if (Date.now() - closeArmed < 4000) { closeArmed = 0; $('btnClose').textContent = '상영 화면 닫기'; send({ type: 'close' }); return; }
    closeArmed = Date.now();
    $('btnClose').textContent = '정말 닫으려면 한 번 더 누르세요';
    setTimeout(() => { if (closeArmed && Date.now() - closeArmed >= 4000) { closeArmed = 0; $('btnClose').textContent = '상영 화면 닫기'; } }, 4100);
  });

  // 남은 시간은 PC가 1초마다 보내 줍니다. 끊기면 "응답 없음"으로 바꿉니다.
  setInterval(render, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && relay) relay.send({ type: 'hello' }); });

  renderQueue();
  const saved = params.get('pw') || store.get();
  if (saved && saved.length >= 8) connect(saved);
})();
