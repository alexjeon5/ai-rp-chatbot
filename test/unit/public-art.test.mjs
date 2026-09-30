import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicArt } from '../../src/services/public-art.js';

function setup(baseUrl = 'https://rp.example/') {
  const characters = new Map([['c1', { id: 'c1', portrait: 'p1.png', expressions: [{ label: '기쁨', file: 'e1.png' }] }]]);
  const store = { characters: { get: (id) => characters.get(id) || null }, discordDoc: { data: {}, save() {} } };
  const art = { isSafe: (id, file) => /^\w+$/.test(id) && /^\w+\.png$/.test(file), path: (id, file) => `/data/portraits/${id}/${file}` };
  return { pub: new PublicArt({ store, art, baseUrl }), characters, store };
}

test('서명된 주소만 그림을 줌: 서명이 틀리거나, 지금 쓰는 그림이 아니거나, 이상한 이름이면 없음', () => {
  const { pub, characters, store } = setup();
  const url = new URL(pub.portraitUrl(characters.get('c1')));
  assert.equal(url.origin + url.pathname, 'https://rp.example/pub/art/c1/p1.png');
  const sig = url.searchParams.get('s');
  assert.equal(pub.pathFor('c1', 'p1.png', sig), '/data/portraits/c1/p1.png');
  assert.equal(pub.pathFor('c1', 'p1.png', `${sig.slice(0, -1)}A`), null, '서명이 틀림');
  assert.equal(pub.pathFor('c1', 'e1.png', sig), null, '다른 파일의 서명');
  assert.equal(pub.pathFor('c1', 'p1.png', ''), null);
  assert.ok(pub.expressionUrl(characters.get('c1'), '기쁨').includes('/e1.png?s='));
  assert.equal(pub.expressionUrl(characters.get('c1'), '슬픔'), null);

  // 그림을 바꾸면 옛 주소는 죽습니다.
  characters.get('c1').portrait = 'p2.png';
  assert.equal(pub.pathFor('c1', 'p1.png', sig), null);
  assert.ok(store.discordDoc.data.artSecret, '비밀은 한 번 만들어 둠');
});

test('PUBLIC_BASE_URL 이 없으면 주소를 만들지 않음, 비밀이 다르면 서명도 다름', () => {
  const { pub, characters } = setup('');
  assert.equal(pub.portraitUrl(characters.get('c1')), null);
  assert.equal(pub.portraitUrl({ id: null, portrait: 'p1.png' }), null);
  const a = new PublicArt({ store: setup().store, art: {}, baseUrl: 'x', secret: 'one' });
  const b = new PublicArt({ store: setup().store, art: {}, baseUrl: 'x', secret: 'two' });
  assert.notEqual(a.sign('c1', 'p1.png'), b.sign('c1', 'p1.png'));
});
