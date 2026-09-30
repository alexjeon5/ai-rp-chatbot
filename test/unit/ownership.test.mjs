import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Store } from '../../src/store.js';
import { flushAll } from '../../src/db.js';
import { createServices } from '../../src/services/index.js';
import { AdminRequests } from '../../src/admin-requests.js';

const alice = { id: 'alice01', name: 'alice', role: 'owner' };
const bob = { id: 'bob0001', name: 'bob', role: 'owner' };
const carol = { id: 'carol01', name: 'carol', role: 'member' };

/** 계정별로 나누기 전의 데이터 폴더를 만듭니다: ownerId 없는 항목과, 계정별 값이 섞인 설정 파일. */
async function legacyDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owner-'));
  const put = async (rel, data) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), JSON.stringify(data));
  };
  await put('settings.json', {
    activeProvider: 'anthropic', activePersonaId: 'p1', historyLimit: 12, activePresetId: 'mine',
    presets: [{ id: 'mine', name: '내 모드', template: '내 틀', adult: false }],
    params: { temperature: 0.5 }, seededPersonas: ['감독'],
    dev: { adultCloud: true, particleFix: false, theme: { accent: '#123456' } },
    builtinCharactersTagged: true, builtinPersonasTagged: true
  });
  await put('chats/c1.json', { id: 'c1', kind: 'rp', characterId: 'ch1', title: '옛 대화', messages: [] });
  await put('characters/ch1.json', { id: 'ch1', name: '옛 캐릭터' });
  await put('personas/p1.json', { id: 'p1', name: '나' });
  await put('lorebooks/b1.json', { id: 'b1', name: '옛 책', entries: [] });
  await put('chats/orphan.json', { id: 'orphan', kind: 'assistant', title: '지운 계정의 대화', ownerId: 'gone', messages: [] });
  await put('chats/bobs.json', { id: 'bobs', kind: 'assistant', title: 'bob 의 대화', ownerId: bob.id, messages: [] });
  await mkdir(path.join(dir, 'images', 'c1'), { recursive: true });
  await writeFile(path.join(dir, 'images', 'c1', 'abcdef123.png'), 'x');
  return dir;
}

async function boot(dir, users, { authDisabled = false } = {}) {
  const store = await new Store(dir).load();
  const logs = [];
  const services = createServices({ store, auth: { disabled: authDisabled }, users: () => users });
  services.ownership.log = (m) => logs.push(m);
  services.admin.log = (m) => logs.push(m);
  return { store, services, logs };
}

const done = async (dir) => { await flushAll(); await rm(dir, { recursive: true, force: true }); };

test('주인이 하나면 옛 데이터와 옛 설정이 그 계정으로 갑니다', async () => {
  const dir = await legacyDir();
  try {
    const { store, services, logs } = await boot(dir, [alice, carol]);
    await services.admin.tick();
    assert.equal(store.chats.get('c1').ownerId, alice.id);
    assert.equal(store.characters.get('ch1').ownerId, alice.id);
    assert.equal(store.lorebooks.get('b1').ownerId, alice.id);
    assert.equal(store.chats.get('orphan').ownerId, alice.id, '지운 계정의 항목도 받습니다');
    assert.equal(store.chats.get('bobs').ownerId, alice.id, 'bob 은 계정 목록에 없어서 bob 의 대화도 고아입니다');
    assert.match(logs.join('\n'), /alice 계정에 붙였습니다/);

    const mine = services.settings.view(alice);
    assert.equal(mine.historyLimit, 12);
    assert.equal(mine.params.temperature, 0.5);
    assert.equal(mine.activePresetId, 'mine');
    assert.equal(mine.dev.theme.accent, '#123456');
    assert.equal(mine.dev.particleFix, false);
    assert.equal(mine.dev.adultCloud, true, '클라우드 허용은 공용으로 남습니다');
    assert.equal(mine.activeProvider, 'anthropic');
    assert.equal(store.settings.defaultProvider, 'anthropic', '옛 엔진이 새 계정 기본 엔진이 됩니다');
    for (const key of ['historyLimit', 'presets', 'params', 'activePersonaId', 'seededPersonas', 'activeProvider']) {
      assert.ok(!(key in store.settings), `${key} 는 공용 설정에서 빠집니다`);
    }
    assert.deepEqual(store.settings.dev, { adultCloud: true });
    await access(path.join(dir, 'settings.json.pre-accounts'));

    // 옛 데이터를 받은 계정은 기본 콘텐츠를 다시 받지 않고, 새 계정은 받습니다.
    const before = store.characters.size;
    services.setup.ensure(alice);
    assert.equal(store.characters.size, before);
    services.setup.ensure(carol);
    assert.ok(services.access.characters(carol).length > 0);
    assert.equal(services.settings.view(carol).historyLimit, 40, '새 계정은 코드 기본값에서 시작합니다');
  } finally {
    await done(dir);
  }
});

