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
const METADATA_FILE = path.join(__dirname, 'metadata.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const MAX_CACHE_BYTES = (parseInt(process.env.MAX_CACHE_MB, 10) || 500) * 1024 * 1024;

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

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// =====================================================================
//  CACHE MANAGER (LRU & LIMIT)
// =====================================================================
function getCacheFiles() {
  let files = [];
  try {
    const ents = fs.readdirSync(CACHE_DIR);
    for (const f of ents) {
      const p = path.join(CACHE_DIR, f);
      try {
        const st = fs.statSync(p);
        files.push({ name: f, path: p, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  } catch {}
  return files;
}

function getCacheStats() {
  const files = getCacheFiles();
  const audioFiles = files.filter(f => f.name.startsWith('au_') && f.name.endsWith('.mp3'));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const audioBytes = audioFiles.reduce((s, f) => s + f.size, 0);
  return {
    totalBytes,
    audioBytes,
    formatted: formatBytes(totalBytes),
    formattedAudio: formatBytes(audioBytes),
    audioCount: audioFiles.length,
    fileCount: files.length,
    limitBytes: MAX_CACHE_BYTES,
    formattedLimit: formatBytes(MAX_CACHE_BYTES)
  };
}

function pruneCache(targetMax = MAX_CACHE_BYTES) {
  const files = getCacheFiles();
  for (const f of files) {
    if (f.name.endsWith('.part.mp3')) {
      try { fs.unlinkSync(f.path); } catch {}
    }
  }
  const current = getCacheFiles();
  let total = current.reduce((s, f) => s + f.size, 0);
  if (total <= targetMax) return;
  const audioFiles = current
    .filter(f => f.name.startsWith('au_') && f.name.endsWith('.mp3'))
    .sort((a, b) => a.mtime - b.mtime);
  for (const f of audioFiles) {
    if (total <= targetMax * 0.75) break;
    try {
      fs.unlinkSync(f.path);
      total -= f.size;
    } catch {}
  }
}

function clearAudioCache() {
  const files = getCacheFiles();
  let freed = 0;
  for (const f of files) {
    if ((f.name.startsWith('au_') && f.name.endsWith('.mp3')) || f.name.endsWith('.part.mp3')) {
      try {
        fs.unlinkSync(f.path);
        freed += f.size;
      } catch {}
    }
  }
  return freed;
}

pruneCache();

// =====================================================================
//  PROFILES
// =====================================================================
let profiles = [];
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch { profiles = []; }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    profiles = [
      { id: 'prof_main', name: 'Główny', avatar: '🍿', color: '#00a8e1', history: {} },
      { id: 'prof_bob', name: 'Bob', avatar: '🎬', color: '#e50914', history: {} }
    ];
    saveProfiles();
  }
}
function saveProfiles() {
  try { fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8'); } catch {}
}
loadProfiles();

// =====================================================================
//  METADATA & IMDB
// =====================================================================
let metadataStore = {};
function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      metadataStore = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    }
  } catch { metadataStore = {}; }
}
function saveMetadata() {
  try { fs.writeFileSync(METADATA_FILE, JSON.stringify(metadataStore, null, 2), 'utf8'); } catch {}
}
loadMetadata();

function fetchJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'BobWatchTogether/2.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function cleanTitleForSearch(raw) {
  let s = raw.replace(/\.[a-z0-9]+$/i, '');
  s = s.replace(/\[.*?\]/g, ' ');
  s = s.replace(/\(.*?\)/g, ' ');
  s = s.replace(/(?:s\d+[._\s]*e\d+)|(?:\d+x\d+)/gi, ' ');
  s = s.replace(/\b(19\d\d|20\d\d)\b.*$/i, ' ');
  s = s.replace(/\b(480p|720p|1080p|2160p|4k|bluray|web-dl|amzn|remux|h264|h265|x264|x265|hevc|ac3|dts|multi|extended|remastered|kit|ft|eng|lektor|pl)\b/gi, ' ');
  s = s.replace(/[._-]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Pobiera tytuł bez "The/A/An" na początku jako alternatywę do wyszukiwania
function stripArticle(title) {
  return title.replace(/^(the|a|an)\s+/i, '').trim();
}

async function fetchOmdbWithFallback(searchTitle, extraParams = '') {
  // Próbuj z oryginalnym tytułem
  const url1 = `https://www.omdbapi.com/?t=${encodeURIComponent(searchTitle)}${extraParams}&plot=full&apikey=trilogy`;
  const res1 = await fetchJSON(url1);
  if (res1 && res1.Response === 'True' && res1.imdbRating && res1.imdbRating !== 'N/A') return res1;
  if (res1 && res1.Response === 'True' && res1.Plot && res1.Plot !== 'N/A') return res1;

  // Fallback: usuń przedrostek "The/A/An"
  const stripped = stripArticle(searchTitle);
  if (stripped !== searchTitle) {
    const url2 = `https://www.omdbapi.com/?t=${encodeURIComponent(stripped)}${extraParams}&plot=full&apikey=trilogy`;
    const res2 = await fetchJSON(url2);
    if (res2 && res2.Response === 'True') return res2;
  }

  // Zwróć pierwszy wynik nawet jeśli nie ma ratingu (może mieć inne dane)
  return res1;
}

async function getRealImdbData(title, season, episode, isEpisode = false) {
  if (isEpisode && season && episode) {
    const sStr = 'S' + String(season).padStart(2, '0');
    const eStr = 'E' + String(episode).padStart(2, '0');
    const cleanT = cleanTitleForSearch(title);

    const candidates = [
      `${title}_${sStr}${eStr}`,
      `${title}_S${season}E${episode}`,
      `${cleanT}_${sStr}${eStr}`,
      `${cleanT}_S${season}E${episode}`
    ];
    for (const k of candidates) {
      if (metadataStore[k]) return metadataStore[k];
    }

    // Próbuj z oryginalnym tytułem, potem bez przedrostka
    let resOmdb = await fetchOmdbWithFallback(cleanT, `&Season=${season}&Episode=${episode}`);
    // Jeśli nadal brak, próbuj stripArticle
    if (!resOmdb || resOmdb.Response !== 'True') {
      const stripped = stripArticle(cleanT);
      if (stripped !== cleanT) {
        resOmdb = await fetchJSON(`https://www.omdbapi.com/?t=${encodeURIComponent(stripped)}&Season=${season}&Episode=${episode}&plot=full&apikey=trilogy`);
      }
    }

    if (resOmdb && resOmdb.Response === 'True') {
      const plotEn = (resOmdb.Plot && resOmdb.Plot !== 'N/A') ? resOmdb.Plot : '';
      // Pobierz opis po polsku z Wikipedii dla odcinka
      let plotPl = '';
      if (resOmdb.Title && resOmdb.Title !== 'N/A') {
        const wikiEp = await fetchJSON(`https://pl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(resOmdb.Title)}`);
        if (wikiEp && wikiEp.extract && wikiEp.type !== 'disambiguation' && !wikiEp.extract.startsWith('Błąd')) plotPl = wikiEp.extract;
      }
      const epData = {
        title: (resOmdb.Title && resOmdb.Title !== 'N/A') ? resOmdb.Title : '',
        imdb: (resOmdb.imdbRating && resOmdb.imdbRating !== 'N/A') ? resOmdb.imdbRating : '—',
        released: (resOmdb.Released && resOmdb.Released !== 'N/A') ? resOmdb.Released : (resOmdb.Year || '—'),
        plotEn,
        plotPl,
        plot: plotPl || plotEn || ''
      };
      metadataStore[`${cleanT}_${sStr}${eStr}`] = epData;
      saveMetadata();
      return epData;
    }
    return { title: '', imdb: '—', released: '—', plot: '', plotPl: '', plotEn: '' };
  }

  const cleanKey = cleanTitleForSearch(title);
  if (metadataStore[title]) return metadataStore[title];
  if (metadataStore[cleanKey]) return metadataStore[cleanKey];

  const resOmdb = await fetchOmdbWithFallback(cleanKey);
  const resWiki = await fetchJSON(`https://pl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanKey)}`);

  // Jeśli Wikipedia PL nie znalazła po cleanKey, próbuj po angielskim tytule z OMDB
  let resWiki2 = null;
  if ((!resWiki || !resWiki.extract) && resOmdb && resOmdb.Title && resOmdb.Title !== 'N/A' && resOmdb.Title !== cleanKey) {
    resWiki2 = await fetchJSON(`https://pl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(resOmdb.Title)}`);
  }

  let info = {
    title: title,
    imdb: '—',
    year: '—',
    released: '—',
    runtime: '',
    genre: '',
    genrePl: '',
    director: '',
    actors: '',
    plotEn: '',
    plotPl: '',
    plot: ''
  };

  if (resOmdb && resOmdb.Response === 'True') {
    if (resOmdb.imdbRating && resOmdb.imdbRating !== 'N/A') info.imdb = resOmdb.imdbRating;
    if (resOmdb.Year && resOmdb.Year !== 'N/A') info.year = resOmdb.Year;
    if (resOmdb.Released && resOmdb.Released !== 'N/A') info.released = resOmdb.Released;
    if (resOmdb.Runtime && resOmdb.Runtime !== 'N/A') info.runtime = resOmdb.Runtime;
    if (resOmdb.Genre && resOmdb.Genre !== 'N/A') info.genre = resOmdb.Genre;
    if (resOmdb.Director && resOmdb.Director !== 'N/A') info.director = resOmdb.Director;
    if (resOmdb.Actors && resOmdb.Actors !== 'N/A') info.actors = resOmdb.Actors;
    if (resOmdb.Plot && resOmdb.Plot !== 'N/A') info.plotEn = resOmdb.Plot;
    if (resOmdb.Poster && resOmdb.Poster !== 'N/A') info.posterUrl = resOmdb.Poster;
  }

  const isValidWiki = (w) => w && w.extract && w.type !== 'disambiguation';
  const wikiData = isValidWiki(resWiki) ? resWiki : isValidWiki(resWiki2) ? resWiki2 : null;
  if (wikiData && wikiData.extract) {
    info.plotPl = wikiData.extract;
  }

  info.plot = info.plotPl || info.plotEn || '';

  if (info.imdb !== '—' || info.plotEn || info.plotPl) {
    metadataStore[cleanKey] = info;
    saveMetadata();
  }

  return info;
}

// =====================================================================
//  LIBRARY SCANNER
// =====================================================================
const titleOf = f => path.basename(f, path.extname(f)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

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
  const decoded = decodeURIComponent(name);
  const p = path.resolve(VIDEO_DIR, decoded);
  if (!p.startsWith(VIDEO_DIR + path.sep) || !VIDEO_MIME[path.extname(p).toLowerCase()]) return null;
  return exists(p) && fs.statSync(p).isFile() ? p : null;
}

const LANG = {
  pol: ['Polski', 'Polish', 'PL'], pl: ['Polski', 'Polish', 'PL'],
  eng: ['Angielski', 'English', 'EN'], en: ['Angielski', 'English', 'EN'],
  ger: ['Niemiecki', 'German', 'DE'], deu: ['Niemiecki', 'German', 'DE'],
  fre: ['Francuski', 'French', 'FR'], fra: ['Francuski', 'French', 'FR'],
  spa: ['Hiszpański', 'Spanish', 'ES'], ita: ['Włoski', 'Italian', 'IT'],
  rus: ['Rosyjski', 'Russian', 'RU'], jpn: ['Japoński', 'Japanese', 'JA'],
  cze: ['Czeski', 'Czech', 'CS'], ces: ['Czeski', 'Czech', 'CS'],
  ukr: ['Ukraiński', 'Ukrainian', 'UK'], kor: ['Koreański', 'Korean', 'KO'],
  chi: ['Chiński', 'Chinese', 'ZH'], zho: ['Chiński', 'Chinese', 'ZH'],
  por: ['Portugalski', 'Portuguese', 'PT'], swe: ['Szwedzki', 'Swedish', 'SV'],
};
const CH = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

function trackInfo(s, i, kind) {
  const t = s.tags || {};
  const lang = (t.language || '').toLowerCase();
  const title = t.title || '';
  const known = LANG[lang];
  const pl = lang === 'pol' || lang === 'pl' || /polsk|lektor|\bpl\b/i.test(title);
  const namePl = pl ? 'Polski' : known ? known[0] : (lang && lang !== 'und' ? lang : 'Nieznany język');
  const nameEn = pl ? 'Polish' : known ? known[1] : (lang && lang !== 'und' ? lang : 'Unknown');
  const code = pl ? 'PL' : known ? known[2] : (lang && lang !== 'und' ? lang.slice(0, 2).toUpperCase() : '?');
  let label = namePl;
  if (title && !title.toLowerCase().includes(namePl.toLowerCase())) label += ` – ${title}`;
  else if (title) label = title;
  if (kind === 'audio') label += ` · ${CH[s.channels] || s.channels + ' ch.'} ${String(s.codec_name).toUpperCase()}`;
  return { i, label, labelEn: nameEn + (title ? ` – ${title}` : ''), code, pl, codec: s.codec_name, def: s.disposition?.default === 1 };
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const SUB_EXTS = ['.srt', '.vtt', '.ass', '.ssa', '.sub'];

const probeCache = new Map();
function probe(file) {
  if (!HAS_FFMPEG) return Promise.resolve(null);
  const k = file + fs.statSync(file).mtimeMs;
  if (probeCache.has(k)) return probeCache.get(k);
  const p = (async () => {
    try {
      const j = JSON.parse(await probeQ(() => run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])));
      const audio = j.streams.filter(s => s.codec_type === 'audio').map((s, i) => trackInfo(s, i, 'audio'));
      const subs = j.streams.filter(x => x.codec_type === 'subtitle')
        .map((x, i) => ({ x, i })).filter(o => TEXT_SUBS.has(o.x.codec_name))
        .map(o => ({ ...trackInfo(o.x, o.i, 'sub'), id: 'e' + o.i }));
      return { duration: parseFloat(j.format?.duration) || 0, audio, subs };
    } catch { return null; }
  })();
  probeCache.set(k, p);
  return p;
}

// =====================================================================
//  POSTERS (SERIES & MOVIES)
// =====================================================================
const POSTER_NAMES = ['poster', 'cover', 'folder', 'front', 'okladka', 'okładka', 'thumb'];

async function getPoster(id) {
  const decodedId = decodeURIComponent(id);
  const target = path.resolve(VIDEO_DIR, decodedId);
  if (!target.startsWith(VIDEO_DIR + path.sep)) return null;

  for (const ext of Object.keys(IMG_MIME)) {
    if (exists(target + ext)) return target + ext;
  }

  let firstVideo = null;
  if (exists(target) && fs.statSync(target).isDirectory()) {
    let imgs = [];
    try { imgs = fs.readdirSync(target).filter(f => IMG_MIME[path.extname(f).toLowerCase()]).sort(natural); } catch {}
    let pick = imgs.find(f => POSTER_NAMES.includes(path.basename(f, path.extname(f)).toLowerCase())) || imgs[0];
    if (pick) return path.join(target, pick);

    try {
      const subdirs = fs.readdirSync(target, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const sd of subdirs) {
        const subPath = path.join(target, sd.name);
        const subImgs = fs.readdirSync(subPath).filter(f => IMG_MIME[path.extname(f).toLowerCase()]).sort(natural);
        const subPick = subImgs.find(f => POSTER_NAMES.includes(path.basename(f, path.extname(f)).toLowerCase())) || subImgs[0];
        if (subPick) return path.join(subPath, subPick);
      }
    } catch {}

    const t = scanLibrary().find(x => x.id === decodedId);
    if (t && t.episodes.length) firstVideo = path.join(VIDEO_DIR, t.episodes[0].file);
  } else if (exists(target)) {
    if (!safeVideoPath(decodedId)) return null;
    const base = target.slice(0, -path.extname(target).length);
    for (const e of Object.keys(IMG_MIME)) if (exists(base + e)) return base + e;
    firstVideo = target;
  }

  const cachePoster = path.join(CACHE_DIR, `p_${decodedId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
  if (exists(cachePoster)) return cachePoster;

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

// =====================================================================
//  SUBTITLES
// =====================================================================
function decodeText(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  let t = buf.toString('utf8');
  if (t.includes('\uFFFD')) { try { t = new TextDecoder('windows-1250').decode(buf); } catch {} }
  return t.replace(/^\uFEFF/, '');
}

function toVtt(buf) {
  let t = decodeText(buf).replace(/\r\n?/g, '\n');
  if (t.startsWith('WEBVTT')) return t;
  t = t.replace(/\{\\[^}]*\}/g, '')
       .replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g, (m, h, mi, se, ms) => `${h.padStart(2, '0')}:${mi}:${se}.${ms.padEnd(3, '0')}`);
  return 'WEBVTT\n\n' + t;
}

const subDirsToo = ['Subs', 'subs', 'Sub', 'Napisy', 'napisy', 'Subtitles', 'subtitles'];
const PL_RE = /(^|[^a-z])(pl|pol|polish|polski|polskie)([^a-z]|$)/i;
const EN_RE = /(^|[^a-z])(en|eng|english|angielski)([^a-z]|$)/i;

function findExtSubs(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file)).toLowerCase();
  let videosInDir = 0;
  try { videosInDir = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && VIDEO_MIME[path.extname(e.name).toLowerCase()]).length; } catch {}
  const onlyOne = videosInDir <= 1;
  const found = [];
  const scan = (d, kind) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((x, y) => natural(x.name, y.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (kind === 'subsdir' && e.name.toLowerCase().startsWith(base)) scan(p, 'nested'); continue; }
      if (!SUB_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
      const nm = path.basename(e.name, path.extname(e.name)).toLowerCase();
      const byName = nm === base || ['.', ' ', '_', '-'].some(c => nm.startsWith(base + c));
      if (kind === 'nested' || byName || onlyOne) found.push(p);
    }
  };
  scan(dir, 'same');
  for (const n of subDirsToo) scan(path.join(dir, n), 'subsdir');
  return [...new Set(found)];
}

function extSubList(file) {
  const base = path.basename(file, path.extname(file));
  const seen = new Map();
  return findExtSubs(file).map((p, i) => {
    const fn = path.basename(p);
    const tag = fn.slice(0, -path.extname(fn).length);
    const pl = PL_RE.test(tag.slice(base.length) || tag);
    const en = !pl && EN_RE.test(tag.slice(base.length) || tag);
    let label = pl ? 'Polski (plik)' : en ? 'English (file)' : `Plik: ${fn}`;
    const n = (seen.get(label) || 0) + 1; seen.set(label, n);
    if (n > 1) label += ` ${n}`;
    return { id: 'x' + i, i, label, code: pl ? 'PL' : en ? 'EN' : '?', pl, codec: 'file' };
  });
}

async function subFileToVtt(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.srt' || ext === '.vtt') return toVtt(fs.readFileSync(p));
  if (!HAS_FFMPEG) return null;
  try { return await run('ffmpeg', ['-v', 'error', '-i', p, '-f', 'webvtt', '-']); } catch { return null; }
}

const subJobs = new Map();
function extractEmbeddedSub(file, n) {
  const out = path.join(CACHE_DIR, `s_${keyOf(file, 's' + n)}.vtt`);
  if (exists(out)) return Promise.resolve(fs.readFileSync(out, 'utf8'));
  if (subJobs.has(out)) return subJobs.get(out);
  const pr = run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', `0:s:${n}`, '-f', 'webvtt', out])
    .then(() => fs.readFileSync(out, 'utf8'))
    .catch(() => null)
    .finally(() => subJobs.delete(out));
  subJobs.set(out, pr);
  return pr;
}

async function getSub(name, s) {
  const file = safeVideoPath(name);
  if (!file) return null;
  if (s && s[0] === 'e') return HAS_FFMPEG ? extractEmbeddedSub(file, parseInt(s.slice(1), 10)) : null;
  const list = findExtSubs(file);
  const p = s && s[0] === 'x' ? list[parseInt(s.slice(1), 10)] : list[0];
  return p ? subFileToVtt(p) : null;
}

// =====================================================================
//  AUDIO TRANSCODE & LIVE STREAM
// =====================================================================
const audioJobs = new Map();
const audioQ = makeQueue();
const audioPathFor = (file, a) => path.join(CACHE_DIR, `au_${keyOf(file, 'mp3-' + a)}.mp3`);

let activeAudioProc = null;
let activeAudioOut = null;

function cancelCurrentAudioJob() {
  if (activeAudioProc) {
    try { activeAudioProc.kill('SIGKILL'); } catch {}
    activeAudioProc = null;
  }
  if (activeAudioOut) {
    const tmp = activeAudioOut + '.part.mp3';
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    activeAudioOut = null;
  }
}

function startAudioJob(file, a, out, job, dur) {
  cancelCurrentAudioJob();
  audioQ(() => new Promise(resolve => {
    activeAudioOut = out;
    const tmp = out + '.part.mp3';
    const p = spawn('ffmpeg', ['-y', '-nostdin', '-i', file, '-map', `0:a:${a}`, '-vn', '-sn', '-dn',
      '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', '-f', 'mp3', tmp]);
    activeAudioProc = p;
    p.stderr.on('data', d => {
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(d.toString());
      if (m && dur) job.progress = Math.min(0.99, (m[1] * 3600 + m[2] * 60 + +m[3]) / dur);
    });
    p.on('error', () => { job.error = true; resolve(); });
    p.on('close', code => {
      activeAudioProc = null;
      activeAudioOut = null;
      if (code === 0) {
        try {
          fs.renameSync(tmp, out);
          job.done = true;
          job.progress = 1;
          pruneCache();
        } catch {
          job.error = true;
        }
      } else {
        job.error = true;
        try { fs.unlinkSync(tmp); } catch {}
      }
      resolve();
    });
  }));
}

async function audioInfo(name, a) {
  const file = safeVideoPath(name);
  if (!file || !HAS_FFMPEG) return { ready: false, error: true };
  const out = audioPathFor(file, a);
  const url = `/audiofile?name=${encodeURIComponent(name)}&a=${a}`;
  if (exists(out)) return { ready: true, url };
  let job = audioJobs.get(out);
  if (!job) {
    job = { progress: 0 }; audioJobs.set(out, job);
    const meta = await probe(file);
    startAudioJob(file, a, out, job, meta?.duration || 0);
  }
  if (job.error) { audioJobs.delete(out); return { ready: false, error: true }; }
  if (job.done) { audioJobs.delete(out); return { ready: true, url }; }
  return { ready: false, progress: job.progress };
}

// =====================================================================
//  WATCH TOGETHER (PARTY) vs SOLO STATE
// =====================================================================
let watchParty = {
  active: false,
  video: null,
  playing: false,
  time: 0,
  updatedAt: Date.now(),
  hostProfile: null,
  hostName: null,
  viewers: 0
};

const clients = new Set();

function currentPartyState() {
  const t = watchParty.playing ? watchParty.time + (Date.now() - watchParty.updatedAt) / 1000 : watchParty.time;
  return { ...watchParty, time: t, viewers: clients.size };
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

const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => {
      body += d;
      if (body.length > 15000000) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// =====================================================================
//  HTTP SERVER & ROUTES
// =====================================================================
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);

    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', party: currentPartyState(), viewers: clients.size + 1 })}\n\n`);
      clients.add(res);
      broadcast({ type: 'viewers', viewers: clients.size, party: currentPartyState() });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); broadcast({ type: 'viewers', viewers: clients.size, party: currentPartyState() }); });
      return;
    }

    if (p === '/api/state') return json(res, currentPartyState());

    if (p === '/api/library') {
      const items = [];
      for (const t of scanLibrary()) {
        const firstFile = path.join(VIDEO_DIR, t.episodes[0].file);
        const m = await probe(firstFile);
        const imdbData = await getRealImdbData(t.title);

        const episodesWithRatings = [];
        for (const e of t.episodes) {
          const epImdb = t.kind === 'series' ? await getRealImdbData(t.title, e.season, e.episode, true) : imdbData;
          episodesWithRatings.push({ 
            ...e, 
            name: (epImdb && epImdb.title) ? epImdb.title : e.name,
            imdb: (epImdb && epImdb.imdb) ? epImdb.imdb : '—', 
            released: (epImdb && (epImdb.released || epImdb.year)) ? (epImdb.released || epImdb.year) : '—',
            plot: (epImdb && (epImdb.plotPl || epImdb.plot || epImdb.plotEn)) ? (epImdb.plotPl || epImdb.plot || epImdb.plotEn) : ''
          });
        }

        items.push({
          id: t.id,
          title: t.title,
          kind: t.kind,
          poster: '/poster/' + encodeURIComponent(t.id),
          duration: t.kind === 'movie' ? (m?.duration || 0) : 0,
          imdb: imdbData.imdb || '—',
          released: imdbData.year || '—',
          runtime: imdbData.runtime || '',
          genre: imdbData.genre || '',
          genrePl: imdbData.genrePl || '',
          director: imdbData.director || '',
          actors: imdbData.actors || '',
          plotEn: imdbData.plotEn || '',
          plotPl: imdbData.plotPl || '',
          plot: imdbData.plot || imdbData.plotPl || imdbData.plotEn || '',
          audio: (m?.audio || []).map(a => ({ code: a.code, pl: a.pl, label: a.label, labelEn: a.labelEn })),
          episodes: episodesWithRatings,
        });
      }
      return json(res, { ffmpeg: HAS_FFMPEG, items });
    }

    if (p === '/api/title') {
      const id = u.searchParams.get('id');
      const item = scanLibrary().find(x => x.id === id);
      if (!item) return json(res, { error: 'Not found' }, 404);
      const firstFile = path.join(VIDEO_DIR, item.episodes[0].file);
      const m = await probe(firstFile);
      const imdbData = await getRealImdbData(item.title);
      return json(res, {
        ...item,
        poster: '/poster/' + encodeURIComponent(item.id),
        duration: m?.duration || 0,
        imdb: imdbData.imdb || '—',
        released: imdbData.year || '—',
        runtime: imdbData.runtime || '',
        genre: imdbData.genre || '',
        genrePl: imdbData.genrePl || '',
        director: imdbData.director || '',
        actors: imdbData.actors || '',
        plotEn: imdbData.plotEn || '',
        plotPl: imdbData.plotPl || '',
        plot: imdbData.plot || imdbData.plotPl || imdbData.plotEn || '',
        audio: (m?.audio || []).map(a => ({ code: a.code, pl: a.pl, label: a.label, labelEn: a.labelEn }))
      });
    }

    if (p === '/api/poster' && req.method === 'POST') {
      const id = u.searchParams.get('id');
      if (!id) return json(res, { error: 'Missing id' }, 400);
      const b = await readBody(req);
      const decodedId = decodeURIComponent(id);
      const target = path.resolve(VIDEO_DIR, decodedId);
      let savePath = null;

      if (exists(target) && fs.statSync(target).isDirectory()) {
        savePath = path.join(target, 'poster.jpg');
      } else {
        savePath = path.join(VIDEO_DIR, decodedId + '.jpg');
      }

      if (b.image && b.image.startsWith('data:image/')) {
        const base64Data = b.image.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(savePath, Buffer.from(base64Data, 'base64'));
        return json(res, { success: true, poster: '/poster/' + encodeURIComponent(decodedId) + '?t=' + Date.now() });
      } else if (b.url) {
        try {
          await new Promise((resolve, reject) => {
            https.get(b.url, { headers: { 'User-Agent': 'BobWatchTogether/2.0' } }, (resp) => {
              if (resp.statusCode >= 200 && resp.statusCode < 300) {
                const fileStream = fs.createWriteStream(savePath);
                resp.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(); });
              } else {
                reject(new Error(`Failed download with status ${resp.statusCode}`));
              }
            }).on('error', reject);
          });
          return json(res, { success: true, poster: '/poster/' + encodeURIComponent(decodedId) + '?t=' + Date.now() });
        } catch (err) {
          return json(res, { error: 'Failed to download poster from URL: ' + err.message }, 400);
        }
      }
      return json(res, { error: 'No image provided' }, 400);
    }

    if (p === '/api/cache') {
      if (req.method === 'GET') return json(res, getCacheStats());
      if (req.method === 'POST') {
        const freed = clearAudioCache();
        return json(res, { success: true, freedBytes: freed, formatted: formatBytes(freed) });
      }
    }

    if (p === '/api/profiles') {
      if (req.method === 'GET') return json(res, profiles);
      if (req.method === 'POST') {
        const b = await readBody(req);
        const newProf = {
          id: 'prof_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: (b.name || 'Nowy profil').trim(),
          avatar: b.avatar || '🍿',
          color: b.color || '#00a8e1',
          history: {}
        };
        profiles.push(newProf);
        saveProfiles();
        return json(res, newProf, 201);
      }
    }

    if (p.startsWith('/api/profiles/')) {
      const parts = p.split('/');
      const profId = parts[3];
      const sub = parts[4];
      const prof = profiles.find(x => x.id === profId);

      if (!prof) return json(res, { error: 'Profil nie istnieje' }, 404);

      if (sub === 'history' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.file) {
          prof.history = prof.history || {};
          const duration = Math.max(0, b.duration || 0);
          const time = Math.max(0, b.time || 0);
          const finished = b.finished !== undefined ? Boolean(b.finished) : (duration > 0 && time >= (duration - 60));
          prof.history[b.file] = {
            file: b.file,
            title: b.title || '',
            season: b.season || 1,
            episode: b.episode || 1,
            epName: b.epName || '',
            time: time,
            duration: duration,
            updatedAt: Date.now(),
            finished: finished
          };
          saveProfiles();
        }
        return json(res, { success: true, entry: prof.history[b.file] });
      }

      if (sub === 'toggle-watched' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.file) {
          prof.history = prof.history || {};
          const curH = prof.history[b.file] || {
            file: b.file,
            title: b.title || '',
            season: b.season || 1,
            episode: b.episode || 1,
            epName: b.epName || '',
            time: 0,
            duration: b.duration || 0
          };
          const newFinished = b.finished !== undefined ? Boolean(b.finished) : !curH.finished;
          curH.finished = newFinished;
          if (newFinished) {
            curH.time = curH.duration || b.duration || 100;
          } else {
            curH.time = 0;
          }
          curH.updatedAt = Date.now();
          prof.history[b.file] = curH;
          saveProfiles();
          return json(res, { success: true, finished: newFinished, entry: curH });
        }
        return json(res, { error: 'Missing file' }, 400);
      }

      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (b.name) prof.name = b.name.trim();
        if (b.avatar) prof.avatar = b.avatar;
        if (b.color) prof.color = b.color;
        saveProfiles();
        return json(res, prof);
      }

      if (req.method === 'DELETE') {
        if (profiles.length <= 1) return json(res, { error: 'Nie można usunąć jedynego profilu' }, 400);
        profiles = profiles.filter(x => x.id !== profId);
        saveProfiles();
        return json(res, { success: true });
      }
    }

    if (p === '/api/meta') {
      const name = u.searchParams.get('name');
      const file = safeVideoPath(name);
      if (!file) return json(res, { error: 'Nie ma takiego pliku.' }, 404);
      const m = await probe(file);
      const subs = [...(m?.subs || []), ...extSubList(file)];
      return json(res, {
        file: name, title: titleOf(path.basename(file, path.extname(file))), duration: m?.duration || 0, vwarn: '',
        audio: m?.audio || [], subs,
      });
    }

    if (p === '/audio') {
      const file = safeVideoPath(u.searchParams.get('name'));
      if (!file || !HAS_FFMPEG) { res.writeHead(404); return res.end(); }
      const a = parseInt(u.searchParams.get('a'), 10) || 0;
      const start = Math.max(0, parseFloat(u.searchParams.get('start')) || 0);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      const args = ['-nostdin', '-v', 'error'];
      if (start > 0) args.push('-ss', start.toFixed(3));
      args.push('-i', file, '-map', `0:a:${a}`, '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2',
        '-flush_packets', '1', '-f', 'mp3', 'pipe:1');
      const proc = spawn('ffmpeg', args);
      proc.stdout.pipe(res);
      proc.stderr.on('data', () => {});
      proc.on('error', () => res.end());
      res.on('close', () => proc.kill('SIGKILL'));
      return;
    }

    if (p === '/audiofile') {
      const file = safeVideoPath(u.searchParams.get('name'));
      const out = file && audioPathFor(file, parseInt(u.searchParams.get('a'), 10) || 0);
      if (!out || !exists(out)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, out, 'audio/mpeg');
    }

    if (p === '/api/audioinfo') return json(res, await audioInfo(u.searchParams.get('name'), parseInt(u.searchParams.get('a'), 10) || 0));

    if (p === '/api/prep') {
      return json(res, { ready: true, url: '/video/' + encodeURIComponent(u.searchParams.get('name')) });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const a = await readBody(req);
      try {
        const time = Number.isFinite(a.time) ? Math.max(0, a.time) : 0;
        const isParty = a.mode === 'party';

        if (isParty) {
          if (a.type === 'load') {
            if (!safeVideoPath(a.video)) throw new Error('bad video');
            watchParty = {
              active: true,
              video: a.video,
              playing: false,
              time: 0,
              updatedAt: Date.now(),
              hostProfile: a.profileId,
              hostName: a.profileName || 'Gospodarz',
              viewers: 1
            };
          } else if (a.type === 'play') {
            watchParty.playing = true;
            watchParty.time = time;
            watchParty.updatedAt = Date.now();
          } else if (a.type === 'pause') {
            watchParty.playing = false;
            watchParty.time = time;
            watchParty.updatedAt = Date.now();
          } else if (a.type === 'seek') {
            watchParty.time = time;
            watchParty.updatedAt = Date.now();
          }
          broadcast({ type: a.type, from: a.id, party: currentPartyState(), isParty: true, profileId: a.profileId, profileName: a.profileName });
        } else {
          broadcast({ type: 'solo_action', from: a.id, action: a.type, profileId: a.profileId, profileName: a.profileName });
        }
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
      return;
    }

    if (p === '/api/end' && req.method === 'POST') {
      watchParty = { active: false, video: null, playing: false, time: 0, updatedAt: Date.now(), hostProfile: null, hostName: null, viewers: 0 };
      cancelCurrentAudioJob();
      broadcast({ type: 'end', party: currentPartyState() });
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
      const txt = await getSub(p.slice(5), u.searchParams.get('s'));
      if (!txt) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
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
  console.log(`\n=================================================`);
  console.log(`  Bob Watch Together v2.1 uruchomiony!`);
  console.log(`  Folder z mediami: ${VIDEO_DIR}`);
  console.log(`  Limit pamięci podręcznej (.cache): ${formatBytes(MAX_CACHE_BYTES)}`);
  console.log(`-------------------------------------------------`);
  console.log(`  Lokalnie: http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  W sieci:  http://${i.address}:${PORT}`);
  if (!HAS_FFMPEG) console.log('  UWAGA: brak ffmpeg/ffprobe w systemie.');
  console.log(`=================================================\n`);
});
