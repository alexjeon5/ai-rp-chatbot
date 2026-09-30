import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../../src/discord/split.js';
import { ReplyRelay, PLACEHOLDER, displayText } from '../../src/discord/relay.js';

test('splitMessage: 문단·줄·문장 순으로 끊고, 한 조각은 한도를 넘지 않음', () => {
  const text = `${'가'.repeat(700)}.\n\n${'나'.repeat(700)}.\n${'다'.repeat(300)}. 라라라 ${'마'.repeat(900)}`;
  const parts = splitMessage(text, 1900);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.ok(parts[0].endsWith(`${'나'.repeat(700)}.`), '줄바꿈에서 끊음');
  assert.deepEqual(splitMessage('x'.repeat(4000)).map((p) => p.length), [1900, 1900, 200], '끊을 곳이 없으면 글자로');
  assert.deepEqual(splitMessage('   '), []);
  // 스트리밍 중: 앞 조각은 뒤에 글이 붙어도 그대로입니다.
  const grown = splitMessage(`${text} 더 붙은 글`, 1900);
  assert.equal(grown[0], parts[0]);
});

test('displayText: 화면 표식과 아직 닫히지 않은 표식을 가림', () => {
  assert.equal(displayText('[[표정: 기쁨]]\n안녕'), '안녕');
  assert.equal(displayText('안녕 [[장소: 교'), '안녕');
});

/** 보내고 고치고 지운 것을 적는 가짜 sink 와, 손으로 돌리는 타이머. */
function fakes() {
  const log = [];
  let n = 0;
  const sink = {
    send: async (content, components) => { const m = { id: `m${++n}`, content, components }; log.push(['send', m.id, content, components.length]); return m; },
    edit: async (m, content, components) => { m.content = content; log.push(['edit', m.id, content, components.length]); },
    remove: async (m) => { log.push(['remove', m.id]); }
  };
  const pending = [];
  const timers = { set: (fn) => { pending.push(fn); return pending.length; }, clear: () => { pending.length = 0; } };
  const tick = () => { const fns = pending.splice(0); fns.forEach((fn) => fn()); };
  return { sink, log, timers, tick };
}

test('ReplyRelay: 자리 → 모아서 고치기 → 마지막에 버튼', async () => {
  const { sink, log, timers, tick } = fakes();
  const live = [{ type: 1 }];
  const relay = new ReplyRelay({ sink, timers, liveComponents: live });
  await relay.begin();
  assert.deepEqual(log.at(-1), ['send', 'm1', PLACEHOLDER, 1], '글이 오기 전에 자리와 멈추기 버튼');

  relay.push('안녕');
  relay.push('하세요 [[표정');
  assert.equal(log.length, 1, '간격이 지나기 전에는 고치지 않음');
  tick();
  await relay.chain;
  assert.deepEqual(log.at(-1), ['edit', 'm1', '안녕하세요', 1]);

  relay.push(': 기쁨]] 반가워요.');
  const handles = await relay.finish({ components: [{ type: 1 }, { type: 1 }] });
  assert.deepEqual(log.at(-1), ['edit', 'm1', '안녕하세요  반가워요.', 2]);
  assert.deepEqual(handles.map((m) => m.id), ['m1']);
  tick();
  await relay.chain;
  assert.equal(log.length, 3, '끝낸 뒤에는 더 고치지 않음');
});

test('ReplyRelay: 길어지면 다음 메시지로, 다시 쓰기로 짧아지면 남는 옛 메시지를 지움', async () => {
  const { sink, log, timers } = fakes();
  const long = new ReplyRelay({ sink, timers, limit: 10 });
  long.push('하나 둘 셋 넷 다섯 여섯 일곱');
  const first = await long.finish();
  assert.ok(first.length >= 2);

  const again = new ReplyRelay({ sink, timers, limit: 10, handles: first });
  again.push('짧음');
  const second = await again.finish();
  assert.deepEqual(second.map((m) => m.id), [first[0].id], '첫 메시지를 고쳐 씀');
  assert.ok(log.some(([op, id]) => op === 'remove' && id === first[1].id));
});

test('ReplyRelay: 쓴 글이 없으면 메시지를 남기지 않고, 디스코드 오류는 모아 둠', async () => {
  const { sink, log, timers } = fakes();
  const relay = new ReplyRelay({ sink, timers });
  await relay.begin();
  assert.deepEqual(await relay.finish(), []);
  assert.deepEqual(log.at(-1), ['remove', 'm1']);

  const broken = new ReplyRelay({ sink: { ...sink, send: async () => { throw new Error('429'); } }, timers });
  broken.push('글');
  await broken.finish();
  assert.equal(broken.failure.message, '429');
});
