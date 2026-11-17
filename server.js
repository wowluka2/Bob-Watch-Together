const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (['/absolute/path/to/videos', '/absolute/path/to/cache'].includes(value)) continue;
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VIDEO_DIR = path.resolve(process.env.VIDEO_DIR || path.join(ROOT, 'videos'));
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(ROOT, '.cache'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const METADATA_FILE = path.resolve(process.env.METADATA_FILE || path.join(ROOT, 'metadata.json'));
const PROFILES_FILE = path.resolve(process.env.PROFILES_FILE || path.join(ROOT, 'profiles.json'));
const ADMIN_FILE = path.resolve(process.env.ADMIN_FILE || path.join(ROOT, '.admin.json'));
const PARTY_FILE = path.resolve(process.env.PARTY_FILE || path.join(ROOT, '.party.json'));
const SQLITE_FILE = path.resolve(process.env.DATABASE_FILE || path.join(ROOT, 'platform.db'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const MAX_BODY = parseInt(process.env.MAX_BODY_MB || '20', 10) * 1024 * 1024;
const MAX_CACHE_BYTES = (parseInt(process.env.MAX_CACHE_MB || '500', 10) * 1024 * 1024);
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
let tmdbArtworkStatus = {
  configured: Boolean(TMDB_API_KEY),
  status: TMDB_API_KEY ? 'not-checked' : 'missing-key',
  lastCheckedAt: null,
  lastTitle: '',
  lastError: TMDB_API_KEY ? '' : 'TMDB_API_KEY is not configured.',
};
const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || '24', 10) * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

for (const dir of [VIDEO_DIR, CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });

const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const HAS_FFMPEG = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

const SQLITE_CLI = process.platform === 'linux' && fs.existsSync('/usr/bin/sqlite3')
  ? '/usr/bin/sqlite3'
  : 'sqlite3';

if (spawnSync(SQLITE_CLI, ['--version']).status !== 0) {
  console.error('\nBŁĄD: SQLite 3 nie jest zainstalowane lub nie jest dostępne jako "sqlite3".');
  console.error('Debian/Ubuntu: sudo apt install -y sqlite3');
  console.error('Docker: użyj docker compose up -d --build\n');
  process.exit(1);
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteExec(sql, args = {}) {
  const completed = String(sql).replace(/\$(\w+)/g, (_, key) => sqlQuote(args[key] ?? ''));
  const result = spawnSync('/usr/bin/sqlite3', ['-batch', '-bail', SQLITE_FILE], {
    input: `${completed}\n`,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error) throw new Error(`SQLite process error: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `sqlite3 exited ${result.status ?? 'without status'} (signal: ${result.signal || 'none'})`).trim());
  return result.stdout || '';
}

function sqliteRows(sql, args = {}) {
  let completed = String(sql).replace(/\$(\w+)/g, (_, key) => sqlQuote(args[key] ?? ''));
  completed = `.mode json\n${completed.endsWith(';') ? completed : completed + ';'}`;
  const result = spawnSync('/usr/bin/sqlite3', ['-batch', '-bail', SQLITE_FILE], {
    input: completed,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error) throw new Error(`SQLite process error: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `sqlite3 exited ${result.status ?? 'without status'} (signal: ${result.signal || 'none'})`).trim());
  try { return JSON.parse(result.stdout || '[]'); } catch { return []; }
}

function sqliteReadOnlyRows(sql) {
  const completed = `.mode json\n${sql.endsWith(';') ? sql : `${sql};`}`;
  const result = spawnSync(SQLITE_CLI, ['-readonly', '-batch', '-bail', SQLITE_FILE], {
    input: completed,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error) throw new Error(`SQLite process error: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `sqlite3 exited ${result.status ?? 'without status'} (signal: ${result.signal || 'none'})`).trim());
  try { return JSON.parse(result.stdout || '[]'); } catch { return []; }
}

function initializeDatabase() {
  sqliteExec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('administrator','editor','viewer')),
      display_name TEXT,
      avatar TEXT,
      color TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      color TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      history TEXT NOT NULL DEFAULT '{}',
      owner_user_id TEXT,
      favorites TEXT NOT NULL DEFAULT '[]',
      watch_later TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS party_rooms (
      id TEXT PRIMARY KEY,
      video TEXT,
      playing INTEGER NOT NULL DEFAULT 0,
      time REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      host_user_id TEXT,
      host_name TEXT,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id TEXT,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS party_invites (
      code_hash TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      max_uses INTEGER NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(room_id,user_id)
    );
  `);
}

initializeDatabase();

function ensureSqliteColumn(table, column, definition) {
  const columns = sqliteRows(`PRAGMA table_info(${table});`);
  if (!columns.some(entry => entry.name === column)) {
    sqliteExec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

ensureSqliteColumn('profiles', 'owner_user_id', 'TEXT');
ensureSqliteColumn('profiles', 'favorites', "TEXT NOT NULL DEFAULT '[]'");
ensureSqliteColumn('profiles', 'watch_later', "TEXT NOT NULL DEFAULT '[]'");

function sqliteAudit(actor, action, details = {}) {
  try {
    sqliteExec(
      `INSERT INTO audit_log(actor,action,details,created_at)
       VALUES($actor,$action,$details,$createdAt);`,
      { actor, action, details: JSON.stringify(details), createdAt: Date.now() }
    );
  } catch (error) {
    console.error(`Audit log failed: ${error.message}`);
  }
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseStoredJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`)));
  });
}

function makeQueue() {
  let chain = Promise.resolve();
  return fn => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
}
function makeLimit(concurrency) {
  let active = 0;
  const pending = [];
  const runNext = () => {
    while (active < concurrency && pending.length) {
      const { fn, resolve, reject } = pending.shift();
      active++;
      const finish = () => {
        active--;
        runNext();
      };
      Promise.resolve().then(fn).then(
        result => { resolve(result); finish(); },
        error => { reject(error); finish(); },
      );
    }
  };
  return fn => new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject });
    runNext();
  });
}
// ---------------------------------------------------------------------
// Authentication and administration
// ---------------------------------------------------------------------
const sessions = new Map();
const loginAttempts = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = crypto.pbkdf2Sync(password, record.salt, 120000, 32, 'sha256');
  const saved = Buffer.from(record.hash, 'hex');
  return saved.length === candidate.length && crypto.timingSafeEqual(saved, candidate);
}

let admin = readJson(ADMIN_FILE, null);
if (!admin || !admin.username || !admin.hash) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  admin = { username, role: 'administrator', createdAt: Date.now(), ...hashPassword(password) };
  atomicWrite(ADMIN_FILE, admin);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`\nPierwsze uruchomienie: login=${username} haslo=${password}`);
    console.log('Zmień hasło natychmiast w panelu administracyjnym lub przez ADMIN_PASSWORD.\n');
  }
}

sqliteExec(
  `INSERT INTO users(id,username,password_salt,password_hash,role,display_name,avatar,color,active,created_at,updated_at)
   VALUES($id,$username,$salt,$hash,'administrator','Administrator','🛡️','#4db7ef',1,$created,$updated)
   ON CONFLICT(id) DO UPDATE SET
     username=excluded.username,
     password_salt=excluded.password_salt,
     password_hash=excluded.password_hash,
     role='administrator',
     updated_at=excluded.updated_at;`,
  {
    id: 'legacy_admin',
    username: admin.username,
    salt: admin.salt,
    hash: admin.hash,
    created: admin.createdAt || Date.now(),
    updated: Date.now(),
  }
);

function parseCookies(header = '') {
  const cookies = {};
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) cookies[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return cookies;
}

function getSession(req) {
  const id = parseCookies(req.headers.cookie)[bwtSessionName];
  let session = id && sessions.get(id);
  if (!session && id) {
    const rows = sqliteRows(`SELECT s.id,s.user_id,s.username,s.role,s.expires_at,u.active
                             FROM sessions s JOIN users u ON u.id=s.user_id
                             WHERE s.id=$id AND s.revoked_at IS NULL LIMIT 1;`, { id });
    if (rows.length) {
      const row = rows[0];
      if (row.expires_at >= Date.now() && row.active === 1) {
        const restored = { userId: row.user_id, username: row.username, role: row.role, expiresAt: row.expires_at };
        session = restored;
        sessions.set(id, restored);
      } else {
        sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE id=$id;`, { now: Date.now(), id });
      }
    }
  }
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    if (id) sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE id=$id AND revoked_at IS NULL;`, { now: Date.now(), id });
    return null;
  }
  return session;
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, { error: 'Zaloguj się, aby kontynuować.' }, 401);
    return null;
  }
  return session;
}

function profileForSession(id, session) {
  return profiles.find(profile => profile.id === id && profile.ownerUserId === session.userId) || null;
}

function hasRoomAccess(userId, roomId = 'main') {
  if (!userId) return false;
  if (roomId === 'main' && watchParty.hostUserId === userId) return true;
  return sqliteRows(`SELECT 1 AS allowed FROM room_members WHERE room_id=$room AND user_id=$user LIMIT 1;`,
    { room: roomId, user: userId }).length > 0;
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session || session.role !== 'administrator') {
    json(res, { error: 'Wymagane zalogowanie administratora.' }, 401);
    return false;
  }
  return true;
}

function revokeUserSessions(userId) {
  const now = Date.now();
  sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE user_id=$user AND revoked_at IS NULL;`, { now, user: userId });
  for (const [id, session] of sessions) if (session.userId === userId) sessions.delete(id);
}

const bwtSessionName = 'bwt_session';
setInterval(() => {
  for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id);
}, 60 * 1000).unref();

