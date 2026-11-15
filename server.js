
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const VIDEO_DIR = path.resolve(process.env.VIDEO_DIR || path.join(__dirname, 'videos'));
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, '.cache'));
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const HAS_FFMPEG = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };


const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const makeQueue = () => { let chain = Promise.resolve(); return fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r; }; };
const probeQ = makeQueue(), posterQ = makeQueue();

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args); let out = '';
    p.stdout.on('data', d => out += d);
    p.on('error', rej);
    p.on('close', c => c === 0 ? res(out) : rej(new Error(`${cmd} -> ${c}`)));
  });
}

function keyOf(file, extra = '') {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}|${extra}`).digest('hex').slice(0, 16);
}

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const toRel = p => path.relative(VIDEO_DIR, p).split(path.sep).join('/');

function walk(dir, depth = 0) {
  let out = [], ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 3) out.push(...walk(p, depth + 1));
    else if (d.isFile() && VIDEO_MIME[path.extname(d.name).toLowerCase()]) out.push(p);
  }
  return out;
}

function scanLibrary() {
  const titles = [];
  let ents = [];
  try { ents = fs.readdirSync(VIDEO_DIR, { withFileTypes: true }); } catch {}
  for (const d of ents) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(VIDEO_DIR, d.name);
    if (d.isDirectory()) {
      const files = walk(full).map(toRel).sort(natural);
      if (!files.length) continue;
      titles.push({
        id: d.name, title: titleOf(d.name), kind: files.length > 1 ? 'series' : 'movie',
        episodes: files.map(f => {
          const parts = f.split('/');
          const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, '');
          const match = /(?:s(\d+)[._\s]*e(\d+))|(?:(\d+)x(\d+))/i.exec(fileName);
          return {
            file: f,
            name: titleOf(fileName),
            group: parts.slice(1, -1).join(' / '),
            season: match ? parseInt(match[1] || match[3], 10) : 1,
            episode: match ? parseInt(match[2] || match[4], 10) : 1
          };
        }),
      });
    } else if (d.isFile() && VIDEO_MIME[path.extname(d.name).toLowerCase()]) {
      titles.push({ id: d.name, title: titleOf(d.name), kind: 'movie', episodes: [{ file: d.name, name: titleOf(d.name), group: '', season: 1, episode: 1 }] });
    }
  }
  return titles.sort((x, y) => natural(x.title, y.title));
}

function safeVideoPath(name) {
  if (!name) return null;
  const p = path.resolve(VIDEO_DIR, name);
  if (!p.startsWith(VIDEO_DIR + path.sep) || !VIDEO_MIME[path.extname(p).toLowerCase()]) return null;
  return exists(p) && fs.statSync(p).isFile() ? p : null;
}

const titleOf = f => path.basename(f, path.extname(f)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();


const LANG = {
  pol: ['Polski', 'PL'], pl: ['Polski', 'PL'], eng: ['Angielski', 'EN'], en: ['Angielski', 'EN'],
  ger: ['Niemiecki', 'DE'], deu: ['Niemiecki', 'DE'], fre: ['Francuski', 'FR'], fra: ['Francuski', 'FR'],
  spa: ['Hiszpański', 'ES'], ita: ['Włoski', 'IT'], rus: ['Rosyjski', 'RU'], jpn: ['Japoński', 'JA'],
  cze: ['Czeski', 'CS'], ces: ['Czeski', 'CS'], ukr: ['Ukraiński', 'UK'], kor: ['Koreański', 'KO'],
  chi: ['Chiński', 'ZH'], zho: ['Chiński', 'ZH'], por: ['Portugalski', 'PT'], swe: ['Szwedzki', 'SV'],
};
const CH = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

function trackInfo(s, i, kind) {
  const t = s.tags || {};
  const lang = (t.language || '').toLowerCase();
  const title = t.title || '';
  const known = LANG[lang];
  const pl = lang === 'pol' || lang === 'pl' || /polsk|lektor|\bpl\b/i.test(title);
  const name = pl ? 'Polski' : known ? known[0] : (lang && lang !== 'und' ? lang : 'Nieznany język');
  const code = pl ? 'PL' : known ? known[1] : (lang && lang !== 'und' ? lang.slice(0, 2).toUpperCase() : '?');
  let label = name;
  if (title && !title.toLowerCase().includes(name.toLowerCase())) label += ` – ${title}`;
  else if (title) label = title;
  if (kind === 'audio') label += ` · ${CH[s.channels] || s.channels + ' kan.'} ${String(s.codec_name).toUpperCase()}`;
  return { i, label, code, pl, codec: s.codec_name, def: s.disposition?.default === 1 };
}

const probeCache = new Map();
function probe(file) {
  if (!HAS_FFMPEG) return Promise.resolve(null);
  const k = file + fs.statSync(file).mtimeMs;
  if (probeCache.has(k)) return probeCache.get(k);
  const p = (async () => {
    try {
      const j = JSON.parse(await probeQ(() => run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])));
      const audio = j.streams.filter(s => s.codec_type === 'audio').map((s, i) => trackInfo(s, i, 'audio'));
      return { duration: parseFloat(j.format?.duration) || 0, audio, subs: [] };
    } catch { return null; }
  })();
  probeCache.set(k, p);
  return p;
}


const imdbCache = new Map();

function fetchJSON(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function getRealImdbData(title, season, episode, isEpisode = false) {
  const cacheKey = `${title}_S${season}E${episode}`;
  if (imdbCache.has(cacheKey)) return imdbCache.get(cacheKey);

  let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=trilogy`;
  if (isEpisode && season && episode) {
    url += `&Season=${season}&Episode=${episode}`;
  }

  const res = await fetchJSON(url);
  let info = { rating: null, year: null, released: null };
  if (res && res.Response === 'True') {
    if (res.imdbRating && res.imdbRating !== 'N/A') info.rating = res.imdbRating;
    if (res.Year && res.Year !== 'N/A') info.year = res.Year;
    if (res.Released && res.Released !== 'N/A') info.released = res.Released;
  }

  imdbCache.set(cacheKey, info);
  return info;
}


