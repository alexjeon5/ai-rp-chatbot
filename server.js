import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, uid, flushAll, DEFAULT_SYSTEM_TEMPLATE, BUILTIN_TEMPLATES } from './src/store.js';
import { streamChat, listModels, readsAsModelGone, supportsWebSearch } from './src/providers.js';
import { buildSystem, buildHistory, fillVars, withThinking } from './src/prompt.js';
import { makeThoughtStripper, looksRepetitive } from './src/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';

await store.load();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const settings = () => store.settings;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

/* ---------------- 설정 ---------------- */

/**
 * 설정에 읽기 전용 정보를 덧붙여 내려보냅니다.
 * GET 과 PUT 이 같은 모양을 돌려줘야, 저장한 뒤에도 화면이 이 값들을 잃지 않습니다.
 */
function settingsPayload() {
  const webSearchCapable = {};
  for (const [key, cfg] of Object.entries(store.settings.providers)) {
    webSearchCapable[key] = supportsWebSearch(key, cfg);
  }
  return {
    ...store.settings,
    webSearchCapable,
    defaultTemplate: DEFAULT_SYSTEM_TEMPLATE,
    // 내장 틀의 원본 내용. 설정에서 '기본 내용 가져오기' 로 되돌릴 때 씁니다.
    builtinTemplates: BUILTIN_TEMPLATES()
  };
}

app.get('/api/settings', (req, res) => res.json(settingsPayload()));

app.put('/api/settings', (req, res) => {
  const s = store.settings;
  const body = req.body || {};
  Object.assign(s, {
    activeProvider: body.activeProvider ?? s.activeProvider,
    activePersonaId: body.activePersonaId ?? s.activePersonaId,
    historyLimit: body.historyLimit ?? s.historyLimit,
    activePresetId: body.activePresetId ?? s.activePresetId,
    askModeOnNewChat: typeof body.askModeOnNewChat === 'boolean'
      ? body.askModeOnNewChat
      : s.askModeOnNewChat
  });
  if (Array.isArray(body.presets) && body.presets.length) {
    s.presets = body.presets
      .filter((p) => p && p.id && p.name)
      .map((p) => ({
        id: p.id,
        name: p.name,
        template: String(p.template ?? ''),
        adult: Boolean(p.adult)
      }));
    if (!s.presets.some((p) => p.id === s.activePresetId)) s.activePresetId = s.presets[0].id;
  }
  if (body.params) Object.assign(s.params, body.params);
  if (body.providers) {
    for (const [key, cfg] of Object.entries(body.providers)) {
      if (s.providers[key]) {
        // 이 기록은 서버가 실제 오류를 보고 쌓는 것이라, 클라이언트 사본으로 덮지 않습니다.
        const { unavailableModels, ...safe } = cfg || {};
        Object.assign(s.providers[key], safe);
      }
      else if (cfg && cfg.label) {
        // 커스텀 엔진 추가. 내장 엔진 키와 겹치지 않는 이름만 받습니다.
        s.providers[key] = {
          label: String(cfg.label),
          type: ['openai', 'anthropic', 'gemini'].includes(cfg.type) ? cfg.type : 'openai',
          builtin: false,
          baseUrl: String(cfg.baseUrl || ''),
          apiKey: String(cfg.apiKey || ''),
          model: String(cfg.model || ''),
          unavailableModels: []
        };
      }
    }
  }
  if (Array.isArray(body.removeProviders)) {
    for (const key of body.removeProviders) {
      if (s.providers[key] && !s.providers[key].builtin) delete s.providers[key];
    }
    if (!s.providers[s.activeProvider]) s.activeProvider = 'lmstudio';
  }
  if (body.assistant) {
    if (typeof body.assistant.systemPrompt === 'string') s.assistant.systemPrompt = body.assistant.systemPrompt;
    if (typeof body.assistant.webSearch === 'boolean') s.assistant.webSearch = body.assistant.webSearch;
    if (typeof body.assistant.thinking === 'boolean') s.assistant.thinking = body.assistant.thinking;
    if (body.assistant.params) Object.assign(s.assistant.params, body.assistant.params);
  }
  if (body.dev) {
    if (typeof body.dev.particleFix === 'boolean') s.dev.particleFix = body.dev.particleFix;
    if (body.dev.markup) Object.assign(s.dev.markup, body.dev.markup);
    if (body.dev.theme) Object.assign(s.dev.theme, body.dev.theme);
  }
  store.saveSettings();
  res.json(settingsPayload());
});

app.get('/api/models', wrap(async (req, res) => {
  const provider = req.query.provider || settings().activeProvider;
  const models = await listModels(provider, settings().providers[provider]);
  res.json({ models });
}));

/* ---------------- 캐릭터 / 페르소나 ---------------- */