// ---------------------------------------------------------------------
// JSON-backed data
// ---------------------------------------------------------------------
let profiles = readJson(PROFILES_FILE, null);
if (!Array.isArray(profiles) || !profiles.length) {
  profiles = sqliteRows(`SELECT id,name,avatar,color,role,history,owner_user_id,favorites,watch_later FROM profiles ORDER BY created_at;`)
    .map(row => ({
      id: row.id, name: row.name, avatar: row.avatar, color: row.color, role: row.role,
      history: parseStoredJson(row.history, {}),
      ownerUserId: row.owner_user_id || 'legacy_admin',
      favorites: parseStoredJson(row.favorites, []),
      watchLater: parseStoredJson(row.watch_later, []),
    }));
}
if (!Array.isArray(profiles) || !profiles.length) {
  profiles = [
    { id: 'prof_main', name: 'Główny', avatar: '🍿', color: '#00a8e1', role: 'viewer', history: {} },
    { id: 'prof_guest', name: 'Gość', avatar: '🎬', color: '#e50914', role: 'viewer', history: {} },
  ];
  atomicWrite(PROFILES_FILE, profiles);
}
for (const profile of profiles) {
  profile.ownerUserId ||= 'legacy_admin';
  profile.favorites = Array.isArray(profile.favorites) ? profile.favorites : [];
  profile.watchLater = Array.isArray(profile.watchLater) ? profile.watchLater : [];
}
let metadataStore = readJson(METADATA_FILE, {});
let watchParty = readJson(PARTY_FILE, null);
if (!watchParty) {
  const savedRoom = sqliteRows(`SELECT video,playing,time,updated_at,host_user_id,host_name,active
                                FROM party_rooms WHERE id='main' LIMIT 1;`)[0];
  watchParty = savedRoom ? {
    active: Boolean(savedRoom.active), video: savedRoom.video, playing: Boolean(savedRoom.playing),
    time: Number(savedRoom.time) || 0, updatedAt: Number(savedRoom.updated_at) || Date.now(),
    hostProfile: null, hostUserId: savedRoom.host_user_id || null,
    hostName: savedRoom.host_name || null, viewers: 0,
  } : { active: false, video: null, playing: false, time: 0, updatedAt: Date.now(), hostProfile: null, hostUserId: null, hostName: null, viewers: 0 };
}
if (watchParty.active && !watchParty.hostUserId) {
  watchParty.hostUserId = profiles.find(profile => profile.id === watchParty.hostProfile)?.ownerUserId || 'legacy_admin';
}

for (const profile of profiles) {
  sqliteExec(
    `INSERT INTO profiles(id,name,avatar,color,role,history,owner_user_id,favorites,watch_later,created_at,updated_at)
     VALUES($id,$name,$avatar,$color,$role,$history,$owner,$favorites,$watchLater,$created,$updated)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, avatar=excluded.avatar, color=excluded.color,
       role=excluded.role, history=excluded.history, owner_user_id=COALESCE(profiles.owner_user_id,excluded.owner_user_id),
       favorites=excluded.favorites, watch_later=excluded.watch_later, updated_at=excluded.updated_at;`,
    { id: profile.id, name: profile.name, avatar: profile.avatar || '🍿', color: profile.color || '#4db7ef',
      role: profile.role || 'viewer', history: JSON.stringify(profile.history || {}), owner: profile.ownerUserId,
      favorites: JSON.stringify(profile.favorites), watchLater: JSON.stringify(profile.watchLater),
      created: Date.now(), updated: Date.now() }
  );
}
for (const [key, value] of Object.entries(metadataStore)) {
  sqliteExec(`INSERT INTO metadata(key,value,updated_at) VALUES($key,$value,$updated)
              ON CONFLICT(key) DO NOTHING;`,
    { key, value: JSON.stringify(value), updated: Date.now() });
}

function saveProfiles() {
  try { atomicWrite(PROFILES_FILE, profiles); } catch (error) { console.error('Nie można zapisać profili:', error.message); }
  for (const profile of profiles) {
    sqliteExec(
      `INSERT INTO profiles(id,name,avatar,color,role,history,owner_user_id,favorites,watch_later,created_at,updated_at)
       VALUES($id,$name,$avatar,$color,$role,$history,$owner,$favorites,$watchLater,$created,$updated)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,color=excluded.color,
       role=excluded.role,history=excluded.history,owner_user_id=excluded.owner_user_id,
       favorites=excluded.favorites,watch_later=excluded.watch_later,updated_at=excluded.updated_at;`,
      { id: profile.id, name: profile.name, avatar: profile.avatar || '🍿', color: profile.color || '#4db7ef',
        role: profile.role || 'viewer', history: JSON.stringify(profile.history || {}), owner: profile.ownerUserId,
        favorites: JSON.stringify(profile.favorites || []), watchLater: JSON.stringify(profile.watchLater || []),
        created: Date.now(), updated: Date.now() }
    );
  }
}
function saveMetadata() {
  try { atomicWrite(METADATA_FILE, metadataStore); } catch (error) { console.error('Nie można zapisać metadanych:', error.message); }
  for (const [key, value] of Object.entries(metadataStore)) {
    sqliteExec(`INSERT INTO metadata(key,value,updated_at) VALUES($key,$value,$updated)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`,
      { key, value: JSON.stringify(value), updated: Date.now() });
  }
}
function saveParty() {
  try { atomicWrite(PARTY_FILE, watchParty); } catch (error) { console.error('Nie można zapisać stanu seansu:', error.message); }
  sqliteExec(
    `INSERT INTO party_rooms(id,video,playing,time,updated_at,host_user_id,host_name,active)
     VALUES('main',$video,$playing,$time,$updated,$host,$hostName,$active)
     ON CONFLICT(id) DO UPDATE SET video=excluded.video,playing=excluded.playing,time=excluded.time,
     updated_at=excluded.updated_at,host_user_id=excluded.host_user_id,host_name=excluded.host_name,active=excluded.active;`,
    { video: watchParty.video, playing: watchParty.playing ? 1 : 0, time: watchParty.time,
      updated: watchParty.updatedAt, host: watchParty.hostUserId || '', hostName: watchParty.hostName || '', active: watchParty.active ? 1 : 0 }
  );
}

// ---------------------------------------------------------------------
// Library and media
// ---------------------------------------------------------------------
const MIME_TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const LANG = {
  pol: ['Polski', 'Polish', 'PL'], pl: ['Polski', 'Polish', 'PL'],
  eng: ['Angielski', 'English', 'EN'], en: ['Angielski', 'English', 'EN'],
  ger: ['Niemiecki', 'German', 'DE'], deu: ['Niemiecki', 'German', 'DE'],
  fre: ['Francuski', 'French', 'FR'], fra: ['Francuski', 'French', 'FR'],
  spa: ['Hiszpański', 'Spanish', 'ES'], ita: ['Włoski', 'Italian', 'IT'],
  rus: ['Rosyjski', 'Russian', 'RU'], jpn: ['Japoński', 'Japanese', 'JA'],
  cze: ['Czeski', 'Czech', 'CS'], ces: ['Czeski', 'Czech', 'CS'],
};

function titleOf(fileName) {
  return path.basename(fileName, path.extname(fileName)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function walk(dir, depth = 0) {
  if (depth > 4) return [];
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
    else if (entry.isFile() && VIDEO_MIME[path.extname(entry.name).toLowerCase()]) out.push(full);
  }
  return out;
}

function scanLibrary() {
  const items = [];
  for (const entry of fs.readdirSync(VIDEO_DIR, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(VIDEO_DIR, entry.name);
    if (entry.isDirectory()) {
      const files = walk(full).map(p => path.relative(VIDEO_DIR, p).split(path.sep).join('/')).sort(natural);
      if (!files.length) continue;
      items.push({
        id: entry.name, title: titleOf(entry.name), kind: files.length > 1 ? 'series' : 'movie',
        episodes: files.map(file => {
          const base = path.basename(file, path.extname(file));
          const match = /(?:s(\d+)[._\s]*e(\d+))|(?:(\d+)x(\d+))/i.exec(base);
          const season = match ? parseInt(match[1] || match[3], 10) : 1;
          const episode = match ? parseInt(match[2] || match[4], 10) : 1;
          return { file, name: titleOf(base), group: path.dirname(file) === '.' ? '' : path.dirname(file), season, episode };
        }),
      });
    } else if (entry.isFile() && VIDEO_MIME[path.extname(entry.name).toLowerCase()]) {
      items.push({ id: entry.name, title: titleOf(entry.name), kind: 'movie', episodes: [{ file: entry.name, name: titleOf(entry.name), group: '', season: 1, episode: 1 }] });
    }
  }
  return items.sort((a, b) => natural(a.title, b.title));
}

function safeVideoPath(name) {
  if (typeof name !== 'string' || !name) return null;
  let decoded;
  try { decoded = decodeURIComponent(name); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(VIDEO_DIR, decoded);
  const inside = candidate === VIDEO_DIR || candidate.startsWith(VIDEO_DIR + path.sep);
  if (!inside || !VIDEO_MIME[path.extname(candidate).toLowerCase()]) return null;
  return exists(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

function trackInfo(stream, index, kind) {
  const tags = stream.tags || {};
  const lang = (tags.language || '').toLowerCase();
  const title = tags.title || '';
  const known = LANG[lang];
  const pl = lang === 'pol' || lang === 'pl' || /polsk|lektor|\bpl\b/i.test(title);
  const labelPl = pl ? 'Polski' : known ? known[0] : (lang && lang !== 'und' ? lang : 'Nieznany język');
  const labelEn = pl ? 'Polish' : known ? known[1] : (lang && lang !== 'und' ? lang : 'Unknown');
  const code = pl ? 'PL' : known ? known[2] : (lang && lang !== 'und' ? lang.slice(0, 2).toUpperCase() : '?');
  let label = title && !title.toLowerCase().includes(labelPl.toLowerCase()) ? `${labelPl} – ${title}` : (title || labelPl);
  if (kind === 'audio') label += ` · ${stream.channels === 6 ? '5.1' : stream.channels === 8 ? '7.1' : (stream.channels + ' ch')} ${String(stream.codec_name).toUpperCase()}`;
  return { i: index, label, labelEn, code, pl };
}

const probeCache = new Map();
const probeQueue = makeLimit(4);
function probe(file) {
  if (!HAS_FFMPEG) return Promise.resolve(null);
  const key = `${file}|${fs.statSync(file).mtimeMs}|${fs.statSync(file).size}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const promise = probeQueue(async () => {
    try {
      const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
      const audio = (json.streams || []).filter(s => s.codec_type === 'audio').map((s, i) => trackInfo(s, i, 'audio'));
      const subs = (json.streams || []).filter(s => s.codec_type === 'subtitle' && MIME_TEXT_SUBS.has(s.codec_name))
        .map((s, i) => ({ ...trackInfo(s, i, 'sub'), id: `e${i}` }));
      return { duration: parseFloat(json.format?.duration) || 0, audio, subs };
    } catch (error) {
      console.error(`Probe failed for ${file}: ${error.message}`);
      return null;
    }
  });
  probeCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------
// Metadata and subtitles
// ---------------------------------------------------------------------
function fetchJSON(url, onFailure) {
  return new Promise(resolve => {
    let settled = false;
    const fail = reason => {
      if (settled) return;
      settled = true;
      onFailure?.(reason);
      resolve(null);
    };
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'BobWatchTogether/3.0' }, timeout: 10000 }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(`Upstream returned HTTP ${response.statusCode}.`);
        return;
      }
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) req.destroy(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          settled = true;
          resolve(parsed);
        } catch {
          fail('Upstream returned invalid JSON.');
        }
      });
    });
    req.on('error', () => fail('Could not connect to the metadata provider.'));
    req.on('timeout', () => req.destroy());
  });
}

function cleanTitle(raw) {
  return raw.replace(/\.[a-z0-9]+$/i, '').replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ')
    .replace(/s\d+[._\s]*e\d+|\d+x\d+/gi, ' ').replace(/\b(19\d\d|20\d\d)\b.*$/i, '')
    .replace(/\b(480p|720p|1080p|2160p|4k|bluray|web-dl|remux|h264|h265|x264|x265|hevc|ac3|dts|multi|extended|remastered|eng|lektor|pl)\b/gi, '')
    .replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getEpisodeArtwork(item, metadata) {
  if (item.kind !== 'series' || !TMDB_API_KEY || !metadata.tmdbId) return item.episodes;
  const seasons = [...new Set(item.episodes.map(episode => episode.season || 1))];
  const limitSeasonRequests = makeLimit(3);
  let updatedCache = false;
  const seasonResults = await Promise.all(seasons.map(season => limitSeasonRequests(async () => {
    const cacheKey = `__tmdb_episode_artwork_${metadata.tmdbId}_S${season}`;
    if (Array.isArray(metadataStore[cacheKey])) return [season, metadataStore[cacheKey]];
    const data = await fetchJSON(
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(metadata.tmdbId)}/season/${season}?api_key=${encodeURIComponent(TMDB_API_KEY)}&language=pl-PL`,
    );
    if (!Array.isArray(data?.episodes)) return [season, []];
    const episodes = data.episodes.map(episode => ({
      episode: episode.episode_number,
      still_path: episode.still_path || '',
    }));
    metadataStore[cacheKey] = episodes;
    updatedCache = true;
    return [season, episodes];
  })));
  if (updatedCache) saveMetadata();
  const stills = new Map();
  seasonResults.forEach(([season, episodes]) => {
    episodes.forEach(episode => {
      if (episode.still_path) stills.set(`${season}:${episode.episode_number}`, `https://image.tmdb.org/t/p/w780${episode.still_path}`);
    });
  });
  return item.episodes.map(episode => ({
    ...episode,
    posterUrl: stills.get(`${episode.season || 1}:${episode.episode || 1}`) || '',
  }));
}

