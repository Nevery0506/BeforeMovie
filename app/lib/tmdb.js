'use strict';
// TMDB(영화 정보 서비스)에서 영화 검색·상세 정보를 가져옵니다.
const fs = require('fs');
const path = require('path');

const API = process.env.PRESHOW_TMDB_API || 'https://api.themoviedb.org/3';
const IMG = process.env.PRESHOW_TMDB_IMG || 'https://image.tmdb.org/t/p/';
let genreCache = null;

async function tm(pathname, params, key) {
  if (!key) throw new Error('TMDB API 키가 없습니다. 오른쪽 위 [설정]에서 입력해 주세요.');
  const u = new URL(API + pathname);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (key.trim().startsWith('eyJ')) headers.Authorization = 'Bearer ' + key.trim();
  else u.searchParams.set('api_key', key.trim());
  let r;
  try {
    r = await (global.preshowFetch || fetch)(u, { headers });
  } catch (e) {
    // 원인을 알 수 있도록 실제 오류 내용을 함께 보여 줍니다.
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message || '';
    throw new Error('영화 정보 서버(api.themoviedb.org)에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.' + (why ? ' [' + String(why).slice(0, 80) + ']' : ''));
  }
  if (r.status === 401) throw new Error('TMDB API 키가 올바르지 않습니다. [설정]에서 다시 확인해 주세요.');
  if (r.status === 429) throw new Error('영화 정보 서버가 잠시 요청을 제한했습니다. 1분쯤 뒤에 다시 검색해 주세요.');
  if (!r.ok) throw new Error('영화 정보 서버 오류 (' + r.status + ')');
  return r.json();
}

async function genres(key) {
  if (genreCache) return genreCache;
  const j = await tm('/genre/movie/list', { language: 'ko' }, key);
  genreCache = {};
  for (const g of j.genres || []) genreCache[g.id] = g.name;
  return genreCache;
}

async function search(query, key) {
  const [j, g] = await Promise.all([
    tm('/search/movie', { query, language: 'ko-KR', region: 'KR', include_adult: 'false' }, key),
    genres(key),
  ]);
  return (j.results || []).slice(0, 12).map((m) => ({
    id: m.id,
    title: m.title || m.original_title,
    originalTitle: m.original_title,
    year: (m.release_date || '').slice(0, 4),
    rating: m.vote_count ? Math.round(m.vote_average * 10) / 10 : null,
    genres: (m.genre_ids || []).map((id) => g[id]).filter(Boolean),
    poster: m.poster_path ? IMG + 'w154' + m.poster_path : null,
  }));
}

const CERT = { ALL: '전체 관람가', All: '전체 관람가', 12: '12세 이상 관람가', 15: '15세 이상 관람가', 18: '청소년 관람불가', 19: '청소년 관람불가' };

function certification(rel) {
  const kr = ((rel && rel.results) || []).find((r) => r.iso_3166_1 === 'KR');
  if (!kr) return '';
  for (const d of kr.release_dates || []) {
    const c = (d.certification || '').trim();
    if (c) return CERT[c] || CERT[c.replace(/\D/g, '')] || c;
  }
  return '';
}

async function download(url, dest) {
  const r = await (global.preshowFetch || fetch)(url);
  if (!r.ok) throw new Error('이미지 다운로드 실패 ' + r.status);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

async function details(id, key, cacheDir) {
  const m = await tm('/movie/' + id, {
    language: 'ko-KR',
    append_to_response: 'credits,videos,release_dates',
    include_video_language: 'ko,en,null',
  }, key);
  let overview = (m.overview || '').trim();
  if (!overview) {
    try {
      const en = await tm('/movie/' + id, { language: 'en-US' }, key);
      overview = (en.overview || '').trim();
    } catch (e) { /* 줄거리 없이 진행 */ }
  }
  const crew = (m.credits && m.credits.crew) || [];
  const cast = (m.credits && m.credits.cast) || [];
  const dir = path.join(cacheDir, String(id));
  let posterFile = null;
  if (m.poster_path) {
    try { posterFile = await download(IMG + 'w780' + m.poster_path, path.join(dir, 'poster.jpg')); } catch (e) { posterFile = null; }
  }
  return {
    id: m.id,
    title: m.title || m.original_title,
    originalTitle: m.original_title || '',
    originalLanguage: m.original_language || '',
    year: (m.release_date || '').slice(0, 4),
    runtime: m.runtime || null,
    genres: (m.genres || []).map((g) => g.name),
    genreIds: (m.genres || []).map((g) => g.id),
    rating: m.vote_count ? Math.round(m.vote_average * 10) / 10 : null,
    certification: certification(m.release_dates),
    director: crew.filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 2).join(', '),
    cast: cast.slice(0, 4).map((c) => c.name),
    overview,
    tagline: (m.tagline || '').trim(),
    posterFile,
    videos: ((m.videos && m.videos.results) || []).map((v) => ({
      key: v.key, name: v.name, site: v.site, type: v.type, official: !!v.official, lang: v.iso_639_1, size: v.size,
    })),
  };
}

module.exports = { search, details };