const POSTER_NAMES = ['poster', 'cover', 'folder', 'front', 'okladka', 'okładka', 'thumb'];

async function getPoster(id) {
  const target = path.resolve(VIDEO_DIR, id);
  if (!target.startsWith(VIDEO_DIR + path.sep) || !exists(target)) return null;
  let firstVideo = null;
  if (fs.statSync(target).isDirectory()) {
    const imgs = fs.readdirSync(target).filter(f => IMG_MIME[path.extname(f).toLowerCase()]).sort(natural);
    const pick = imgs.find(f => POSTER_NAMES.includes(path.basename(f, path.extname(f)).toLowerCase())) || imgs[0];
    if (pick) return path.join(target, pick);
    const t = scanLibrary().find(x => x.id === id);
    if (t) firstVideo = path.join(VIDEO_DIR, t.episodes[0].file);
  } else {
    if (!safeVideoPath(id)) return null;
    const base = target.slice(0, -path.extname(target).length);
    for (const e of Object.keys(IMG_MIME)) if (exists(base + e)) return base + e;
    firstVideo = target;
  }
  if (!firstVideo || !HAS_FFMPEG) return null;
  const out = path.join(CACHE_DIR, 'p_' + keyOf(firstVideo) + '.jpg');
  if (exists(out)) return out;
  const meta = await probe(firstVideo);
  const t = meta?.duration ? Math.floor(meta.duration * 0.2) : 30;
  try {
    await posterQ(() => run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', firstVideo, '-frames:v', '1',
      '-vf', 'crop=ih*2/3:ih,scale=360:-2', '-q:v', '4', out]));
  } catch { return null; }
  return exists(out) ? out : null;
}

function toVtt(buf) {
  let txt = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (txt.includes('\uFFFD')) {
    try { txt = new TextDecoder('windows-1250').decode(buf).replace(/^\uFEFF/, ''); } catch {}
  }
  if (txt.startsWith('WEBVTT')) return txt;
  return 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

async function getSub(name) {
  const file = safeVideoPath(name);
  if (!file) return null;
  const base = file.slice(0, -path.extname(file).length);
  
  for (const ext of ['.srt', '.vtt', '.sub']) {
    const subPath = base + ext;
    if (exists(subPath)) {
      return toVtt(fs.readFileSync(subPath));
    }
  }
  return null;
}


let state = { video: null, playing: false, time: 0, updatedAt: Date.now() };
const clients = new Set();

function currentState() {
  const t = state.playing ? state.time + (Date.now() - state.updatedAt) / 1000 : state.time;
  return { video: state.video, playing: state.playing, time: t };
}
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(msg);
}


