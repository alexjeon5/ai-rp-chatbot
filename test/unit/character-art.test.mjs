import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import express from 'express';
import { CharacterArt, ArtError, cleanLabel, ART_LIMITS, cleanAssetName, ASSET_LIMITS } from '../../src/services/character-art.js';
import { CharacterArtRoutes } from '../../src/http/routes/character-art.js';
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
    // 테스트의 항목은 모두 ME 의 것입니다.
    add: (o) => { const it = { id: `c${items.size + 1}`, ownerId: 'me', ...o }; items.set(it.id, it); return it; },
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

test('cleanAssetName: 위험한 글자와 제어 문자를 빼고 공백·길이를 정리하며 확장자는 보존', () => {
  assert.equal(cleanAssetName('  <Neutral>  "1"\'`\u0000\u007f.webp  '), 'Neutral 1.webp');
  assert.equal(cleanAssetName('가'.repeat(100)).length, ASSET_LIMITS.nameChars);
  assert.equal(cleanAssetName(null), '');
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

test('CharacterArt.addAssets: 이름·순서를 보존하고 같은 목록의 중복은 첫 그림만 저장', async (t) => {
  const { store, art, ch, done } = await setup();
  t.after(done);
  const first = pic();
  const second = png(chunk('IDAT', Buffer.from('second')));
  let updates = 0;
  const update = store.characters.update;
  store.characters.update = (id, patch) => { updates++; return update(id, patch); };
  const out = await art.addAssets(ME, ch.id, [
    { name: ' Neutral.1.webp ', data: first },
    { name: 'NEUTRAL.1.WEBP', data: second },
    { name: 'Neutral.1', data: second },
    { name: '웃음', data: first }
  ]);
  assert.deepEqual(out.character.assets.map((asset) => asset.name), ['Neutral.1.webp', 'Neutral.1', '웃음']);
  assert.deepEqual(await readFile(art.path(ch.id, out.character.assets[0].file)), first);
  assert.deepEqual(out.failed, []);
  assert.equal(out.skipped, 0);
  assert.equal(updates, 1);
  assert.deepEqual(await art.addAssets(ME, ch.id, []), { character: out.character, failed: [], skipped: 0 });
  assert.equal(updates, 1);
});

test('CharacterArt.addAssets: 같은 이름을 대소문자 무시해 바꾸고 옛 파일을 지움', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const first = await art.addAssets(ME, ch.id, [{ name: 'Neutral.webp', data: pic() }]);
  const oldFile = first.character.assets[0].file;
  const replacement = png(chunk('IDAT', Buffer.from('replacement')));
  const out = await art.addAssets(ME, ch.id, [{ name: ' neutral.WEBP ', data: replacement }]);
  assert.equal(out.character.assets.length, 1);
  assert.equal(out.character.assets[0].name, 'Neutral.webp');
  assert.notEqual(out.character.assets[0].file, oldFile);
  assert.equal(existsSync(art.path(ch.id, oldFile)), false);
  assert.deepEqual(await readFile(art.path(ch.id, out.character.assets[0].file)), replacement);
});

test('CharacterArt.addAssets: 빈 이름·그림 아닌 파일·8MB 초과는 failed 에 담고 다음 그림은 저장', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const out = await art.addAssets(ME, ch.id, [
    { name: '<>', data: pic() },
    { name: '깨짐', data: Buffer.from('not an image') },
    { name: '깨짐', data: pic() },
    { name: '너무 큼', data: Buffer.alloc(ART_LIMITS.bytes + 1) },
    { name: '빈 그림', data: null },
    { name: '정상', data: pic() }
  ]);
  assert.deepEqual(out.character.assets.map((asset) => asset.name), ['정상']);
  assert.deepEqual(out.failed.map((failure) => failure.name), ['<>', '깨짐', '너무 큼', '빈 그림']);
  assert.equal(out.failed[0].message, '이름이 없습니다.');
  assert.match(out.failed[1].message, /PNG·JPEG·WebP/);
  assert.match(out.failed[2].message, /8MB/);
  assert.match(out.failed[3].message, /비어 있습니다/);
  assert.equal(out.skipped, 0);
});

