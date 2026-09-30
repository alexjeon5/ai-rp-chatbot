/**
 * 로그인·계정 명령 동작 기록기. run.mjs 와 같은 방식으로 앞뒤 결과를 비교합니다.
 *
 *   node test/golden/auth.mjs [앱 폴더] [결과 파일]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(process.argv[2] || path.join(here, '../..'));
const outFile = process.argv[3] || path.join(appDir, 'golden-auth.json');
const PORT = 5186;
const preload = pathToFileURL(path.join(here, '../support/deterministic.mjs')).href;
const dataDir = await mkdtemp(path.join(tmpdir(), 'rp-auth-'));
const env = { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(PORT), AUTH_DISABLED: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { commands: [], http: [] };
// 프로세스마다 id 시작값을 달리 줘야 계정 id 가 겹치지 않습니다.
let spawned = 0;
const envFor = () => ({ ...env, DET_SEQ_BASE: String(++spawned * 1000) });

/** scripts/user.js 한 번. stdin 으로 비밀번호 줄을 넘깁니다. */
function user(args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', preload, 'scripts/user.js', ...args], { cwd: appDir, env: envFor() });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('close', (code) => {
      out.commands.push({ args, code, text: text.replace(/\r/g, '').split(dataDir).join('DATA') });
      resolve();
    });
    child.stdin.end(input);
  });
}

await user(['list']);
await user(['add', '앨리스'], 'password1\npassword1\n');
await user(['add', 'bob', '--member'], 'short\nshort\n');
await user(['add', 'bob', '--member'], 'password2\npassword2\n');
await user(['add', 'bob'], 'password2\npassword2\n');
await user(['add', 'bad name!'], '');
await user(['role', 'bob', 'owner']);
await user(['role', 'bob', 'king']);
await user(['list']);

const server = spawn(process.execPath, ['--import', preload, 'server.js'], { cwd: appDir, env: envFor() });
const logs = [];
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  try { await fetch(`${base}/api/me`); break; } catch { await sleep(100); }
}

let cookie = '';
async function http(name, method, url, body, { origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' });
  const set = res.headers.get('set-cookie') || '';
  const token = /rp_session=([^;]*)/.exec(set)?.[1];
  if (token !== undefined) cookie = token ? `rp_session=${token}` : '';
  const type = res.headers.get('content-type') || '';
  out.http.push({
    name, status: res.status, location: res.headers.get('location'),
    cookie: set.replace(/rp_session=[^;]+/, 'rp_session=TOKEN'),
    body: type.includes('json') ? await res.json() : null
  });
}

await http('첫 화면(로그인 전)', 'GET', '/');
await http('로그인 페이지', 'GET', '/login.html');
await http('me(로그인 전)', 'GET', '/api/me');
await http('설정(로그인 전)', 'GET', '/api/settings');
await http('로그인: 빈 값', 'POST', '/api/login', { name: '', password: '' });
await http('로그인: 틀림', 'POST', '/api/login', { name: '앨리스', password: 'nope' });
await http('로그인: 없는 사람', 'POST', '/api/login', { name: 'nobody', password: 'password1' });
await http('로그인: 대소문자 무시', 'POST', '/api/login', { name: 'BOB', password: 'password2' });
await http('me', 'GET', '/api/me');
await http('첫 화면', 'GET', '/');
await http('로그인 페이지(로그인 후)', 'GET', '/login.html');
await http('다른 출처 요청', 'PUT', '/api/settings', {}, { origin: 'http://evil.example.com' });
await http('로그아웃', 'POST', '/api/logout', {});
await http('me(로그아웃 후)', 'GET', '/api/me');
await http('로그인: 앨리스', 'POST', '/api/login', { name: '앨리스', password: 'password1' });
await http('멤버가 아닌 주인: 로그', 'GET', '/api/logs');
// 데이터를 옮기는 명령은 켜져 있는 서버가 처리합니다. 앨리스가 로그인하며 받은 기본 콘텐츠를 bob 에게 옮깁니다.
await user(['claim', 'bob', '--from', '앨리스']);
await user(['claim', 'nobody']);
await http('옮긴 뒤 앨리스의 캐릭터', 'GET', '/api/characters');
server.kill();
await sleep(300);

await user(['logout-all', '앨리스']);
await user(['passwd', 'bob'], 'password3\npassword3\n');
await user(['remove', 'bob']);
await user(['remove', 'nobody']);
await user(['list']);
await user(['help']);

const users = JSON.parse(await readFile(path.join(dataDir, 'users.json'), 'utf8'));
await rm(dataDir, { recursive: true, force: true });
out.users = users.users.map(({ passwordHash, id, createdAt, ...rest }) => ({ ...rest, hash: passwordHash.split('$').slice(0, 4).join('$') }));
out.logs = logs.join('').split('\n').filter(Boolean);
await writeFile(outFile, JSON.stringify(out, null, 2).replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, 'DATE'));
console.log(`기록했습니다: ${outFile}`);