async function getMetadata(title, season, episode, fetchRemote = true, refreshArtwork = false) {
  const cleanKey = cleanTitle(title);
  const episodeKey = `${cleanKey}_S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`;
  const cached = season ? metadataStore[episodeKey] : (metadataStore[title] || metadataStore[cleanKey]);
  if (cached) {
    const hasUsefulMetadata = cached.imdb && cached.imdb !== '—'
      || (!season && (cached.year && cached.year !== '—') || cached.plotEn);
    if (!refreshArtwork && (hasUsefulMetadata || !fetchRemote)
        && (!fetchRemote || cached.backdropUrl || !TMDB_API_KEY)) return cached;
  }
  if (!fetchRemote) {
    if (season) return {
      title: '', imdb: '—', released: '—', plotEn: '', plotPl: '', plot: '',
    };
    return {
      title, imdb: '—', year: '—', released: '—', runtime: '', genre: '', genrePl: '',
      director: '', actors: '', plotEn: '', plotPl: '', plot: '',
    };
  }

  let data = null;
  if (OMDB_API_KEY) {
    const params = season ? `&Season=${season}&Episode=${episode}` : '';
    data = await fetchJSON(`https://www.omdbapi.com/?t=${encodeURIComponent(cleanKey)}${params}&plot=full&apikey=${encodeURIComponent(OMDB_API_KEY)}`);
  }

  if (season) {
    const result = {
      title: data?.Response === 'True' ? (data.Title || '') : '',
      imdb: data?.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : '—',
      released: data?.Released && data.Released !== 'N/A' ? data.Released : (data?.Year || '—'),
      plotEn: data?.Plot && data.Plot !== 'N/A' ? data.Plot : '',
      plotPl: '', plot: data?.Plot && data.Plot !== 'N/A' ? data.Plot : '',
    };
    metadataStore[episodeKey] = result;
    saveMetadata();
    return result;
  }

  const result = {
    title, imdb: '—', year: '—', released: '—', runtime: '', genre: '', genrePl: '',
    director: '', actors: '', plotEn: '', plotPl: '', plot: '',
  };
  if (data?.Response === 'True') {
    if (data.imdbRating && data.imdbRating !== 'N/A') result.imdb = data.imdbRating;
    if (data.Year && data.Year !== 'N/A') result.year = data.Year;
    if (data.Released && data.Released !== 'N/A') result.released = data.Released;
    if (data.Runtime && data.Runtime !== 'N/A') result.runtime = data.Runtime;
    if (data.Genre && data.Genre !== 'N/A') result.genre = data.Genre;
    if (data.Director && data.Director !== 'N/A') result.director = data.Director;
    if (data.Actors && data.Actors !== 'N/A') result.actors = data.Actors;
    if (data.Plot && data.Plot !== 'N/A') result.plotEn = data.Plot;
    if (data.Poster && data.Poster !== 'N/A') result.posterUrl = data.Poster;
  }
  if (TMDB_API_KEY) {
    tmdbArtworkStatus = {
      ...tmdbArtworkStatus,
      configured: true,
      status: 'checking',
      lastCheckedAt: Date.now(),
      lastTitle: title,
      lastError: '',
    };
    const tmdb = await fetchJSON(
      `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(TMDB_API_KEY)}&language=pl-PL&query=${encodeURIComponent(cleanKey)}&include_adult=false`,
      error => {
        tmdbArtworkStatus = { ...tmdbArtworkStatus, status: 'provider-error', lastError: error };
      },
    );
    if (tmdb?.success === false) {
      tmdbArtworkStatus = {
        ...tmdbArtworkStatus,
        status: 'provider-error',
        lastError: tmdb.status_message || `TMDb rejected the request (status ${tmdb.status_code || 'unknown'}).`,
      };
    }
    const results = Array.isArray(tmdb?.results) ? tmdb.results : [];
    const match = results.find(item => item.backdrop_path) || results.find(item => item.poster_path);
    if (!match && tmdbArtworkStatus.status !== 'provider-error') {
      tmdbArtworkStatus = {
        ...tmdbArtworkStatus,
        status: 'no-match',
        lastError: 'TMDb returned no matching artwork for this title.',
      };
    } else if (match) {
      tmdbArtworkStatus = {
        ...tmdbArtworkStatus,
        status: match.backdrop_path ? 'backdrop-found' : 'poster-only',
        lastError: match.backdrop_path ? '' : 'TMDb has a poster for this title but no wide banner.',
      };
    }
    if (match) {
      if (!result.year || result.year === '—') result.year = String(match.first_air_date || match.release_date || '').slice(0, 4) || '—';
      if (!result.plotPl) result.plotPl = match.overview || '';
      if (!result.posterUrl) result.posterUrl = match.poster_path ? `https://image.tmdb.org/t/p/w780${match.poster_path}` : '';
      result.backdropUrl = match.backdrop_path ? `https://image.tmdb.org/t/p/original${match.backdrop_path}` : '';
      result.tmdbId = match.id || null;
      result.ratingSource = 'TMDb';
    }
  }
  const wiki = await fetchJSON(`https://pl.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanKey)}`);
  if (wiki?.extract && wiki.type !== 'disambiguation') result.plotPl = wiki.extract;
  result.plot = result.plotPl || result.plotEn || '';
  const mergedResult = { ...(cached || {}), ...result };
  for (const key of ['imdb', 'year', 'released', 'runtime', 'genre', 'genrePl', 'director', 'actors', 'plotEn', 'plotPl', 'plot']) {
    if ((!mergedResult[key] || mergedResult[key] === '—') && cached?.[key]) mergedResult[key] = cached[key];
  }
  metadataStore[cleanKey] = mergedResult;
  saveMetadata();
  return mergedResult;
}

