import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import express from 'express';
import { writeZip } from '../../src/zip.js';
import { cardFromCharx } from '../../src/charx-card.js';
import { CardError } from '../../src/png-card.js';
import { CharacterCards } from '../../src/services/character-cards.js';
import { CharacterArt, ART_LIMITS } from '../../src/services/character-art.js';
import { NotFound } from '../../src/services/errors.js';
import { CharacterCardRoutes } from '../../src/http/routes/character-cards.js';

const ME = { id: 'me', name: 'me', role: 'owner' };
// 1×1 PNG 파일입니다. 실제 그림 서비스의 형식 검사와 파일 저장을 거칩니다.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');

function fakeStore() {
  const table = (prefix) => {
    const items = new Map();
    return {
      all: () => [...items.values()],
      get: (id) => items.get(id) || null,
      get size() { return items.size; },
      add: (value) => {
        const item = { id: `${prefix}${items.size + 1}`, ...value };
        items.set(item.id, item);
        return item;
      },
      update: (id, patch) => {
        const item = items.get(id);
        if (!item) return null;
        const next = { ...item, ...patch };
        items.set(id, next);
        return next;
      }
    };
  };
  return { characters: table('character'), lorebooks: table('book') };
}

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'charx-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = fakeStore();
  const art = new CharacterArt(store, dir);
  return { store, art, cards: new CharacterCards(store, art) };
}

/** 다른 앱에서 만든 것처럼 V3 카드와 ZIP 내부 그림 참조를 직접 만듭니다. */
function archive({ name = '리아', expressions = ['기쁨', '슬픔'], icon = PNG, data = {}, extraAssets = [], extraFiles = [], assetPictures = [] } = {}) {
  const assets = [...extraAssets];
  const files = [...extraFiles];
  if (icon !== null) {
    const file = 'assets/icon/image/main.png';
    assets.push({ type: 'icon', uri: `embeded://${file}`, name: 'main', ext: 'png' });
    files.push({ name: file, data: icon, compress: false });
  }
  expressions.forEach((expression, i) => {
    const label = typeof expression === 'string' ? expression : expression.label;
    const bytes = typeof expression === 'string' ? PNG : expression.data;
    const file = `assets/emotion/image/expression-${i}.png`;
    assets.push({ type: 'emotion', uri: `embeded://${file}`, name: label, ext: 'png' });
    files.push({ name: file, data: bytes });
  });
  assetPictures.forEach((picture, i) => {
    const name = typeof picture === 'string' ? picture : picture.name;
    const bytes = typeof picture === 'string' ? PNG : picture.data;
    const file = `assets/other/image/${i + 1}.png`;
    assets.push({ type: 'x-risu-asset', uri: `embeded://${file}`, name, ext: 'png' });
    files.push({ name: file, data: bytes });
  });
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name, first_mes: '안녕', ...data, assets } };
  return writeZip([{ name: 'card.json', data: Buffer.from(JSON.stringify(card)) }, ...files]);
}

test('CHARX import: 프로필·표정 2개와 캐릭터에 묶인 세계관을 저장합니다', async (t) => {
  const { store, art, cards } = await setup(t);
  const zip = archive({ data: {
    character_book: { name: '왕국', entries: [{ keys: ['왕도'], content: '수도' }] }
  } });
  const out = await cards.import(ME, { charx: zip.toString('base64') });
  assert.equal(out.character.name, '리아');
  assert.equal(out.character.ownerId, ME.id);
  assert.match(out.character.portrait, /\.png$/);
  assert.deepEqual(out.character.expressions.map((e) => e.label), ['기쁨', '슬픔']);
  for (const file of [out.character.portrait, ...out.character.expressions.map((e) => e.file)]) {
    assert.deepEqual(await readFile(art.path(out.character.id, file)), PNG);
  }
  assert.equal(store.characters.get(out.character.id), out.character);
  assert.equal(store.lorebooks.size, 1);
  assert.equal(out.lorebook.name, '왕국');
  assert.equal(out.lorebook.ownerId, ME.id);
  assert.equal(out.lorebook.global, false);
  assert.deepEqual(out.lorebook.characterIds, [out.character.id]);
  assert.equal(out.lorebook.entries[0].content, '수도');
  assert.deepEqual(out.dropped, []);
  assert.ok(Array.isArray(out.notices));
});

