import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEntry, cleanLorebook, cleanLoreSettings, LoreScanner, renderLore } from '../../src/lorebook.js';
import { LoreBooks } from '../../src/services/lorebooks.js';
import { buildSystem } from '../../src/prompt.js';

const entry = (o) => cleanEntry({ content: '내용', ...o });
const book = (entries, o = {}) => ({ id: 'b1', name: '책', entries: entries.map(entry), ...o });
const msgs = (...texts) => texts.map((content) => ({ role: 'user', content }));
const titles = (sel) => sel.map((s) => s.entry.title);

test('cleanEntry: 내용이 비면 버리고, 키는 쉼표·줄바꿈으로 나눠 겹침 없이', () => {
  assert.equal(cleanEntry({ content: '  ' }), null);
  assert.equal(cleanEntry(null), null);
  const e = cleanEntry({ content: ' 설정 ', keys: '용사, 마왕\n용사', priority: 999 });
  assert.deepEqual(e.keys, ['용사', '마왕']);
  assert.equal(e.content, '설정');
  assert.equal(e.priority, 100);
  assert.equal(e.enabled, true);
  assert.match(e.id, /^[A-Za-z0-9_-]+$/);
});

test('cleanLorebook: 들어온 칸만 돌려주고 항목 id 중복은 새로 붙임', () => {
  assert.deepEqual(cleanLorebook({ name: ' 이름 ' }), { name: '이름' });
  const out = cleanLorebook({ entries: [{ id: 'a', content: 'x' }, { id: 'a', content: 'y' }, { content: '' }] });
  assert.equal(out.entries.length, 2);
  assert.notEqual(out.entries[0].id, out.entries[1].id);
  assert.deepEqual(cleanLorebook({ characterIds: ['ok', '../bad', 'ok'] }).characterIds, ['ok']);
});

test('cleanLoreSettings: 범위 밖 값은 범위 안으로, 안 준 칸은 그대로', () => {
  assert.deepEqual(cleanLoreSettings({ scanDepth: 999, tokenBudget: 1 }, { scanDepth: 4, tokenBudget: 1200 }), { scanDepth: 20, tokenBudget: 100 });
  assert.deepEqual(cleanLoreSettings({ scanDepth: 'x' }, { scanDepth: 4, tokenBudget: 1200 }), { scanDepth: 4, tokenBudget: 1200 });
});

test('키워드가 나오면 발동하고, 대소문자는 기본으로 무시', () => {
  const s = new LoreScanner();
  const b = book([{ title: 'A', keys: ['Dragon'] }, { title: 'B', keys: ['성'] }]);
  assert.deepEqual(titles(s.select([b], msgs('a dragon flies'))), ['A']);
  assert.deepEqual(titles(s.select([b], msgs('성으로 간다'))), ['B']);
  assert.deepEqual(titles(s.select([b], msgs('아무 일 없음'))), []);
});

test('대소문자 구분 항목, 보조 키, 꺼짐, 항상 넣기', () => {
  const s = new LoreScanner();
  const b = book([
    { title: 'case', keys: ['API'], caseSensitive: true },
    { title: 'both', keys: ['왕'], secondaryKeys: ['검'] },
    { title: 'off', keys: ['왕'], enabled: false },
    { title: 'always', constant: true },
    { title: 'nokey' }
  ]);
  assert.deepEqual(titles(s.select([b], msgs('api 호출'))), ['always']);
  assert.deepEqual(titles(s.select([b], msgs('API 왕'))), ['case', 'always']);
  assert.deepEqual(titles(s.select([b], msgs('왕이 검을 든다'))).sort(), ['always', 'both']);
});

