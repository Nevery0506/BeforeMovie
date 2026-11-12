'use strict';
// 상영 화면의 시간표 엔진.
// 상영 시각(T)을 기준으로:  …정보 50초 ↔ 예고편 반복… → T-65초 정보 화면 복귀 → T-60초 안내방송+자막 → T-10초 카운트다운 → T 상영
(function () {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const video = $('video');
  const announce = $('announce');

  const RETURN_AT = 65; // 초: 이 시점엔 반드시 정보 화면
  const ANNOUNCE_AT = 60;
  const COUNT_AT = 10;

  let D = null;          // 세팅 화면에서 넘어온 데이터
  let T = 0;             // 상영 시각 (ms)
  let startedAt = 0;
  let scene = '';
  let phase = '';        // loop-info | trailer | hold | announce | countdown | end
  let infoSince = 0;
  let trailerIdx = 0;
  let lastCount = null;
  let finished = false;
  let subLines = [];
  let escAt = 0;
  let autoTrailer = true;   // 정보 화면 뒤에 예고편을 자동으로 이어 틀지 (리모컨에서 끌 수 있음)
  let noticeItems = [];
  let noticeIdx = 0;
  let noticeTimer = null;
  let noticeRotate = null;
  let noticeEvery = 8;
  let vol = 100;            // 예고편 음량(0~100)
  let muted = false;        // 예고편 음소거
  let lastResult = null;
  let lastReportSec = null;

  // ── 화면 크기에 맞추기 ──
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
    stage.style.transformOrigin = '50% 50%';
    stage.style.left = '50%';
    stage.style.top = '50%';
  }
  window.addEventListener('resize', fit);
  fit();

  // ── 효과음 ──
  const sounds = {};
  ['beep', 'beep_hi', 'beep_go'].forEach((n) => {
    const a = new Audio('../assets/audio/' + n + '.wav');
    a.preload = 'auto';
    sounds[n] = a;
  });
  function play(name) {
    const a = sounds[name];
    if (!a) return;
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) { /* 무시 */ }
  }

  const mmss = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  };

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), ms || 2200);
  }

  function setScene(name) {
    if (scene === name) return;
    scene = name;
    ['main', 'announce', 'trailer', 'countdown', 'end'].forEach((n) => $('scene-' + n).classList.toggle('on', n === name));
  }

  // ── 영화 정보 채우기 ──
  function fitTitle(max) {
    const el = $('title');
    const width = 850;
    el.classList.remove('wrap');
    let size = max;
    el.style.fontSize = size + 'px';
    while (el.scrollWidth > width && size > Math.round(max * 0.6)) { size -= 4; el.style.fontSize = size + 'px'; }
    if (el.scrollWidth > width) {
      el.classList.add('wrap');
      size = Math.round(max * 0.58);
      el.style.fontSize = size + 'px';
    }
  }
  function fitColumn(limitBottom) {
    // 줄거리가 길면 줄 수를 줄여 아래 띠와 겹치지 않게 합니다.
    const col = $('col');
    const ov = $('overview');
    for (let lines = 4; lines >= 1; lines--) {
      ov.style.setProperty('--clamp', lines);
      if (col.offsetTop + col.offsetHeight <= limitBottom) break;
    }
  }
  // 줄거리가 칸보다 길면 위로 천천히 흘려서 끝까지 보여 줍니다.
  let ovAnim = null;
  function scrollOverview() {
    const box = $('overview');
    const inner = $('ovInner');
    if (ovAnim) { ovAnim.cancel(); ovAnim = null; }
    box.classList.remove('scrolling');
    const dist = inner.scrollHeight - box.clientHeight;
    if (dist < 8) return;
    box.classList.add('scrolling');
    const hold = 4000;                    // 처음과 끝에서 멈춰 있는 시간
    const move = (dist / 24) * 1000;      // 1초에 24px (한 줄에 약 2초)
    const fade = 700;
    const total = hold + move + hold + fade * 2;
    const at = (ms) => ms / total;
    const end = 'translateY(' + (-dist) + 'px)';
    ovAnim = inner.animate([
      { transform: 'translateY(0)', opacity: 1, offset: 0 },
      { transform: 'translateY(0)', opacity: 1, offset: at(hold) },
      { transform: end, opacity: 1, offset: at(hold + move) },
      { transform: end, opacity: 1, offset: at(hold + move + hold) },
      { transform: end, opacity: 0, offset: at(hold + move + hold + fade) },
      { transform: 'translateY(0)', opacity: 0, offset: at(hold + move + hold + fade) + 0.0001 },
      { transform: 'translateY(0)', opacity: 1, offset: 1 },
    ], { duration: total, iterations: Infinity, easing: 'linear' });
  }
  function layoutInfo() {
    fitTitle(168);
    fitColumn(940);
    scrollOverview();
  }

  function fillMovie() {
    const m = D.movie;
    $('title').textContent = m.title || '';
    const orig = [m.originalTitle && m.originalTitle !== m.title ? m.originalTitle.toUpperCase() : '', m.year].filter(Boolean).join(' · ');
    $('orig').textContent = orig;
    $('orig').classList.toggle('hide', !orig);

    const hasRating = m.rating !== null && m.rating !== undefined && m.rating !== '';
    $('gauge').classList.toggle('hide', !hasRating);
    if (hasRating) {
      const r = Number(m.rating);
      $('rating').textContent = r.toFixed(1);
      $('gauge').style.background = 'conic-gradient(var(--accent) 0 ' + Math.round(r * 10) + '%, var(--track) ' + Math.round(r * 10) + '% 100%)';
    }
    const chips = $('chips');
    chips.innerHTML = '';
    (m.genres || []).slice(0, 3).forEach((g) => { const s = document.createElement('span'); s.textContent = g; chips.appendChild(s); });
    const facts = [m.runtime ? m.runtime + '분' : '', m.certification || ''].filter(Boolean).join(' · ');
    $('facts').textContent = facts;

    const setCredit = (id, label, val) => {
      const el = $(id);
      el.innerHTML = '';
      el.classList.toggle('hide', !val);
      if (!val) return;
      const b = document.createElement('b'); b.textContent = label;
      el.appendChild(b); el.appendChild(document.createTextNode(val));
    };
    setCredit('director', '감독', m.director);
    setCredit('cast', '출연', (m.cast || []).slice(0, 3).join(' · '));
    $('metaLine').textContent = [m.year, (m.genres || []).slice(0, 3).join(', '), m.runtime ? m.runtime + '분' : '', m.certification].filter(Boolean).join(' · ');
    $('ovInner').textContent = m.overview || m.tagline || '';

    if (m.posterUrl) {
      const img = $('poster');
      img.onload = () => { img.classList.remove('hide'); };
      img.src = m.posterUrl;
      const th = $('tThumb');
      th.onload = () => th.classList.remove('hide');
      th.src = m.posterUrl;
    }
    $('tTitle').textContent = m.title || '';
    $('tMeta').textContent = $('metaLine').textContent;
    // 안내방송 화면 아래 요약 띠
    $('aTitle').textContent = m.title || '';
    $('aMeta').textContent = $('metaLine').textContent;
    $('aRateBox').classList.toggle('hide', !hasRating);
    if (hasRating) $('aRate').textContent = Number(m.rating).toFixed(1);
    $('aSum').textContent = m.tagline || m.overview || '';
    if (m.posterUrl) {
      const at = $('aThumb');
      at.onload = () => at.classList.remove('hide');
      at.src = m.posterUrl;
      $('annPoster').setAttribute('href', m.posterUrl);
      $('annPosterPh').style.display = 'none';
    }
    $('tRateBox').classList.toggle('hide', !hasRating);
    if (hasRating) $('tRate').textContent = Number(m.rating).toFixed(1);
    $('tSum').textContent = m.tagline || m.overview || '';
    $('cdTitle').textContent = m.title || '';

    const pips = $('pips');
    pips.innerHTML = '';
    for (let i = 0; i < 10; i++) pips.appendChild(document.createElement('i'));
  }

  // ── 자막 ──
  function prepareSubs(lines) {
    subLines = (lines || []).map((ln) => {
      const words = [];
      (ln.segs || []).forEach((sg) => {
        const t0 = sg[0], t1 = sg[1];
        const ws = String(sg[2]).split(/\s+/).filter(Boolean);
        const total = ws.reduce((n, w) => n + w.length, 0) || 1;
        let acc = 0;
        ws.forEach((w) => { words.push({ text: w, t: t0 + (t1 - t0) * (acc / total) }); acc += w.length; });
      });
      const segs = ln.segs || [];
      return { start: segs.length ? segs[0][0] : 0, end: segs.length ? segs[segs.length - 1][1] : 0, words, text: segs.map((s) => s[2]).join(' ') };
    }).filter((l) => l.words.length);
  }
  // 안내방송 멘트에 맞춘 입체 장면 (시간표는 subtitles.json 의 scenes)
  let annScenes = [{ t: 0, id: 'hello' }, { t: 2.9, id: 'projector' }, { t: 6.6, id: 'numbers' }, { t: 13.6, id: 'seats' }, { t: 18.8, id: 'ring' }, { t: 25.5, id: 'light' }, { t: 30.8, id: 'fire' }, { t: 40.0, id: 'enjoy' }];
  let annShown = null;
  function renderAnnScene(t) {
    let id = null;
    for (const sc of annScenes) if (t >= sc.t) id = sc.id;
    if (id === annShown) return;
    annShown = id;
    let label = '';
    document.querySelectorAll('#annStage .as').forEach((el) => {
      const on = el.dataset.scene === id;
      el.classList.toggle('on', on);
      if (on) label = el.dataset.label || '';
    });
    $('annChip').textContent = label;
    $('annChip').classList.toggle('hide', !label);
  }
  let subShown = -2;
  function renderSubs(t) {
    let idx = -1;
    for (let i = 0; i < subLines.length; i++) if (t >= subLines[i].start - 0.15) idx = i;
    const cur = $('subCur');
    if (idx !== subShown) {
      subShown = idx;
      cur.innerHTML = '';
      $('subPrev').textContent = idx > 0 ? subLines[idx - 1].text : '';
      if (idx >= 0) {
        subLines[idx].words.forEach((w) => {
          const s = document.createElement('span');
          s.textContent = w.text;
          s.dataset.t = w.t;
          cur.appendChild(s);
          cur.appendChild(document.createTextNode(' '));
        });
      }
    }
    let speaking = false;
    if (idx >= 0) {
      cur.querySelectorAll('span').forEach((s) => s.classList.toggle('said', t >= Number(s.dataset.t) - 0.05));
      speaking = t <= subLines[idx].end + 0.25;
    }
    $('band').classList.toggle('speaking', speaking && !announce.paused);
    $('scene-announce').classList.toggle('speaking', speaking && !announce.paused);
  }

  // ── 예고편 엠비언트 라이트 ──
  // 재생 중인 화면을 아주 작게 읽어 흐리게 키운 뒤 영상 뒤에 깔아, 영상 색이 주변으로 번지게 합니다.
  const amb = $('ambCanvas');
  const ambCtx = amb.getContext('2d');
  let ambTimer = null;
  function ambStart() {
    if (!document.body.classList.contains('amb-trailer')) return;
    ambStop();
    ambCtx.globalAlpha = 1;
    ambCtx.fillStyle = '#000';
    ambCtx.fillRect(0, 0, amb.width, amb.height);
    ambTimer = setInterval(() => {
      if (video.readyState < 2 || video.paused) return;
      try { ambCtx.globalAlpha = 0.3; ambCtx.drawImage(video, 0, 0, amb.width, amb.height); } catch (e) { /* 무시 */ }
    }, 66);
  }
  function ambStop() { clearInterval(ambTimer); ambTimer = null; }

  // ── 예고편 ──
  function nextTrailer() {
    const list = D.trailers || [];
    if (!list.length) return null;
    return list[trailerIdx % list.length];
  }
  function trailerFits(tr, remaining) {
    if (!tr) return false;
    const room = remaining - RETURN_AT - 1.5;
    if (D.options.cutTrailer) return room >= 20;
    const dur = tr.duration || 0;
    return dur > 0 && dur <= room;
  }
  function startTrailer(tr) {
    phase = 'trailer';
    video.querySelectorAll('track').forEach((t) => t.remove());
    video.src = tr.fileUrl;
    if (tr.subUrl) {
      const tk = document.createElement('track');
      tk.kind = 'subtitles'; tk.srclang = 'ko'; tk.label = '한국어'; tk.src = tr.subUrl; tk.default = true;
      video.appendChild(tk);
    }
    applyVolume();
    video.currentTime = 0;
    setScene('trailer');
    ambStart();
    video.play().catch(() => endTrailer());
  }
  function endTrailer() {
    if (phase !== 'trailer') return;
    trailerIdx++;
    try { video.pause(); } catch (e) { /* 무시 */ }
    ambStop();
    phase = 'loop-info';
    infoSince = Date.now();
    setScene('main');
  }
  function fadeOutTrailer() {
    // T-65초가 되면 재생 중이라도 소리를 줄이며 정보 화면으로 돌아갑니다.
    const v0 = video.volume;
    let i = 0;
    const iv = setInterval(() => { i++; video.volume = Math.max(0, v0 * (1 - i / 8)); if (i >= 8) { clearInterval(iv); try { video.pause(); } catch (e) { /* 무시 */ } applyVolume(); } }, 60);
  }
  video.addEventListener('ended', endTrailer);
  video.addEventListener('error', () => { if (phase === 'trailer') { toast('예고편을 재생할 수 없어 건너뜁니다'); endTrailer(); } });
  video.addEventListener('loadedmetadata', () => {
    const tr = nextTrailer();
    if (tr && !tr.duration && isFinite(video.duration)) tr.duration = video.duration;
  });

  // 길이를 모르는 예고편(직접 지정한 파일)은 미리 길이를 알아 둡니다.
  function probeDurations() {
    (D.trailers || []).forEach((tr) => {
      if (tr.duration) return;
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { if (isFinite(v.duration)) tr.duration = v.duration; v.src = ''; };
      v.src = tr.fileUrl;
    });
  }

  // ── 공지 (리모컨에서 올림) ──
  // items: 공지 문구 목록. 두 개 이상이면 every초마다 돌아가며 보여 줍니다.
  function drawNotice() {
    $('noticeText').textContent = noticeItems[noticeIdx] || '';
    $('noticeIdx').textContent = noticeItems.length > 1 ? (noticeIdx + 1) + ' / ' + noticeItems.length : '';
  }
  function showNotice(items, seconds, every) {
    items = (Array.isArray(items) ? items : [items]).map((t) => String(t || '').trim().slice(0, 200)).filter(Boolean).slice(0, 10);
    if (!items.length) { hideNotice(); return; }
    clearTimeout(noticeTimer);
    clearInterval(noticeRotate);
    noticeItems = items;
    noticeIdx = 0;
    noticeEvery = Math.max(3, Math.min(120, Number(every) || 8));
    drawNotice();
    $('noticeText').classList.remove('swap');
    $('notice').classList.add('on');
    play('beep');
    if (items.length > 1) {
      noticeRotate = setInterval(() => {
        $('noticeText').classList.add('swap');
        setTimeout(() => { noticeIdx = (noticeIdx + 1) % noticeItems.length; drawNotice(); $('noticeText').classList.remove('swap'); }, 360);
      }, noticeEvery * 1000);
    }
    if (seconds > 0) noticeTimer = setTimeout(hideNotice, seconds * 1000);
  }
  function hideNotice() {
    noticeItems = [];
    noticeIdx = 0;
    clearTimeout(noticeTimer);
    clearInterval(noticeRotate);
    $('notice').classList.remove('on');
  }
  function applyVolume() {
    video.muted = muted;
    video.volume = Math.max(0, Math.min(1, vol / 100));
  }

  // ── 리모컨으로 현재 상태 보내기 ──
  function report() {
    if (!D || !window.api.reportStatus) return;
    const rem = (T - Date.now()) / 1000;
    const tr = phase === 'trailer' ? nextTrailer() : null;
    window.api.reportStatus({
      phase, remaining: Math.max(0, Math.round(rem)), startAt: T, title: D.movie.title || '', theme: D.theme || 'default', rehearsal: !!D.rehearsal,
      trailers: (D.trailers || []).length, autoTrailer, volume: vol, muted,
      notice: noticeItems.length ? { items: noticeItems, index: noticeIdx, every: noticeEvery } : null, next: $('next').textContent, lastResult,
      trailer: tr ? { title: tr.title || '', cur: Math.round(video.currentTime || 0), dur: Math.round(tr.duration || video.duration || 0) } : null,
    });
  }

  // ── 리모컨 명령 처리 ──
  function command(c) {
    if (!c || !c.type || finished) return;
    const now = Date.now();
    const rem = (T - now) / 1000;
    let ok = true;
    let msg = '';
    const setT = (nt, label) => {
      if (nt - now < 15000) { ok = false; msg = '상영 시각이 너무 가깝거나 이미 지났습니다'; return; }
      T = nt; msg = label; toast(label);
    };
    if (c.type === 'notice') {
      const items = Array.isArray(c.items) && c.items.length ? c.items : [c.text];
      showNotice(items, Math.max(0, Number(c.seconds) || 0), c.every);
      if (!noticeItems.length) { ok = false; msg = '공지 내용이 없습니다'; }
      else msg = noticeItems.length > 1 ? '공지 ' + noticeItems.length + '개를 돌려가며 표시합니다' : '공지를 올렸습니다';
    }
    else if (c.type === 'volume') { vol = Math.max(0, Math.min(100, Math.round(Number(c.value) || 0))); if (vol > 0 && c.unmute) muted = false; applyVolume(); msg = '예고편 음량 ' + vol + '%'; }
    else if (c.type === 'mute') { muted = !!c.on; applyVolume(); msg = muted ? '예고편 소리를 껐습니다' : '예고편 소리를 켰습니다'; }
    else if (c.type === 'noticeClear') { hideNotice(); msg = '공지를 내렸습니다'; }
    else if (c.type === 'shift') {
      const min = Math.round(Number(c.minutes) || 0);
      setT(T + min * 60000, '상영 시각을 ' + Math.abs(min) + '분 ' + (min >= 0 ? '늦췄습니다' : '당겼습니다'));
    } else if (c.type === 'setStart') {
      const d = new Date();
      d.setHours(Number(c.hh) || 0, Number(c.mm) || 0, Number(c.ss) || 0, 0);
      if (d.getTime() < now - 60000) d.setDate(d.getDate() + 1);
      const p2 = (n) => String(n).padStart(2, '0');
      setT(d.getTime(), '상영 시각을 ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' 로 바꿨습니다');
    } else if (c.type === 'playTrailer') {
      const tr = nextTrailer();
      if (!tr) { ok = false; msg = '준비된 예고편이 없습니다'; }
      else if (phase === 'trailer') { ok = false; msg = '이미 예고편을 재생하고 있습니다'; }
      else if (rem <= RETURN_AT + 15) { ok = false; msg = '안내방송이 가까워 재생할 수 없습니다'; }
      else { startTrailer(tr); msg = '예고편을 재생합니다'; }
    } else if (c.type === 'showInfo') {
      if (phase === 'trailer') { endTrailer(); msg = '영화 정보 화면으로 바꿨습니다'; } else msg = '이미 영화 정보 화면입니다';
    } else if (c.type === 'autoTrailer') {
      autoTrailer = !!c.on; msg = autoTrailer ? '예고편 자동 재생을 켰습니다' : '예고편 자동 재생을 껐습니다';
    } else if (c.type === 'announceNow') {
      if (rem > RETURN_AT + 2) { T = now + (RETURN_AT + 1) * 1000; msg = '안내방송으로 바로 넘어갑니다'; toast(msg); } else { ok = false; msg = '이미 안내방송 단계입니다'; }
    } else if (c.type === 'close') {
      lastResult = { id: c.id, ok: true, msg: '프리쇼를 종료합니다' }; report();
      window.api.closeShow(); return;
    } else { ok = false; msg = '알 수 없는 명령입니다'; }
    lastResult = { id: c.id, ok, msg };
    report();
  }

  // ── 단계 전환 ──
  function leaveAnnounce() {
    // 상영 시각이 늦춰져 안내방송 단계에서 되돌아갈 때
    try { announce.pause(); announce.currentTime = 0; } catch (e) { /* 무시 */ }
    document.body.classList.remove('announcing');
    $('band').classList.remove('speaking');
    $('scene-announce').classList.remove('speaking');
    annShown = null;
    document.querySelectorAll('#annStage .as').forEach((el) => el.classList.remove('on'));
    subShown = -2;
    $('subCur').innerHTML = ''; $('subPrev').textContent = '';
    phase = '';
  }
  function enterAnnounce(remaining) {
    phase = 'announce';
    document.body.classList.add('announcing');
    setScene('announce');
    const offset = ANNOUNCE_AT - remaining; // 늦게 들어왔으면 그만큼 건너뜀
    try {
      announce.currentTime = Math.max(0, offset);
      announce.play().catch(() => {});
    } catch (e) { /* 무시 */ }
  }
  function enterCountdown() {
    phase = 'countdown';
    if (window.api.prepareOtt) window.api.prepareOtt();
    try { announce.pause(); } catch (e) { /* 무시 */ }
    setScene('countdown');
  }
  function finish() {
    if (finished) return;
    finished = true;
    phase = 'end';
    play('beep_go');
    if (D.rehearsal) { $('endEn').textContent = 'REHEARSAL'; $('endKo').textContent = '리허설이 끝났습니다'; }
    else if (!D.ottUrl) { $('endKo').textContent = '상영 시각입니다'; }
    setScene('end');
    hideNotice();
    report();
    window.api.finishShow();
  }

  function tick() {
    if (finished) return;
    const now = Date.now();
    const remaining = (T - now) / 1000;
    const clock = mmss(remaining);
    $('clock').textContent = clock;
    $('tClock').textContent = clock;
    $('miniClock').textContent = clock;
    $('aClock').textContent = clock;
    const total = Math.max(1, (T - startedAt) / 1000);
    $('fill').style.width = Math.max(0, Math.min(100, (1 - remaining / total) * 100)) + '%';

    if (remaining <= 0) { finish(); return; }
    if (remaining > ANNOUNCE_AT && document.body.classList.contains('announcing')) leaveAnnounce();
    if (remaining > COUNT_AT && phase === 'countdown') { phase = ''; lastCount = null; }
    const sec = Math.floor(now / 1000);
    if (sec !== lastReportSec) { lastReportSec = sec; report(); }

    if (remaining <= COUNT_AT) {
      if (phase !== 'countdown') enterCountdown();
      const n = Math.ceil(remaining);
      if (n !== lastCount) {
        lastCount = n;
        const b = $('cdNum');
        b.textContent = n;
        b.classList.remove('beat'); void b.offsetWidth; b.classList.add('beat');
        play(n <= 3 ? 'beep_hi' : 'beep');
        const pips = $('pips').children;
        for (let i = 0; i < pips.length; i++) {
          pips[i].classList.toggle('used', i < 10 - n);
          pips[i].classList.toggle('now', i === 10 - n);
        }
      }
      return;
    }

    if (remaining <= ANNOUNCE_AT) {
      if (phase !== 'announce') enterAnnounce(remaining);
      const at = announce.paused && announce.currentTime === 0 ? ANNOUNCE_AT - remaining : announce.currentTime;
      renderSubs(at);
      renderAnnScene(at);
      return;
    }

    if (remaining <= RETURN_AT) {
      if (phase === 'trailer') { fadeOutTrailer(); trailerIdx++; ambStop(); }
      if (phase !== 'hold') { phase = 'hold'; setScene('main'); $('next').textContent = '안내방송'; }
      return;
    }

    // 여유 구간: 정보 화면과 예고편을 번갈아
    if (phase === 'trailer') return;
    if (phase !== 'loop-info') { phase = 'loop-info'; infoSince = now; setScene('main'); }
    const tr = nextTrailer();
    const fits = trailerFits(tr, remaining - Math.max(0, D.options.infoSeconds - (now - infoSince) / 1000));
    $('next').textContent = fits && autoTrailer ? '예고편' : '안내방송';
    if (autoTrailer && (now - infoSince) / 1000 >= D.options.infoSeconds && trailerFits(tr, remaining)) startTrailer(tr);
  }

  // ── 조작 키 ──
  window.addEventListener('keydown', (e) => {
    if (finished) return;
    if (e.key === 'Escape') {
      const now = Date.now();
      if (now - escAt < 2500) { window.api.closeShow(); return; }
      escAt = now;
      toast('종료하려면 Esc를 한 번 더 누르세요');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      T += 60000; toast('상영 시각을 1분 늦췄습니다');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      if ((T - Date.now()) / 1000 > 130) { T -= 60000; toast('상영 시각을 1분 당겼습니다'); } else toast('더 당길 수 없습니다');
    } else if (e.key === 's' || e.key === 'S' || e.key === 'ㄴ') {
      if ((T - Date.now()) / 1000 > RETURN_AT + 2) { T = Date.now() + (RETURN_AT + 1) * 1000; toast('안내방송으로 바로 넘어갑니다'); }
    } else if (e.key === 'h' || e.key === 'H' || e.key === 'F1' || e.key === 'ㅗ') {
      toast('Esc 두 번: 종료 · ←/→: 상영 시각 1분 당기기/늦추기 · S: 바로 안내방송', 5000);
    }
  });
  let cursorTimer = null;
  window.addEventListener('mousemove', () => {
    document.body.classList.add('show-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 2000);
  });

  // ── 시작 ──
  async function init() {
    D = await window.api.showData();
    D.options = Object.assign({ reduceFx: false, cutTrailer: false, infoSeconds: 50, trailerVolume: 100, flicker: true }, D.options || {});
    if (D.rehearsal) D.options.infoSeconds = Math.min(D.options.infoSeconds, 10);
    T = D.startAt;
    startedAt = Date.now();
    document.body.dataset.theme = D.theme || 'default';
    if (!D.options.ambientOff) {
      document.body.classList.add('amb-trailer');
      document.body.style.setProperty('--ambl', { low: 0.4, mid: 0.62, high: 0.88 }[D.options.ambientLevel] || 0.62);
    }
    vol = Math.max(0, Math.min(100, Number(D.options.trailerVolume)));
    if (!isFinite(vol)) vol = 100;
    if (Array.isArray(D.posterColor) && D.posterColor.length === 3) {
      document.body.style.setProperty('--amb', D.posterColor.join(','));
      document.body.classList.add('has-amb');
    }
    document.body.classList.toggle('reduce-fx', !!D.options.reduceFx);
    document.body.classList.toggle('flicker-on', !!D.options.flicker && !D.options.reduceFx);
    fillMovie();
    prepareSubs(D.subtitles);
    if (Array.isArray(D.annScenes) && D.annScenes.length) annScenes = D.annScenes.filter((x) => x && typeof x.t === 'number' && x.id).sort((x, y) => x.t - y.t);
    probeDurations();
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
    layoutInfo();
    tick();
    setInterval(tick, 100);
    if (D.rehearsal) toast('리허설 모드 · 실제 OTT는 열리지 않습니다', 4000);
    if (window.api.on) window.api.on('remote:cmd', command);
  }
  init();
})();
