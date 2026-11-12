'use strict';
// 상영 PC와 휴대전화 리모컨을 인터넷 중계(MQTT)로 잇는 공용 모듈.
// - 비밀번호로 암호 키와 채널 이름을 만듭니다. 비밀번호가 같은 PC와 리모컨만 서로 통합니다.
// - 주고받는 내용은 AES-GCM으로 암호화되어, 중계 서버는 내용을 볼 수 없습니다.
// - 중계 서버 여러 곳에 동시에 붙어서 한 곳이 멈춰도 계속 동작합니다.
(function (root) {
  const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (u8) => { let s = ''; u8.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(password) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('preshow-remote-v1'), iterations: 150000, hash: 'SHA-256' }, base, 512);
    const all = new Uint8Array(bits);
    const key = await crypto.subtle.importKey('raw', all.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const channel = hex(all.slice(32, 48));
    return { key, channel };
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return b64(out);
  }
  async function open(key, text) {
    const raw = unb64(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(dec.decode(pt));
  }

  // role: 'pc' (명령을 받고 상태를 보냄) 또는 'remote' (명령을 보내고 상태를 받음)
  async function connect(opts) {
    if (!root.mqtt) throw new Error('통신 부품(mqtt)을 불러오지 못했습니다.');
    if (!root.crypto || !root.crypto.subtle) throw new Error('이 브라우저에서는 암호화를 쓸 수 없습니다. https 주소로 접속해 주세요.');
    const { key, channel } = await derive(opts.password);
    const base = 'preshow/' + channel + '/';
    const inTopic = base + (opts.role === 'pc' ? 'cmd' : 'state');
    const outTopic = base + (opts.role === 'pc' ? 'state' : 'cmd');
    const brokers = (opts.brokers && opts.brokers.length ? opts.brokers : DEFAULT_BROKERS).slice(0, 5);
    const seen = new Map();
    const clients = [];
    let closed = false;

    const report = () => { if (opts.onStatus && !closed) opts.onStatus(clients.filter((c) => c.connected).length, brokers.length); };

    brokers.forEach((url) => {
      let c;
      try {
        c = root.mqtt.connect(url, { clientId: 'ps_' + opts.role + '_' + Math.random().toString(16).slice(2, 12), clean: true, keepalive: 30, reconnectPeriod: 4000, connectTimeout: 12000 });
      } catch (e) { return; }
      c.on('connect', () => { c.subscribe(inTopic, { qos: 0 }); report(); });
      c.on('close', report);
      c.on('offline', report);
      c.on('error', () => {});
      c.on('message', async (topic, payload) => {
        if (topic !== inTopic || closed) return;
        try {
          const msg = await open(key, payload.toString());
          if (!msg || !msg.id) return;
          if (Math.abs(Date.now() - (msg.ts || 0)) > 900000) return; // 아주 오래된 메시지는 버림 (PC·휴대전화 시계 차이는 15분까지 허용)
          if (seen.has(msg.id)) return;                               // 여러 중계 서버로 온 같은 메시지는 한 번만
          seen.set(msg.id, Date.now());
          if (seen.size > 400) { const cut = Date.now() - 180000; seen.forEach((t, k) => { if (t < cut) seen.delete(k); }); }
          opts.onMessage(msg.body, msg);
        } catch (e) { /* 비밀번호가 다른 메시지 등은 무시 */ }
      });
      clients.push(c);
    });

    let seq = 0;
    return {
      channel,
      async send(body) {
        if (closed) return 0;
        const msg = { id: Date.now().toString(36) + '-' + (seq++) + '-' + Math.random().toString(36).slice(2, 8), ts: Date.now(), body };
        const text = await seal(key, msg);
        let n = 0;
        clients.forEach((c) => { if (c.connected) { c.publish(outTopic, text, { qos: 0, retain: false }); n++; } });
        return n;
      },
      connected() { return clients.filter((c) => c.connected).length; },
      close() { closed = true; clients.forEach((c) => { try { c.end(true); } catch (e) { /* 무시 */ } }); },
    };
  }

  root.PreShowRelay = { connect, DEFAULT_BROKERS };
})(typeof window !== 'undefined' ? window : globalThis);
