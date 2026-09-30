import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageTally, dayKey, summarizeUsage } from '../../src/usage.js';
import { UsageLedger } from '../../src/services/usage-ledger.js';

const doc = () => ({ data: { days: {} }, saved: 0, save() { this.saved++; } });
const DAY = 86_400_000;
const NOW = new Date(2026, 8, 29, 12).getTime();

test('UsageTally: 엔진이 알려 준 마지막 누적값을 쓰고 estimated 는 false', () => {
  const t = new UsageTally({ promptEstimate: 999 });
  t.note({ promptTokens: 100 });
  t.note({ completionTokens: 5 });
  t.note({ completionTokens: 40 });
  t.note({});
  assert.deepEqual(t.finish('답'), { promptTokens: 100, completionTokens: 40, estimated: false });
});

test('UsageTally: 알려 주지 않으면 어림값으로 채우고 estimated, 받은 게 없으면 null', () => {
  const t = new UsageTally({ promptEstimate: 300 });
  const used = t.finish('안녕하세요 반갑습니다');
  assert.equal(used.promptTokens, 300);
  assert.ok(used.completionTokens > 0);
  assert.equal(used.estimated, true);
  assert.equal(new UsageTally({ promptEstimate: 300 }).finish('  '), null);
  // 글은 없어도 엔진이 토큰을 알려 줬다면(사고만 하다 끝남 등) 남깁니다.
  const u = new UsageTally();
  u.note({ promptTokens: 10, completionTokens: 20 });
  assert.equal(u.finish('').completionTokens, 20);
});

test('UsageLedger: 같은 날 같은 모델은 한 줄로 합치고 요청 수·어림 횟수를 셈', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  ledger.add('openai', 'gpt-x', { promptTokens: 10, completionTokens: 5, estimated: false }, NOW);
  ledger.add('openai', 'gpt-x', { promptTokens: 20, completionTokens: 7, estimated: true }, NOW);
  ledger.add('lmstudio', '', { promptTokens: 1, completionTokens: 1, estimated: true }, NOW);
  ledger.add('openai', 'gpt-x', null, NOW);
  const rows = d.data.days[dayKey(NOW)];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { provider: 'openai', model: 'gpt-x', requests: 2, promptTokens: 30, completionTokens: 12, estimated: 1 });
  assert.equal(rows[1].model, '(모델 미지정)');
  assert.equal(d.saved, 3);
});

test('UsageLedger.meter: onUsage 와 record 로 한 호출이 기록됨', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  const m = ledger.meter({ provider: 'anthropic', config: { model: 'claude-x' }, system: 'sys', messages: [{ role: 'user', content: '안녕' }] });
  m.onUsage({ promptTokens: 50 });
  m.onUsage({ completionTokens: 9 });
  m.record('답변');
  const [row] = Object.values(d.data.days)[0];
  assert.equal(row.model, 'claude-x');
  assert.equal(row.promptTokens, 50);
  assert.equal(row.completionTokens, 9);
  assert.equal(row.estimated, 0);
});

test('UsageLedger: 90일보다 오래된 날짜는 지움, clear 는 전부 지움', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  const used = { promptTokens: 1, completionTokens: 1, estimated: false };
  ledger.add('p', 'm', used, NOW - 100 * DAY);
  ledger.add('p', 'm', used, NOW);
  assert.deepEqual(Object.keys(d.data.days), [dayKey(NOW)]);
  ledger.clear();
  assert.deepEqual(d.data.days, {});
});

test('summarizeUsage: 오늘·7일·30일 합계와 모델별 표(많이 쓴 순), 날짜별 30칸', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  const u = (p, c) => ({ promptTokens: p, completionTokens: c, estimated: false });
  ledger.add('a', 'small', u(10, 10), NOW);
  ledger.add('a', 'big', u(500, 500), NOW);
  ledger.add('a', 'big', u(100, 100), NOW - 3 * DAY);
  ledger.add('a', 'small', u(1, 1), NOW - 20 * DAY);
  const s = summarizeUsage(d.data.days, NOW);
  const [today, week, month] = s.periods;
  assert.equal(today.total.promptTokens, 510);
  assert.equal(week.total.promptTokens, 610);
  assert.equal(month.total.promptTokens, 611);
  assert.deepEqual(week.rows.map((r) => r.model), ['big', 'small']);
  assert.equal(week.rows[0].requests, 2);
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.at(-1).date, dayKey(NOW));
  assert.equal(s.daily.at(-1).completionTokens, 510);
});

test('UsageLedger: 계정마다 따로 쌓고, 내 요약은 내 줄만, 전체 요약은 계정별 합계를 붙임', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  const u = (p, c) => ({ promptTokens: p, completionTokens: c, estimated: false });
  ledger.add('a', 'm', u(10, 1), NOW, 'alice');
  ledger.add('a', 'm', u(20, 2), NOW, 'alice');
  ledger.add('a', 'm', u(300, 3), NOW, 'bob');
  ledger.add('a', 'm', u(4000, 4), NOW);
  assert.equal(d.data.days[dayKey(NOW)].length, 3, '같은 모델이라도 계정이 다르면 다른 줄');

  const alice = ledger.summary({ userId: 'alice' }, NOW);
  assert.equal(alice.periods[0].total.promptTokens, 30);
  assert.equal(alice.periods[0].users, undefined, '내 요약에는 계정별 합계가 없습니다');
  assert.equal(alice.daily.at(-1).promptTokens, 30);

  const all = ledger.summary({ all: true, nameOf: (id) => id.toUpperCase() }, NOW);
  assert.equal(all.periods[0].total.promptTokens, 4330);
  assert.deepEqual(all.periods[0].users.map((x) => [x.name, x.promptTokens]), [['(계정 나누기 전)', 4000], ['BOB', 300], ['ALICE', 30]]);

  assert.equal(ledger.reassign('alice'), 1, '주인 없는 옛 줄을 옮깁니다');
  assert.equal(ledger.summary({ userId: 'alice' }, NOW).periods[0].total.promptTokens, 4030);
  assert.equal(ledger.reassign('carol', { from: 'bob' }), 1);
  assert.equal(ledger.summary({ userId: 'bob' }, NOW).periods[0].total.promptTokens, 0);
});

test('UsageLedger.meter: 부른 사람(userId)으로 남김', () => {
  const d = doc();
  const ledger = new UsageLedger(d);
  const m = ledger.meter({ userId: 'alice', provider: 'p', config: { model: 'x' } });
  m.onUsage({ promptTokens: 5, completionTokens: 5 });
  m.record('답');
  assert.equal(Object.values(d.data.days)[0][0].userId, 'alice');
});
