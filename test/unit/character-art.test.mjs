import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { CharacterArt, ArtError, cleanLabel, ART_LIMITS } from '../../src/services/character-art.js';
import { CharacterCards } from '../../src/services/character-cards.js';
import { stripCardText, cardFromPng } from '../../src/png-card.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body, Buffer.alloc(4)]);
}
const text = (key, value) => chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
const png = (...chunks) => Buffer.concat([SIG, ...chunks, chunk('IEND', Buffer.alloc(0))]);
const card = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '리아' } })).toString('base64');

function fakeStore() {
  const items = new Map();
  const characters = {
    items,
    all: () => [...items.values()],
    get: (id) => items.get(id) || null,
    add: (o) => { const it = { id: `c${items.size + 1}`, ...o }; items.set(it.id, it); return it; },
    update: (id, patch) => { const it = items.get(id); if (!it) return null; Object.assign(it, patch); return it; }
  };
  return { characters, lorebooks: { size: 0, all: () => [], add: (o) => o } };
}

/** 요청한 사람. 서비스는 이 사람이 볼 수 있는 항목만 다룹니다. */
const ME = { id: 'me', name: 'me', role: 'owner' };

test('stripCardText: 카드 글 조각만 빼고 나머지 조각은 그대로', () => {
  const src = png(chunk('IHDR', Buffer.alloc(13)), text('chara', card), text('ccv3', card), text('Comment', '남김'), chunk('IDAT', Buffer.from('픽셀')));
  const out = stripCardText(src);
  assert.ok(out.length < src.length);
  assert.throws(() => cardFromPng(out));
  assert.ok(out.includes(Buffer.from('Comment')));
  assert.ok(out.includes(Buffer.from('픽셀')));
  assert.ok(out.subarray(-12, -8).equals(Buffer.from([0, 0, 0, 0])) && out.includes(Buffer.from('IEND')));
});

test('stripCardText: PNG 가 아니거나 잘린 파일은 망가뜨리지 않음', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal(stripCardText(jpeg), jpeg);
  const cut = png(text('chara', card)).subarray(0, 30);
  assert.equal(stripCardText(cut).length <= cut.length, true);
});

test('cleanLabel: 표식에 쓰는 글자와 제어 문자를 빼고 길이를 자름', () => {
  assert.equal(cleanLabel(' 기쁨: [웃음]|\n '), '기쁨 웃음'.replace(' ', ' '));
  assert.equal(cleanLabel('가'.repeat(30)).length, ART_LIMITS.labelChars);
  assert.equal(cleanLabel(null), '');
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'art-'));
  const store = fakeStore();
  const art = new CharacterArt(store, dir);
  const ch = store.characters.add({ name: '리아' });
  return { dir, store, art, ch, done: () => rm(dir, { recursive: true, force: true }) };
}
const pic = () => png(chunk('IHDR', Buffer.alloc(13)));

test('CharacterArt: 프로필 그림을 넣고 바꾸면 옛 파일은 지워지고, 지우면 비워짐', async () => {
  const { dir, art, ch, done } = await setup();
  try {
    const a = await art.setPortrait(ME, ch.id, pic());
    assert.match(a.portrait, /\.png$/);
    assert.ok(existsSync(art.path(ch.id, a.portrait)));
    const first = a.portrait;
    const b = await art.setPortrait(ME, ch.id, pic());
    assert.notEqual(b.portrait, first);
    assert.ok(!existsSync(art.path(ch.id, first)));
    assert.equal((await art.clearPortrait(ME, ch.id)).portrait, '');
    assert.deepEqual(await readdir(path.join(dir, ch.id)), []);
  } finally { await done(); }
});

test('CharacterArt: 그림이 아니거나 너무 크면 거절', async () => {
  const { art, ch, done } = await setup();
  try {
    await assert.rejects(() => art.setPortrait(ME, ch.id, Buffer.from('not an image at all')), ArtError);
    await assert.rejects(() => art.setPortrait(ME, ch.id, Buffer.alloc(ART_LIMITS.bytes + 1, 1)), /너무 큽니다/);
    await assert.rejects(() => art.setPortrait(ME, 'nope', pic()), /없는 캐릭터/);
  } finally { await done(); }
});

test('CharacterArt: 표정은 같은 이름이면 그림만 바꾸고, 개수 제한이 있고, 지울 수 있음', async () => {
  const { art, ch, done } = await setup();
  try {
    await art.setExpression(ME, ch.id, '기쁨', pic());
    const again = await art.setExpression(ME, ch.id, ' 기쁨 ', pic());
    assert.equal(again.expressions.length, 1);
    await art.setExpression(ME, ch.id, 'Angry', pic());
    assert.equal((await art.setExpression(ME, ch.id, 'angry', pic())).expressions.length, 2);
    await assert.rejects(() => art.setExpression(ME, ch.id, '[]', pic()), /이름/);
    for (let i = 0; i < ART_LIMITS.expressions; i += 1) {
      await art.setExpression(ME, ch.id, `e${i}`, pic()).catch(() => {});
    }
    assert.equal(ch.expressions.length, ART_LIMITS.expressions);
    await assert.rejects(() => art.setExpression(ME, ch.id, '새 표정', pic()), /까지/);
    assert.equal((await art.removeExpression(ME, ch.id, '기쁨')).expressions.length, ART_LIMITS.expressions - 1);
    await assert.rejects(() => art.removeExpression(ME, ch.id, '없음'), /없는 표정/);
  } finally { await done(); }
});

test('CharacterArt.removeAll: 캐릭터의 그림 폴더를 통째로 지움', async () => {
  const { dir, art, ch, done } = await setup();
  try {
    await art.setPortrait(ME, ch.id, pic());
    await art.removeAll(ch.id);
    assert.ok(!existsSync(path.join(dir, ch.id)));
  } finally { await done(); }
});

test('CharacterCards.import: PNG 카드의 그림이 카드 글 없이 프로필 그림이 됨', async () => {
  const { dir, store, art, done } = await setup();
  try {
    const cards = new CharacterCards(store, art);
    const src = png(chunk('IHDR', Buffer.alloc(13)), text('chara', card));
    const out = await cards.import(ME, { png: src.toString('base64') });
    assert.ok(out.character.portrait);
    const saved = await (await import('node:fs/promises')).readFile(art.path(out.character.id, out.character.portrait));
    assert.throws(() => cardFromPng(saved));
    assert.deepEqual(out.dropped, []);
    const viaClient = await cards.import(ME, { png: src.toString('base64'), portrait: pic().toString('base64') });
    assert.ok(viaClient.character.portrait);
    const bad = await cards.import(ME, { png: src.toString('base64'), portrait: Buffer.from('nope, not an image').toString('base64') });
    assert.ok(!bad.character.portrait);
    assert.match(bad.dropped.join(), /프로필 그림/);
    assert.equal(dir.length > 0, true);
  } finally { await done(); }
});
