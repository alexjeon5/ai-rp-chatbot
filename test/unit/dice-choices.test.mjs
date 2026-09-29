import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation, rollDice, judge, formatRoll, formatCheck, secureInt, MAX_COUNT } from '../../public/js/shared/dice.js';
import { choicesPrompt, parseChoices } from '../../src/choices.js';
import { sceneBlock } from '../../src/scene-prompt.js';
import { checkTag, extractDirectives } from '../../public/js/shared/scene-tags.js';

test('parseNotation: 표기 읽기와 범위 밖 거절', () => {
  assert.deepEqual(parseNotation('2d6+3'), { count: 2, sides: 6, mod: 3 });
  assert.deepEqual(parseNotation(' D20 '), { count: 1, sides: 20, mod: 0 });
  assert.deepEqual(parseNotation('3d8 - 1'), { count: 3, sides: 8, mod: -1 });
  assert.equal(parseNotation('d7'), null);
  assert.equal(parseNotation(`${MAX_COUNT + 1}d6`), null);
  assert.equal(parseNotation('d20+999'), null);
  assert.equal(parseNotation('굴려'), null);
});

test('rollDice: 주입한 난수로 눈과 합을 계산한다', () => {
  const seq = [0, 5, 19];
  const rng = () => seq.shift();
  assert.deepEqual(rollDice({ count: 3, sides: 20, mod: 2 }, rng), { rolls: [1, 6, 20], mod: 2, total: 29 });
});

test('secureInt: 늘 0 이상 n 미만이고 모든 값이 나온다', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const v = secureInt(6);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 6);
    seen.add(v);
  }
  assert.equal(seen.size, 6);
});

test('judge: d20 은 20·1 이 대성공·대실패, 그 밖에는 난이도 이상이 성공', () => {
  assert.equal(judge({ sides: 20, dc: 25 }, 20), '대성공');
  assert.equal(judge({ sides: 20, dc: 1 }, 1), '대실패');
  assert.equal(judge({ sides: 20, dc: 15 }, 15), '성공');
  assert.equal(judge({ sides: 20, dc: 15 }, 14), '실패');
  assert.equal(judge({ sides: 100, dc: 50 }, 1), '실패');
});

test('결과 문장', () => {
  assert.equal(formatRoll({ count: 1, sides: 20 }, { rolls: [14], mod: 0, total: 14 }), '🎲 d20 → 14');
  assert.equal(formatRoll({ count: 2, sides: 6 }, { rolls: [4, 5], mod: 3, total: 12 }), '🎲 2d6+3 → 4 + 5 +3 = 12');
  assert.equal(formatCheck({ label: '설득', sides: 20, dc: 15 }, 17), '🎲 설득 판정 (d20, 난이도 15): 17 — 성공');
});

test('checkTag 는 extractDirectives 가 되읽는다', () => {
  const check = { label: '설득', sides: 20, dc: 14 };
  assert.equal(extractDirectives(`말한다.\n${checkTag(check)}`).check.dc, 14);
  assert.equal(checkTag(null), '');
});

test('sceneBlock: 주사위만 켜도 안내가 나오고, 표정이 없으면 표정 표식은 없다', () => {
  assert.equal(sceneBlock({ name: '리아' }), '');
  const dice = sceneBlock({ name: '리아', dice: true });
  assert.ok(dice.includes('[[판정:') && !dice.includes('[[표정'));
  const both = sceneBlock({ name: '리아', expressions: ['기쁨'], dice: true });
  assert.ok(both.includes('[[표정: 이름]]') && both.includes('🎲'));
});

test('parseChoices: 기호·따옴표·판정 꼬리를 정리하고 중복은 버린다', () => {
  const out = parseChoices([
    '- 조심스럽게 문을 연다.',
    '2) "솔직히 말한다."',
    '* 문지기를 구슬려 본다. (판정: 설득 d20 난이도 14)',
    '- 조심스럽게 문을 연다.',
    '',
    '- 벽을 넘는다. (판정: 이상한 표기)'
  ].join('\n'));
  assert.deepEqual(out, [
    { text: '조심스럽게 문을 연다.' },
    { text: '솔직히 말한다.' },
    { text: '문지기를 구슬려 본다.', check: { label: '설득', sides: 20, dc: 14 } },
    { text: '벽을 넘는다.' }
  ]);
});

test('parseChoices: 개수 제한과 한 글자 줄 버리기', () => {
  assert.equal(parseChoices('- 가나\n- 다라\n- 마바', 2).length, 2);
  assert.deepEqual(parseChoices('- 가'), []);
});

test('choicesPrompt: 모드에 따라 지시가 달라진다', () => {
  assert.ok(choicesPrompt({ dice: true }).includes('(판정:'));
  assert.ok(!choicesPrompt({}).includes('(판정:'));
  assert.ok(choicesPrompt({ messenger: true }).includes('메신저'));
  assert.ok(choicesPrompt({ director: true }).includes('연출 지시'));
  assert.ok(choicesPrompt({ count: 99 }).includes('5개'));
  assert.ok(choicesPrompt({ count: 0 }).includes('3개'));
});
