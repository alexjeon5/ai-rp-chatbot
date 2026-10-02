/**
 * 계정 나누기: 다른 계정의 대화·그림·검색 결과·백업이 보이지 않는지, 실제 HTTP 경로로 확인합니다.
 * 로그인은 x-test-user 헤더로 대신합니다. 나머지(저장소·서비스·라우트)는 서버와 같은 것을 씁니다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { Store } from '../../src/store.js';
import { flushAll } from '../../src/db.js';
import { createServices } from '../../src/services/index.js';
import { createApp } from '../../src/http/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USERS = {
  alice: { id: 'alice01', name: 'alice', role: 'member' },
  bob: { id: 'bob0001', name: 'bob', role: 'owner' }
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

/** 쿠키 대신 헤더로 사람을 정하는 로그인. 나머지 모양은 src/auth.js 의 createAuth 와 같습니다. */
const fakeAuth = {
  disabled: false,
  filterStatus: () => ({ eligible: false, active: false, expiresAt: 0 }),
  setFilterRelaxation: (req, res) => res.status(403).json({ error: '성인 확인 필요' }),
  attachUser: (req, res, next) => {
    req.user = USERS[req.get('x-test-user')] || null;
    // auth off(로그인 잠시 끄기)로 들어온 요청 흉내
    if (req.get('x-test-bypass')) req.authBypass = true;
    next();
  },
  pageGate: (req, res, next) => next(),
  requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: '로그인이 필요합니다.' })),
  requireOwner: (req, res, next) => (req.user?.role === 'owner' ? next() : res.status(403).json({ error: '주인 계정만 쓸 수 있는 기능입니다.' })),
  login: async (req, res) => res.json({}),
  logout: (req, res) => res.json({ ok: true }),
  me: (req, res) => res.json({ user: req.user })
};

async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'isolation-'));
  const store = await new Store(dir).load();
  const services = createServices({ store, auth: fakeAuth, users: () => Object.values(USERS) });
  await services.admin.tick();
  const app = createApp({ store, auth: fakeAuth, services, publicDir: path.join(root, 'public') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** who 로 한 번 부릅니다. 본문이 Buffer 면 그림 파일로 보냅니다. */
  const as = (who, extra = {}) => async (method, url, body) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'x-test-user': who, 'Content-Type': raw ? 'image/png' : 'application/json', ...extra },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    store, services, alice: as('alice'), bob: as('bob'), bypassed: as('bob', { 'x-test-bypass': '1' }),
    stop: async () => { server.close(); services.admin.stop(); await flushAll(); await rm(dir, { recursive: true, force: true }); }
  };
}

