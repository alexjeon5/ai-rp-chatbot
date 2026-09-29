import test from 'node:test';
import assert from 'node:assert/strict';
import { searchChats, parseTerms, snippetAround, SEARCH_LIMITS } from '../../src/chat-search.js';

const chat = (id, title, messages, extra = {}) => ({ id, title, updatedAt: 1000, messages, ...extra });
const msg = (id, role, content) => ({ id, role, content, at: 1 });

test('parseTerms: 소문자로 바꾸고 공백으로 나누며 중복·과다 검색어를 정리', () => {
  assert.deepEqual(parseTerms('  Hello   WORLD hello '), ['hello', 'world']);
  assert.deepEqual(parseTerms(''), []);
  assert.deepEqual(parseTerms(null), []);
  assert.equal(parseTerms('a b c d e f g h').length, SEARCH_LIMITS.terms);
});

test('searchChats: 검색어를 모두 포함한 메시지만, 한글·대소문자 무관', () => {
  const chats = [
    chat('a', '옥상', [msg('1', 'user', '별이 예쁘다'), msg('2', 'assistant', '*고개를 든다.* "Star 는 처음 봐?"')]),
    chat('b', '학원', [msg('3', 'user', '별 이야기는 나중에')])
  ];
  const r = searchChats(chats, '별 예쁘');
  assert.deepEqual(r.hits.map((h) => [h.chatId, h.messageId]), [['a', '1']]);
  assert.deepEqual(searchChats(chats, 'STAR').hits.map((h) => h.messageId), ['2']);
  assert.equal(searchChats(chats, '없는말').hits.length, 0);
  assert.equal(searchChats(chats, '   ').hits.length, 0);
});

test('searchChats: 제목이 걸리면 messageId 가 null, 최근 수정한 대화가 먼저', () => {
  const chats = [
    chat('old', '고양이 이야기', [], { updatedAt: 10 }),
    chat('new', '기타', [msg('m', 'user', '고양이가 울었다')], { updatedAt: 20 })
  ];
  const r = searchChats(chats, '고양이');
  assert.deepEqual(r.hits.map((h) => [h.chatId, h.messageId]), [['new', 'm'], ['old', null]]);
});

test('searchChats: 본문이 걸린 대화는 제목 결과를 따로 내지 않음', () => {
  const r = searchChats([chat('a', '별 보는 법', [msg('m', 'user', '별 보는 법')])], '별');
  assert.deepEqual(r.hits.map((h) => h.messageId), ['m']);
});

test('searchChats: 한 대화에서는 최근 메시지 몇 개까지만, 더 있다고 표시', () => {
  const many = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, 'user', `사과 ${i}`));
  const r = searchChats([chat('a', 'x', many)], '사과');
  assert.equal(r.hits.length, SEARCH_LIMITS.perChat);
  assert.deepEqual(r.hits.map((h) => h.messageId), ['m5', 'm4', 'm3']);
  assert.equal(r.hits[0].moreInChat, true);
});

test('searchChats: 전체 결과 수 상한과 kind 필터', () => {
  const chats = Array.from({ length: SEARCH_LIMITS.hits + 5 }, (_, i) => chat(`c${i}`, 't', [msg('m', 'user', '단어')], { kind: i % 2 ? 'assistant' : 'rp' }));
  const r = searchChats(chats, '단어');
  assert.equal(r.hits.length, SEARCH_LIMITS.hits);
  assert.equal(r.truncated, true);
  const rp = searchChats(chats, '단어', { kind: 'rp' });
  assert.ok(rp.hits.every((h) => Number(h.chatId.slice(1)) % 2 === 0));
});

test('snippetAround: 검색어 둘레만 잘라 줄바꿈을 접고 앞뒤 생략 표시', () => {
  const text = `${'가'.repeat(100)}\n\n찾는말 ${'나'.repeat(200)}`;
  const s = snippetAround(text, ['찾는말']);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.includes('찾는말'));
  assert.ok(!s.includes('\n'));
  assert.ok(s.length < 130);
  assert.equal(snippetAround('짧은 글', ['짧은']), '짧은 글');
});