test('CHARX import/export: 에셋 그림 이름·바이트를 보존하고 소리는 dropped 로 안내', async (t) => {
  const { store, art, cards } = await setup(t);
  const names = ['Neutral.1.webp', '웃음'];
  const zip = archive({ expressions: [], assetPictures: names,
    extraAssets: [{ type: 'x-risu-asset', uri: 'embeded://assets/other/audio/theme.mp3', name: 'theme', ext: 'mp3' }],
    extraFiles: [{ name: 'assets/other/audio/theme.mp3', data: Buffer.from('ID3 music') }]
  });
  const out = await cards.import(ME, { charx: zip.toString('base64') });
  assert.deepEqual(out.character.assets.map((asset) => asset.name), names);
  for (const { file } of out.character.assets) {
    assert.deepEqual(await readFile(art.path(out.character.id, file)), PNG);
    assert.equal(art.canServe(ME, out.character.id, file), true);
    assert.equal(art.canServe({ id: 'someone' }, out.character.id, file), false);
  }
  assert.equal(store.characters.get(out.character.id), out.character);
  assert.ok(out.dropped.some((message) => /소리/.test(message)));
  assert.ok(Array.isArray(out.notices));
  assert.ok(out.notices.includes('에셋 그림 2개'));

  const exported = await cards.exportCharx(ME, out.character.id);
  const extracted = cardFromCharx(exported.data);
  assert.deepEqual(extracted.assets, names.map((name) => ({ name, data: PNG })));
  assert.deepEqual(extracted.card.data.assets.filter((asset) => asset.type === 'x-risu-asset').map((asset) => asset.name), names);
  const restored = await cards.import(ME, { charx: exported.data.toString('base64') });
  assert.deepEqual(restored.character.assets.map((asset) => asset.name), names);
  for (const { file } of restored.character.assets) {
    assert.deepEqual(await readFile(art.path(restored.character.id, file)), PNG);
  }
  assert.deepEqual(restored.dropped, []);
  assert.ok(restored.notices.includes('에셋 그림 2개'));
});

test('CHARX import: 에셋 중복은 첫 그림만 담고 저장된 개수로 안내', async (t) => {
  const { cards } = await setup(t);
  const out = await cards.import(ME, { charx: archive({ expressions: [], assetPictures: ['Neutral.webp', 'NEUTRAL.WEBP', 'Neutral'] }).toString('base64') });
  assert.deepEqual(out.character.assets.map((asset) => asset.name), ['Neutral.webp', 'Neutral']);
  assert.ok(out.notices.includes('에셋 그림 2개'));
  assert.deepEqual(out.dropped, []);
});

test('CHARX import: 에셋 실패는 다섯 개까지 자세히 쓰고 나머지와 한도 초과는 합쳐 안내', async (t) => {
  const { store, art, cards } = await setup(t);
  art.addAssets = async (_actor, id, list) => {
    assert.equal(list.length, 1);
    return {
      character: store.characters.update(id, { assets: [] }),
      failed: Array.from({ length: 7 }, (_, i) => ({ name: `asset${i}`, message: '읽지 못함' })),
      skipped: 3
    };
  };
  const out = await cards.import(ME, { charx: archive({ expressions: [], assetPictures: ['Neutral'] }).toString('base64') });
  assert.deepEqual(out.dropped, [
    ...Array.from({ length: 5 }, (_, i) => `에셋 그림 'asset${i}' (읽지 못함)`),
    '에셋 그림 2개 더 (읽지 못함)', '에셋 그림 3개 (한도 초과)'
  ]);
  assert.ok(out.notices.includes('에셋 그림 0개'));
});