test('다른 계정의 대화·그림·검색 결과·백업이 보이지 않습니다', async () => {
  const t = await start();
  const { alice, bob } = t;
  try {
    /* ---- alice 가 대화와 딸린 것들을 만듭니다 ---- */
    const aChars = (await alice('GET', '/api/characters')).body;
    const bChars = (await bob('GET', '/api/characters')).body;
    assert.ok(aChars.length > 0 && bChars.length > 0, '계정마다 내장 캐릭터 사본을 받습니다');
    assert.equal(aChars.filter((c) => bChars.some((b) => b.id === c.id)).length, 0, '사본은 서로 다른 항목입니다');

    const hero = aChars[0];
    const chat = (await alice('POST', '/api/chats', { characterId: hero.id })).body;
    await alice('POST', `/api/chats/${chat.id}/messages`, { content: '앨리스의 비밀 암호는 무지개다' });
    const upload = (await alice('POST', `/api/chats/${chat.id}/attachments`, PNG)).body;
    const book = (await alice('POST', '/api/lorebooks', { name: '앨리스 세계', global: true, entries: [{ keys: ['무지개'], content: '앨리스만 아는 설정' }] })).body;
    const bg = (await alice('POST', `/api/backgrounds?name=${encodeURIComponent('앨리스 방')}`, PNG)).body;
    const portrait = (await alice('PUT', `/api/characters/${hero.id}/portrait`, PNG)).body.portrait;

    // alice 자신은 볼 수 있습니다. 그림은 공용 캐시에 남지 않게 private 로 나갑니다.
    const own = await alice('GET', `/api/uploads/${chat.id}/${upload.file}`);
    assert.equal(own.status, 200);
    assert.match(own.headers.get('cache-control'), /^private/);
    assert.equal((await alice('GET', `/api/character-art/${hero.id}/${portrait}`)).status, 200);

    /* ---- bob(주인 역할)은 하나도 보지 못합니다 ---- */
    assert.equal((await bob('GET', '/api/chats')).body.some((c) => c.id === chat.id), false);
    for (const [method, url, body] of [
      ['GET', `/api/chats/${chat.id}`],
      ['PUT', `/api/chats/${chat.id}`, { title: '가로챔' }],
      ['POST', `/api/chats/${chat.id}/messages`, { content: '끼어들기' }],
      ['POST', `/api/chats/${chat.id}/generate`, {}],
      ['POST', `/api/chats/${chat.id}/branch`, { messageId: 'x' }],
      ['GET', `/api/chats/${chat.id}/system`],
      ['GET', `/api/chats/${chat.id}/lore`],
      ['DELETE', `/api/chats/${chat.id}`]
    ]) {
      const got = await bob(method, url, body);
      assert.equal(got.status, 404, `${method} ${url}`);
      assert.equal(got.body.error, '없는 대화입니다.', `${method} ${url} — 없는 대화와 같은 안내`);
    }
    assert.deepEqual((await bob('POST', `/api/chats/${chat.id}/stop`, {})).body, { stopped: false });

    for (const url of [
      `/api/uploads/${chat.id}/${upload.file}`,
      `/api/character-art/${hero.id}/${portrait}`,
      `/api/background-art/${bg.id}/${bg.file}`
    ]) {
      const got = await bob('GET', url);
      assert.equal(got.status, 404, url);
      assert.equal(got.body.length, 0, `${url} — 빈 응답`);
    }
    assert.equal((await bob('PUT', `/api/characters/${hero.id}/portrait`, PNG)).status, 404);
    assert.equal((await bob('PUT', `/api/characters/${hero.id}`, { name: '가로챔' })).status, 404);
    assert.equal((await bob('DELETE', `/api/lorebooks/${book.id}`)).status, 404);
    assert.equal((await bob('DELETE', `/api/backgrounds/${bg.id}`)).status, 404);
    assert.equal((await bob('GET', `/api/characters/${hero.id}/export`)).status, 404);

    const search = (await bob('GET', `/api/search?q=${encodeURIComponent('무지개')}`)).body;
    assert.deepEqual(search.hits, []);
    assert.equal((await bob('GET', '/api/lorebooks')).body.some((b) => b.id === book.id), false);
    assert.equal((await bob('GET', '/api/backgrounds')).body.length, 0);

    const exported = (await bob('GET', '/api/export')).body;
    assert.equal(exported.chats.some((c) => c.id === chat.id), false);
    assert.equal(exported.characters.some((c) => c.id === hero.id), false);
    assert.equal(exported.lorebooks.length, 0);
    assert.equal(JSON.stringify(exported).includes('무지개'), false);

    /* ---- 남의 id 를 내 항목에 끌어다 붙여도 무시됩니다 ---- */
    assert.equal((await bob('POST', '/api/chats', { characterId: hero.id })).status, 400);
    const bChat = (await bob('POST', '/api/chats', { characterId: bChars[0].id })).body;
    const patched = (await bob('PUT', `/api/chats/${bChat.id}`, { castIds: [hero.id], lorebookIds: [book.id] })).body;
    assert.deepEqual(patched.castIds, []);
    assert.deepEqual(patched.lorebookIds, []);
    const bBook = (await bob('POST', '/api/lorebooks', { name: 'bob 책', characterIds: [hero.id, bChars[0].id] })).body;
    assert.deepEqual(bBook.characterIds, [bChars[0].id]);
    await bob('POST', `/api/chats/${bChat.id}/messages`, { content: '무지개를 봤어' });
    const bSystem = (await bob('GET', `/api/chats/${bChat.id}/system`)).body.system;
    assert.equal(bSystem.includes('앨리스만 아는 설정'), false, '남의 전역 로어북은 붙지 않습니다');
    assert.equal((await alice('GET', `/api/chats/${chat.id}/system`)).body.system.includes('앨리스만 아는 설정'), true);

    /* ---- 설정은 계정마다 따로입니다 ---- */
    await bob('PUT', '/api/settings', { historyLimit: 7, dev: { theme: { accent: '#000000' } } });
    const aSettings = (await alice('GET', '/api/settings')).body;
    assert.equal(aSettings.historyLimit, 40);
    assert.equal(aSettings.canManage, false);
    assert.equal((await bob('GET', '/api/settings')).body.historyLimit, 7);

    /* ---- 사용량: 기본은 내 것, 전체는 주인만 ---- */
    t.services.usage.add('p', 'm', { promptTokens: 7, completionTokens: 1, estimated: false }, Date.now(), 'alice01');
    t.services.usage.add('p', 'm', { promptTokens: 90, completionTokens: 1, estimated: false }, Date.now(), 'bob0001');
    const aUsage = (await alice('GET', '/api/usage')).body;
    assert.equal(aUsage.periods[0].total.promptTokens, 7);
    assert.equal(aUsage.canSeeAll, false);
    assert.equal((await alice('GET', '/api/usage?scope=all')).status, 403);
    assert.equal((await alice('DELETE', '/api/usage')).status, 403);
    const allUsage = (await bob('GET', '/api/usage?scope=all')).body;
    assert.equal(allUsage.periods[0].total.promptTokens, 97);
    assert.deepEqual(allUsage.periods[0].users.map((u) => u.name), ['bob', 'alice']);

    /* ---- 남의 백업을 불러와도 원본은 그대로이고, 내 몫의 새 항목이 생깁니다 ---- */
    const aliceBackup = (await alice('GET', '/api/export')).body;
    const first = (await bob('POST', '/api/import', { data: aliceBackup })).body;
    assert.equal(first.chats.added, 1);
    const again = (await bob('POST', '/api/import', { data: aliceBackup })).body;
    assert.equal(again.chats.added, 0, '같은 백업을 두 번 불러와도 겹치지 않습니다');
    assert.equal(t.store.chats.get(chat.id).ownerId, 'alice01');
    assert.equal(t.store.chats.get(chat.id).title, hero.name);
    const bobsCopy = (await bob('GET', '/api/chats')).body.find((c) => c.title === hero.name && c.id !== chat.id);
    assert.ok(bobsCopy, 'bob 에게는 새 id 의 사본');
    const copied = (await bob('GET', `/api/chats/${bobsCopy.id}`)).body;
    assert.ok(t.services.access.findCharacter(USERS.bob, copied.characterId), '사본이 가리키는 캐릭터도 bob 의 것');

    // 원래 alice 의 것은 그대로 alice 만 봅니다.
    assert.equal((await alice('GET', `/api/chats/${chat.id}`)).status, 200);
    assert.equal((await alice('GET', '/api/chats')).body.length, 1);
  } finally {
    await t.stop();
  }
});

