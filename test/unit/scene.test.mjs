import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDirectives, stripForDisplay, matchLabel, parseCheck, resolveScene, sceneTags } from '../../public/js/shared/scene-tags.js';
import { sceneBlock } from '../../src/scene-prompt.js';
import { GenerationRoutes } from '../../src/http/routes/generation.js';
import { showSwipe, branchFrom } from '../../src/chat-ops.js';

test('extractDirectives: 표식을 뽑고 본문에서 지우며, 같은 표식은 마지막이 이김', () => {
  const out = extractDirectives('[[표정: 기쁨]] [[장소: 교실]]\n안녕 *웃는다*\n[[표정: 슬픔]]');
  assert.equal(out.expression, '슬픔');
  assert.equal(out.place, '교실');
  assert.equal(out.text, '안녕 *웃는다*\n');
  assert.deepEqual(extractDirectives('그냥 글'), { text: '그냥 글' });
  assert.deepEqual(extractDirectives('[[판정: 설득 d20 난이도 15]]\n말한다').check, { label: '설득', sides: 20, dc: 15 });
});

test('parseCheck: 이름·면 수·난이도를 읽고 이상한 값은 버림', () => {
  assert.deepEqual(parseCheck('완력 D6 4'), { label: '완력', sides: 6, dc: 4 });
  assert.equal(parseCheck('설득'), null);
  assert.equal(parseCheck('d20 15'), null);
  assert.equal(parseCheck('설득 d7 3'), null);
  assert.equal(parseCheck('설득 d20 999'), null);
});

test('stripForDisplay: 쓰는 도중 닫히지 않은 표식도 감춤', () => {
  assert.equal(stripForDisplay('[[표정: 기쁨]]\n안녕'), '안녕');
  assert.equal(stripForDisplay('안녕 [[장소: 교'), '안녕 ');
  assert.equal(stripForDisplay('안녕 ['), '안녕 ');
  assert.equal(stripForDisplay('배열 [1, 2] 입니다'), '배열 [1, 2] 입니다');
});

test('matchLabel: 같은 이름 → 서로 포함 → 없음, 대소문자 무시', () => {
  assert.equal(matchLabel('Happy', ['happy', '슬픔']), 'happy');
  assert.equal(matchLabel('부끄', ['기본', '부끄러움']), '부끄러움');
  assert.equal(matchLabel('완전히 부끄러움', ['부끄러움']), '부끄러움');
  assert.equal(matchLabel('분노', ['기쁨']), null);
  assert.equal(matchLabel('', ['기쁨']), null);
});

test('resolveScene·sceneTags: 준비된 이름과 맞는 것만 남기고, 프롬프트용 표식으로 되돌림', () => {
  const scene = resolveScene({ expression: '기쁨!', place: '숲' }, { expressions: ['기쁨', '슬픔'], places: ['교실'] });
  assert.deepEqual(scene, { expression: '기쁨' });
  assert.equal(resolveScene({ expression: 'x' }, { expressions: ['기쁨'], places: [] }), null);
  assert.equal(sceneTags({ expression: '기쁨', place: '교실' }), '[[표정: 기쁨]] [[장소: 교실]]');
  assert.equal(sceneTags(undefined), '');
});

test('sceneBlock: 고를 이름이 있는 표식만 요청하고, 아무것도 없으면 빈 글', () => {
  assert.equal(sceneBlock({ name: '리아' }), '');
  const both = sceneBlock({ name: '리아', expressions: ['기본', '기쁨'], places: ['교실'] });
  assert.match(both, /\[\[표정: 이름\]\].*기본, 기쁨/);
  assert.match(both, /\[\[장소: 이름\]\].*교실/);
  assert.match(both, /예\) \[\[표정: 기본\]\] \[\[장소: 교실\]\]/);
  assert.doesNotMatch(sceneBlock({ name: '리아', expressions: ['기본'] }), /장소/);
});

