import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { renderGemini, renderOpenAi, IMAGE_DEFAULTS, REFERENCE_NOTE } from '../../src/image.js';
import { setConsoleEcho } from '../../src/logs.js';

// 통신 로그가 stdout 에 찍히면 테스트 러너와 주고받는 직렬화 메시지 사이에 끼어들어
// 가끔 'Unable to deserialize cloned data' 로 파일 전체가 실패합니다. 콘솔 출력만 끕니다.
setConsoleEcho(false);

const PIXEL = Buffer.from('픽셀');
const reference = { buffer: Buffer.from('REFERENCE-BYTES'), mime: 'image/png', ext: 'png' };

async function withServer(reply, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

test('참조 그림 설정은 기본으로 꺼져 있다', () => {
  assert.equal(IMAGE_DEFAULTS().useReference, false);
});

test('Gemini: 참조가 있으면 그림 조각이 글보다 앞에 붙고, 없으면 글만 간다', async () => {
  const reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PIXEL.toString('base64') } }] } }] };
  await withServer(reply, async (baseUrl, seen) => {
    const config = { baseUrl, apiKey: 'k' };
    const out = await renderGemini({ config, model: 'm', prompt: '장면', aspectRatio: '2:3', reference });
    assert.ok(out.buffer.equals(PIXEL));
    const parts = JSON.parse(seen[0].body).contents[0].parts;
    assert.equal(parts[0].inlineData.data, reference.buffer.toString('base64'));
    assert.equal(parts[0].inlineData.mimeType, 'image/png');
    assert.ok(parts[1].text.startsWith(REFERENCE_NOTE) && parts[1].text.endsWith('장면'));

    await renderGemini({ config, model: 'm', prompt: '장면', aspectRatio: '2:3' });
    const plain = JSON.parse(seen[1].body).contents[0].parts;
    assert.deepEqual(plain, [{ text: '장면' }]);
  });
});

test('OpenAI: gpt-image 는 참조가 있으면 edits 로 multipart 를 보낸다', async () => {
  const reply = { data: [{ b64_json: PIXEL.toString('base64') }] };
  await withServer(reply, async (baseUrl, seen) => {
    const config = { baseUrl, apiKey: 'k' };
    const out = await renderOpenAi({ config, model: 'gpt-image-1', prompt: '장면', size: '1024x1536', quality: 'auto', reference });
    assert.ok(out.buffer.equals(PIXEL));
    assert.equal(seen[0].url, '/images/edits');
    assert.match(seen[0].type, /^multipart\/form-data/);
    const raw = seen[0].body.toString('latin1');
    assert.ok(raw.includes('name="image"') && raw.includes('REFERENCE-BYTES'));
    assert.ok(raw.includes('name="model"') && raw.includes('gpt-image-1'));
  });
});

test('OpenAI: 참조가 없거나 dall-e 면 지금처럼 generations 로 JSON 을 보낸다', async () => {
  const reply = { data: [{ b64_json: PIXEL.toString('base64') }] };
  await withServer(reply, async (baseUrl, seen) => {
    const config = { baseUrl, apiKey: 'k' };
    await renderOpenAi({ config, model: 'gpt-image-1', prompt: '장면', size: 'auto', quality: 'auto' });
    await renderOpenAi({ config, model: 'dall-e-3', prompt: '장면', size: 'auto', quality: 'auto', reference });
    for (const call of seen) {
      assert.equal(call.url, '/images/generations');
      assert.equal(call.type, 'application/json');
    }
    assert.equal(JSON.parse(seen[0].body).prompt, '장면');
    assert.ok(!seen[1].body.includes('REFERENCE'));
  });
});