function cacheKey(file, extra) {
  const stat = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}|${extra}`).digest('hex').slice(0, 16);
}

function cacheFiles() {
  return fs.readdirSync(CACHE_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(CACHE_DIR, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, file, size: stat.size, mtime: stat.mtimeMs };
    });
}

function pruneCache() {
  let files = cacheFiles();
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  for (const file of files.filter(f => f.name.endsWith('.part')).sort((a, b) => a.mtime - b.mtime)) {
    try { fs.unlinkSync(file.file); total -= file.size; } catch {}
  }
  for (const file of cacheFiles().filter(f => f.name.startsWith('au_')).sort((a, b) => a.mtime - b.mtime)) {
    if (total <= MAX_CACHE_BYTES * 0.75) break;
    try { fs.unlinkSync(file.file); total -= file.size; } catch {}
  }
}

function clearCache() {
  let freed = 0;
  for (const file of cacheFiles()) {
    if (file.name.startsWith('au_') || file.name.endsWith('.part') || file.name.startsWith('s_')) {
      try { fs.unlinkSync(file.file); freed += file.size; } catch {}
    }
  }
  return freed;
}

const externalSubs = new Map();
function externalSubList(file) {
  const base = file.replace(/\.[^.]+$/, '');
  const result = [];
  for (const ext of ['.srt', '.vtt', '.ass', '.ssa']) {
    const candidate = base + ext;
    if (!exists(candidate)) continue;
    const id = `x${result.length}`;
    externalSubs.set(id, candidate);
    result.push({ id, label: `${path.basename(candidate)} · external`, pl: /(^|[._-])(pl|pol)[._-]?/i.test(candidate) });
  }
  return result;
}

function extSubKey(file, id) {
  const candidate = externalSubs.get(id);
  const dir = path.dirname(path.resolve(file));
  return candidate && path.resolve(candidate).startsWith(dir + path.sep) ? candidate : null;
}

async function getSubtitle(file, id) {
  if (id?.startsWith('e')) {
    const stream = parseInt(id.slice(1), 10);
    const out = path.join(CACHE_DIR, `s_${cacheKey(file, `subtitle-${stream}`)}.vtt`);
    if (exists(out)) return fs.readFileSync(out, 'utf8');
    await run('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', file, '-map', `0:s:${stream}`, '-f', 'webvtt', out]);
    return fs.readFileSync(out, 'utf8');
  }
  const candidate = extSubKey(file, id);
  if (!candidate) return null;
  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.vtt') return fs.readFileSync(candidate, 'utf8');
  return await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', candidate, '-f', 'webvtt', 'pipe:1']);
}

// ---------------------------------------------------------------------
// Audio cache and watch-party synchronization
// ---------------------------------------------------------------------
const audioJobs = new Map();
const audioQueue = makeQueue();
let activeAudioProc = null;

function audioPath(file, stream) {
  return path.join(CACHE_DIR, `au_${cacheKey(file, `mp3-${stream}`)}.mp3`);
}

function startAudioJob(file, stream, out, job, duration) {
  if (activeAudioProc) {
    try { activeAudioProc.kill('SIGKILL'); } catch {}
  }
  audioQueue(() => new Promise(resolve => {
    const tmp = `${out}.part`;
    const proc = spawn('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', file, '-map', `0:a:${stream}`, '-vn', '-sn', '-dn',
      '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', '-f', 'mp3', tmp]);
    activeAudioProc = proc;
    proc.stderr.on('data', data => {
      const match = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(data.toString());
      if (match && duration) job.progress = Math.min(0.99, (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) / duration);
    });
    proc.on('error', () => { job.error = true; resolve(); });
    proc.on('close', code => {
      activeAudioProc = null;
      if (code === 0) {
        try { fs.renameSync(tmp, out); job.done = true; job.progress = 1; pruneCache(); }
        catch (error) { job.error = true; console.error(`Audio cache failed: ${error.message}`); }
      } else {
        job.error = true;
        try { fs.unlinkSync(tmp); } catch {}
      }
      resolve();
    });
  }));
}

async function audioInfo(name, stream) {
  const file = safeVideoPath(name);
  if (!file || !HAS_FFMPEG) return { ready: false, error: true };
  const out = audioPath(file, stream);
  const url = `/audiofile?name=${encodeURIComponent(name)}&a=${stream}`;
  if (exists(out)) return { ready: true, url };
  let job = audioJobs.get(out);
  if (!job) {
    job = { progress: 0 };
    audioJobs.set(out, job);
    const meta = await probe(file);
    startAudioJob(file, stream, out, job, meta?.duration || 0);
  }
  if (job.error) { audioJobs.delete(out); return { ready: false, error: true }; }
  if (job.done) { audioJobs.delete(out); return { ready: true, url }; }
  return { ready: false, progress: job.progress };
}

const clients = new Set();
function currentPartyState() {
  const time = watchParty.playing
    ? watchParty.time + Math.max(0, (Date.now() - watchParty.updatedAt) / 1000)
    : watchParty.time;
  return { ...watchParty, time, viewers: clients.size };
}

function broadcast(object) {
  for (const client of clients) {
    if ((object.roomId || object.isParty || object.party?.active) && !hasRoomAccess(client.userId, object.roomId || 'main')) continue;
    try { client.res.write(`data: ${JSON.stringify(object)}\n\n`); } catch { clients.delete(client); }
  }
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------
function json(res, value, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    req.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Niepoprawny JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res, file, type) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0 || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-transform',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

async function getPoster(id) {
  const direct = path.resolve(VIDEO_DIR, id);
  const inside = direct === VIDEO_DIR || direct.startsWith(VIDEO_DIR + path.sep);
  if (!inside) return null;
  const candidates = [];
  if (exists(direct) && fs.statSync(direct).isDirectory()) candidates.push(path.join(direct, 'poster.jpg'));
  else candidates.push(path.join(path.dirname(direct), 'poster.jpg'), `${direct.replace(/\.[^.]+$/, '')}.jpg`);
  for (const candidate of candidates) if (exists(candidate) && fs.statSync(candidate).isFile()) return candidate;
  const item = scanLibrary().find(entry => entry.id === id);
  if (!item) return null;
  const first = path.join(VIDEO_DIR, item.episodes[0].file);
  const out = path.join(CACHE_DIR, `p_${crypto.createHash('sha1').update(`${first}|${fs.statSync(first).mtimeMs}`).digest('hex').slice(0, 16)}.jpg`);
  if (exists(out)) return out;
  if (!HAS_FFMPEG) return null;
  try {
    const meta = await probe(first);
    const time = Math.max(1, Math.min((meta?.duration || 60) * 0.1, 600));
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(time), '-i', first, '-frames:v', '1', '-q:v', '3', out]);
    pruneCache();
    return out;
  } catch { return null; }
}

function localNetworkAddress(address) {
  return address === 'localhost' || address.endsWith('.localhost') || address.endsWith('.local')
    || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    || address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function downloadPoster(url, target) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(new Error('Niepoprawny URL')); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { reject(new Error('Dozwolone są tylko HTTP i HTTPS')); return; }
    if (localNetworkAddress(parsed.hostname)) { reject(new Error('URL lokalny nie jest dozwolony')); return; }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { headers: { 'User-Agent': 'BobWatchTogether/3.0' }, timeout: 15000 }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Serwer zwrócił HTTP ${res.statusCode}`)); return; }
      const contentType = res.headers['content-type'] || '';
      if (!/^image\//i.test(contentType)) { res.resume(); reject(new Error('URL nie wskazuje obrazu')); return; }
      let bytes = 0;
      const stream = fs.createWriteStream(target);
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 15 * 1024 * 1024) { req.destroy(); stream.destroy(); reject(new Error('Obraz przekracza 15 MB')); }
      });
      res.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
  });
}

