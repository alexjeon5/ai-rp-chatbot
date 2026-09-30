import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Access, OwnerPolicy, SharedPolicy } from '../../src/services/access.js';
import { NotFound } from '../../src/services/errors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function table(items) {
  const map = new Map(items.map((x) => [x.id, x]));
  return { get: (id) => (id ? map.get(id) || null : null), all: () => [...map.values()] };
}

function fakeStore() {
  return {
    chats: table([
      { id: 'a1', ownerId: 'alice', messages: [{ id: 'm1', content: '안녕' }] },
      { id: 'b1', ownerId: 'bob', messages: [{ id: 'm2', content: '비밀' }] }
    ]),
    characters: table([{ id: 'ca', ownerId: 'alice' }, { id: 'cb', ownerId: 'bob' }]),
    personas: table([]),
    lorebooks: table([]),
    backgrounds: table([])
  };
}

const alice = { id: 'alice', name: 'alice', role: 'member' };
const bob = { id: 'bob', name: 'bob', role: 'owner' };

test('Access(SharedPolicy): 모두가 모든 항목을 봅니다', () => {
  const access = new Access(fakeStore(), new SharedPolicy());
  assert.equal(access.chats(alice).length, 2);
  assert.equal(access.findChat(alice, 'b1').id, 'b1');
});

test('Access(OwnerPolicy): 남의 것은 없는 것과 같고, 주인 역할도 예외가 아닙니다', () => {
  const access = new Access(fakeStore(), new OwnerPolicy());
  assert.deepEqual(access.chats(alice).map((c) => c.id), ['a1']);
  assert.equal(access.findChat(alice, 'b1'), null);
  assert.equal(access.findChat(bob, 'a1'), null);
  assert.equal(access.findChat(null, 'a1'), null);
  assert.equal(access.findChat(alice, 'nope'), null);
  assert.equal(access.findChat(alice, 42), null);
  assert.throws(() => access.chat(alice, 'b1'), (e) => e instanceof NotFound && e.status === 404 && e.message === '없는 대화입니다.');
  assert.throws(() => access.character(alice, 'cb', '없는 항목입니다.'), /없는 항목입니다/);
  assert.deepEqual(access.findMessage(alice, 'a1', 'm1').msg.content, '안녕');
  assert.equal(access.findMessage(alice, 'b1', 'm2'), null);
  assert.throws(() => access.message(alice, 'b1', 'm2'), /없는 메시지입니다/);
});

test('Access.ownerOf: 대화의 주인으로 딸린 항목을 찾습니다', () => {
  const access = new Access(fakeStore(), new OwnerPolicy());
  const owner = access.ownerOf(access.findChat(alice, 'a1'));
  assert.equal(access.findCharacter(owner, 'ca').id, 'ca');
  assert.equal(access.findCharacter(owner, 'cb'), null);
  assert.deepEqual(access.ownerOf({}), { id: null });
});

/*
 * 권한 검사는 Access 한 곳에서만 합니다. 라우트나 서비스가 저장소에서 항목을 직접 꺼내면 거르기를 건너뛰므로,
 * 읽기(get·all·size)는 Access 를 거치게 하고 쓰기(add·update·save·remove)만 저장소를 직접 부릅니다.
 * 라우트는 has 도 금지합니다. 서비스의 has 는 모든 계정이 나눠 쓰는 id 공간의 충돌 검사(백업 가져오기)에만 씁니다.
 */
async function directReads(dir, pattern, skip = []) {
  const found = [];
  for (const file of await readdir(path.join(root, dir))) {
    if (skip.includes(file)) continue;
    const lines = (await readFile(path.join(root, dir, file), 'utf8')).split('\n');
    lines.forEach((line, i) => { if (pattern.test(line)) found.push(`${dir}/${file}:${i + 1}: ${line.trim()}`); });
  }
  return found;
}

test('라우트는 대화·캐릭터·페르소나·로어북·배경을 저장소에서 직접 읽지 않습니다', async () => {
  const direct = /store\.(chats|characters|personas|lorebooks|backgrounds)\.(get|all|has|size)\b|this\.(chats|books)\.(get|all|has|size)\b/;
  assert.deepEqual(await directReads('src/http/routes', direct), []);
});

test('서비스도 Access 를 거쳐 읽습니다', async () => {
  const direct = /store\.(chats|characters|personas|lorebooks|backgrounds)\.(get|all|size)\b|collection\.(get|all|size)\b/;
  assert.deepEqual(await directReads('src/services', direct, ['access.js']), []);
});
