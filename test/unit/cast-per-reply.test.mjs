import test from 'node:test';
import assert from 'node:assert/strict';
import { addSwipe, showSwipe } from '../../src/chat-ops.js';

test('답변 넘겨보기: 장마다 그때의 등장인물을 들고 다님', () => {
  // 혼자 나왔을 때 쓴 답변
  const msg = { id: 'm1', role: 'assistant', content: '혼자', at: 1 };
  // 등장인물을 넣고 다시 받은 답변
  addSwipe(msg, { content: '둘이', at: 2, castIds: ['c2'] });
  assert.deepEqual(msg.castIds, ['c2']);

  showSwipe(msg, 0);
  assert.equal(msg.content, '혼자');
  assert.equal(msg.castIds, undefined);

  showSwipe(msg, 1);
  assert.deepEqual(msg.castIds, ['c2']);
});
