import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// auth.js 는 불러올 때 DATA_DIR 을 정하므로 먼저 임시 폴더로 돌려 둡니다.
const dir = await mkdtemp(path.join(tmpdir(), 'rp-auth-control-'));
process.env.DATA_DIR = dir;
delete process.env.AUTH_DISABLED;
const { createAuth, readAuthControl, writeAuthControl, writeUsers } = await import('../../src/auth.js');
const { rateLimit } = await import('../../src/security.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 수정 시각이 확실히 달라지게 조금 쉬었다 씁니다. 서버는 수정 시각을 보고 다시 읽습니다. */
const control = async (data) => { await sleep(20); writeAuthControl(data); };

function fakeReq(cookie = '') {
  return { headers: { cookie }, get: () => '', secure: false };
}
const fakeRes = () => ({ append() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

function run(auth, req = fakeReq()) {
  auth.attachUser(req, fakeRes(), () => {});
  return req;
}

test.after(() => rm(dir, { recursive: true, force: true }));

test('auth off: 시간 안에는 로그인 없이 주인, 지나거나 auth on 이면 다시 막힘', async () => {
  writeUsers([{ id: 'u1', name: 'alex', role: 'owner', passwordHash: 'x', epoch: 0 }]);
  const auth = await createAuth({ host: '0.0.0.0' });

  assert.equal(run(auth).user, null);

  await control({ offUntil: Date.now() + 60_000 });
  const req = run(auth);
  assert.equal(req.user.role, 'owner');
  const res = fakeRes();
  auth.me(req, res);
  assert.equal(res.body.authDisabled, true);

  await control({ offUntil: Date.now() - 1 });
  assert.equal(run(auth).user, null);

  await control({ offUntil: Date.now() + 60_000 });
  assert.ok(run(auth).user);
  await control({ ...readAuthControl(), offUntil: 0 });
  assert.equal(run(auth).user, null);
});

test('auth.json 이 없거나 깨져도 로그인은 켜진 채로', async () => {
  await rm(path.join(dir, 'auth.json'), { force: true });
  assert.deepEqual(readAuthControl(), { offUntil: 0, resetAt: 0 });
});

test('rateLimit since: 그 시각 전의 기록은 세지 않음 (unlock)', () => {
  let floor = 0;
  const limit = rateLimit({ windowMs: 60_000, max: 2, message: '막힘', since: () => floor });
  const hit = () => {
    const res = fakeRes();
    let passed = false;
    limit({ ip: '1.2.3.4' }, res, () => { passed = true; });
    return passed;
  };
  assert.equal(hit(), true);
  assert.equal(hit(), true);
  assert.equal(hit(), false);
  floor = Date.now();
  assert.equal(hit(), true);
});