test('CHARX import: 잘못된 프로필·표정 그림은 안내하고 다음 표정은 저장합니다', async (t) => {
  const { cards } = await setup(t);
  const zip = archive({ icon: Buffer.from('not an image'), expressions: [
    { label: '깨짐', data: Buffer.from('not an image') }, '기쁨'
  ] });
  const out = await cards.import(ME, { charx: zip.toString('base64') });
  assert.equal(out.character.name, '리아');
  assert.ok(!out.character.portrait);
  assert.deepEqual(out.character.expressions.map((e) => e.label), ['기쁨']);
  assert.ok(out.dropped.some((message) => message.startsWith('프로필 그림 (')));
  assert.ok(out.dropped.some((message) => message.startsWith("표정 '깨짐' (")));
});

test('CHARX import: 표정 17개 중 한도까지 저장하고 빠진 개수를 안내합니다', async (t) => {
  const { cards } = await setup(t);
  const labels = Array.from({ length: ART_LIMITS.expressions + 1 }, (_, i) => `표정${i}`);
  const out = await cards.import(ME, { charx: archive({ expressions: labels }).toString('base64') });
  assert.deepEqual(out.character.expressions.map((e) => e.label), labels.slice(0, ART_LIMITS.expressions));
  assert.ok(out.dropped.includes(`표정 그림 1개 (최대 ${ART_LIMITS.expressions}개)`));
});

test('CHARX import: 카드와 압축 파일의 dropped 안내를 순서대로 합칩니다', async (t) => {
  const { cards } = await setup(t);
  const zip = archive({ expressions: [], data: { alternate_greetings: ['다른 인사'] },
    extraAssets: [{ type: 'background', uri: 'https://example.com/background.png', name: '배경', ext: 'png' }] });
  const extracted = cardFromCharx(zip);
  assert.ok(extracted.dropped.length > 0);
  const out = await cards.import(ME, { charx: zip.toString('base64') });
  assert.deepEqual(out.dropped, ['대체 첫 대사 1개', ...extracted.dropped]);
});

test('CHARX import: ZIP 아닌 입력은 CardError 이고 캐릭터를 만들지 않습니다', async (t) => {
  const { store, cards } = await setup(t);
  await assert.rejects(() => cards.import(ME, { charx: Buffer.from('not a zip').toString('base64') }), CardError);
  assert.equal(store.characters.size, 0);
});

test('CHARX export: 이름·세계관·프로필·표정 그림이 다시 열립니다', async (t) => {
  const { store, cards } = await setup(t);
  const imported = await cards.import(ME, { charx: archive({ name: '리아/기사', data: {
    character_book: { name: '왕국', entries: [{ keys: ['왕도'], content: '수도' }] }
  } }).toString('base64') });
  store.lorebooks.add({ ownerId: 'someone', name: '남의 책', characterIds: [imported.character.id], entries: [{ keys: ['비밀'], content: '숨김' }] });
  store.lorebooks.add({ ownerId: ME.id, name: '다른 캐릭터 책', characterIds: ['other'], entries: [{ keys: ['다른'], content: '숨김' }] });
  const out = await cards.exportCharx(ME, imported.character.id);
  assert.equal(out.filename, '리아_기사.charx');
  assert.ok(Buffer.isBuffer(out.data));
  const back = cardFromCharx(out.data);
  assert.equal(back.card.spec, 'chara_card_v3');
  assert.equal(back.card.spec_version, '3.0');
  assert.equal(back.card.data.name, '리아/기사');
  assert.equal(back.card.data.character_book.name, '왕국');
  assert.equal(back.card.data.character_book.entries.length, 1);
  assert.deepEqual(back.icon, PNG);
  assert.deepEqual(back.expressions, [{ label: '기쁨', data: PNG }, { label: '슬픔', data: PNG }]);
  const restored = await cards.import(ME, { charx: out.data.toString('base64') });
  assert.equal(restored.character.name, imported.character.name);
  assert.equal(restored.character.expressions.length, 2);
  assert.equal(restored.lorebook.entries[0].content, '수도');
  await assert.rejects(() => cards.exportCharx(ME, 'missing'), NotFound);
  await assert.rejects(() => cards.exportCharx({ id: 'someone' }, imported.character.id), NotFound);
});