/** 컬렉션 하나에 대한 목록·추가·수정·삭제 경로를 한 번에 만듭니다. */
function crud(name, collection, fields) {
  app.get(`/api/${name}`, (req, res) => res.json(collection.all()));

  app.post(`/api/${name}`, (req, res) => {
    const draft = {};
    for (const f of fields) draft[f] = req.body?.[f] ?? '';
    if (!draft.name?.trim()) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    res.json(collection.add(draft));
  });

  app.put(`/api/${name}/:id`, (req, res) => {
    const patch = {};
    for (const f of fields) if (f in (req.body || {})) patch[f] = req.body[f];
    const item = collection.update(req.params.id, patch);
    if (!item) return res.status(404).json({ error: '없는 항목입니다.' });
    res.json(item);
  });

  app.delete(`/api/${name}/:id`, wrap(async (req, res) => {
    if (!(await collection.remove(req.params.id))) {
      return res.status(404).json({ error: '없는 항목입니다.' });
    }
    res.json({ ok: true });
  }));
}

const CHARACTER_FIELDS = [
  'name', 'avatar', 'tags', 'description', 'personality',
  'speech', 'scenario', 'greeting', 'exampleDialogue', 'notes'
];

crud('characters', store.characters, CHARACTER_FIELDS);
crud('personas', store.personas, ['name', 'description']);

/** 내장 캐릭터 중 아직 없는 것만 추가합니다. 기존 캐릭터는 손대지 않습니다. */
app.post('/api/characters/seed', (req, res) => {
  const added = store.addMissingBuiltins();
  res.json({ added, characters: store.characters.all() });
});

/* ---------------- 대화 ---------------- */

/** 사설망·localhost 주소인지. 로컬 엔진은 API 키를 요구하지 않습니다. */
const isLocalUrl = (url = '') =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);

/** 대화에 박혀 있는 1회성 캐릭터가 우선입니다. */
const characterOf = (chat) => chat.character || store.characters.get(chat.characterId);

const presetOf = (id) => {
  const s = store.settings;
  return s.presets.find((p) => p.id === id) || s.presets.find((p) => p.id === s.activePresetId) || s.presets[0];
};

app.get('/api/chats', (req, res) => {
  res.json(store.chats.all().map(({ messages, ...rest }) => {
    const assistant = rest.kind === 'assistant';
    const preset = presetOf(rest.presetId);
    const character = assistant ? null : characterOf(rest);
    return {
      ...rest,
      kind: rest.kind || 'rp',
      avatar: character?.avatar || '',
      onceOnly: Boolean(rest.character),
      presetName: assistant ? '어시스턴트' : preset.name,
      adult: assistant ? false : preset.adult,
      messageCount: messages.length,
      preview: messages[messages.length - 1]?.content?.slice(0, 60) || ''
    };
  }));
});

app.get('/api/chats/:id', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  res.json(chat);
});

app.post('/api/chats', (req, res) => {
  if (req.body?.kind === 'assistant') {
    return res.json(store.chats.add({
      kind: 'assistant',
      characterId: null,
      personaId: null,
      title: '새 채팅',
      updatedAt: Date.now(),
      messages: []
    }));
  }

  // 1회성 캐릭터는 목록에 넣지 않고 대화 안에 그대로 담습니다.
  const inline = req.body?.character;
  const character = inline?.name?.trim()
    ? { ...CHARACTER_FIELDS.reduce((o, f) => ({ ...o, [f]: String(inline[f] ?? '') }), {}), id: null }
    : store.characters.get(req.body?.characterId);
  if (!character) return res.status(400).json({ error: '캐릭터를 먼저 선택해 주세요.' });
  const persona = store.personas.get(req.body?.personaId ?? settings().activePersonaId);

  const chat = {
    kind: 'rp',
    characterId: character.id,
    ...(character.id ? {} : { character }),
    personaId: persona?.id || null,
    title: character.name,
    presetId: req.body?.presetId || settings().activePresetId,
    updatedAt: Date.now(),
    messages: []
  };
  if (character.greeting?.trim()) {
    chat.messages.push({
      id: uid(),
      role: 'assistant',
      content: fillVars(character.greeting, { char: character.name, user: persona?.name }),
      at: Date.now()
    });
  }
  res.json(store.chats.add(chat));
});

app.put('/api/chats/:id', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  if (req.body.title) chat.title = req.body.title;
  if (req.body.personaId !== undefined) chat.personaId = req.body.personaId;
  if (req.body.presetId !== undefined) chat.presetId = req.body.presetId;
  store.chats.save(chat.id);
  res.json(chat);
});

app.delete('/api/chats/:id', wrap(async (req, res) => {
  if (!(await store.chats.remove(req.params.id))) {
    return res.status(404).json({ error: '없는 대화입니다.' });
  }
  res.json({ ok: true });
}));