const routes = () => new GenerationRoutes({ store: { chats: { save() {} } } });
const names = { expressions: ['기본', '기쁨'], places: ['교실'] };

test('saveReply: 표식을 떼어 msg.scene 에 두고, 다른 버전(swipe)마다 따로 가짐', () => {
  const chat = { id: 'c', messages: [] };
  const g = routes();
  const first = g.saveReply(chat, { mode: 'new', text: '[[표정: 기쁨]] [[장소: 교실]]\n안녕', thought: '', sources: [], provider: 'p', config: { model: 'm' }, names });
  assert.equal(first.content, '안녕');
  assert.deepEqual(first.scene, { expression: '기쁨', place: '교실' });

  const again = g.saveReply(chat, { mode: 'regenerate', target: first, text: '[[표정: 기본]]\n다시', thought: '', sources: [], provider: 'p', config: { model: 'm' }, names });
  assert.equal(again.content, '다시');
  assert.deepEqual(again.scene, { expression: '기본' });
  showSwipe(again, 0);
  assert.deepEqual(again.scene, { expression: '기쁨', place: '교실' });
  showSwipe(again, 1);
  assert.deepEqual(again.scene, { expression: '기본' });
});

test('saveReply: 표식만 있는 답변은 저장하지 않고, 표식이 꺼진 대화는 글을 그대로 둠', () => {
  const chat = { id: 'c', messages: [] };
  const g = routes();
  assert.equal(g.saveReply(chat, { mode: 'new', text: '[[표정: 기쁨]]', thought: '', sources: [], config: {}, names }), null);
  assert.equal(chat.messages.length, 0);
  const plain = g.saveReply(chat, { mode: 'new', text: '[[표정: 기쁨]] 글', thought: '', sources: [], config: {} });
  assert.equal(plain.content, '[[표정: 기쁨]] 글');
  assert.equal(plain.scene, undefined);
});

test('saveReply: 이어쓰기에서 새로 나온 표식은 기존 장면에 합쳐짐', () => {
  const chat = { id: 'c', messages: [] };
  const g = routes();
  const msg = g.saveReply(chat, { mode: 'new', text: '[[장소: 교실]]\n시작', thought: '', sources: [], config: {}, names });
  g.saveReply(chat, { mode: 'continue', target: msg, text: ' 이어서 [[표정: 기쁨]]', thought: '', sources: [], config: {}, names });
  assert.deepEqual(msg.scene, { place: '교실', expression: '기쁨' });
  assert.ok(!msg.content.includes('[['));
});

test('withSceneTags: 지난 답변 앞에 표식을 되살려 붙임', () => {
  const chat = { messages: [{ id: 'a', role: 'user' }, { id: 'b', role: 'assistant', scene: { expression: '기쁨' } }, { id: 'c', role: 'assistant' }] };
  const out = routes().withSceneTags(
    [{ role: 'user', content: '안녕' }, { role: 'assistant', content: '응' }, { role: 'assistant', content: '음' }], ['a', 'b', 'c'], chat);
  assert.deepEqual(out.map((t) => t.content), ['안녕', '[[표정: 기쁨]]\n응', '음']);
});

test('withSceneTags: 판정 요청은 답변 끝에 표식으로 되살림', () => {
  const chat = { messages: [{ id: 'b', role: 'assistant', check: { label: '설득', sides: 20, dc: 14 } }] };
  const out = routes().withSceneTags([{ role: 'assistant', content: '노려본다.' }], ['b'], chat);
  assert.equal(out[0].content, '노려본다.\n[[판정: 설득 d20 난이도 14]]');
});

test('branchFrom: 화면 표식 스위치도 분기 대화에 이어짐', () => {
  const chat = { id: 'x', title: 't', vn: true, dice: true, messages: [{ id: 'm1', role: 'user', content: 'a', at: 1 }] };
  const { chat: branch } = branchFrom(chat, 'm1');
  assert.equal(branch.vn, true);
  assert.equal(branch.dice, true);
  assert.equal(branch.autoChoices, undefined);
});