test('남의 대화 파일 경로를 알아도 대화를 지우면 파일도 사라지고, 멤버도 백업을 불러올 수 있습니다', async () => {
  const t = await start();
  const { alice, bob } = t;
  try {
    const hero = (await alice('GET', '/api/characters')).body[0];
    const chat = (await alice('POST', '/api/chats', { characterId: hero.id })).body;
    const up = (await alice('POST', `/api/chats/${chat.id}/attachments`, PNG)).body;
    assert.equal((await bob('DELETE', `/api/chats/${chat.id}/attachments/${up.file}`)).status, 404);
    assert.equal((await alice('GET', `/api/uploads/${chat.id}/${up.file}`)).status, 200, 'bob 은 지우지 못했습니다');
    await alice('DELETE', `/api/chats/${chat.id}`);
    assert.equal((await alice('GET', `/api/uploads/${chat.id}/${up.file}`)).status, 404);

    const backup = (await bob('GET', '/api/export')).body;
    const imported = await alice('POST', '/api/import', { data: backup });
    assert.equal(imported.status, 200, '멤버도 자기 계정으로 불러옵니다');
  } finally {
    await t.stop();
  }
});

test('HTTP 없이 부르는 생성 서비스(Replies)도 남의 대화는 없는 것으로 보고, 아무것도 흘려보내지 않습니다', async () => {
  const t = await start();
  const { alice } = t;
  const { replies, jobs } = t.services;
  try {
    const hero = (await alice('GET', '/api/characters')).body[0];
    const chat = (await alice('POST', '/api/chats', { characterId: hero.id })).body;
    const sent = [];
    const emit = (event) => sent.push(event);
    const refused = async (work) => {
      await assert.rejects(work, (e) => e.status === 404 && e.message === '없는 대화입니다.');
    };

    await refused(replies.reply(USERS.bob, chat.id, { emit }));
    await refused(replies.impersonate(USERS.bob, chat.id, { emit }));
    await refused(replies.choices(USERS.bob, chat.id));
    await refused(replies.summarize(USERS.bob, chat.id));
    await refused(replies.extractFacts(USERS.bob, chat.id));
    assert.deepEqual(sent, [], '막힌 요청은 조각을 하나도 보내지 않습니다');
    assert.equal(jobs.running.has(chat.id), false);

    // 주인은 시작 전 검사(이어 쓸 답변 없음)를 지나 같은 모양의 오류를 받습니다.
    const empty = (await alice('POST', '/api/chats', { kind: 'assistant' })).body;
    await assert.rejects(replies.reply(USERS.alice, empty.id, { mode: 'continue', emit }), (e) => e.status === 400);
    assert.deepEqual(sent, []);
  } finally {
    await t.stop();
  }
});

test('디스코드 연결 코드는 내 계정에만 걸리고, 로그인을 잠시 꺼 둔 동안에는 받을 수 없습니다', async () => {
  const t = await start();
  const { alice, bob, bypassed } = t;
  try {
    const issued = await alice('POST', '/api/discord/link-code');
    assert.equal(issued.status, 200);
    assert.ok((await alice('GET', '/api/discord/link')).body.pending);
    assert.equal((await bob('GET', '/api/discord/link')).body.pending, null);

    const refused = await bypassed('POST', '/api/discord/link-code');
    assert.equal(refused.status, 403);

    const actor = t.services.discordLinks.redeem({ id: '333333333333333333', name: 'a' }, issued.body.code);
    assert.equal(actor.id, 'alice01');
    assert.equal((await alice('GET', '/api/discord/link')).body.linked.name, 'a');
    assert.equal((await bob('DELETE', '/api/discord/link')).body.removed, false, 'bob 은 alice 의 연결을 못 끊음');
    assert.equal((await alice('DELETE', '/api/discord/link')).body.removed, true);
  } finally {
    await t.stop();
  }
});
