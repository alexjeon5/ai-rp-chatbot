import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Backgrounds, BACKGROUND_LIMIT } from '../../src/services/backgrounds.js';
import { ArtError } from '../../src/services/character-art.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([SIG, Buffer.alloc(24)]);

function fakeStore() {
  const items = new Map();
  let n = 0;
  return {
    backgrounds: {
      get size() { return items.size; },
      all: () => [...items.values()],
      get: (id) => items.get(id) || null,
      add: (o) => { const it = { id: `b${++n}`, ...o }; items.set(it.id, it); return it; },
      update: (id, patch) => Object.assign(items.get(id), patch),
      remove: async (id) => { items.delete(id); }
    }
  };
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bg-'));
  return { dir, bg: new Backgrounds(fakeStore(), dir), done: () => rm(dir, { recursive: true, force: true }) };
}

/** 요청한 사람. 서비스는 이 사람이 볼 수 있는 항목만 다룹니다. */
const ME = { id: 'me', name: 'me', role: 'owner' };

test('배경: 올리기·이름 목록·같은 이름은 그림만 교체', async () => {
  const { bg, done } = await setup();
  const a = await bg.add(ME, '교실', PNG);
  assert.equal(a.name, '교실');
  assert.ok(existsSync(bg.path(a.id, a.file)));
  const again = await bg.add(ME, ' 교실 ', PNG);
  assert.equal(again.id, a.id);
  assert.deepEqual(bg.names(ME), ['교실']);
  await done();
});

test('배경: 이름 바꾸기는 중복·빈 이름을 막고, 지우면 파일도 사라진다', async () => {
  const { bg, done } = await setup();
  const a = await bg.add(ME, '교실', PNG);
  const b = await bg.add(ME, '바닷가', PNG);
  assert.throws(() => bg.rename(ME, b.id, '교실'), ArtError);
  assert.throws(() => bg.rename(ME, b.id, ''), ArtError);
  assert.equal(bg.rename(ME, b.id, '해변').name, '해변');
  await bg.remove(ME, a.id);
  assert.equal(existsSync(bg.path(a.id, a.file)), false);
  await assert.rejects(() => bg.remove(ME, a.id), ArtError);
  await done();
});

test('배경: 그림이 아니거나 비었거나 한도를 넘으면 거절', async () => {
  const { bg, done } = await setup();
  await assert.rejects(() => bg.add(ME, 'x', Buffer.from('not an image')), ArtError);
  await assert.rejects(() => bg.add(ME, 'x', Buffer.alloc(0)), ArtError);
  await assert.rejects(() => bg.add(ME, '', PNG), ArtError);
  for (let i = 0; i < BACKGROUND_LIMIT; i++) await bg.add(ME, `장소${i}`, PNG);
  await assert.rejects(() => bg.add(ME, '하나 더', PNG), /30개/);
  await bg.add(ME, '장소0', PNG);
  await done();
});