app.post('/api/chats/:id/messages', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const msg = {
    id: uid(),
    role: req.body?.role === 'assistant' ? 'assistant' : 'user',
    content: String(req.body?.content ?? ''),
    at: Date.now()
  };
  if (chat.kind === 'assistant' && chat.title === '새 채팅' && msg.role === 'user') {
    chat.title = msg.content.trim().slice(0, 24) || '새 채팅';
  }
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  store.chats.save(chat.id);
  res.json(msg);
});

app.put('/api/chats/:id/messages/:mid', (req, res) => {
  const chat = store.chats.get(req.params.id);
  const msg = chat?.messages.find((m) => m.id === req.params.mid);
  if (!msg) return res.status(404).json({ error: '없는 메시지입니다.' });
  msg.content = String(req.body?.content ?? msg.content);
  msg.editedAt = Date.now();
  store.chats.save(chat.id);
  res.json(msg);
});

app.delete('/api/chats/:id/messages/:mid', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const i = chat.messages.findIndex((m) => m.id === req.params.mid);
  if (i < 0) return res.status(404).json({ error: '없는 메시지입니다.' });
  chat.messages.splice(i, 1);
  store.chats.save(chat.id);
  res.json({ ok: true });
});

/* ---------------- 생성 (SSE) ---------------- */

app.post('/api/chats/:id/generate', wrap(async (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const assistant = chat.kind === 'assistant';

  let character = null;
  let persona = null;
  if (!assistant) {
    character = characterOf(chat);
    if (!character) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
    persona = store.personas.get(chat.personaId) || store.personas.get(s.activePersonaId);
  }

  // 다시 생성: 마지막 assistant 응답을 걷어냅니다.
  if (req.body?.regenerate) {
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') {
      chat.messages.pop();
    }
  }

  const provider = req.body?.provider || s.activeProvider;
  const config = s.providers[provider];
  if (!config) return res.status(400).json({ error: `설정되지 않은 엔진: ${provider}` });
  if (!config.model) return res.status(400).json({ error: '설정에서 모델을 먼저 선택해 주세요.' });
  if (!config.apiKey && !isLocalUrl(config.baseUrl)) {
    return res.status(400).json({ error: `${config.label} API 키가 비어 있습니다. 설정에서 입력해 주세요.` });
  }

  let system;
  let params = s.params;
  let webSearch = false;
  let thinking = false;
  if (assistant) {
    system = s.assistant.systemPrompt;
    params = s.assistant.params;
    webSearch = Boolean(s.assistant.webSearch);
    thinking = Boolean(s.assistant.thinking);
    system = withThinking(system, thinking);
    if (webSearch && !supportsWebSearch(provider, config)) {
      return res.status(400).json({
        error: `웹 검색을 지원하지 않는 엔진입니다 (${config.label}).\n` +
          '검색을 지원하는 엔진(Gemini, Anthropic, OpenAI 검색 모델)으로 바꾸거나 웹 검색을 꺼 주세요.'
      });
    }
  } else {
    const preset = presetOf(chat.presetId);
    if (preset.adult && !isLocalUrl(config.baseUrl)) {
      return res.status(400).json({
        error: `'${preset.name}' 모드는 로컬 엔진으로만 보낼 수 있습니다.\n` +
          `지금 선택된 엔진은 로컬 주소가 아닙니다 (${config.label}).\n` +
          '설정에서 엔진을 LM Studio 로 바꾸거나, 대화 상단에서 다른 모드를 선택하세요.'
      });
    }
    system = buildSystem({
      character,
      persona,
      template: preset.template,
      particleFix: s.dev.particleFix
    });
  }
  const history = buildHistory(chat, s.historyLimit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // 브라우저가 창을 닫거나 '멈추기'를 누르면 응답 소켓이 끊깁니다.
  // req 의 close 는 요청 본문이 끝날 때도 발생하므로 res 를 봐야 합니다.
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  let text = '';
  let thought = '';
  let loopStopped = false;
  const sources = [];
  const onThought = (t) => {
    // 생각을 껐는데도 사고 조각을 보내는 엔진이 있습니다. 여기서 한 번 더 막습니다.
    if (!thinking || !t) return;
    thought += t;
    send({ thought: t });
  };
  // 로컬 모델의 사고 블록은 사고를 껐을 때도 나오므로, 켰을 때만 화면으로 넘깁니다.
  const stripper = makeThoughtStripper({ onThought: thinking ? onThought : undefined });
  try {
    const stream = streamChat({
      provider,
      config,
      system,
      messages: history,
      params,
      webSearch,
      sources,
      thinking,
      onThought,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      const clean = stripper.feed(chunk);
      if (!clean) continue;
      text += clean;
      send({ delta: clean });

      // 같은 조각을 끝없이 되풀이하면 최대 길이를 다 채울 때까지 멈추지 않습니다.
      if (looksRepetitive(text)) {
        loopStopped = true;
        controller.abort();
        break;
      }
    }
    const tail = stripper.flush();
    if (tail) {
      text += tail;
      send({ delta: tail });
    }
    // 출처는 본문에 섞지 않습니다. 구글 근거 링크는 길고 읽을 수도 없어 접어서 보여 줍니다.
    if (sources.length) send({ sources });
  } catch (e) {
    if (!controller.signal.aborted) send({ error: describeFailure(e, provider, config) });
  }

  if (loopStopped) {
    const notice = '\n\n(같은 말이 되풀이되어 생성을 멈췄습니다. 재전송을 누르거나, 설정에서 반복 억제 값을 올려 보세요.)';
    text += notice;
    send({ delta: notice });
  }

  finished = true;
  if (text.trim()) {
    const msg = { id: uid(), role: 'assistant', content: text.trim(), at: Date.now(), provider, model: config.model };
    // 사고와 출처는 본문과 따로 둡니다. 다음 턴에 같이 보내지 않으므로 맥락을 잡아먹지 않습니다.
    if (thought.trim()) msg.thought = thought.trim().slice(0, 6000);
    if (sources.length) msg.sources = sources.slice(0, 20);
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    store.chats.save(chat.id);
    send({ done: true, message: msg });
  } else {
    send({ done: true, message: null });
  }
  res.end();
}));

/**
 * 못 쓰는 모델이면 기록해 두고, 사람이 읽을 만한 안내로 바꿔 돌려줍니다.
 * 같은 모델을 다시 고르지 않도록 이후 목록에서 빠집니다.
 */
function describeFailure(error, provider, config) {
  const gone = readsAsModelGone(error);
  if (!gone) return error.message;

  const list = config.unavailableModels || (config.unavailableModels = []);
  if (config.model && !list.includes(config.model)) {
    list.push(config.model);
    store.saveSettings();
  }

  const lines = [`이 계정에서 쓸 수 없는 모델입니다 (${config.model}). 목록에서 감췄습니다.`];
  if (gone.replacement) lines.push(`API 가 권하는 대체 모델: ${gone.replacement}`);
  lines.push('설정에서 모델을 다시 선택해 주세요. 불러오기를 누르면 쓸 수 있는 모델만 나옵니다.');
  return lines.join('\n');
}

/** 1회성 캐릭터를 캐릭터 목록에 넣습니다. 마음에 들면 계속 쓰라고. */
app.post('/api/chats/:id/save-character', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat?.character) return res.status(400).json({ error: '1회성 캐릭터가 아닙니다.' });

  const saved = store.characters.add({ ...chat.character, id: undefined });
  chat.characterId = saved.id;
  delete chat.character;
  store.chats.save(chat.id);
  res.json({ character: saved });
});

