import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, buildCard } from '../../src/character-card.js';
import { cardFromPng, pngTextChunks, CardError } from '../../src/png-card.js';
import { CharacterCards } from '../../src/services/character-cards.js';
import { cleanLorebook } from '../../src/lorebook.js';

const v2 = (data) => ({ spec: 'chara_card_v2', spec_version: '2.0', data });

/** tEXt/iTXt 조각을 담은 PNG. 읽기 쪽은 CRC 를 보지 않으므로 0 으로 채웁니다. */
function png(...chunks) {
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, body] of [...chunks, ['IEND', Buffer.alloc(0)]]) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    parts.push(head, body, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}
const tEXt = (key, value) => ['tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])];
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

/** 요청한 사람. 서비스는 이 사람이 볼 수 있는 항목만 다룹니다. */
const ME = { id: 'me', name: 'me', role: 'owner' };

test('parseCard: V2 카드를 이 앱의 칸으로 옮기고 <START>·<USER> 를 다듬음', () => {
  const { character, dropped } = parseCard(v2({
    name: '리아', description: '기사단의 <BOT>.', personality: '과묵함', scenario: '성문 앞',
    first_mes: '<USER>, 왔군.', mes_example: '<START>\n{{user}}: 안녕\n{{char}}: 응\n<START>\n{{user}}: 잘 가',
    tags: ['판타지', '기사'], alternate_greetings: ['다른 인사'], creator_notes: '만든이 메모', system_prompt: '항상 존댓말'
  }));
  assert.equal(character.name, '리아');
  assert.equal(character.personality, '기사단의 {{char}}.\n\n과묵함');
  assert.equal(character.greeting, '{{user}}, 왔군.');
  assert.equal(character.exampleDialogue, '{{user}}: 안녕\n{{char}}: 응\n\n{{user}}: 잘 가');
  assert.equal(character.tags, '판타지, 기사');
  assert.equal(character.notes, '항상 존댓말');
  assert.deepEqual(dropped, ['대체 첫 대사 1개', '제작자 메모']);
});

test('parseCard: 1판(납작한 JSON)도 읽고, 카드가 아니면 CardError', () => {
  assert.equal(parseCard({ name: '옛 카드', description: '설명', first_mes: '안녕' }).character.greeting, '안녕');
  assert.throws(() => parseCard({ foo: 1 }), CardError);
  assert.throws(() => parseCard([]), CardError);
  assert.throws(() => parseCard(v2({ name: '  ' })), /이름/);
});

test('parseCard: character_book 을 로어북 모양으로', () => {
  const { book } = parseCard(v2({
    name: '리아',
    character_book: { entries: [
      { keys: ['왕도', '카엘른'], content: '수도', comment: '왕도', priority: 80, selective: true, secondary_keys: ['성벽'] },
      { keys: 'a, b', content: '규칙', constant: true, enabled: false },
      { keys: ['x'], content: '' }
    ] }
  }));
  const clean = cleanLorebook(book);
  assert.equal(clean.name, '리아 세계관');
  assert.equal(clean.entries.length, 2);
  assert.deepEqual([clean.entries[0].title, clean.entries[0].priority, clean.entries[0].secondaryKeys], ['왕도', 80, ['성벽']]);
  assert.deepEqual([clean.entries[1].keys, clean.entries[1].constant, clean.entries[1].enabled], [['a', 'b'], true, false]);
  assert.equal(parseCard(v2({ name: 'x', character_book: { entries: [] } })).book, null);
});

test('buildCard → parseCard: 이 앱에서 낸 카드는 칸이 그대로 돌아옴', () => {
  const mine = {
    id: 'c1', name: '유하린', avatar: '🌙', tags: '일상, 학원물', description: '같은 과 선배', appearance: '1girl, black hair',
    personality: '무심한 척', speech: '짧은 문장', scenario: '옥상', greeting: '*돌아본다.*', exampleDialogue: '{{user}}: 응', notes: '금기 없음'
  };
  const book = cleanLorebook({ name: '학교', entries: [{ title: '옥상', keys: '옥상', content: '밤에만 열림', priority: 70 }] });
  const card = buildCard(mine, [book]);
  assert.equal(card.spec, 'chara_card_v2');
  assert.match(card.data.description, /무심한 척\n\n말투: 짧은 문장\n\n외형: 1girl, black hair\n\n추가 설정: 금기 없음/);
  assert.equal(card.data.creator_notes, '같은 과 선배');
  assert.deepEqual(card.data.tags, ['일상', '학원물']);
  assert.equal(card.data.character_book.name, '학교');

  const back = parseCard(JSON.parse(JSON.stringify(card)));
  const { id, ...fields } = mine;
  assert.deepEqual(back.character, fields);
  assert.equal(cleanLorebook(back.book).entries[0].priority, 70);
  assert.equal(buildCard(mine, []).data.character_book, undefined);
});

test('PNG 카드: ccv3 를 chara 보다 먼저 쓰고, 없거나 깨지면 CardError', () => {
  const both = png(tEXt('chara', b64({ name: 'old' })), tEXt('ccv3', b64({ spec: 'chara_card_v3', data: { name: 'new' } })));
  assert.equal(cardFromPng(both).data.name, 'new');
  assert.equal(cardFromPng(png(tEXt('chara', b64({ name: '한글 이름' })))).name, '한글 이름');
  assert.deepEqual(Object.keys(pngTextChunks(both)), ['chara', 'ccv3']);
  assert.throws(() => cardFromPng(png()), /카드 정보가 들어 있지 않습니다/);
  assert.throws(() => cardFromPng(png(tEXt('chara', '@@@'))), CardError);
  assert.throws(() => pngTextChunks(Buffer.from('not a png at all')), /PNG 파일이 아닙니다/);
});

test('PNG 카드: iTXt 도 읽음', () => {
  const body = Buffer.concat([Buffer.from('chara\0\0\0\0\0', 'latin1'), Buffer.from(b64({ name: '아이텍스트' }), 'utf8')]);
  assert.equal(cardFromPng(png(['iTXt', body])).name, '아이텍스트');
});

function fakeStore() {
  const table = () => {
    const items = [];
    // 테스트의 항목은 모두 ME 의 것입니다.
    return { items, add: (o) => { const it = { id: `id${items.length + 1}`, ownerId: 'me', ...o }; items.push(it); return it; },
      get: (id) => items.find((i) => i.id === id), all: () => items, get size() { return items.length; } };
  };
  return { characters: table(), lorebooks: table() };
}

test('CharacterCards.import: 캐릭터를 만들고 세계관은 그 캐릭터에 묶인 로어북으로', async () => {
  const store = fakeStore();
  const cards = new CharacterCards(store, { setPortrait: async (actor, id) => store.characters.get(id) });
  const card = v2({ name: '리아', character_book: { name: '왕국', entries: [{ keys: ['왕도'], content: '수도' }] } });
  const out = await cards.import(ME, { png: png(tEXt('chara', b64(card))).toString('base64') });
  assert.equal(out.character.name, '리아');
  assert.equal(out.lorebook.name, '왕국');
  assert.deepEqual(out.lorebook.characterIds, [out.character.id]);
  assert.equal(out.lorebook.global, false);
  await assert.rejects(() => cards.import(ME, {}), /카드 파일이 없습니다/);
  assert.equal((await cards.import(ME, { card: { name: '세계관 없음' } })).lorebook, null);
});

test('CharacterCards.export: 묶인 로어북만 담고 파일 이름을 안전하게', () => {
  const store = fakeStore();
  const cards = new CharacterCards(store, null);
  const ch = store.characters.add({ name: 'a/b:c', greeting: '안녕' });
  store.lorebooks.add({ name: '묶임', characterIds: [ch.id], ...cleanLorebook({ entries: [{ keys: 'k', content: 'v' }] }) });
  store.lorebooks.add({ name: '남의 책', characterIds: ['other'], ...cleanLorebook({ entries: [{ keys: 'k', content: 'v' }] }) });
  const out = cards.export(ME, ch.id);
  assert.equal(out.filename, 'a_b_c.json');
  assert.equal(out.card.data.character_book.name, '묶임');
  assert.throws(() => cards.export(ME, 'none'), /없는 캐릭터/);
});
