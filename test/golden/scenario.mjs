/**
 * 서버 동작 기록 시나리오. 모든 API 경로를 한 번 이상, 오류 경로까지 부릅니다.
 * 생성 계열(요청 제한 1분 30회)은 29회 안에서 씁니다. 시계가 고정되어 창이 지나지 않기 때문입니다.
 */
const MOCK = `http://127.0.0.1:${process.env.GOLDEN_MOCK_PORT || 5181}`;

export async function scenario({ call }) {
  /* ---------- 설정 ---------- */
  await call('me', 'GET', '/api/me');
  const settings = await call('settings', 'GET', '/api/settings');
  await call('settings: 엔진·이미지', 'PUT', '/api/settings', {
    providers: {
      lmstudio: { baseUrl: `${MOCK}/v1`, model: 'mock-7b', contextTokens: 4096, apiKey: '', hasApiKey: true, unavailableModels: ['x'] },
      c_anth: { label: 'Anth', type: 'anthropic', baseUrl: `${MOCK}/anth/v1`, apiKey: 'k-anth', model: 'claude-x' },
      c_adapt: { label: 'Adaptive', type: 'anthropic', baseUrl: `${MOCK}/anth/v1`, apiKey: 'k-anth', model: 'claude-adaptive' },
      c_gem: { label: 'Gem', type: 'gemini', baseUrl: `${MOCK}/gem/v1beta`, apiKey: 'k-gem', model: 'gemini-3-x' },
      c_gone: { label: 'Gone', type: 'openai', baseUrl: `${MOCK}/v1`, apiKey: '', model: 'gone-model' },
      c_strict: { label: 'Strict', type: 'openai', baseUrl: `${MOCK}/v1`, apiKey: 'k', model: 'strict-model' },
      c_temp: { label: 'Temp', type: 'openai', baseUrl: `${MOCK}/v1`, apiKey: 'k', model: 'x' },
      // 공식 주소지만 요청이 나가기 전에 막히는 경로(성인 모드 차단)에만 씁니다.
      openai: { apiKey: 'sk-test', model: 'gpt-test' }
    },
    image: { enabled: true, baseUrl: `${MOCK}/comfy`, checkpoint: 'a.safetensors', width: 830, steps: 999, cfg: -3, adult: { blockTags: 'smile, *night*' } },
    params: { temperature: 0.9 },
    memory: { autoSummarize: true, autoFacts: true },
    dev: { markup: { quote: false }, theme: { accent: '#ff0000' }, particleFix: true },
    assistant: { thinking: true, webSearch: true }
  });
  await call('settings: 거부되는 엔진 주소', 'PUT', '/api/settings', { providers: { lmstudio: { baseUrl: 'http://evil.example.com/v1' } } });
  await call('settings: 거부되는 ComfyUI', 'PUT', '/api/settings', { image: { baseUrl: 'ftp://x' } });
  await call('settings: 워크플로 형식 오류', 'PUT', '/api/settings', { image: { workflow: { a: 1 } } });
  await call('settings: 프리셋·삭제', 'PUT', '/api/settings', {
    presets: [...settings.presets, { id: 'mine', name: '내 모드', template: '자리표시자 없는 틀입니다.', adult: false }, { id: '', name: 'x' }],
    removeProviders: ['c_temp', 'lmstudio', 'nope'],
    askModeOnNewChat: false,
    historyLimit: 30
  });
  await call('models: lmstudio', 'GET', '/api/models?provider=lmstudio');
  await call('models: anthropic', 'GET', '/api/models?provider=c_anth');
  await call('models: gemini', 'GET', '/api/models?provider=c_gem');
  await call('models: 없는 엔진', 'GET', '/api/models?provider=nope');

  /* ---------- 캐릭터 · 페르소나 ---------- */
  const characters = await call('characters', 'GET', '/api/characters');
  const personas = await call('personas', 'GET', '/api/personas');
  const hana = await call('character: 만들기', 'POST', '/api/characters', {
    name: '하나', avatar: '🌸', description: '{{char}}는 {{user}}의 이웃이다.', personality: '밝다', speech: '반말',
    scenario: '아파트 복도', greeting: '*문을 연다.* "{{user}}야, 안녕!"', exampleDialogue: '{{user}}: 안녕\n{{char}}: 응!', notes: '비밀이 있다.',
    appearance: '1girl, adult, short hair', junk: 'x'
  });
  await call('character: 이름 없음', 'POST', '/api/characters', { name: '  ' });
  await call('character: 고치기', 'PUT', `/api/characters/${hana.id}`, { tags: '이웃, 일상', builtin: 'x' });
  await call('character: 없는 id', 'PUT', '/api/characters/nope', { name: 'x' });
  const me = await call('persona: 만들기', 'POST', '/api/personas', {
    name: '도윤', description: '대학생', gender: '남성', age: '21', traits: '커피를 좋아한다\n  고양이 알레르기  \n'
  });
  const extra = await call('persona: 하나 더', 'POST', '/api/personas', { name: '임시', traits: ['a', ' ', 'b'] });
  await call('persona: 고치기', 'PUT', `/api/personas/${extra.id}`, { age: 'x'.repeat(100) });
  await call('persona: 지우기', 'DELETE', `/api/personas/${extra.id}`);
  await call('persona: 없는 것 지우기', 'DELETE', '/api/personas/nope');
  await call('persona roll', 'POST', '/api/personas/roll', {});
  const rolled = await call('persona roll: 성인', 'POST', '/api/personas/roll', { adult: true });
  await call('persona roll: 하나만', 'POST', '/api/personas/roll', { seeds: rolled.seeds, only: ['trait', 'bad'], adult: true });
  await call('persona generate', 'POST', '/api/personas/generate', { seeds: rolled.seeds });                  // 생성 1
  await call('persona generate: 성인 클라우드 거부', 'POST', '/api/personas/generate', { seeds: rolled.seeds, adult: true, provider: 'openai' }); // 2
  await call('character draft', 'POST', '/api/characters/draft', { brief: '헌책방 주인', current: { name: '미리 정한 이름', speech: '' } }); // 3
  await call('character draft: 형식 실패', 'POST', '/api/characters/draft', { brief: '형식실패' });           // 4
  await call('character draft: 빈 설명', 'POST', '/api/characters/draft', { brief: ' ' });                   // 5
  await call('characters seed', 'POST', '/api/characters/seed', {});
  const director = personas.find((p) => p.director) || personas.find((p) => p.name === '감독');

  /* ---------- 대화 ---------- */
  const yuha = characters.find((c) => c.name === '유하린');
  const chat = await call('chat: 만들기', 'POST', '/api/chats', { characterId: yuha.id, personaId: me.id });
  const inline = await call('chat: 1회성', 'POST', '/api/chats', { character: { name: '임시 인물', greeting: '{{char}}가 인사한다.', bogus: 1 } });
  const helper = await call('chat: 어시스턴트', 'POST', '/api/chats', { kind: 'assistant' });
  await call('chat: 캐릭터 없음', 'POST', '/api/chats', { characterId: 'nope' });
  await call('chat: 하나 대화', 'POST', '/api/chats', { characterId: hana.id, presetId: 'mine' });
  await call('chats', 'GET', '/api/chats');
  await call('chat', 'GET', `/api/chats/${chat.id}`);
  await call('chat: 없음', 'GET', '/api/chats/nope');

  await call('msg: 보내기', 'POST', `/api/chats/${chat.id}/messages`, { content: '안녕, 오늘 옥상 가자' });
  await call('generate', 'POST', `/api/chats/${chat.id}/generate`, {});                                         // 6
  await call('generate: 다른 버전', 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true });              // 7
  const swiped = await call('chat: 버전 후', 'GET', `/api/chats/${chat.id}`);
  const last = swiped.messages[swiped.messages.length - 1];
  await call('swipe', 'PUT', `/api/chats/${chat.id}/messages/${last.id}/swipe`, { index: 0 });
  await call('swipe: 없는 메시지', 'PUT', `/api/chats/${chat.id}/messages/nope/swipe`, { index: 0 });
  await call('generate: 이어쓰기', 'POST', `/api/chats/${chat.id}/generate`, { continue: true });               // 8
  await call('msg: 고치기', 'PUT', `/api/chats/${chat.id}/messages/${last.id}`, { content: '고친 답변' });
  await call('generate: anthropic', 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true, provider: 'c_anth' }); // 9
  await call('generate: gemini', 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true, provider: 'c_gem' });     // 10
  await call('generate: 없는 모델', 'POST', `/api/chats/${chat.id}/generate`, { regenerate: true, provider: 'c_gone' }); // 11
  await call('models: 감춘 모델 빠짐', 'GET', '/api/models?provider=c_gone');
  await call('unavailable 지우기', 'DELETE', '/api/providers/c_gone/unavailable');
  await call('unavailable: 없는 엔진', 'DELETE', '/api/providers/nope/unavailable');
  await call('msg: 반복', 'POST', `/api/chats/${chat.id}/messages`, { content: '반복테스트' });
  await call('generate: 반복 멈춤', 'POST', `/api/chats/${chat.id}/generate`, {});                                // 12
  await call('msg: 1회성', 'POST', `/api/chats/${inline.id}/messages`, { content: '이어쓰기 전에 내 말' });
  await call('generate: 이어쓸 것 없음', 'POST', `/api/chats/${inline.id}/generate`, { continue: true });          // 13
  await call('stop: 도는 것 없음', 'POST', `/api/chats/${chat.id}/stop`, {});

  await call('msg: 어시스턴트', 'POST', `/api/chats/${helper.id}/messages`, { content: '생각테스트 질문입니다' });
  await call('generate: 어시스턴트 생각', 'POST', `/api/chats/${helper.id}/generate`, {});                        // 14
  await call('generate: 어시스턴트 anthropic 생각·검색', 'POST', `/api/chats/${helper.id}/generate`, { regenerate: true, provider: 'c_adapt' }); // 15
  await call('msg: 빈 답', 'POST', `/api/chats/${helper.id}/messages`, { content: '빈응답' });
  await call('generate: 빈 답', 'POST', `/api/chats/${helper.id}/generate`, {});                                 // 16

  /* ---------- 대화 설정 ---------- */
  await call('chat: 고치기', 'PUT', `/api/chats/${chat.id}`, {
    title: '옥상', authorNote: '{{char}}는 조금 쌀쌀맞게', memory: '처음 만남', castIds: [hana.id, yuha.id, 'nope', hana.id],
    facts: [{ id: 'f1', text: '  직접 적은  사실 ', auto: false }, { text: '' }, { id: 'f1', text: '같은 id' }]
  });
  await call('chat: 보관', 'PUT', `/api/chats/${chat.id}`, { archived: true });
  await call('chats: 보관 후', 'GET', '/api/chats');
  await call('msg: 보관 풀림', 'POST', `/api/chats/${chat.id}/messages`, { content: '태그실패 장면으로 가자' });
  await call('chat: 보관 해제', 'PUT', `/api/chats/${chat.id}`, { archived: false });
  await call('system', 'GET', `/api/chats/${chat.id}/system`);
  await call('system: 어시스턴트', 'GET', `/api/chats/${helper.id}/system`);
  await call('context', 'GET', `/api/chats/${chat.id}/context`);
  await call('context: anthropic', 'GET', `/api/chats/${chat.id}/context?provider=c_anth`);
  await call('generate: 작가 노트·등장인물', 'POST', `/api/chats/${chat.id}/generate`, {});                       // 17
  await call('impersonate', 'POST', `/api/chats/${chat.id}/impersonate`, { hint: '화난 척' });                    // 18
  await call('chat: 감독 페르소나', 'PUT', `/api/chats/${chat.id}`, { personaId: director.id });
  await call('impersonate: 감독', 'POST', `/api/chats/${chat.id}/impersonate`, {});                               // 19
  await call('impersonate: 어시스턴트 거부', 'POST', `/api/chats/${helper.id}/impersonate`, {});                  // 20

  /* 기억: 메시지를 쌓아 컨텍스트 밖으로 밀어냅니다 */
  for (let i = 0; i < 14; i++) {
    await call(`msg: 쌓기 ${i}`, 'POST', `/api/chats/${chat.id}/messages`,
      { role: i % 2 ? 'assistant' : 'user', content: `긴 메시지 ${i} `.repeat(120) });
  }
  await call('context: 쌓은 뒤', 'GET', `/api/chats/${chat.id}/context`);
  await call('summarize: 자동', 'POST', `/api/chats/${chat.id}/summarize`, { auto: true });                       // 21
  await call('summarize: 손으로', 'POST', `/api/chats/${chat.id}/summarize`, {});                                 // 22
  await call('summarize: 어시스턴트', 'POST', `/api/chats/${helper.id}/summarize`, {});                           // 23
  await call('facts: 자동', 'POST', `/api/chats/${chat.id}/facts/extract`, { auto: true });                       // 24
  await call('facts: 손으로', 'POST', `/api/chats/${chat.id}/facts/extract`, {});                                 // 25

  /* 성인 모드 규칙 */
  await call('chat: 성인 모드', 'PUT', `/api/chats/${inline.id}`, { presetId: 'adult' });
  await call('generate: 성인 클라우드 거부', 'POST', `/api/chats/${inline.id}/generate`, { provider: 'openai' });  // 26
  await call('generate: max_tokens 거부 후 재시도', 'POST', `/api/chats/${helper.id}/generate`, { regenerate: true, provider: 'c_strict' }); // 30

  /* ---------- 장면 그리기 ---------- */
  await call('checkpoints', 'GET', `/api/image/checkpoints?baseUrl=${encodeURIComponent(`${MOCK}/comfy`)}`);
  const full = await call('chat: 그리기 전', 'GET', `/api/chats/${chat.id}`);
  const tagFail = full.messages.find((m) => m.content.includes('태그실패'));
  const answer = full.messages.find((m) => m.role === 'assistant');
  await call('image: 검토(재요청)', 'POST', `/api/chats/${chat.id}/messages/${tagFail.id}/image`, { review: true }); // 27
  const drawn = await call('image: 그리기', 'POST', `/api/chats/${chat.id}/messages/${answer.id}/image`, {
    prompt: '1girl, adult, rooftop, night', negative: 'daytime', checkpoint: 'b.safetensors'
  });                                                                                                              // 28
  const done = drawn.find((e) => e.done);
  if (done?.image) {
    await call('image 파일', 'GET', `/api/images/${chat.id}/${done.image.file}`);
    await call('image 지우기', 'DELETE', `/api/chats/${chat.id}/messages/${answer.id}/images/${done.image.id}`);
  }
  await call('image 파일: 잘못된 이름', 'GET', `/api/images/${chat.id}/..%2Fsettings.json`);
  await call('image: 어시스턴트 거부', 'POST', `/api/chats/${helper.id}/messages/nope/image`, {});                 // 29

  /* ---------- 정리 ---------- */
  await call('save-character', 'POST', `/api/chats/${inline.id}/save-character`, {});
  await call('save-character: 1회성 아님', 'POST', `/api/chats/${chat.id}/save-character`, {});
  const now = await call('chat: 지우기 전', 'GET', `/api/chats/${chat.id}`);
  await call('msg: 지우기', 'DELETE', `/api/chats/${chat.id}/messages/${now.messages[1].id}`);
  await call('msg: 없는 것 지우기', 'DELETE', `/api/chats/${chat.id}/messages/nope`);
  await call('character: 지우기(대화는 1회성으로)', 'DELETE', `/api/characters/${hana.id}`);
  await call('chats: 지운 뒤', 'GET', '/api/chats');
  await call('logs', 'GET', '/api/logs');
  await call('logs 지우기', 'DELETE', '/api/logs');
  const backup = await call('export', 'GET', '/api/export');
  await call('import: 형식 아님', 'POST', '/api/import', { data: [] });
  await call('import: 빈 백업', 'POST', '/api/import', { data: { settings: {} } });
  await call('import', 'POST', '/api/import', {
    includeSettings: true,
    data: {
      ...backup,
      settings: { ...backup.settings, historyLimit: 12, presets: [{ id: 'imported', name: '가져온 모드', template: 'x', adult: true }], dev: { adultCloud: true, particleFix: false } },
      characters: [...backup.characters, { id: 'bad id!', name: '새 인물', builtin: '서다인' }, { name: '' }, 3],
      personas: [...backup.personas, { name: '가져온 사람', traits: ['x', 2], director: true }],
      chats: [...backup.chats, { id: 'imp1', title: '', characterId: yuha.id, messages: [{ role: 'x', content: 'hi', swipes: [{ content: 'a' }, { content: 'b' }], swipeIndex: 9, sources: [{ url: 'javascript:x' }, { url: 'https://a.b', title: 't' }] }], archivedAt: 5 }]
    }
  });
  await call('chat: 지우기', 'DELETE', `/api/chats/${chat.id}`);
  await call('chat: 없는 것 지우기', 'DELETE', `/api/chats/${chat.id}`);
  await call('settings: 마지막', 'GET', '/api/settings');
  await call('chats: 마지막', 'GET', '/api/chats');
}
