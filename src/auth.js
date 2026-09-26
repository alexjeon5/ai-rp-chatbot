/**
 * 로그인과 세션.
 *
 * 지금은 사용자 목록만 있고 데이터(캐릭터·대화·설정)는 모두가 같이 씁니다.
 * 사용자 개념을 먼저 넣어 두면, 나중에 데이터를 사용자별로 나눌 때
 * 모든 요청이 누가 보낸 것인지 이미 알고 있습니다 (req.user).
 *
 *   data/users.json     계정 목록. scripts/user.js 만 씁니다. 서버는 읽기만 하고,
 *                       파일이 바뀌면(수정 시각) 다시 읽습니다. 서버를 껐다 켤 필요가 없습니다.
 *   data/sessions.json  로그인 상태. 서버만 씁니다.
 *
 * 쿠키에는 무작위 토큰만 담기고, 서버에는 그 해시만 남습니다.
 * sessions.json 이 새어도 그걸로 로그인할 수는 없습니다.
 */
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { JsonDoc, DATA_DIR } from './db.js';

const scrypt = promisify(scryptCb);

export const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const COOKIE = 'rp_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** 마지막 사용 시각은 이 간격보다 자주 쓰지 않습니다. 라즈베리파이 SD 카드를 아끼려고. */
const TOUCH_MS = 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 20;

export const ROLES = ['owner', 'member'];

/* ---------------- 비밀번호 ---------------- */

/*
 * scrypt N=2^14 는 16MB·수십 ms 입니다. 라즈베리파이에서도 로그인 한 번에 무리가 없고,
 * 파일이 새어도 비밀번호를 하나씩 맞춰 보는 데 그만큼 비용이 듭니다.
 * 값은 해시 문자열에 같이 적어 두므로, 나중에 올려도 옛 해시는 그대로 검사됩니다.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** 맥에서 친 한글은 자모가 풀린(NFD) 채로 올 수 있어, 같은 비밀번호로 보이게 맞춥니다. */
const normalizePassword = (pw) => String(pw).normalize('NFC');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(normalizePassword(password), salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  if (!expected.length) return false;
  try {
    const key = await scrypt(normalizePassword(password), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** 없는 아이디로 로그인해도 걸리는 시간이 같도록, 가짜 해시와 비교합니다. */
let dummyHash = null;
const dummy = async () => (dummyHash ||= await hashPassword(randomBytes(16).toString('hex')));

/* ---------------- 사용자 목록 ---------------- */

/** 로그인 아이디. 한글도 됩니다. 비교할 때는 대소문자를 가리지 않습니다. */
export const NAME_RULE = /^[\p{L}\p{N}_.-]{1,32}$/u;
export const nameKey = (name) => String(name || '').trim().normalize('NFC').toLowerCase();

let usersCache = { mtimeMs: -1, users: [] };

/** users.json 을 읽습니다. 파일이 바뀌었을 때만 다시 읽습니다. */
export function readUsers() {
  let stat;
  try {
    stat = statSync(USERS_FILE);
  } catch {
    usersCache = { mtimeMs: 0, users: [] };
    return usersCache.users;
  }
  if (stat.mtimeMs !== usersCache.mtimeMs) {
    try {
      const raw = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
      usersCache = { mtimeMs: stat.mtimeMs, users: Array.isArray(raw?.users) ? raw.users : [] };
    } catch (e) {
      // 손으로 고치다 깨졌으면 예전 목록을 그대로 씁니다. 아무도 못 들어오는 것보다 낫습니다.
      console.error(`users.json 을 읽지 못했습니다 — ${e.message}`);
    }
  }
  return usersCache.users;
}

/** scripts/user.js 가 씁니다. 임시 파일에 쓴 뒤 바꿔치기해서, 서버가 반쯤 쓰인 파일을 읽지 않게 합니다. */
export function writeUsers(users) {
  mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ users }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, USERS_FILE);
}

export const findUser = (name) => readUsers().find((u) => nameKey(u.name) === nameKey(name)) || null;
const userById = (id) => readUsers().find((u) => u.id === id) || null;

/** 화면으로 내보내도 되는 부분만. */
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role });

/* ---------------- 세션 ---------------- */

