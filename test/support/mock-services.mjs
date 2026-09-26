/**
 * 테스트용 가짜 엔진과 가짜 ComfyUI. 한 서버에서 경로로 나눕니다.
 *
 *   /v1/...            OpenAI 호환 (LM Studio 자리)
 *   /anth/v1/...       Anthropic
 *   /gem/v1beta/...    Gemini
 *   /comfy/...         ComfyUI
 *   /__requests        지금까지 받은 요청 (읽으면 비웁니다)
 *
 * 답은 요청 내용으로 정해집니다. 같은 요청이면 늘 같은 답이라, 서버 동작을 앞뒤로 비교할 수 있습니다.
 */
import http from 'node:http';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** 시스템 프롬프트와 마지막 사용자 말로 답을 고릅니다. */
export function replyFor(system = '', user = '') {
  if (user.includes('빈응답')) return '';
  if (system.includes('설정 기록 담당')) {
    return '{"add":[{"text":"유하린은 옥상을 좋아한다","from":[1]},{"text":"둘은 같은 과다","from":[]}],"update":[],"remove":[]}';
  }
  if (system.includes('기록을 정리하는 편집자')) return '# 요약\n- 둘은 옥상에서 처음 만났다.\n- 다음 주에 다시 보기로 했다.';
  if (system.includes('캐릭터 시트를 쓰는')) {
    if (user.includes('형식실패')) return '그냥 아무 말이나 늘어놓습니다. 라벨은 없습니다.';
    return '이름: 한가람\n아이콘: 📚\n태그: 일상, 서점\n한 줄 소개: 헌책방 주인, 29세.\n성격: 말수가 적다.\n책 얘기만 나오면 길어진다.\n말투: 느린 존댓말.\n배경과 상황: 비 오는 밤의 헌책방.\n첫 대사: *고개를 든다.* "어서 오세요."';
  }
  if (system.includes('인물 소개 한 문단')) return '소개: 김서연은 조용한 사람이다. 늘 먼저 와서 기다린다.\n\n둘째 문단은 버려집니다.';
  if (system.includes('Danbooru tags')) {
    if (user.includes('That was not a tag list')) return 'Tags: 1girl, adult, smile, rooftop, night\nNegative: 2girls, daytime';
    if (user.includes('태그실패')) return '이 장면은 옥상에서 벌어지는 이야기입니다.';
    return 'Tags: 1girl, adult, smile, rooftop, night, loli\nNegative: 2girls, daytime';
  }
  if (user.includes('[진행 지시: 이번 한 번은 예외로')) return '감독: 유하린이 고개를 든다. "누구야?" 빗줄기가 굵어진다.';
  if (user.includes('[진행 지시: 바로 앞')) return ' 이어서 쓴 뒷부분.';
  if (user.includes('반복테스트')) return 'ㅋ'.repeat(400);
  if (user.includes('생각테스트')) return '<think>속으로 생각</think>생각 끝의 답변';
  return '*난간에 기댄다.* "왔구나."';
}

const pieces = (text) => (text ? [text.slice(0, 5), text.slice(5, 40), text.slice(40)].filter(Boolean) : []);
const lastUser = (messages = []) => [...messages].reverse().find((m) => m.role === 'user');
const textOf = (content) => (typeof content === 'string' ? content : (content || []).map((p) => p.text || '').join(''));

