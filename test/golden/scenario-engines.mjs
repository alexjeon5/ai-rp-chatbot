/**
 * 엔진 어댑터 시나리오. 내장 엔진 여섯과 커스텀 엔진의 모델 목록·답변·웹 검색·생각·거부 후 재시도를 부릅니다.
 * 기본 시나리오와 요청 제한(생성 1분 30회)을 나눠 쓰려고 따로 둡니다.
 */
const MOCK = `http://127.0.0.1:${process.env.GOLDEN_MOCK_PORT || 5181}`;

export async function scenario({ call }) {
  await call('settings: 엔진', 'PUT', '/api/settings', {
    providers: {
      lmstudio: { baseUrl: `${MOCK}/v1`, model: 'mock-7b' },
      openai: { baseUrl: `${MOCK}/v1`, apiKey: 'sk-o', model: 'mock-search' },
      ollama: { baseUrl: `${MOCK}/ollama/v1`, apiKey: 'ok', model: 'gemma4:31b' },
      vercel: { baseUrl: `${MOCK}/vercel/v1`, apiKey: 'vk', model: 'anthropic/claude' },
      gemini: { baseUrl: `${MOCK}/gem/v1beta`, apiKey: 'gk', model: 'gemini-3-x' },
      anthropic: { baseUrl: `${MOCK}/anth/v1`, apiKey: 'ak', model: 'claude-x' },
      c_old: { label: 'Old', type: 'gemini', baseUrl: `${MOCK}/gem/v1beta`, apiKey: 'gk', model: 'gemini-2-old' },
      c_gemma: { label: 'Gemma', type: 'gemini', baseUrl: `${MOCK}/gem/v1beta`, apiKey: 'gk', model: 'gemma-3' },
      c_nokey: { label: 'NoKey', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'x' }
    },
    assistant: { webSearch: true, thinking: true }
  });
  const settings = await call('settings', 'GET', '/api/settings');
  for (const p of ['lmstudio', 'openai', 'ollama', 'vercel', 'gemini', 'anthropic', 'c_old']) {
    await call(`models: ${p}`, 'GET', `/api/models?provider=${p}`);
  }

  const chat = await call('chat: 어시스턴트', 'POST', '/api/chats', { kind: 'assistant' });
  await call('msg', 'POST', `/api/chats/${chat.id}/messages`, { content: '검색해서 알려 줘' });
  for (const p of ['lmstudio', 'openai', 'ollama', 'vercel', 'gemini', 'anthropic', 'c_old', 'c_gemma', 'c_nokey']) {
    await call(`generate: ${p}`, 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true, provider: p });
  }
  await call('settings: 생각·검색 끄기', 'PUT', '/api/settings', { assistant: { webSearch: false, thinking: false } });
  for (const p of ['gemini', 'c_old', 'anthropic']) {
    await call(`generate(끔): ${p}`, 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true, provider: p });
  }

  /* 롤플레이 대화를 각 엔진으로: 연속된 같은 역할·첫 턴이 답변인 히스토리 정리(normalizeTurns) */
  const character = (await call('characters', 'GET', '/api/characters'))[0];
  const rp = await call('chat: 롤플레이', 'POST', '/api/chats', { characterId: character.id });
  await call('msg: 1', 'POST', `/api/chats/${rp.id}/messages`, { content: '첫째' });
  await call('msg: 2', 'POST', `/api/chats/${rp.id}/messages`, { content: '둘째' });
  for (const p of ['anthropic', 'gemini', 'vercel']) {
    await call(`rp generate: ${p}`, 'POST', `/api/chats/${rp.id}/generate`, { provider: p });
  }
  await call('context', 'GET', `/api/chats/${rp.id}/context?provider=gemini`);

  /* 그림: 미성년으로 읽히는 태그는 그리지 않습니다 */
  await call('settings: 그리기 켜기', 'PUT', '/api/settings', { image: { enabled: true, baseUrl: `${MOCK}/comfy`, checkpoint: 'a.safetensors' } });
  const blocked = await call('msg: 금지 태그', 'POST', `/api/chats/${rp.id}/messages`, { role: 'assistant', content: '금지태그 장면' });
  await call('image: 미성년 차단', 'POST', `/api/chats/${rp.id}/messages/${blocked.id}/image`, { review: true });
  await call('image: 성인 대화 필터', 'PUT', `/api/chats/${rp.id}`, { presetId: 'adult' });
  await call('settings: 필터', 'PUT', '/api/settings', { image: { adult: { forceTags: 'adult, mature', blockTags: 'smile, *night*', extraNegative: 'blurry' } } });
  await call('image: 성인 대화 검토', 'POST', `/api/chats/${rp.id}/messages/${blocked.id}/image`, { prompt: 'smile, night sky, rooftop' , review: true });
  await call('settings: 마지막', 'GET', '/api/settings');
  return settings;
}
