import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Attachments, sniffImage, ATTACHMENT_LIMITS } from '../../src/services/attachments.js';
import { planContext, IMAGE_TOKENS, MAX_SENT_IMAGES } from '../../src/context.js';
import { normalizeTurns, openAiTurns, anthropicTurns, geminiTurns } from '../../src/providers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'att-'));
  try {
    await fn(new Attachments(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('sniffImage: 파일 머리로 PNG·JPEG·WebP 를 알아보고 나머지는 거절', () => {
  assert.deepEqual(sniffImage(PNG), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(sniffImage(JPG), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(sniffImage(WEBP), { ext: 'webp', mime: 'image/webp' });
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......................')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
});

test('Attachments: 저장 → resolve → inline 왕복, 남의 파일·이상한 이름은 걸러냄', async () => {
  await withDir(async (att) => {
    const saved = await att.save('chat1', PNG);
    assert.equal(saved.mime, 'image/png');
    assert.equal(await att.save('chat1', Buffer.from('not an image at all')), null);

    const refs = [
      { file: saved.file, name: '  사진<b>.png  ' },
      { file: saved.file },
      { file: '../../etc/passwd' },
      { file: 'nothere1234.png' }
    ];
    const got = await att.resolve('chat1', refs);
    assert.equal(got.length, 1);
    assert.equal(got[0].name, '사진b.png');
    assert.equal(got[0].mime, 'image/png');
    assert.equal(got[0].bytes, PNG.length);
    // 다른 대화의 파일은 이 대화에 붙일 수 없습니다.
    assert.deepEqual(await att.resolve('chat2', [{ file: saved.file }]), []);

    const [turn] = await att.inline('chat1', [{ role: 'user', content: '봐', attachments: got }]);
    assert.equal(turn.attachments, undefined);
    assert.equal(turn.images[0].mime, 'image/png');
    assert.equal(Buffer.from(turn.images[0].data, 'base64').equals(PNG), true);
  });
});

test('Attachments: 한 메시지에 붙일 수 있는 개수를 자르고 삭제·전체 삭제가 동작', async () => {
  await withDir(async (att, dir) => {
    const files = [];
    for (let i = 0; i < ATTACHMENT_LIMITS.perMessage + 2; i++) files.push({ file: (await att.save('c1', JPG)).file });
    assert.equal((await att.resolve('c1', files)).length, ATTACHMENT_LIMITS.perMessage);

    att.remove('c1', files[0].file);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await readdir(path.join(dir, 'c1'))).length, files.length - 1);
    await att.removeAll('c1');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('planContext: 그림 토큰을 세고 가장 최근 MAX_SENT_IMAGES 장만 보냄, 그림만 있는 메시지도 남김', () => {
  const att = (n) => Array.from({ length: n }, (_, i) => ({ file: `f${n}${i}.png`, mime: 'image/png' }));
  const messages = [
    { id: 'a', role: 'user', content: '첫', attachments: att(4) },
    { id: 'b', role: 'assistant', content: '응' },
    { id: 'c', role: 'user', content: '', attachments: att(3) }
  ];
  const plan = planContext(messages, { system: '', limit: 100000, reserve: 0 });
  assert.equal(plan.history.length, 3);
  assert.equal(plan.history[2].attachments.length, 3);
  assert.equal(plan.history[0].attachments.length, MAX_SENT_IMAGES - 3);
  assert.equal(plan.history[1].attachments, undefined);
  assert.ok(plan.usage.history >= IMAGE_TOKENS * 7);
});

test('planContext: 그림 없는 히스토리는 예전과 같은 모양', () => {
  const plan = planContext([{ id: 'a', role: 'user', content: '안녕' }], { system: '', limit: 1000 });
  assert.deepEqual(plan.history, [{ role: 'user', content: '안녕' }]);
});

const img = { mime: 'image/png', data: 'QUJD' };

test('openAiTurns: 그림이 있으면 조각 배열, 없으면 글 그대로, 빈 턴은 뺌', () => {
  const out = openAiTurns([
    { role: 'user', content: '이게 뭐야', images: [img] },
    { role: 'assistant', content: '고양이' },
    { role: 'user', content: '', images: [img] },
    { role: 'user', content: '  ' }
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].content, [
    { type: 'text', text: '이게 뭐야' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
  ]);
  assert.equal(out[1].content, '고양이');
  assert.equal(out[2].content.length, 1);
});

test('anthropicTurns: 그림이 글보다 앞, 같은 역할은 합치되 그림도 함께 모음', () => {
  const out = anthropicTurns([
    { role: 'user', content: '하나', images: [img] },
    { role: 'user', content: '둘', images: [img] },
    { role: 'assistant', content: '답' }
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].content[0].type, 'image');
  assert.deepEqual(out[0].content[0].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' });
  assert.equal(out[0].content[2].type, 'text');
  assert.equal(out[0].content[2].text, '하나\n\n둘');
  assert.equal(out[1].content, '답');
});

test('geminiTurns: inlineData 조각과 model 역할', () => {
  const out = geminiTurns([{ role: 'user', content: '', images: [img] }, { role: 'assistant', content: '네' }]);
  assert.deepEqual(out[0], { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJD' } }] });
  assert.deepEqual(out[1], { role: 'model', parts: [{ text: '네' }] });
});

test('normalizeTurns: 첫 턴이 답변이면 시작 문구를 앞에 붙임', () => {
  const out = normalizeTurns([{ role: 'assistant', content: '어서 와' }]);
  assert.equal(out[0].role, 'user');
  assert.equal(out.length, 2);
});