/** 감춰 둔 모델 기록을 지웁니다. 계정 상태가 바뀌었을 때 씁니다. */
app.delete('/api/providers/:key/unavailable', (req, res) => {
  const cfg = settings().providers[req.params.key];
  if (!cfg) return res.status(404).json({ error: '없는 엔진입니다.' });
  const count = (cfg.unavailableModels || []).length;
  cfg.unavailableModels = [];
  store.saveSettings();
  res.json({ cleared: count });
});

/** 개발자 설정의 '시스템 프롬프트 미리보기'가 쓰는 엔드포인트입니다. */
app.get('/api/chats/:id/system', (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });

  if (chat.kind === 'assistant') {
    return res.json({ system: s.assistant.systemPrompt, turns: buildHistory(chat, s.historyLimit).length });
  }
  const character = characterOf(chat);
  if (!character) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
  const persona = store.personas.get(chat.personaId) || store.personas.get(s.activePersonaId);
  const preset = presetOf(chat.presetId);
  res.json({
    system: buildSystem({ character, persona, template: preset.template, particleFix: s.dev.particleFix }),
    turns: buildHistory(chat, s.historyLimit).length
  });
});

/* ---------------- 백업 ---------------- */

app.get('/api/export', (req, res) => {
  const { providers, ...safeSettings } = store.settings; // API 키는 내보내지 않습니다.
  res.setHeader('Content-Disposition', 'attachment; filename="rp-chat-backup.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
    characters: store.characters.all(),
    personas: store.personas.all(),
    chats: store.chats.all()
  });
});

// 종료 신호를 받으면 큐에 남은 쓰기를 끝내고 나갑니다.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flushAll().catch(console.error);
    process.exit(0);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`AI 롤플레이 & 어시스턴트: http://${HOST}:${PORT}`);
});