test('주인이 여럿이면 기다리고, claim 으로 정합니다. 기다리는 동안 주인 계정은 기본 콘텐츠를 받지 않습니다', async () => {
  const dir = await legacyDir();
  const users = [alice, bob, carol];
  try {
    const { store, services, logs } = await boot(dir, users);
    await services.admin.tick();
    assert.equal(store.chats.get('c1').ownerId, undefined);
    assert.match(logs.join('\n'), /claim/);
    assert.ok(services.ownership.waitingForClaim());

    const personas = store.personas.size;
    services.setup.ensure(alice);
    assert.equal(store.personas.size, personas, '주인은 claim 을 기다립니다');
    services.setup.ensure(carol);
    assert.ok(store.personas.size > personas, '멤버는 바로 받습니다');

    const moved = await services.ownership.claim(bob.id);
    assert.equal(store.chats.get('c1').ownerId, bob.id);
    assert.equal(store.chats.get('orphan').ownerId, bob.id);
    assert.equal(moved.settings, true);
    assert.equal(services.settings.view(bob).historyLimit, 12);
    assert.equal(services.ownership.waitingForClaim(), false);
    assert.equal(store.chats.get('bobs').ownerId, bob.id);
  } finally {
    await done(dir);
  }
});

test('claim --from 은 그 계정의 항목만, purge 는 항목·그림·설정을 모두 지웁니다', async () => {
  const dir = await legacyDir();
  try {
    const { store, services } = await boot(dir, [alice]);
    await services.admin.tick();
    await services.ownership.claim(carol.id, { from: alice.id });
    assert.equal(store.chats.get('c1').ownerId, carol.id);
    services.prefs.of(carol);

    const removed = await services.ownership.purge(carol.id);
    assert.ok(removed.chat >= 1 && removed.character >= 1);
    assert.equal(store.chats.get('c1'), null);
    assert.equal(services.prefs.has(carol), false);
    await flushAll();
    assert.equal(existsSync(path.join(dir, 'images', 'c1')), false);
  } finally {
    await done(dir);
  }
});

test('계정이 없고 로그인을 껐으면 옛 데이터는 local 이 받습니다', async () => {
  const dir = await legacyDir();
  try {
    const { store, services } = await boot(dir, [], { authDisabled: true });
    await services.admin.tick();
    assert.equal(store.chats.get('c1').ownerId, 'local');
  } finally {
    await done(dir);
  }
});

test('AdminRequests: 명령이 남긴 요청을 서버가 처리하고 결과를 돌려줍니다', async () => {
  const dir = await legacyDir();
  try {
    const users = [alice, bob];
    const { store, services } = await boot(dir, users);
    const requests = new AdminRequests(path.join(dir, 'admin'));
    const claimId = requests.submit({ type: 'claim', to: alice.id });
    const purgeId = requests.submit({ type: 'purge', userId: bob.id });
    const badId = requests.submit({ type: 'nope' });
    await services.admin.tick();

    const claimed = await requests.wait(claimId, 1000);
    assert.equal(claimed.ok, true);
    assert.match(claimed.message, /alice 계정으로 옮겼습니다/);
    assert.equal(store.chats.get('c1').ownerId, alice.id);
    assert.equal((await requests.wait(purgeId, 1000)).ok, false, '아직 있는 계정은 지우지 않습니다');
    assert.match((await requests.wait(badId, 1000)).message, /모르는 요청/);
    assert.deepEqual(requests.pending(), []);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'chats', 'bobs.json'), 'utf8')).ownerId, bob.id);
  } finally {
    await done(dir);
  }
});