function serveFile(req, res, file, type) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type });
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', state: currentState(), viewers: clients.size + 1 })}\n\n`);
      clients.add(res);
      broadcast({ type: 'viewers', viewers: clients.size });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); broadcast({ type: 'viewers', viewers: clients.size }); });
      return;
    }

    if (p === '/api/state') return json(res, currentState());

    if (p === '/api/library') {
      const items = [];
      for (const t of scanLibrary()) {
        const m = await probe(path.join(VIDEO_DIR, t.episodes[0].file));
        const imdbData = await getRealImdbData(t.title);

        const episodesWithRatings = [];
        for (const e of t.episodes) {
          const epImdb = t.kind === 'series' ? await getRealImdbData(t.title, e.season, e.episode, true) : imdbData;
          episodesWithRatings.push({ 
            ...e, 
            imdb: epImdb.rating || '—', 
            released: epImdb.released || epImdb.year || '—' 
          });
        }

        items.push({
          id: t.id, title: t.title, kind: t.kind, poster: '/poster/' + encodeURIComponent(t.id),
          duration: t.kind === 'movie' ? (m?.duration || 0) : 0,
          imdb: imdbData.rating || '—',
          released: imdbData.year || '—',
          audio: (m?.audio || []).map(a => ({ code: a.code, pl: a.pl })),
          episodes: episodesWithRatings,
        });
      }
      return json(res, { ffmpeg: HAS_FFMPEG, items });
    }

    if (p === '/api/meta') {
      const name = u.searchParams.get('name');
      const file = safeVideoPath(name);
      if (!file) return json(res, { error: 'Nie ma takiego pliku.' }, 404);
      const m = await probe(file);
      
      const base = file.slice(0, -path.extname(file).length);
      const hasExtSub = ['.srt', '.vtt', '.sub'].some(ext => exists(base + ext));

      return json(res, {
        file: name, title: titleOf(path.basename(file, path.extname(file))), duration: m?.duration || 0, vwarn: '',
        audio: m?.audio || [], 
        subs: hasExtSub ? [{ i: 0, label: 'Polskie (zewnętrzne pliki)', code: 'PL', pl: true }] : [], 
        extSub: hasExtSub
      });
    }

    if (p === '/audio') {
      const name = u.searchParams.get('name');
      const file = safeVideoPath(name);
      if (!file) { res.writeHead(404); return res.end(); }
      const a = parseInt(u.searchParams.get('a'), 10) || 0;
      const start = parseFloat(u.searchParams.get('start')) || 0;

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
      });

      const args = ['-y', '-nostdin'];
      if (start > 0) args.push('-ss', String(start));
      args.push('-i', file, '-map', `0:a:${a}`, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1');

      const ffmpegProc = spawn('ffmpeg', args);
      ffmpegProc.stdout.pipe(res);
      ffmpegProc.stderr.on('data', () => {});
      req.on('close', () => { ffmpegProc.kill('SIGKILL'); });
      return;
    }

    if (p === '/api/prep') {
      return json(res, { ready: true, url: '/video/' + encodeURIComponent(u.searchParams.get('name')) });
    }

    if (p === '/api/action' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const a = JSON.parse(body);
          const time = Number.isFinite(a.time) ? Math.max(0, a.time) : 0;
          if (a.type === 'load') {
            if (!safeVideoPath(a.video)) throw new Error('bad video');
            if (a.after && state.video !== a.after) { res.writeHead(204); return res.end(); }
            state = { video: a.video, playing: false, time: 0, updatedAt: Date.now() };
          } else if (a.type === 'play') state = { ...state, playing: true, time, updatedAt: Date.now() };
          else if (a.type === 'pause') state = { ...state, playing: false, time, updatedAt: Date.now() };
          else if (a.type === 'seek') state = { ...state, time, updatedAt: Date.now() };
          else throw new Error('bad action');
          broadcast({ type: a.type, from: a.id, state: currentState() });
          res.writeHead(204); res.end();
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }


    if (p === '/api/end' && req.method === 'POST') {
      state = { video: null, playing: false, time: 0, updatedAt: Date.now() };
      broadcast({ type: 'end', state: currentState() });
      return json(res, { success: true });
    }

    if (p.startsWith('/video/')) {
      const f = safeVideoPath(p.slice(7));
      if (!f) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, f, VIDEO_MIME[path.extname(f).toLowerCase()]);
    }

    if (p.startsWith('/poster/')) {
      const f = await getPoster(p.slice(8));
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': IMG_MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }

    if (p.startsWith('/sub/')) {
      const name = p.slice(5);
      const txt = await getSub(name);
      if (txt === null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
      return res.end(txt);
    }

    if (p === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'style.css')).pipe(res);
    }

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nWspólny seans działa. Folder z filmami: ${VIDEO_DIR}\n`);
  console.log(`  Ty:      http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  Znajomy: http://${i.address}:${PORT}`);
  if (!HAS_FFMPEG) console.log('\n  UWAGA: brak ffmpeg/ffprobe.\n');
  console.log('');
});
