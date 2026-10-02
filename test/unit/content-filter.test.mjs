import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// 인증·저장소 모듈을 불러오기 전에 운영 데이터와 분리합니다.
const dir = await mkdtemp(path.join(tmpdir(), 'rp-content-filter-'));
process.env.DATA_DIR = dir;
delete process.env.AUTH_DISABLED;
const { createAuth, writeUsers, hashPassword, readUsers } = await import('../../src/auth.js');
const { Store } = await import('../../src/store.js');
const { flushAll } = await import('../../src/db.js');
const { createApp } = await import('../../src/http/app.js');
const { ImageRoutes } = await import('../../src/http/routes/images.js');
const { composePrompt, imageConfig, CORE_NEGATIVE } = await import('../../src/image.js');

test.after(async () => { await flushAll(); await rm(dir, { recursive: true, force: true }); });

const cfg = imageConfig({ enabled: true, checkpoint: 'test.safetensors', prefix: '',
  adult: { forceTags: 'adult', blockTags: 'gore, *blood*, loli', extraNegative: 'blur' } });

test('태그 필터 완화 중에도 고정 차단·외형·네거티브를 적용', () => {
  const args = { cfg, adult: true, sceneTags: ['gore', 'blood splatter', 'smile'], appearance: ['adult woman'] };
  const normal = composePrompt(args);
  assert.deepEqual(normal.removed, ['gore', 'blood splatter']);
  const relaxed = composePrompt({ ...args, relaxUserFilter: true });
  assert.deepEqual(relaxed.removed, []);
  assert.match(relaxed.prompt, /gore, blood splatter/);
  assert.match(relaxed.prompt, /adult woman/);
  assert.ok(relaxed.negative.includes(CORE_NEGATIVE));
  assert.ok(relaxed.negative.includes('blur'));
  for (const relaxUserFilter of [false, true]) {
    assert.deepEqual(composePrompt({ ...args, sceneTags: ['loli'], relaxUserFilter }), { blocked: ['loli'] });
  }
});

test('태그를 만드는 동안 만료되면 조립 시점에 필터를 다시 적용', async () => {
  let active = true;
  const routes = new ImageRoutes({});
  routes.sceneTags = async () => { active = false; return { tags: ['gore'], negative: [] }; };
  const result = await routes.composeTags({ cfg, adult: true, body: {}, typed: '',
    ctx: { character: {}, cast: [] }, relaxUserFilter: () => active });
  assert.deepEqual(result.removed, ['gore']);
});

test('실제 HTTP: 성인 확인·세션 격리·만료·취소·로그아웃·우회 차단', async () => {
  const passwordHash = await hashPassword('test-password');
  writeUsers([
    { id: 'adult001', name: 'adult', role: 'member', passwordHash, epoch: 0, adultVerifiedAt: Date.now(), adultVerificationEpoch: 1 },
    { id: 'owner001', name: 'owner', role: 'owner', passwordHash, epoch: 0 }
  ]);
  const auth = await createAuth({ host: '127.0.0.1' });
  const store = await new Store(dir).load();
  store.settings.image = cfg;
  const app = createApp({ store, auth, publicDir: path.resolve('public') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, url, cookie = '', body, extraHeaders = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text();
    return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : raw };
  };
  const login = async (name) => {
    const res = await request('POST', '/api/login', '', { name, password: 'test-password' });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const cli = async (action) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = spawnSync(process.execPath, ['scripts/user.js', 'adult', 'adult', action], { env: process.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  const realNow = Date.now;
  try {
    const first = await login('adult');
    const second = await login('adult');
    const owner = await login('owner');
    assert.equal((await request('GET', '/api/content-filter')).status, 401);
    assert.equal((await request('POST', '/api/content-filter', owner, { adultVerifiedAt: Date.now(), active: true })).status, 403);
    assert.equal((await request('POST', '/api/content-filter', first, {}, { origin: 'https://other.example' })).status, 403);
    const before = Date.now();
    const grant = (await request('POST', '/api/content-filter', first, { expiresAt: Number.MAX_SAFE_INTEGER })).body;
    assert.equal(grant.active, true);
    assert.ok(grant.expiresAt >= before + 30 * 60_000 && grant.expiresAt <= Date.now() + 30 * 60_000);
    assert.equal((await request('POST', '/api/content-filter', first)).body.expiresAt, grant.expiresAt);
    const otherSession = await request('GET', '/api/content-filter', second);
    assert.equal(otherSession.body.active, false);
    assert.equal(otherSession.headers.get('cache-control'), 'private, no-store');

    const chat = (await request('POST', '/api/chats', first, { character: { name: 'Test', appearance: 'adult woman' }, presetId: 'adult' })).body;
    const msg = (await request('POST', `/api/chats/${chat.id}/messages`, first, { role: 'assistant', content: '장면' })).body;
    const review = (cookie, prompt = 'gore, smile', extra = {}) => request('POST', `/api/chats/${chat.id}/messages/${msg.id}/image`, cookie, { prompt, review: true, ...extra });
    assert.match((await review(first)).body, /"removed":\[\]/);
    assert.match((await review(second, 'gore, smile', { relaxUserFilter: true })).body, /"removed":\["gore"\]/);
    assert.match((await review(first, 'loli, gore')).body, /미성년/);
    Date.now = () => grant.expiresAt;
    assert.equal((await request('GET', '/api/content-filter', first)).body.active, false);
    assert.match((await review(first)).body, /"removed":\["gore"\]/);
    Date.now = realNow;

    assert.equal((await request('DELETE', '/api/content-filter', first)).body.active, false);
    await request('POST', '/api/content-filter', first);
    await cli('revoke');
    assert.equal((await request('GET', '/api/content-filter', first)).body.eligible, false);
    assert.equal((await request('POST', '/api/content-filter', first)).status, 403);
    await cli('verify');
    assert.ok(readUsers().find((u) => u.name === 'adult').adultVerifiedAt > 0);
    assert.equal((await request('GET', '/api/content-filter', first)).body.active, false);
    await request('POST', '/api/content-filter', first);
    await request('POST', '/api/logout', first);
    assert.equal((await request('GET', '/api/content-filter', first)).status, 401);
    assert.equal((await request('GET', '/api/content-filter', await login('adult'))).body.active, false);
    assert.equal(auth.filterStatus({ user: { id: 'adult001', role: 'owner', adultVerifiedAt: Date.now() }, authBypass: true }).eligible, false);
    process.env.AUTH_DISABLED = '1';
    process.env.AUTH_DISABLED_AS = 'adult';
    const disabled = await createAuth({ host: '127.0.0.1' });
    assert.equal(disabled.filterStatus({ user: { id: 'adult001' } }).eligible, false);
  } finally {
    Date.now = realNow;
    delete process.env.AUTH_DISABLED;
    delete process.env.AUTH_DISABLED_AS;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await flushAll();
  }
});