export function startMockServices(port) {
  const requests = [];
  let promptSeq = 0;
  const history = new Map();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const raw0 = url.pathname;
      const vendor = /^\/(ollama|vercel)(?=\/)/.exec(raw0)?.[1] || '';
      const path = vendor ? raw0.slice(vendor.length + 1) : raw0;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      if (path === '/__requests') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests.splice(0)));
        return;
      }
      const pick = ['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version'];
      requests.push({
        method: req.method,
        path: path + (url.search && !path.startsWith('/comfy/history') ? url.search : ''),
        headers: Object.fromEntries(pick.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
        body
      });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const sse = (events) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
        res.end();
      };
      const usage = (b) => Math.round(JSON.stringify(b).length / 3);

      /* ----- OpenAI 호환 ----- */
      if (vendor === 'ollama' && path === '/api/tags') return json(200, { models: [{ model: 'gemma4:31b' }, { name: 'llama3' }, { model: 'gemma4:31b' }] });
      if (vendor === 'vercel' && path === '/v1/models') {
        return json(200, { data: [{ id: 'anthropic/claude', type: 'language' }, { id: 'openai/dall-e', type: 'image' }, { id: 'plain' }] });
      }
      if (path === '/v1/models') {
        return json(200, { data: ['mock-7b', 'gone-model', 'text-embedding-3', 'mock-search'].map((id) => ({ id })) });
      }
      if (path === '/v1/chat/completions') {
        if (body.model === 'gone-model') return json(404, { error: { message: 'The model gone-model does not exist. Use mock-7b instead.' } });
        if (body.model === 'strict-model' && 'max_tokens' in body) {
          return json(400, { error: { message: 'Unsupported parameter: max_tokens. Use max_completion_tokens instead.' } });
        }
        const system = body.messages[0]?.content || '';
        const reply = replyFor(system, textOf(lastUser(body.messages.slice(1))?.content));
        const events = pieces(reply).map((t) => ({ choices: [{ delta: { content: t } }] }));
        if (body.web_search_options) events.push({ choices: [{ delta: { content: '', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/o', title: 'O' } }] } }] });
        if (body.stream_options?.include_usage) events.push({ choices: [], usage: { prompt_tokens: usage(body.messages) } });
        events.push('[DONE]');
        return sse(events);
      }

      /* ----- Anthropic ----- */
      if (path === '/anth/v1/models') return json(200, { data: [{ id: 'claude-x' }, { id: 'claude-y' }], has_more: false });
      if (path === '/anth/v1/messages') {
        if (body.thinking?.type === 'enabled' && body.model === 'claude-adaptive') {
          return json(400, { error: { message: 'thinking.type enabled is not supported for this model' } });
        }
        const reply = replyFor(body.system, textOf(lastUser(body.messages)?.content));
        return sse([
          { type: 'message_start', message: { usage: { input_tokens: usage(body.messages) } } },
          ...(body.thinking ? [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '앤트로픽 생각' } }] : []),
          ...(body.tools ? [{ type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/a', title: 'A again' }] } }] : []),
          ...pieces(reply).map((t) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })),
          { type: 'message_stop' }
        ]);
      }

      /* ----- Gemini ----- */
      if (path === '/gem/v1beta/models') {
        return json(200, { models: [
          { name: 'models/gemini-3-x', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed-1', supportedGenerationMethods: ['embedContent'] }
        ] });
      }
      if (path.startsWith('/gem/v1beta/models/') && path.endsWith(':streamGenerateContent')) {
        const thinkingConfig = body.generationConfig?.thinkingConfig;
        const model = decodeURIComponent(path.slice('/gem/v1beta/models/'.length).split(':')[0]);
        if (model.startsWith('gemini-2') && thinkingConfig && 'thinkingBudget' in thinkingConfig) {
          return json(400, { error: { message: 'thinkingBudget is not supported for this model' } });
        }
        if (model.startsWith('gemma') && body.tools) return json(400, { error: { message: 'Tool use with google_search is not supported' } });
        const system = body.systemInstruction?.parts?.[0]?.text || '';
        const users = body.contents.filter((c) => c.role === 'user');
        const reply = replyFor(system, users[users.length - 1]?.parts?.[0]?.text || '');
        return sse([
          ...(thinkingConfig?.includeThoughts ? [{ candidates: [{ content: { parts: [{ text: '제미니 생각', thought: true }] } }] }] : []),
          ...pieces(reply).map((t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] })),
          { candidates: [{ content: { parts: [] }, ...(body.tools ? { groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/g', title: 'G' } }] } } : {}) }], usageMetadata: { promptTokenCount: usage(body.contents) } }
        ]);
      }

      /* ----- ComfyUI ----- */
      if (path === '/comfy/object_info/CheckpointLoaderSimple') {
        return json(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } } } });
      }
      if (path === '/comfy/object_info/KSampler') {
        return json(200, { KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']] } } } });
      }
      if (path === '/comfy/prompt') {
        promptSeq += 1;
        const id = `p${promptSeq}`;
        history.set(id, 0);
        return json(200, { prompt_id: id });
      }
      if (path.startsWith('/comfy/history/')) {
        const id = decodeURIComponent(path.slice('/comfy/history/'.length));
        const seen = history.get(id) ?? 0;
        history.set(id, seen + 1);
        if (seen === 0) return json(200, {});
        return json(200, { [id]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'rp_00001_.png', subfolder: '', type: 'output' }] } } } });
      }
      if (path === '/comfy/queue') return json(200, { queue_running: [], queue_pending: [[0, 'x'], [1, `p${promptSeq}`]] });
      if (path === '/comfy/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      if (path === '/comfy/free' || path === '/comfy/interrupt') return json(200, {});

      json(404, { error: 'mock: unknown path' });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