test('CHARX export: 없거나 안전하지 않은 그림은 건너뜁니다', async (t) => {
  const { store, art, cards } = await setup(t);
  const { character } = await cards.import(ME, { charx: archive({ assetPictures: ['Neutral', '웃음'] }).toString('base64') });
  await unlink(art.path(character.id, character.portrait));
  await unlink(art.path(character.id, character.expressions[0].file));
  await unlink(art.path(character.id, character.assets.find((asset) => asset.name === 'Neutral').file));
  store.characters.update(character.id, {
    expressions: [...character.expressions, { label: '위험', file: '../../outside.png' }],
    assets: [...character.assets, { name: '위험', file: '../../outside.png' }]
  });
  const originalPath = art.path.bind(art);
  art.path = (id, file) => {
    assert.ok(art.isSafe(id, file), '안전하지 않은 파일의 경로를 만들지 않습니다');
    return originalPath(id, file);
  };
  const out = cardFromCharx((await cards.exportCharx(ME, character.id)).data);
  assert.equal(out.icon, null);
  assert.deepEqual(out.expressions, [{ label: '슬픔', data: PNG }]);
  assert.deepEqual(out.assets.filter((asset) => asset.name === '웃음'), [{ name: '웃음', data: PNG }]);
  assert.ok(!out.assets.some((asset) => ['Neutral', '위험'].includes(asset.name)));
});

test('CHARX import: 그림 저장의 예상하지 못한 오류는 그대로 던집니다', async (t) => {
  const { art, cards } = await setup(t);
  const error = new Error('storage unavailable');
  art.setExpression = async () => { throw error; };
  await assert.rejects(() => cards.import(ME, { charx: archive({ icon: null }).toString('base64') }), (err) => err === error);
  art.addAssets = async () => { throw error; };
  await assert.rejects(() => cards.import(ME, { charx: archive({ icon: null, expressions: [], assetPictures: ['Neutral'] }).toString('base64') }), (err) => err === error);
});

test('CHARX HTTP: 가져오기, ZIP 내려받기, JSON 기본 형식과 오류 상태를 처리합니다', async (t) => {
  const { cards } = await setup(t);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = ME; next(); });
  new CharacterCardRoutes({ cards }).mount(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const imported = await fetch(`${base}/api/characters/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ charx: archive().toString('base64') })
  });
  assert.equal(imported.status, 200);
  const { character, lorebook, dropped, notices } = await imported.json();
  assert.equal(character.expressions.length, 2);
  assert.equal(lorebook, null);
  assert.deepEqual(dropped, []);
  assert.ok(Array.isArray(notices));
  const url = `${base}/api/characters/${character.id}/export`;
  const charx = await fetch(`${url}?format=charx`);
  assert.equal(charx.status, 200);
  assert.equal(charx.headers.get('content-type'), 'application/zip');
  assert.equal(charx.headers.get('content-disposition'), `attachment; filename="card.charx"; filename*=UTF-8''${encodeURIComponent('리아.charx')}`);
  const back = cardFromCharx(Buffer.from(await charx.arrayBuffer()));
  assert.equal(back.card.data.name, '리아');
  assert.deepEqual(back.icon, PNG);
  for (const suffix of ['', '?format=unknown']) {
    const json = await fetch(`${url}${suffix}`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /^application\/json/);
    assert.match(json.headers.get('content-disposition'), /filename="card\.json"/);
    assert.equal((await json.json()).spec, 'chara_card_v2');
  }
  const missing = await fetch(`${base}/api/characters/missing/export?format=charx`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, '없는 캐릭터입니다.');
  const invalid = await fetch(`${base}/api/characters/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ charx: Buffer.from('not a zip').toString('base64') })
  });
  assert.equal(invalid.status, 400);
  assert.equal(typeof (await invalid.json()).error, 'string');
});