const server = http.createServer(async (req, res) => {
  try {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    const p = decodeURIComponent(u.pathname);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const publicAuthRoutes = new Set([
      '/api/health', '/api/auth/me', '/api/auth/login', '/api/auth/register', '/api/auth/logout',
    ]);
    const protectedMedia = ['/video/', '/poster/', '/quality/', '/hls/', '/audio', '/sub/'];
    if ((p.startsWith('/api/') && !publicAuthRoutes.has(p)) ||
        protectedMedia.some(prefix => p.startsWith(prefix))) {
      if (!requireUser(req, res)) return;
    }

    if (p === '/api/health') {
      const cache = cacheFiles();
      return json(res, {
        status: 'ok', version: '3.0', uptime: process.uptime(),
        ffmpeg: HAS_FFMPEG, mediaDirectory: VIDEO_DIR, mediaCount: scanLibrary().reduce((n, item) => n + item.episodes.length, 0),
        cacheBytes: cache.reduce((sum, file) => sum + file.size, 0), cacheLimitBytes: MAX_CACHE_BYTES,
        party: { active: Boolean(watchParty.active) }, profiles: profiles.length,
      });
    }

    if (p === '/api/auth/me') {
      const session = getSession(req);
      return json(res, {
        authenticated: Boolean(session),
        user: session ? { id: session.userId, username: session.username, role: session.role } : null,
      });
    }

    if (p === '/api/auth/register' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(`register:${ip}`) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, { error: 'Za dużo prób rejestracji. Spróbuj później.' }, 429);
      let body;
      try { body = await readBody(req); } catch (error) { return json(res, { error: error.message }, 400); }
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return json(res, { error: 'Login: 3–32 znaki, litery, cyfry, kropka, myślnik lub podkreślenie.' }, 400);
      if (password.length < 12 || password.length > 256) return json(res, { error: 'Hasło musi mieć od 12 do 256 znaków.' }, 400);
      if (sqliteRows(`SELECT 1 AS found FROM users WHERE username=$username LIMIT 1;`, { username }).length) {
        return json(res, { error: 'Ten login jest już zajęty.' }, 409);
      }
      const credentials = hashPassword(password);
      const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
      const now = Date.now();
      try {
        sqliteExec(
          `INSERT INTO users(id,username,password_salt,password_hash,role,display_name,avatar,color,active,created_at,updated_at)
           VALUES($id,$username,$salt,$hash,'viewer',$name,'👤','#4db7ef',1,$now,$now);`,
          { id: userId, username, salt: credentials.salt, hash: credentials.hash,
            name: String(body.displayName || username).trim().slice(0, 60), now }
        );
      } catch {
        attempt.count++;
        if (attempt.count >= 10) { attempt.until = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
        loginAttempts.set(`register:${ip}`, attempt);
        console.error('Account registration failed while saving user.');
        return json(res, { error: 'Nie udało się utworzyć konta. Spróbuj ponownie.' }, 500);
      }
      loginAttempts.delete(`register:${ip}`);
      const remember = Boolean(body.remember);
      const ttl = remember ? REMEMBERED_SESSION_TTL : SESSION_TTL;
      const id = crypto.randomBytes(32).toString('hex');
      const session = { userId, username, role: 'viewer', expiresAt: now + ttl };
      sessions.set(id, session);
      sqliteExec(
        `INSERT INTO sessions(id,user_id,username,role,ip,user_agent,expires_at,created_at,revoked_at)
         VALUES($id,$userId,$username,'viewer',$ip,$ua,$expires,$now,NULL);`,
        { id, userId, username, ip, ua: String(req.headers['user-agent'] || '').slice(0, 300), expires: session.expiresAt, now }
      );
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      const maxAge = remember ? `; Max-Age=${Math.floor(ttl / 1000)}` : '';
      res.writeHead(201, {
        'Set-Cookie': `${bwtSessionName}=${id}; HttpOnly; SameSite=Strict; Path=/${maxAge}${secure}`,
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      });
      sqliteAudit(username, 'auth.register', { ip });
      return res.end(JSON.stringify({ success: true, user: { id: userId, username, role: 'viewer' } }));
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, { error: 'Za dużo prób logowania. Spróbuj później.' }, 429);
      let body;
      try { body = await readBody(req); } catch (error) { return json(res, { error: error.message }, 400); }
      const [user] = sqliteRows(
        `SELECT id,username,password_salt,password_hash,role,active FROM users WHERE username=$username LIMIT 1;`,
        { username: String(body.username || '') }
      );
      const valid = user && user.active === 1 && verifyPassword(String(body.password || ''), {
        salt: user.password_salt, hash: user.password_hash,
      });
      if (!valid) {
        attempt.count++;
        if (attempt.count >= 5) { attempt.until = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
        loginAttempts.set(ip, attempt);
        return json(res, { error: 'Nieprawidłowy login lub hasło.' }, 401);
      }
      loginAttempts.delete(ip);
      const remember = Boolean(body.remember);
      const ttl = remember ? REMEMBERED_SESSION_TTL : SESSION_TTL;
      const id = crypto.randomBytes(32).toString('hex');
      const session = { userId: user.id, username: user.username, role: user.role, expiresAt: Date.now() + ttl };
      sessions.set(id, session);
      sqliteExec(
        `INSERT INTO sessions(id,user_id,username,role,ip,user_agent,expires_at,created_at,revoked_at)
         VALUES($id,$userId,$username,$role,$ip,$ua,$expires,$now,NULL);`,
        { id, userId: user.id, username: user.username, role: user.role,
          ip: req.socket.remoteAddress || '', ua: String(req.headers['user-agent'] || '').slice(0, 300),
          expires: session.expiresAt, now: Date.now() }
      );
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      const maxAge = remember ? `; Max-Age=${Math.floor(ttl / 1000)}` : '';
      res.writeHead(200, {
        'Set-Cookie': `${bwtSessionName}=${id}; HttpOnly; SameSite=Strict; Path=/${maxAge}${secure}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      sqliteAudit(user.username, 'auth.login', { ip });
      return res.end(JSON.stringify({ success: true, username: user.username, role: user.role }));
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const id = parseCookies(req.headers.cookie)[bwtSessionName];
      if (id) {
        sessions.delete(id);
        sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE id=$id;`, { now: Date.now(), id });
      }
      res.writeHead(200, { 'Set-Cookie': `${bwtSessionName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    }

    if (p === '/events') {
      const session = requireUser(req, res);
      if (!session) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const visibleParty = hasRoomAccess(session.userId) ? currentPartyState() : { active: false, video: null, playing: false, time: 0, viewers: 0 };
      res.write(`data: ${JSON.stringify({ type: 'state', party: visibleParty, viewers: visibleParty.viewers || 0 })}\n\n`);
      const client = { res, userId: session.userId };
      clients.add(client);
      broadcast({ type: 'viewers', viewers: clients.size, party: currentPartyState() });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(client); broadcast({ type: 'viewers', viewers: clients.size, party: currentPartyState() }); });
      return;
    }

    if (p === '/api/state') {
      const session = requireUser(req, res);
      if (!session) return;
      return json(res, hasRoomAccess(session.userId) ? currentPartyState() : { active: false, video: null, playing: false, time: 0, viewers: 0 });
    }

    if (p === '/api/rooms') {
      const session = requireUser(req, res);
      if (!session) return;
      if (req.method === 'GET') {
        const rows = sqliteRows(`SELECT id,video,playing,time,updated_at,host_user_id,host_name,active
                                 FROM party_rooms WHERE active=1 ORDER BY updated_at DESC;`)
          .filter(row => hasRoomAccess(session.userId, row.id));
        return json(res, rows);
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const id = /^room-[a-zA-Z0-9_-]{3,32}$/.test(body.id) ? body.id : `room-${crypto.randomBytes(5).toString('hex')}`;
        sqliteExec(`INSERT INTO party_rooms(id,video,playing,time,updated_at,host_user_id,host_name,active)
                    VALUES($id,$video,0,0,$now,$host,$hostName,1)
                    ON CONFLICT(id) DO UPDATE SET video=excluded.video,active=1,updated_at=excluded.updated_at;`,
          { id, video: safeVideoPath(body.video) ? body.video : null, now: Date.now(),
            host: session.userId, hostName: session.username });
        sqliteAudit(session.username, 'party.room.create', { id });
        return json(res, { success: true, id }, 201);
      }
    }

    if (p === '/api/rooms/invites' && req.method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      if (!watchParty.active || watchParty.hostUserId !== session.userId) {
        return json(res, { error: 'Najpierw rozpocznij seans jako gospodarz.' }, 409);
      }
      const code = crypto.randomBytes(8).toString('hex').toUpperCase();
      const now = Date.now();
      sqliteExec(
        `INSERT INTO party_invites(code_hash,room_id,created_by,expires_at,max_uses,uses,created_at)
         VALUES($hash,'main',$user,$expires,20,0,$now);`,
        { hash: crypto.createHash('sha256').update(code).digest('hex'), user: session.userId,
          expires: now + 24 * 60 * 60 * 1000, now }
      );
      sqliteAudit(session.username, 'party.invite.create', { roomId: 'main' });
      return json(res, { code, expiresAt: now + 24 * 60 * 60 * 1000, maxUses: 20 }, 201);
    }

    if (p === '/api/rooms/join' && req.method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readBody(req);
      const ip = req.socket.remoteAddress || 'unknown';
      const attemptKey = `invite:${ip}`;
      const attempt = loginAttempts.get(attemptKey) || { count: 0, until: 0 };
      if (attempt.until > Date.now()) return json(res, { error: 'Za dużo prób. Spróbuj ponownie później.' }, 429);
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!/^[A-F0-9]{16}$/.test(code)) {
        attempt.count++;
        if (attempt.count >= 10) { attempt.until = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
        loginAttempts.set(attemptKey, attempt);
        return json(res, { error: 'Kod zaproszenia ma nieprawidłowy format.' }, 400);
      }
      const profile = profileForSession(body.profileId, session);
      if (!profile) return json(res, { error: 'Wybierz profil należący do tego konta.' }, 403);
      const hash = crypto.createHash('sha256').update(code).digest('hex');
      const invite = sqliteRows(
        `SELECT room_id,expires_at,max_uses,uses FROM party_invites
         WHERE code_hash=$hash LIMIT 1;`, { hash }
      )[0];
      if (!invite || invite.expires_at < Date.now() || invite.uses >= invite.max_uses ||
          invite.room_id !== 'main' || !watchParty.active) {
        attempt.count++;
        if (attempt.count >= 10) { attempt.until = Date.now() + 15 * 60 * 1000; attempt.count = 0; }
        loginAttempts.set(attemptKey, attempt);
        return json(res, { error: 'Kod jest nieprawidłowy, wygasł lub seans już się zakończył.' }, 404);
      }
      loginAttempts.delete(attemptKey);
      sqliteExec(`UPDATE party_invites SET uses=uses+1 WHERE code_hash=$hash AND uses<max_uses;`, { hash });
      sqliteExec(
        `INSERT INTO room_members(room_id,user_id,joined_at) VALUES($room,$user,$now)
         ON CONFLICT(room_id,user_id) DO NOTHING;`,
        { room: invite.room_id, user: session.userId, now: Date.now() }
      );
      sqliteAudit(session.username, 'party.invite.join', { roomId: invite.room_id });
      broadcast({ type: 'state', roomId: invite.room_id, party: currentPartyState() });
      return json(res, { success: true, roomId: invite.room_id, party: currentPartyState() });
    }

    if (p.startsWith('/api/rooms/') && p.endsWith('/chat')) {
      const parts = p.split('/');
      const roomId = decodeURIComponent(parts[3]);
      const session = requireUser(req, res);
      if (!session) return;
      if (!hasRoomAccess(session.userId, roomId)) return json(res, { error: 'Nie masz dostępu do tego pokoju.' }, 403);
      if (req.method === 'GET') {
        const rows = sqliteRows(`SELECT id,username,message,created_at FROM chat_messages
                                 WHERE room_id=$roomId ORDER BY id DESC LIMIT 200;`, { roomId });
        return json(res, rows.reverse());
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : '';
        if (!message) return json(res, { error: 'Wiadomość nie może być pusta.' }, 400);
        const profile = profileForSession(body.profileId, session);
        const username = profile?.name || session.username;
        const result = sqliteExec(
          `INSERT INTO chat_messages(room_id,user_id,username,message,created_at)
           VALUES($roomId,$userId,$username,$message,$now);`,
          { roomId, userId: session.userId, username, message, now: Date.now() }
        );
        broadcast({ type: 'chat', roomId, username, message, createdAt: Date.now() });
        return json(res, { success: true, result: result.length ? result : undefined }, 201);
      }
    }

    if (p === '/api/library') {
      const items = [];
      for (const title of scanLibrary()) {
        const firstFile = path.join(VIDEO_DIR, title.episodes[0].file);
        const media = await probe(firstFile);
        const baseMeta = await getMetadata(title.title, undefined, undefined, false);
        const episodes = [];
        for (const episode of title.episodes) {
          const episodeMeta = title.kind === 'series'
            ? await getMetadata(title.title, episode.season, episode.episode, false)
            : baseMeta;
          episodes.push({
            ...episode,
            name: episodeMeta.title || episode.name,
            imdb: episodeMeta.imdb || '—',
            released: episodeMeta.released || '—',
            plot: episodeMeta.plotPl || episodeMeta.plot || episodeMeta.plotEn || '',
            posterUrl: episodeMeta.posterUrl || baseMeta.posterUrl || '',
          });
        }
        items.push({
          id: title.id, title: title.title, kind: title.kind,
          poster: `/poster/${encodeURIComponent(title.id)}`, duration: title.kind === 'movie' ? (media?.duration || 0) : 0,
          posterUrl: baseMeta.posterUrl || '', backdropUrl: baseMeta.backdropUrl || '',
          imdb: baseMeta.imdb || '—', released: baseMeta.year || baseMeta.released || '—',
          runtime: baseMeta.runtime || '', genre: baseMeta.genre || '', genrePl: baseMeta.genrePl || '',
          director: baseMeta.director || '', actors: baseMeta.actors || '',
          plotEn: baseMeta.plotEn || '', plotPl: baseMeta.plotPl || '', plot: baseMeta.plot || '',
          audio: (media?.audio || []).map(track => ({ i: track.i, code: track.code, pl: track.pl, label: track.label, labelEn: track.labelEn })),
          episodes,
        });
      }
      return json(res, { ffmpeg: HAS_FFMPEG, items });
    }

    if (p === '/api/artwork') {
      const id = u.searchParams.get('id');
      const title = scanLibrary().find(item => item.id === id);
      if (!title) return json(res, { error: 'Nie znaleziono pozycji.' }, 404);
      const metadata = await getMetadata(title.title);
      return json(res, {
        posterUrl: metadata.posterUrl || '',
        backdropUrl: metadata.backdropUrl || '',
        tmdbConfigured: Boolean(TMDB_API_KEY),
        tmdbStatus: tmdbArtworkStatus.status,
      });
    }

    if (p === '/api/title') {
      const id = u.searchParams.get('id');
      const item = scanLibrary().find(entry => entry.id === id);
      if (!item) return json(res, { error: 'Nie znaleziono pozycji.' }, 404);
      const media = await probe(path.join(VIDEO_DIR, item.episodes[0].file));
      const meta = await getMetadata(item.title);
      const episodes = await getEpisodeArtwork(item, meta);
      return json(res, {
        ...item, episodes, poster: `/poster/${encodeURIComponent(item.id)}`, duration: media?.duration || 0,
        ...meta, audio: (media?.audio || []).map(track => ({ i: track.i, code: track.code, pl: track.pl, label: track.label, labelEn: track.labelEn })),
      });
    }

    if (p === '/api/meta') {
      const name = u.searchParams.get('name');
      const file = safeVideoPath(name);
      if (!file) return json(res, { error: 'Nie ma takiego pliku.' }, 404);
      const media = await probe(file);
      const subs = [
        ...(media?.subs || []),
        ...externalSubList(file),
      ];
      return json(res, { file: name, title: titleOf(path.basename(file)), duration: media?.duration || 0, audio: media?.audio || [], subs });
    }

    if (p === '/api/profiles') {
      const session = requireUser(req, res);
      if (!session) return;
      if (req.method === 'GET') return json(res, profiles.filter(profile => profile.ownerUserId === session.userId));
      if (req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        if (typeof body?.name !== 'string' || !body.name.trim()) return json(res, { error: 'Nazwa profilu jest wymagana.' }, 400);
        const ownedProfiles = profiles.filter(profile => profile.ownerUserId === session.userId);
        if (ownedProfiles.length >= 8) return json(res, { error: 'Konto może mieć maksymalnie 8 profili.' }, 400);
        const profile = {
          id: `prof_${crypto.randomBytes(8).toString('hex')}`, name: body.name.trim().slice(0, 40),
          avatar: String(body.avatar || '🍿').slice(0, 8), color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#00a8e1',
          role: 'viewer', history: {}, ownerUserId: session.userId, favorites: [], watchLater: [],
        };
        profiles.push(profile); saveProfiles();
        return json(res, profile, 201);
      }
    }

    if (p.startsWith('/api/profiles/')) {
      const parts = p.split('/');
      const id = parts[3], action = parts[4];
      const session = requireUser(req, res);
      if (!session) return;
      const profile = profileForSession(id, session);
      if (!profile) return json(res, { error: 'Profil nie istnieje.' }, 404);
      if (action === 'history' && req.method === 'POST') {
        const body = await readBody(req);
        if (!safeVideoPath(body.file)) return json(res, { error: 'Niepoprawna ścieżka pliku.' }, 400);
        profile.history ||= {};
        const duration = Math.max(0, Number(body.duration) || 0);
        const time = Math.max(0, Number(body.time) || 0);
        profile.history[body.file] = {
          file: body.file, title: String(body.title || ''), season: Number(body.season) || 1,
          episode: Number(body.episode) || 1, epName: String(body.epName || ''),
          time, duration, updatedAt: Date.now(),
          finished: body.finished !== undefined ? Boolean(body.finished) : duration > 0 && time >= duration - 60,
        };
        saveProfiles();
        return json(res, { success: true, entry: profile.history[body.file] });
      }
      if (action === 'lists' && req.method === 'POST') {
        const body = await readBody(req);
        const listName = body.list === 'favorites' ? 'favorites' : body.list === 'watchLater' ? 'watchLater' : null;
        const titleId = typeof body.titleId === 'string' ? body.titleId.slice(0, 160) : '';
        if (!listName || !titleId || !scanLibrary().some(item => item.id === titleId)) {
          return json(res, { error: 'Nieprawidłowa lista lub pozycja.' }, 400);
        }
        const values = new Set(Array.isArray(profile[listName]) ? profile[listName] : []);
        if (body.enabled === false) values.delete(titleId); else values.add(titleId);
        profile[listName] = [...values];
        saveProfiles();
        return json(res, { success: true, [listName]: profile[listName] });
      }
      if (action === 'toggle-watched' && req.method === 'POST') {
        const body = await readBody(req);
        if (!safeVideoPath(body.file)) return json(res, { error: 'Niepoprawna ścieżka pliku.' }, 400);
        profile.history ||= {};
        const current = profile.history[body.file] || { file: body.file, duration: Number(body.duration) || 0, time: 0 };
        current.finished = body.finished !== undefined ? Boolean(body.finished) : !current.finished;
        current.time = current.finished ? (current.duration || Number(body.duration) || 100) : 0;
        current.updatedAt = Date.now(); profile.history[body.file] = current; saveProfiles();
        return json(res, { success: true, finished: current.finished, entry: current });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.name === 'string' && body.name.trim()) profile.name = body.name.trim().slice(0, 40);
        if (body.avatar) profile.avatar = String(body.avatar).slice(0, 8);
        if (/^#[0-9a-f]{6}$/i.test(body.color)) profile.color = body.color;
        saveProfiles(); return json(res, profile);
      }
      if (req.method === 'DELETE') {
        if (profiles.filter(entry => entry.ownerUserId === session.userId).length <= 1) {
          return json(res, { error: 'Nie można usunąć ostatniego profilu na koncie.' }, 400);
        }
        profiles = profiles.filter(entry => entry.id !== id); saveProfiles();
        sqliteExec(`DELETE FROM profiles WHERE id=$id;`, { id });
        return json(res, { success: true });
      }
    }

    if (p === '/api/cache') {
      if (req.method === 'GET') {
        const files = cacheFiles();
        const audio = files.filter(file => file.name.startsWith('au_'));
        return json(res, {
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          audioBytes: audio.reduce((sum, file) => sum + file.size, 0),
          fileCount: files.length, audioCount: audio.length,
          limitBytes: MAX_CACHE_BYTES, formatted: formatBytes(files.reduce((sum, file) => sum + file.size, 0)),
          formattedLimit: formatBytes(MAX_CACHE_BYTES),
        });
      }
      if (req.method === 'POST') {
        const freed = clearCache(); pruneCache();
        return json(res, { success: true, freedBytes: freed, formatted: formatBytes(freed) });
      }
    }

    if (p === '/api/admin/tmdb/test' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      if (!TMDB_API_KEY) {
        return json(res, {
          configured: false,
          status: 'missing-key',
          error: 'TMDB_API_KEY is not available in the running server. Recreate the container to load the .env change.',
        }, 503);
      }
      const title = scanLibrary()[0];
      if (!title) return json(res, { configured: true, status: 'empty-library', error: 'The media library is empty.' }, 404);
      const metadata = await getMetadata(title.title, undefined, undefined, true, true);
      return json(res, {
        configured: true,
        title: title.title,
        posterAvailable: Boolean(metadata.posterUrl),
        backdropAvailable: Boolean(metadata.backdropUrl),
        status: tmdbArtworkStatus.status,
        error: tmdbArtworkStatus.lastError,
      });
    }

    if (p === '/api/admin/stats') {
      if (!requireAdmin(req, res)) return;
      const files = cacheFiles();
      return json(res, {
        version: '3.0', host: HOST, port: PORT, uptime: process.uptime(),
        ffmpeg: HAS_FFMPEG, videoDirectory: VIDEO_DIR, mediaCount: scanLibrary().reduce((n, item) => n + item.episodes.length, 0),
        titleCount: scanLibrary().length, profileCount: profiles.length, viewerCount: clients.size,
        cacheBytes: files.reduce((sum, file) => sum + file.size, 0), cacheLimitBytes: MAX_CACHE_BYTES,
        party: currentPartyState(), omdbConfigured: Boolean(OMDB_API_KEY),
        tmdbConfigured: Boolean(TMDB_API_KEY), tmdbArtworkStatus,
      });
    }

    if (p === '/api/admin/users') {
      if (!requireAdmin(req, res)) return;
      if (req.method === 'GET') {
        return json(res, sqliteRows(
          `SELECT id,username,role,display_name,avatar,color,active,created_at,updated_at
           FROM users ORDER BY created_at ASC;`
        ).map(row => ({ ...row, active: Boolean(row.active) })));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const role = ['administrator', 'editor', 'viewer'].includes(body.role) ? body.role : 'viewer';
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return json(res, { error: 'Niepoprawny login.' }, 400);
        if (password.length < 12) return json(res, { error: 'Hasło musi mieć co najmniej 12 znaków.' }, 400);
        const credentials = hashPassword(password);
        const id = `usr_${crypto.randomBytes(8).toString('hex')}`;
        try {
          sqliteExec(
            `INSERT INTO users(id,username,password_salt,password_hash,role,display_name,avatar,color,active,created_at,updated_at)
             VALUES($id,$username,$salt,$hash,$role,$name,$avatar,$color,1,$now,$now);`,
            { id, username, salt: credentials.salt, hash: credentials.hash, role,
              name: String(body.displayName || username).slice(0, 60),
              avatar: String(body.avatar || '👤').slice(0, 8), color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#4db7ef', now: Date.now() }
          );
        } catch (error) {
          return json(res, { error: 'Taki login już istnieje.' }, 409);
        }
        sqliteAudit(getSession(req)?.username, 'users.create', { id, username, role });
        return json(res, { success: true, id, username, role }, 201);
      }
    }

    if (p.startsWith('/api/admin/users/')) {
      if (!requireAdmin(req, res)) return;
      const id = p.split('/')[4];
      if (req.method === 'PUT') {
        const actor = getSession(req)?.username;
        const currentUser = sqliteRows(`SELECT role FROM users WHERE id=$id LIMIT 1;`, { id })[0];
        const body = await readBody(req);
        const role = ['administrator', 'editor', 'viewer'].includes(body.role) ? body.role : null;
        if (role) sqliteExec(`UPDATE users SET role=$role,updated_at=$now WHERE id=$id;`, { role, now: Date.now(), id });
        if (typeof body.displayName === 'string') sqliteExec(`UPDATE users SET display_name=$name,updated_at=$now WHERE id=$id;`, { name: body.displayName.slice(0, 60), now: Date.now(), id });
        if (/^#[0-9a-f]{6}$/i.test(body.color)) sqliteExec(`UPDATE users SET color=$color,updated_at=$now WHERE id=$id;`, { color: body.color, now: Date.now(), id });
        if (typeof body.active === 'boolean') sqliteExec(`UPDATE users SET active=$active,updated_at=$now WHERE id=$id;`, { active: body.active ? 1 : 0, now: Date.now(), id });
        if (typeof body.password === 'string' && body.password.length >= 12) {
          const credentials = hashPassword(body.password);
          sqliteExec(`UPDATE users SET password_salt=$salt,password_hash=$hash,updated_at=$now WHERE id=$id;`,
            { salt: credentials.salt, hash: credentials.hash, now: Date.now(), id });
        }
        if (body.active === false || (typeof body.password === 'string' && body.password.length >= 12) ||
            (role && role !== currentUser?.role)) {
          revokeUserSessions(id);
        }
        sqliteAudit(actor, 'users.update', { id });
        return json(res, { success: true });
      }
      if (req.method === 'DELETE') {
        const actor = getSession(req)?.username;
        const target = sqliteRows(`SELECT role FROM users WHERE id=$id LIMIT 1;`, { id })[0];
        if (!target) return json(res, { error: 'Nie znaleziono konta.' }, 404);
        if (target.role === 'administrator') {
          const admins = sqliteRows(`SELECT COUNT(*) AS count FROM users WHERE role='administrator' AND active=1;`);
          if (Number(admins[0]?.count) <= 1) return json(res, { error: 'Nie można usunąć ostatniego aktywnego administratora.' }, 400);
        }
        revokeUserSessions(id);
        profiles = profiles.filter(profile => profile.ownerUserId !== id);
        saveProfiles();
        sqliteExec(`DELETE FROM profiles WHERE owner_user_id=$id;`, { id });
        sqliteExec(`DELETE FROM room_members WHERE user_id=$id; DELETE FROM party_invites WHERE created_by=$id;`, { id });
        if (watchParty.active && watchParty.hostUserId === id) {
          watchParty = { active: false, video: null, playing: false, time: 0, updatedAt: Date.now(), hostProfile: null, hostUserId: null, hostName: null, viewers: 0 };
          sqliteExec(`DELETE FROM room_members WHERE room_id='main'; DELETE FROM party_invites WHERE room_id='main';`);
          saveParty();
          broadcast({ type: 'end', party: currentPartyState() });
        }
        sqliteExec(`DELETE FROM users WHERE id=$id;`, { id });
        sqliteAudit(actor, 'users.delete', { id });
        return json(res, { success: true });
      }
    }

    if (p === '/api/admin/sql' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) return json(res, { error: 'Wpisz kwerendę SQL.' }, 400);
      if (!/^\s*(select|pragma|explain)\b/i.test(query)) {
        return json(res, { error: 'Konsola pozwala tylko na SELECT, PRAGMA i EXPLAIN.' }, 403);
      }
      const statement = query.endsWith(';') ? query.slice(0, -1).trimEnd() : query;
      if (statement.includes(';') || /--|\/\*/.test(statement)) {
        return json(res, { error: 'Wykonaj jedną kwerendę bez komentarzy SQL.' }, 400);
      }
      try {
        const rows = sqliteReadOnlyRows(statement);
        sqliteAudit(getSession(req)?.username, 'sql.query', { query: query.slice(0, 500) });
        return json(res, { rows });
      } catch (error) {
        return json(res, { error: error.message }, 400);
      }
    }

    if (p === '/api/admin/audit') {
      if (!requireAdmin(req, res)) return;
      return json(res, sqliteRows(`SELECT id,actor,action,details,created_at
                                   FROM audit_log ORDER BY id DESC LIMIT 200;`)
        .map(row => ({ ...row, details: (() => { try { return JSON.parse(row.details || '{}'); } catch { return {}; } })() })));
    }

    if (p === '/api/admin/sessions') {
      if (!requireAdmin(req, res)) return;
      if (req.method === 'GET') {
        return json(res, sqliteRows(`SELECT id,user_id,username,role,ip,user_agent,expires_at,created_at,revoked_at
                                     FROM sessions ORDER BY created_at DESC LIMIT 300;`)
          .map(row => ({ ...row, active: row.revoked_at === null && row.expires_at >= Date.now() })));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.all) {
          const now = Date.now();
          sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE revoked_at IS NULL;`, { now });
          for (const [id] of sessions) sessions.delete(id);
          sqliteAudit(getSession(req)?.username, 'sessions.revoke_all', {});
        } else if (body.id) {
          sqliteExec(`UPDATE sessions SET revoked_at=$now WHERE id=$id;`, { now: Date.now(), id: body.id });
          sessions.delete(body.id);
        } else {
          return json(res, { error: 'Podaj id lub all=true.' }, 400);
        }
        return json(res, { success: true });
      }
    }

    if (p === '/api/admin/backup' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const backup = path.join(BACKUP_DIR, `platform-${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
      const result = spawnSync('/usr/bin/sqlite3', [SQLITE_FILE, '.backup ' + backup], { encoding: 'utf8', timeout: 30000 });
      if (result.status !== 0) {
        return json(res, { error: result.stderr || 'Nie udało się utworzyć kopii.' }, 500);
      }
      sqliteAudit(getSession(req)?.username, 'database.backup', { backup: path.basename(backup) });
      return json(res, { success: true, file: path.basename(backup) });
    }

    if (p === '/api/admin/password' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      if (typeof body.password !== 'string' || body.password.length < 12) return json(res, { error: 'Hasło musi mieć co najmniej 12 znaków.' }, 400);
      const credentials = hashPassword(body.password);
      admin = { username: admin.username, role: 'administrator', createdAt: admin.createdAt || Date.now(), ...credentials };
      atomicWrite(ADMIN_FILE, admin);
      sqliteExec(`UPDATE users SET password_salt=$salt,password_hash=$hash,updated_at=$now WHERE id='legacy_admin';`,
        { salt: credentials.salt, hash: credentials.hash, now: Date.now() });
      sqliteAudit(getSession(req)?.username, 'account.password.change', {});
      return json(res, { success: true });
    }

    if (p === '/api/admin/username' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
        return json(res, { error: 'Login może mieć 3-32 znaki: litery, cyfry, ., _ lub -.' }, 400);
      }
      admin = { ...admin, username };
      atomicWrite(ADMIN_FILE, admin);
      sqliteExec(`UPDATE users SET username=$username,updated_at=$now WHERE id='legacy_admin';`,
        { username, now: Date.now() });
      sqliteAudit(getSession(req)?.username, 'account.username.change', { username });
      return json(res, { success: true, username });
    }

    if (p === '/api/admin/library/refresh' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      probeCache.clear();
      externalSubs.clear();
      const items = scanLibrary();
      return json(res, { success: true, titleCount: items.length, mediaCount: items.reduce((sum, item) => sum + item.episodes.length, 0) });
    }

    if (p === '/api/admin/profiles/reset' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const session = getSession(req);
      profiles = profiles.filter(profile => profile.ownerUserId !== session.userId);
      sqliteExec(`DELETE FROM profiles WHERE owner_user_id=$id;`, { id: session.userId });
      profiles.push(
        { id: `prof_${crypto.randomBytes(8).toString('hex')}`, name: 'Główny', avatar: '🍿', color: '#00a8e1', role: 'viewer', history: {}, ownerUserId: session.userId, favorites: [], watchLater: [] },
        { id: `prof_${crypto.randomBytes(8).toString('hex')}`, name: 'Gość', avatar: '🎬', color: '#e50914', role: 'viewer', history: {}, ownerUserId: session.userId, favorites: [], watchLater: [] },
      );
      saveProfiles();
      return json(res, { success: true, profiles: profiles.filter(profile => profile.ownerUserId === session.userId) });
    }

    if (p === '/api/admin/party/end' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      watchParty = { active: false, video: null, playing: false, time: 0, updatedAt: Date.now(), hostProfile: null, hostUserId: null, hostName: null, viewers: 0 };
      sqliteExec(`DELETE FROM room_members WHERE room_id='main'; DELETE FROM party_invites WHERE room_id='main';`);
      saveParty(); broadcast({ type: 'end', party: currentPartyState() });
      return json(res, { success: true });
    }

    if (p === '/api/admin/metadata/refresh' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      metadataStore = {}; saveMetadata();
      return json(res, { success: true, refreshed: 0 });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      const body = await readBody(req);
      const profile = profileForSession(body.profileId, session);
      if (!profile) return json(res, { error: 'Wybierz profil należący do tego konta.' }, 403);
      const time = Number.isFinite(body.time) ? Math.max(0, body.time) : 0;
      if (body.mode === 'party') {
        if (body.type === 'load') {
          if (!safeVideoPath(body.video)) return json(res, { error: 'Niepoprawny plik wideo.' }, 400);
          if (watchParty.active && watchParty.hostUserId && watchParty.hostUserId !== session.userId) {
            return json(res, { error: 'Aktywny jest już seans innego użytkownika.' }, 409);
          }
          if (!watchParty.active) {
            sqliteExec(`DELETE FROM room_members WHERE room_id='main'; DELETE FROM party_invites WHERE room_id='main'; DELETE FROM chat_messages WHERE room_id='main';`);
          }
          watchParty = { active: true, video: body.video, playing: false, time: 0, updatedAt: Date.now(),
            hostProfile: profile.id, hostUserId: session.userId, hostName: profile.name, viewers: clients.size };
        } else if (body.type === 'play') {
          if (!watchParty.active || !hasRoomAccess(session.userId)) return json(res, { error: 'Nie masz dostępu do aktywnego seansu.' }, 403);
          watchParty.playing = true; watchParty.time = time; watchParty.updatedAt = Date.now();
        } else if (body.type === 'pause') {
          if (!watchParty.active || !hasRoomAccess(session.userId)) return json(res, { error: 'Nie masz dostępu do aktywnego seansu.' }, 403);
          watchParty.playing = false; watchParty.time = time; watchParty.updatedAt = Date.now();
        } else if (body.type === 'seek') {
          if (!watchParty.active || !hasRoomAccess(session.userId)) return json(res, { error: 'Nie masz dostępu do aktywnego seansu.' }, 403);
          watchParty.time = time; watchParty.updatedAt = Date.now();
        } else {
          return json(res, { error: 'Nieznana akcja seansu.' }, 400);
        }
        saveParty();
        broadcast({ type: body.type, from: body.id, party: currentPartyState(), isParty: true, roomId: 'main', profileId: profile.id, profileName: profile.name });
      } else {
        broadcast({ type: 'solo_action', from: body.id, action: body.type, profileId: body.profileId, profileName: body.profileName });
      }
      res.writeHead(204); return res.end();
    }

    if (p === '/api/end' && req.method === 'POST') {
      const session = requireUser(req, res);
      if (!session) return;
      if (!watchParty.active || watchParty.hostUserId !== session.userId) {
        return json(res, { error: 'Tylko gospodarz może zakończyć wspólny seans.' }, 403);
      }
      watchParty = { active: false, video: null, playing: false, time: 0, updatedAt: Date.now(), hostProfile: null, hostUserId: null, hostName: null, viewers: 0 };
      sqliteExec(`DELETE FROM room_members WHERE room_id='main'; DELETE FROM party_invites WHERE room_id='main';`);
      saveParty(); broadcast({ type: 'end', party: currentPartyState() });
      return json(res, { success: true });
    }

    if (p === '/api/prep') return json(res, { ready: true, url: `/video/${encodeURIComponent(u.searchParams.get('name') || '')}` });

    if (p === '/api/qualities') {
      const name = u.searchParams.get('name');
      const file = safeVideoPath(name);
      if (!file) return json(res, { error: 'Nie znaleziono pliku wideo.' }, 404);
      const media = await probe(file);
      const qualities = [{ id: 'native', label: 'Natywnie (oryginał MKV)', type: 'original', url: `/video/${encodeURIComponent(name)}` }];
      qualities.push({ id: 'hls720', label: 'HLS 720p (adaptacyjne)', type: 'hls', url: `/api/hls?name=${encodeURIComponent(name)}&h=720` });
      for (const height of [1080, 720, 480]) {
        qualities.push({ id: `${height}p`, label: `${height}p (transkodowane MP4)`, type: 'transcoded', url: `/quality/${height}?name=${encodeURIComponent(name)}` });
      }
      return json(res, { duration: media?.duration || 0, native: path.extname(file).toLowerCase() === '.mkv' ? 'mkv' : 'native', qualities });
    }

    if (p.startsWith('/quality/')) {
      const match = /^\/quality\/(\d+)/.exec(p);
      if (!match) { res.writeHead(400); return res.end(); }
      const height = Math.min(1080, Math.max(360, parseInt(match[1], 10)));
      const file = safeVideoPath(u.searchParams.get('name'));
      if (!file || !HAS_FFMPEG) { res.writeHead(404); return res.end(); }
      const out = path.join(CACHE_DIR, `q_${cacheKey(file, `h264-${height}`)}.mp4`);
      if (!exists(out)) {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-y', '-nostdin', '-v', 'error', '-i', file,
            '-vf', `scale=-2:${height}`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
            '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
            '-movflags', '+faststart', out,
          ]);
          proc.on('error', reject);
          proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Transcoding exited ${code}`)));
        }).catch(error => {
          console.error(`Quality transcode failed: ${error.message}`);
        });
      }
      if (!exists(out)) { res.writeHead(503); return res.end(); }
      return serveFile(req, res, out, 'video/mp4');
    }

    if (p === '/api/hls') {
      const file = safeVideoPath(u.searchParams.get('name'));
      if (!file || !HAS_FFMPEG) return json(res, { error: 'HLS nie jest dostępne.' }, 404);
      const height = Math.min(1080, Math.max(360, parseInt(u.searchParams.get('h'), 10) || 720));
      const id = cacheKey(file, `hls-${height}`);
      const dir = path.join(CACHE_DIR, `hls_${id}`);
      fs.mkdirSync(dir, { recursive: true });
      const playlist = path.join(dir, 'index.m3u8');
      if (!exists(playlist)) {
        try {
          await run('ffmpeg', [
            '-y', '-nostdin', '-v', 'error', '-i', file,
            '-vf', `scale=-2:${height}`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
            '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
            '-hls_time', '6', '-hls_playlist_type', 'vod',
            '-hls_segment_filename', path.join(dir, 'segment-%03d.ts'),
            playlist,
          ]);
        } catch (error) {
          return json(res, { error: `Transkodowanie HLS nie powiodło się: ${error.message}` }, 503);
        }
      }
      return json(res, { url: `/hls/${id}/index.m3u8`, height });
    }

    if (p.startsWith('/hls/')) {
      const rel = p.slice('/hls/'.length);
      const match = /^([a-f0-9]{16})\/(index\.m3u8|segment-\d{3}\.ts)$/.exec(rel);
      if (!match) { res.writeHead(404); return res.end(); }
      const file = path.join(CACHE_DIR, `hls_${match[1]}`, match[2]);
      if (!exists(file)) { res.writeHead(404); return res.end(); }
      const type = match[2].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    if (p.startsWith('/video/')) {
      const file = safeVideoPath(p.slice('/video/'.length));
      if (!file) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, file, VIDEO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    }

    if (p === '/audio') {
      const file = safeVideoPath(u.searchParams.get('name'));
      if (!file || !HAS_FFMPEG) { res.writeHead(404); return res.end(); }
      const stream = Math.max(0, parseInt(u.searchParams.get('a'), 10) || 0);
      const start = Math.max(0, parseFloat(u.searchParams.get('start')) || 0);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const args = ['-nostdin', '-v', 'error'];
      if (start > 0) args.push('-ss', start.toFixed(3));
      args.push('-i', file, '-map', `0:a:${stream}`, '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', '-flush_packets', '1', '-f', 'mp3', 'pipe:1');
      const proc = spawn('ffmpeg', args);
      proc.stdout.pipe(res);
      proc.stderr.resume();
      proc.on('error', () => res.end());
      req.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
      return;
    }

    if (p === '/audiofile') {
      const file = safeVideoPath(u.searchParams.get('name'));
      const stream = Math.max(0, parseInt(u.searchParams.get('a'), 10) || 0);
      const out = file ? audioPath(file, stream) : null;
      if (!out || !exists(out)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, out, 'audio/mpeg');
    }

    if (p === '/api/audioinfo') {
      const name = u.searchParams.get('name');
      const stream = Math.max(0, parseInt(u.searchParams.get('a'), 10) || 0);
      return json(res, await audioInfo(name, stream));
    }

    if (p.startsWith('/sub/')) {
      const file = safeVideoPath(p.slice('/sub/'.length));
      if (!file) { res.writeHead(404); return res.end(); }
      const id = u.searchParams.get('s');
      try {
        const text = await getSubtitle(file, id);
        if (!text) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(text);
      } catch (error) {
        console.error(`Subtitle conversion failed: ${error.message}`);
        res.writeHead(404); return res.end();
      }
    }

    if (p.startsWith('/poster/')) {
      const id = decodeURIComponent(p.slice('/poster/'.length));
      const file = await getPoster(id);
      if (!file) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    if (p === '/api/poster' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const id = u.searchParams.get('id');
      if (!id || !scanLibrary().some(item => item.id === id)) return json(res, { error: 'Nie znaleziono pozycji.' }, 404);
      const body = await readBody(req);
      const item = scanLibrary().find(entry => entry.id === id);
      const direct = path.resolve(VIDEO_DIR, id);
      let target = null;
      if (exists(direct) && fs.statSync(direct).isDirectory()) target = path.join(direct, 'poster.jpg');
      else target = path.join(VIDEO_DIR, `${id.replace(/\.[^.]+$/, '')}.jpg`);
      try {
        if (body.image?.startsWith('data:image/')) {
          const match = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/s.exec(body.image);
          if (!match) throw new Error('Nieobsługiwany format obrazu');
          const data = Buffer.from(match[1], 'base64');
          if (!data.length || data.length > 15 * 1024 * 1024) throw new Error('Obraz musi mieć do 15 MB');
          fs.writeFileSync(target, data);
        } else if (body.url) {
          await downloadPoster(String(body.url), target);
        } else {
          return json(res, { error: 'Nie przekazano obrazu ani URL.' }, 400);
        }
        return json(res, { success: true, poster: `/poster/${encodeURIComponent(id)}?t=${Date.now()}` });
      } catch (error) {
        return json(res, { error: error.message }, 400);
      }
    }

    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/admin': ['admin.html', 'text/html; charset=utf-8'],
      '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
      '/icon.svg': ['icon.svg', 'image/svg+xml'],
    };
    if (staticFiles[p]) {
      const [name, type] = staticFiles[p];
      const file = path.join(PUBLIC_DIR, name);
      if (!exists(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'Nie znaleziono zasobu.' }));
  } catch (error) {
    console.error(error.stack || error.message);
    if (!res.headersSent) json(res, { error: 'Wewnętrzny błąd serwera.' }, 500);
    else res.end();
  }
});