test('CharacterArt.addAssets: 개수 한도에서는 새 이름을 건너뛰고 기존 이름은 교체', async (t) => {
  const { store, art, ch, done } = await setup();
  t.after(done);
  const assets = Array.from({ length: ASSET_LIMITS.count }, (_, i) => ({ name: `image${i}`, file: `missing${i}.png` }));
  store.characters.update(ch.id, { assets });
  const out = await art.addAssets(ME, ch.id, [
    { name: '추가', data: pic() },
    { name: '추가', data: pic() },
    { name: 'IMAGE0', data: pic() }
  ]);
  assert.equal(out.character.assets.length, ASSET_LIMITS.count);
  assert.equal(out.character.assets[0].name, 'image0');
  assert.ok(existsSync(art.path(ch.id, out.character.assets[0].file)));
  assert.equal(out.skipped, 1);
  assert.deepEqual(out.failed, []);
});

test('CharacterArt.addAssets: 이번 저장의 누적 바이트 한도를 넘으면 이후 그림도 건너뜀', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const large = Buffer.alloc(ART_LIMITS.bytes);
  let saved = 0;
  art.keep = async (_id, data) => {
    if (!Buffer.isBuffer(data)) throw new ArtError('그림 파일이 비어 있습니다.');
    return `saved${++saved}.png`;
  };
  const fitting = ASSET_LIMITS.totalBytes / large.length;
  const out = await art.addAssets(ME, ch.id, [
    { name: '실패', data: null },
    ...Array.from({ length: fitting }, (_, i) => ({ name: `large${i}`, data: large })),
    { name: '초과', data: pic() },
    { name: '이후', data: pic() }
  ]);
  assert.equal(saved, fitting);
  assert.equal(out.character.assets.length, fitting);
  assert.equal(out.failed.length, 1);
  assert.equal(out.skipped, 2);
});

test('CharacterArt.addAssets: 저장소의 예상하지 못한 오류는 그대로 던짐', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const error = new Error('storage unavailable');
  art.keep = async () => { throw error; };
  await assert.rejects(() => art.addAssets(ME, ch.id, [{ name: '그림', data: pic() }]), (err) => err === error);
});

test('CharacterArt.removeAsset: 정확한 이름만 삭제하고 파일도 지우며 없는 이름은 404', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const { character } = await art.addAssets(ME, ch.id, [{ name: 'Neutral.webp', data: pic() }]);
  const file = character.assets[0].file;
  await assert.rejects(() => art.removeAsset(ME, ch.id, 'Neutral'), (err) => err instanceof ArtError && err.status === 404);
  const out = await art.removeAsset(ME, ch.id, ' neutral.WEBP ');
  assert.deepEqual(out.assets, []);
  assert.equal(existsSync(art.path(ch.id, file)), false);
  await assert.rejects(() => art.removeAsset(ME, ch.id, '없음'), (err) => err instanceof ArtError && err.status === 404);
  await assert.rejects(() => art.addAssets({ id: 'someone' }, ch.id, []), (err) => err.status === 404);
  await assert.rejects(() => art.removeAsset({ id: 'someone' }, ch.id, '없음'), (err) => err.status === 404);
});

test('CharacterArt HTTP: 쿼리의 에셋 이름으로 파일을 삭제하고 없으면 404', async (t) => {
  const { art, ch, done } = await setup();
  t.after(done);
  const { character } = await art.addAssets(ME, ch.id, [{ name: '웃음.webp', data: pic() }]);
  const file = character.assets[0].file;
  const app = express();
  app.use((req, res, next) => { req.user = ME; next(); });
  new CharacterArtRoutes({ art }).mount(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = await fetch(`${base}/api/character-art/${ch.id}/${file}`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), pic());
  const url = `${base}/api/characters/${ch.id}/assets?name=${encodeURIComponent('웃음.webp')}`;
  const removed = await fetch(url, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).assets, []);
  assert.equal(existsSync(art.path(ch.id, file)), false);
  const missing = await fetch(url, { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, '없는 에셋 그림입니다.');
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
