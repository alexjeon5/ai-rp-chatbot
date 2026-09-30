import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordLinks, CODE_TTL_MS, normalizeCode } from '../../src/services/discord-links.js';

function setup() {
  let now = 1_700_000_000_000;
  const users = [
    { id: 'alice01', name: 'alice', role: 'member', epoch: 0 },
    { id: 'bob0001', name: 'bob', role: 'owner', epoch: 0 }
  ];
  const doc = { data: {}, saves: 0, save() { this.saves += 1; } };
  const links = new DiscordLinks({ doc, resolveUser: (id) => users.find((u) => u.id === id) || null, now: () => now });
  return { links, doc, users, tick: (ms) => { now += ms; } };
}
const ALICE = { id: 'alice01', name: 'alice', role: 'member' };
const BOB = { id: 'bob0001', name: 'bob', role: 'owner' };
const D1 = { id: '111111111111111111', name: 'alice#1' };
const D2 = { id: '222222222222222222', name: 'other' };

test('코드는 해시만 남고, 한 번만 쓰이며, 이은 뒤에는 그 계정으로 일함', () => {
  const { links, doc } = setup();
  const { code, expiresAt } = links.issueCode(ALICE);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(expiresAt > 0);
  assert.ok(!JSON.stringify(doc.data).includes(normalizeCode(code)), '원래 코드는 저장하지 않습니다');

  assert.equal(links.actorOf(D1.id), null);
  // 소문자·공백으로 적어도 받습니다.
  assert.deepEqual(links.redeem(D1, ` ${code.toLowerCase().replace('-', ' ')} `), ALICE);
  assert.deepEqual(links.actorOf(D1.id), ALICE);
  assert.throws(() => links.redeem(D2, code), /코드가 맞지 않거나/, '같은 코드는 두 번 못 씁니다');
  assert.equal(links.status(ALICE).linked.name, 'alice#1');
  assert.equal(links.status(BOB).linked, null);
});

test('시간이 지난 코드, 새로 받아 무효가 된 코드는 못 씀', () => {
  const { links, tick } = setup();
  const old = links.issueCode(ALICE).code;
  const fresh = links.issueCode(ALICE).code;
  assert.throws(() => links.redeem(D1, old), /코드가 맞지 않거나/);
  tick(CODE_TTL_MS + 1);
  assert.throws(() => links.redeem(D1, fresh), /코드가 맞지 않거나/);
  assert.equal(links.status(ALICE).pending, null);
});

test('계정을 지우거나 epoch 가 바뀌면(비밀번호 변경·logout-all) 연결이 끊김', () => {
  const { links, users } = setup();
  links.redeem(D1, links.issueCode(ALICE).code);
  links.redeem(D2, links.issueCode(BOB).code);
  users[0].epoch = 1;
  assert.equal(links.actorOf(D1.id), null);
  assert.equal(links.status(ALICE).linked, null);
  users.splice(1, 1);
  assert.equal(links.actorOf(D2.id), null);
});

test('앱 계정 하나에 디스코드 하나: 다시 이으면 앞의 연결은 끊기고, 디스코드 쪽에서 옮겨 붙을 수도 있음', () => {
  const { links } = setup();
  links.redeem(D1, links.issueCode(ALICE).code);
  links.redeem(D2, links.issueCode(ALICE).code);
  assert.equal(links.actorOf(D1.id), null, 'alice 에게 새 디스코드가 붙으면 옛 디스코드는 끊김');
  assert.deepEqual(links.actorOf(D2.id), ALICE);

  links.redeem(D2, links.issueCode(BOB).code);
  assert.deepEqual(links.actorOf(D2.id), BOB, '같은 디스코드가 다른 계정으로 옮겨 감');
  assert.equal(links.status(ALICE).linked, null);
});

test('연결 끊기: 웹에서도, 디스코드에서도', () => {
  const { links } = setup();
  links.redeem(D1, links.issueCode(ALICE).code);
  assert.equal(links.unlink(ALICE), true);
  assert.equal(links.actorOf(D1.id), null);
  links.redeem(D1, links.issueCode(ALICE).code);
  assert.equal(links.unlinkDiscord(D1.id), true);
  assert.equal(links.unlinkDiscord(D1.id), false);
});

test('코드 맞춰 보기는 디스코드 사용자마다 10분에 5번까지', () => {
  const { links } = setup();
  for (let i = 0; i < 5; i += 1) assert.throws(() => links.redeem(D1, 'AAAA-AAAA'), /코드가 맞지 않거나/);
  const { code } = links.issueCode(ALICE);
  assert.throws(() => links.redeem(D1, code), (e) => e.status === 429, '맞는 코드여도 한도를 넘으면 막힘');
  assert.deepEqual(links.redeem(D2, code), ALICE, '다른 디스코드 사용자는 따로 셈');
});

test('디스코드 사용자 id 가 아닌 값은 받지 않음', () => {
  const { links } = setup();
  const { code } = links.issueCode(ALICE);
  assert.throws(() => links.redeem({ id: '../x' }, code), /디스코드 사용자를 알 수 없습니다/);
});