test('스캔 깊이: 오래된 메시지의 키워드는 무시, 숨긴 메시지는 건너뜀', () => {
  const b = book([{ title: 'A', keys: ['옛날'] }]);
  const list = [...msgs('옛날 이야기'), ...msgs('하나', '둘')];
  assert.deepEqual(titles(new LoreScanner({ scanDepth: 2 }).select([b], list)), []);
  assert.deepEqual(titles(new LoreScanner({ scanDepth: 3 }).select([b], list)), ['A']);
  const hidden = [{ role: 'user', content: '옛날', hidden: true }, ...msgs('현재')];
  assert.deepEqual(titles(new LoreScanner().select([b], hidden)), []);
});

test('우선순위 높은 순으로 정렬하고, 토큰 상한을 넘는 항목은 건너뛰고 작은 것을 계속 봄', () => {
  const big = '가'.repeat(400);
  const b = book([
    { title: 'low', keys: ['x'], priority: 10 },
    { title: 'big', keys: ['x'], priority: 90, content: big },
    { title: 'high', keys: ['x'], priority: 80 }
  ]);
  const all = new LoreScanner({ tokenBudget: 8000 }).select([b], msgs('x'));
  assert.deepEqual(titles(all), ['big', 'high', 'low']);
  const tight = new LoreScanner({ tokenBudget: 100 }).select([b], msgs('x'));
  assert.deepEqual(titles(tight), ['high', 'low']);
});

test('renderLore: 없으면 빈 글, 제목 없는 항목은 본문만', () => {
  assert.equal(renderLore([]), '');
  const out = renderLore([{ entry: { title: '왕국', content: '북쪽에 있다' } }, { entry: { title: '', content: '이름 없는 설정' } }]);
  assert.match(out, /^# 세계관 설정/);
  assert.match(out, /### 왕국\n북쪽에 있다/);
  assert.match(out, /\n\n이름 없는 설정$/);
});

test('buildSystem: lore 를 추가 설정 뒤·기억 앞에 붙이고 이름 자리표시자를 채움', () => {
  const out = buildSystem({
    character: { name: '하린', notes: '메모' }, persona: { name: '나' }, template: '{{char}} 연기',
    lore: '# 세계관 설정\n{{char}}는 성에 산다', facts: [{ text: '사실' }], memory: '요약'
  });
  const at = (t) => out.indexOf(t);
  assert.ok(at('메모') < at('# 세계관 설정') && at('# 세계관 설정') < at('# 기억해 둔 사실') && at('# 기억해 둔 사실') < at('# 지금까지의 이야기'));
  assert.match(out, /하린은 성에 산다/);
});

test('LoreBooks.appliedTo: 전체·캐릭터·대화 이유로 모으고 한 책은 한 번만, 대화 주인의 책만', () => {
  const books = [
    { id: 'g', name: 'g', global: true, characterIds: [], entries: [], ownerId: 'me' },
    { id: 'c', name: 'c', global: false, characterIds: ['ch1'], entries: [], ownerId: 'me' },
    { id: 'x', name: 'x', global: false, characterIds: [], entries: [], ownerId: 'me' },
    { id: 'both', name: 'both', global: true, characterIds: ['ch1'], entries: [], ownerId: 'me' },
    // 남의 책은 전체 적용이어도, 같은 캐릭터 id 에 묶여도, 대화에 id 를 적어도 붙지 않습니다.
    { id: 'other', name: 'other', global: true, characterIds: ['ch1'], entries: [], ownerId: 'someone' }
  ];
  const store = { lorebooks: { all: () => books, get: (id) => books.find((b) => b.id === id) || null }, settings: {} };
  const lore = new LoreBooks(store);
  const got = lore.appliedTo({ ownerId: 'me', characterId: 'ch1', lorebookIds: ['x', 'c', 'gone', 'other'] }).map((a) => `${a.book.id}:${a.via}`);
  assert.deepEqual(got, ['g:global', 'both:global', 'c:character', 'x:chat']);
  assert.deepEqual(lore.appliedTo({ ownerId: 'me', characterId: null }).map((a) => a.book.id), ['g', 'both']);
  assert.deepEqual(lore.appliedTo({ ownerId: 'someone', characterId: null }).map((a) => a.book.id), ['other']);
});