const sessions = new JsonDoc(SESSIONS_FILE, () => ({ sessions: {} }));
const tokenKey = (token) => createHash('sha256').update(token).digest('hex');

function pruneSessions() {
  const now = Date.now();
  const all = sessions.data.sessions;
  let changed = false;
  for (const [key, s] of Object.entries(all)) {
    if (!(s?.expiresAt > now) || !userById(s.userId)) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) sessions.save();
}

function createSession(user, req) {
  const now = Date.now();
  const all = sessions.data.sessions;

  // 한 사람이 끝없이 쌓지 않게, 오래된 것부터 치웁니다.
  const mine = Object.entries(all)
    .filter(([, s]) => s.userId === user.id)
    .sort((a, b) => a[1].seenAt - b[1].seenAt);
  while (mine.length >= MAX_SESSIONS_PER_USER) delete all[mine.shift()[0]];

  const token = randomBytes(32).toString('base64url');
  all[tokenKey(token)] = {
    userId: user.id,
    epoch: user.epoch || 0,
    createdAt: now,
    seenAt: now,
    expiresAt: now + SESSION_MS,
    agent: String(req.get('user-agent') || '').slice(0, 160)
  };
  sessions.save();
  return token;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

/*
 * HttpOnly: 페이지 스크립트가 쿠키를 읽지 못합니다. 화면에 뭔가 새어 들어가도 토큰은 못 가져갑니다.
 * SameSite=Lax: 다른 사이트에서 보낸 POST 에는 쿠키가 붙지 않습니다. sameOrigin 과 함께 CSRF 를 막습니다.
 * Secure 는 https 로 들어왔을 때만 붙입니다. LAN 에서 http 로 직접 들어오면 붙일 수 없습니다.
 */
function setSessionCookie(req, res, token, maxAgeMs) {
  const parts = [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

const clearSessionCookie = (req, res) => setSessionCookie(req, res, '', 0);

/* ---------------- 로그인 실패 제한 ---------------- */

/*
 * IP 별 제한(loginLimit)은 X-Forwarded-For 를 믿는 설정이면 헤더를 바꿔 가며 피할 수 있습니다.
 * 그래서 IP 와 상관없이 전체 실패 횟수에도 상한을 둡니다. 걸리면 그동안은 주인도 새로 로그인하지
 * 못하지만, 이미 로그인한 기기는 그대로 쓸 수 있습니다.
 */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 30;
let failures = [];

function lockedOut() {
  const now = Date.now();
  failures = failures.filter((t) => now - t < FAIL_WINDOW_MS);
  return failures.length >= FAIL_MAX;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 인증 켜고 끄기 ---------------- */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * AUTH_DISABLED=1 은 자기 PC 에서 개발·테스트할 때만 씁니다.
 * 밖에서 들어올 수 있는 주소(0.0.0.0 등)에 묶여 있으면 무시하고 로그인을 요구합니다.
 */
function resolveDisabled(host) {
  if (process.env.AUTH_DISABLED !== '1') return false;
  if (LOOPBACK.has(String(host))) return true;
  console.warn(`AUTH_DISABLED=1 은 HOST 가 127.0.0.1 일 때만 적용됩니다 (지금: ${host}). 로그인을 켠 채로 시작합니다.`);
  return false;
}

const LOCAL_OWNER = Object.freeze({ id: 'local', name: 'local', role: 'owner' });

/* ---------------- 조립 ---------------- */

/**
 * @param {{ host: string }} o  서버가 묶이는 주소. AUTH_DISABLED 판단에 씁니다.
 */
export async function createAuth({ host }) {
  const disabled = resolveDisabled(host);
  await sessions.load();
  pruneSessions();
  // 오래 켜 두어도 만료된 세션이 쌓이지 않게 가끔 치웁니다.
  setInterval(pruneSessions, 6 * 60 * 60 * 1000).unref();

  if (disabled) {
    console.warn('로그인 없이 시작합니다 (AUTH_DISABLED=1). 이 PC 에서만 접속할 수 있습니다.');
  } else if (!readUsers().length) {
    console.warn(
      '\n아직 계정이 없어 아무도 로그인할 수 없습니다. 먼저 계정을 만드세요.\n' +
      '  npm run user -- add <아이디>\n' +
      '  (Docker) docker compose exec rp-chat node scripts/user.js add <아이디>\n'
    );
  }

  /** 쿠키를 보고 req.user 를 채웁니다. 막지는 않습니다. 막는 건 requireAuth 입니다. */
  function attachUser(req, res, next) {
    req.user = null;
    if (disabled) {
      req.user = LOCAL_OWNER;
      return next();
    }
    const token = readCookie(req, COOKIE);
    if (!token) return next();

    const key = tokenKey(token);
    const session = sessions.data.sessions[key];
    const user = session && userById(session.userId);
    const now = Date.now();

    // 만료, 계정 삭제, 비밀번호 변경(epoch 증가) 중 하나면 이 세션은 끝났습니다.
    if (!session || !user || session.expiresAt <= now || (session.epoch || 0) !== (user.epoch || 0)) {
      if (session) {
        delete sessions.data.sessions[key];
        sessions.save();
      }
      clearSessionCookie(req, res);
      return next();
    }

    // 쓰는 동안은 만료가 뒤로 밀립니다. 30일 동안 한 번도 안 쓰면 다시 로그인합니다.
    if (now - session.seenAt > TOUCH_MS) {
      session.seenAt = now;
      session.expiresAt = now + SESSION_MS;
      sessions.save();
      setSessionCookie(req, res, token, SESSION_MS);
    }
    req.user = publicUser(user);
    req.sessionKey = key;
    next();
  }

  /** /api 아래에 겁니다. 로그인하지 않았으면 401. */
  function requireAuth(req, res, next) {
    if (req.user) return next();
    res.status(401).json({ error: '로그인이 필요합니다.', auth: 'required' });
  }

  /** 엔진·API 키처럼 주인만 다뤄야 하는 경로에 겁니다. */
  function requireOwner(req, res, next) {
    if (req.user?.role === 'owner') return next();
    res.status(403).json({ error: '주인 계정만 쓸 수 있는 기능입니다.' });
  }

  /**
   * 첫 화면은 로그인하지 않았으면 로그인 페이지로 보냅니다.
   * 스타일·스크립트는 비밀이 없어 그대로 둡니다. 데이터는 전부 /api 뒤에 있습니다.
   */
  function pageGate(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if ((req.path === '/' || req.path === '/index.html') && !req.user) {
      return res.redirect(302, '/login.html');
    }
    if (req.path === '/login.html' && req.user) return res.redirect(302, '/');
    next();
  }

  async function login(req, res) {
    if (disabled) return res.json({ user: LOCAL_OWNER });

    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!name.trim() || !password) {
      return res.status(400).json({ error: '아이디와 비밀번호를 입력해 주세요.' });
    }
    // 아주 긴 입력으로 해시 계산을 붙잡아 두지 못하게 합니다.
    if (name.length > 64 || password.length > 1024) {
      return res.status(400).json({ error: '아이디나 비밀번호가 너무 깁니다.' });
    }
    if (lockedOut()) {
      return res.status(429).json({ error: '로그인 실패가 너무 많아 잠시 막아 두었습니다. 15분 뒤에 다시 시도해 주세요.' });
    }
    if (!readUsers().length) {
      return res.status(503).json({
        error: '아직 계정이 없습니다. 서버에서 npm run user -- add <아이디> 로 먼저 만들어 주세요.'
      });
    }

    const user = findUser(name);
    const ok = await verifyPassword(password, user?.passwordHash || await dummy());
    if (!user || !ok) {
      failures.push(Date.now());
      // 틀렸을 때만 조금 늦춥니다. 맞출 때까지 두드리는 속도를 떨어뜨립니다.
      await sleep(300 + Math.floor(Math.random() * 400));
      return res.status(401).json({ error: '아이디나 비밀번호가 맞지 않습니다.' });
    }

    const token = createSession(user, req);
    setSessionCookie(req, res, token, SESSION_MS);
    res.json({ user: publicUser(user) });
  }

  function logout(req, res) {
    if (req.sessionKey && sessions.data.sessions[req.sessionKey]) {
      delete sessions.data.sessions[req.sessionKey];
      sessions.save();
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }

  const me = (req, res) => res.json({ user: req.user, authDisabled: disabled });

  return { disabled, attachUser, requireAuth, requireOwner, pageGate, login, logout, me };
}