pruneCache();

server.listen(PORT, HOST, () => {
  console.log(`\n=================================================`);
  console.log(`  Bob Watch Together v3.0 uruchomiony`);
  console.log(`  Lokalnie: http://localhost:${PORT}`);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const interfaceInfo of interfaces || []) {
      if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) console.log(`  W sieci: http://${interfaceInfo.address}:${PORT}`);
    }
  }
  console.log(`  Folder mediów: ${VIDEO_DIR}`);
  console.log(`  FFmpeg/FFprobe: ${HAS_FFMPEG ? 'dostępne' : 'BRAK'}`);
  console.log(`=================================================\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

let lastLibrarySignature = '';
setInterval(() => {
  try {
    const signature = scanLibrary().map(item => `${item.id}:${item.episodes.map(ep => ep.file).join('|')}`).join('\n');
    if (lastLibrarySignature && signature !== lastLibrarySignature) {
      broadcast({ type: 'library', party: currentPartyState(), count: scanLibrary().length });
      sqliteAudit('system', 'library.autoscan', { titleCount: scanLibrary().length });
    }
    lastLibrarySignature = signature;
  } catch (error) {
    console.error(`Automatyczny skan biblioteki nie powiódł się: ${error.message}`);
  }
}, 60000).unref();

setInterval(() => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `platform-auto-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const result = spawnSync('/usr/bin/sqlite3', [SQLITE_FILE, '.backup ' + backup], { encoding: 'utf8', timeout: 30000 });
    if (result.status === 0) sqliteAudit('system', 'database.autobackup', { backup: path.basename(backup) });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const full = path.join(BACKUP_DIR, file.name);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
    }
  } catch (error) {
    console.error(`Automatyczna kopia bazy nie powiodła się: ${error.message}`);
  }
}, 24 * 60 * 60 * 1000).unref();
