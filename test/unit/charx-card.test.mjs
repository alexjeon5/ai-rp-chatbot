import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFromCharx, buildCharx } from '../../src/charx-card.js';
import { buildCard, buildCardV3, parseCard } from '../../src/character-card.js';
import { CardError } from '../../src/png-card.js';
import { openZip, writeZip } from '../../src/zip.js';
import { cleanLorebook } from '../../src/lorebook.js';

const picture = Buffer.from('profile image');
const emotion = Buffer.from('emotion image');
const card = (assets = []) => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '리아', assets } });
const asset = (type, uri, name = 'main') => ({ type, uri, name, ext: 'png' });
const archive = (raw, files = []) => writeZip([{ name: 'card.json', data: Buffer.from(JSON.stringify(raw)) }, ...files]);

test('CHARX: 두 embedded 철자·대소문자·URL 인코딩과 main 프로필을 읽습니다', () => {
  const raw = card([
    asset('icon', 'embeded://assets/icon/other.png', 'other'),
    asset('emotion', 'EMBEDDED://assets/emotion/%ED%96%89%EB%B3%B5.png', ' 행복 '),
    asset('icon', 'EmBeDeD://./assets\\icon\\main.png'),
    asset('emotion', `data:image/png;base64,${picture.toString('base64')}`, '놀람')
  ]);
  const back = cardFromCharx(archive(raw, [
    { name: 'assets/icon/other.png', data: emotion },
    { name: 'assets/icon/main.png', data: picture, compress: false },
    { name: 'assets/emotion/행복.png', data: emotion }
  ]));
  assert.deepEqual(back.card, raw);
  assert.deepEqual(back.icon, picture);
  assert.deepEqual(back.expressions, [{ label: '행복', data: emotion }, { label: '놀람', data: picture }]);
  assert.deepEqual(back.dropped, []);
});

test('CHARX: main 이 없으면 첫 icon 을 사용합니다', () => {
  const back = cardFromCharx(archive(card([
    asset('icon', `data:image/png;base64,${picture.toString('base64')}`, 'first'),
    asset('icon', `data:image/png;base64,${emotion.toString('base64')}`, 'second')
  ])));
  assert.deepEqual(back.icon, picture);
});

test('CHARX: ccdefault 는 그림·안내가 없고 잘못된 asset 은 무시합니다', () => {
  const back = cardFromCharx(archive(card([
    null, [], 'invalid', 4, asset('icon', 'ccdefault:'), asset('emotion', 'CCDEFAULT:'), asset('background', 'ccdefault:')
  ]), [{ name: 'assets/icon/fallback.png', data: picture }]));
  assert.equal(back.icon, null);
  assert.deepEqual(back.expressions, []);
  assert.deepEqual(back.dropped, []);
});

test('CHARX: 외부·빠진 그림·기타 에셋·RisuAI 모듈을 정해진 순서로 안내합니다', () => {
  const back = cardFromCharx(archive(card([
    asset('icon', 'https://example.invalid/main.png'),
    asset('emotion', 'HTTP://example.invalid/happy.png', 'happy'),
    asset('emotion', 'embeded://missing.png', 'missing'),
    asset('emotion', '__asset:1', 'legacy'),
    asset('emotion', 'embeded://bad%ZZ.png', 'bad path'),
    asset('background', 'embeded://background.png'),
    asset('x-risu-asset', 'embeded://audio.mp3')
  ]), [{ name: 'module.risum', data: Buffer.from('binary') }]));
  assert.equal(back.icon, null);
  assert.deepEqual(back.expressions, []);
  assert.deepEqual(back.dropped, ['외부 주소 그림 2개', '읽지 못한 그림 3개', '그 밖의 에셋 2개 (배경·소리 등)', 'RisuAI 모듈(module.risum)']);
});

test('CHARX: icon 항목이 없는 옛 카드의 첫 프로필 그림을 찾습니다', () => {
  const raw = card();
  delete raw.data.assets;
  const back = cardFromCharx(archive(raw, [
    { name: 'assets/icon/readme.txt', data: Buffer.from('ignore') },
    { name: 'assets/icon/image/portrait.JPEG', data: picture },
    { name: 'assets/icon/next.webp', data: emotion }
  ]));
  assert.deepEqual(back.icon, picture);
  assert.deepEqual(back.dropped, []);
  assert.equal(cardFromCharx(archive(card())).icon, null);
});

test('CHARX: ZIP·JSON·card.json 오류는 모두 CardError 입니다', () => {
  assert.throws(() => cardFromCharx(Buffer.from('not a zip')), { name: 'Error', message: 'CHARX(압축) 파일을 열지 못했습니다.' });
  assert.throws(() => cardFromCharx(writeZip([])), /card.json 이 없습니다/);
  for (const json of ['{invalid', 'null', '[]', '1', '"text"']) {
    assert.throws(() => cardFromCharx(writeZip([{ name: 'card.json', data: Buffer.from(json) }])), CardError);
  }
  const corrupt = archive(card());
  const directory = corrupt.readUInt32LE(corrupt.length - 6);
  corrupt.writeUInt32LE(0, directory + 16);
  assert.throws(() => cardFromCharx(corrupt), /card.json 을 읽지 못했습니다/);
  const huge = archive({ note: 'a'.repeat(8 * 1024 * 1024) });
  assert.throws(() => cardFromCharx(huge), CardError);
});

test('CHARX: 큰 그림·깨진 그림을 건너뛰고 다른 그림은 가져옵니다', () => {
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
  const buf = archive(card([
    asset('icon', 'embeded://huge.png'),
    asset('emotion', 'embeded://broken.png', 'broken'),
    asset('emotion', 'embeded://ok.png', 'ok')
  ]), [
    { name: 'huge.png', data: huge },
    { name: 'broken.png', data: picture, compress: false },
    { name: 'ok.png', data: emotion }
  ]);
  const zip = openZip(buf);
  const directory = buf.readUInt32LE(buf.length - 6);
  let at = directory;
  for (const entry of zip.entries) {
    if (entry.name === 'broken.png') buf.writeUInt32LE(0, at + 16);
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  const back = cardFromCharx(buf);
  assert.equal(back.icon, null);
  assert.deepEqual(back.expressions, [{ label: 'ok', data: emotion }]);
  assert.deepEqual(back.dropped, ['읽지 못한 그림 2개']);
});

test('CHARX: V3 → CHARX → parseCard 로 모든 캐릭터 칸·로어북·그림을 왕복합니다', () => {
  const character = {
    name: '유하린', avatar: '🌙', tags: '일상, 학원물', description: '같은 과 선배', appearance: '검은 머리',
    personality: '무심한 척', speech: '짧은 문장', scenario: '옥상', greeting: '*돌아본다.*', exampleDialogue: '{{user}}: 응', notes: '추가 설정'
  };
  const book = cleanLorebook({ name: '학교', description: '학교 배경', entries: [{ title: '옥상', keys: '옥상', content: '밤에만 열림', priority: 70 }] });
  const v3 = buildCardV3(character, [book]);
  assert.equal(v3.spec, 'chara_card_v3');
  assert.equal(v3.spec_version, '3.0');
  assert.deepEqual(v3.data.group_only_greetings, []);
  assert.deepEqual(v3.data.assets, []);
  assert.equal(v3.data.character_book.entries[0].use_regex, false);
  assert.equal(buildCard(character, [book]).data.character_book.entries[0].use_regex, undefined);
  const original = structuredClone(v3);
  const buf = buildCharx(v3, {
    icon: { data: picture, ext: '.PNG' },
    expressions: [{ label: '행복', data: emotion, ext: 'WEBP' }, { label: '../슬픔', data: picture, ext: '!!' }]
  });
  assert.deepEqual(v3, original);
  const zip = openZip(buf);
  assert.deepEqual(zip.entries.map((e) => e.name), ['card.json', 'assets/icon/image/main.png', 'assets/emotion/image/1.webp', 'assets/emotion/image/2.png']);
  assert.deepEqual(zip.entries.slice(1).map((e) => e.method), [0, 0, 0]);
  const back = cardFromCharx(buf);
  const parsed = parseCard(back.card);
  assert.deepEqual(parsed.character, character);
  assert.equal(parsed.book.name, '학교');
  assert.equal(parsed.book.description, '학교 배경');
  assert.equal(parsed.book.entries[0].content, '밤에만 열림');
  assert.equal(parsed.book.entries[0].priority, 70);
  assert.deepEqual(back.icon, picture);
  assert.deepEqual(back.expressions, [{ label: '행복', data: emotion }, { label: '../슬픔', data: picture }]);
  assert.deepEqual(back.dropped, []);
});

test('CHARX: 그림이 없으면 ccdefault 로 내보내고 입력 assets 는 바꾸지 않습니다', () => {
  const v3 = buildCardV3({ name: '그림 없음' });
  v3.data.assets.push(asset('background', 'https://example.invalid/background.png'));
  const before = structuredClone(v3);
  const back = cardFromCharx(buildCharx(v3));
  assert.deepEqual(v3, before);
  assert.deepEqual(back.card.data.assets, [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }]);
  assert.equal(back.icon, null);
  assert.deepEqual(back.dropped, []);
  assert.equal(back.card.data.character_book, undefined);
});
