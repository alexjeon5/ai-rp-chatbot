import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, uid, flushAll, DEFAULT_SYSTEM_TEMPLATE, BUILTIN_TEMPLATES } from './src/store.js';
import { streamChat, listModels, readsAsModelGone, supportsWebSearch } from './src/providers.js';
import { listLogs, clearLogs } from './src/logs.js';
import { buildSystem, buildHistory, fillVars, withThinking } from './src/prompt.js';
import { makeThoughtStripper, looksRepetitive } from './src/sanitize.js';
import { rollSeeds, sanitizeSeeds, SEED_FIELDS, SEED_KEYS } from './src/persona-seeds.js';
import { GEN_SYSTEM, genSystem, buildGenPrompt, cleanGenerated, fallbackDescription } from './src/persona-gen.js';
import {
  CHAR_GEN_SYSTEM, CHAR_FIELDS as CHAR_GEN_FIELDS, buildCharPrompt, parseCharacter, looksUsable,
  mergeCharacters, roughFallback
} from './src/character-gen.js';
import {
  isLocalUrl, checkBaseUrl, resolveApiKey, maskProviders, rateLimit, sameOrigin
} from './src/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';

await store.load();

const app = express();

// 리버스 프록시(Nginx Proxy Manager) 뒤에 있으면 켭니다.
// 켜야 요청 제한이 프록시 IP 하나가 아니라 실제 접속자 기준으로 걸립니다.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use(express.json({ limit: '2mb' }));
app.use('/api', sameOrigin);
app.use(express.static(path.join(__dirname, 'public')));

// 밖으로 요청을 내보내는 경로만 제한합니다. 화면 조작은 막지 않습니다.
const generateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: '요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.'
});
const modelsLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: '모델 목록 요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.'
});

/** 엔진 설정을 쓸 때는 항상 이걸 거칩니다. 환경변수 키가 우선 적용됩니다. */
function engineConfig(providerKey) {
  const cfg = store.settings.providers[providerKey];
  if (!cfg) return null;
  return { ...cfg, apiKey: resolveApiKey(providerKey, cfg) };
}

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
    webSearchCapable[key] = supportsWebSearch(key, { ...cfg, apiKey: resolveApiKey(key, cfg) });
  }
  return {
    ...store.settings,
    // API 키는 브라우저로 내보내지 않습니다. 들어 있는지 여부만 알려 줍니다.
    providers: maskProviders(store.settings.providers),
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
    // 주소를 먼저 전부 검사합니다. 하나라도 걸리면 아무것도 저장하지 않습니다.
    for (const [key, cfg] of Object.entries(body.providers)) {
      if (cfg?.baseUrl === undefined) continue;
      const verdict = checkBaseUrl(String(cfg.baseUrl));
      if (!verdict.ok) {
        return res.status(400).json({ error: `'${key}' 엔진 주소를 쓸 수 없습니다.\n${verdict.reason}` });
      }
    }

    for (const [key, cfg] of Object.entries(body.providers)) {
      if (s.providers[key]) {
        // 이 기록은 서버가 실제 오류를 보고 쌓는 것이라, 클라이언트 사본으로 덮지 않습니다.
        // hasApiKey / keyFromEnv 는 서버가 만들어 내보낸 표시용 값이라 되돌려 받지 않습니다.
        const { unavailableModels, hasApiKey, keyFromEnv, apiKey, ...safe } = cfg || {};
        Object.assign(s.providers[key], safe);

        /*
         * 키는 이제 마스킹해서 내려보내므로, 화면에서 돌아오는 값은 대개 빈 문자열입니다.
         * 그걸 그대로 덮으면 저장해 둔 키가 지워집니다.
         *   빈 값  → 그대로 둠 (사용자가 건드리지 않은 것)
         *   null  → 지우기 (화면의 '키 지우기')
         *   그 외  → 새 키로 교체
         */
        if (apiKey === null) s.providers[key].apiKey = '';
        else if (typeof apiKey === 'string' && apiKey.trim()) s.providers[key].apiKey = apiKey.trim();
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

app.get('/api/models', modelsLimit, wrap(async (req, res) => {
  const provider = req.query.provider || settings().activeProvider;
  const config = engineConfig(provider);
  if (!config) return res.status(400).json({ error: `설정되지 않은 엔진: ${provider}` });

  // 저장된 값이라도 한 번 더 봅니다. 허용 목록이 바뀌었거나
  // settings.json 을 직접 고친 경우가 있습니다.
  const verdict = checkBaseUrl(config.baseUrl);
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });

  const models = await listModels(provider, config);
  res.json({ models });
}));

/* ---------------- 통신 로그 ---------------- */

/** 대화 내용은 담지 않습니다 — 요청 대상 주소·상태 코드·걸린 시간·오류 메시지뿐입니다. */
app.get('/api/logs', (req, res) => res.json({ logs: listLogs() }));
app.delete('/api/logs', (req, res) => { clearLogs(); res.json({ ok: true }); });

/* ---------------- 캐릭터 / 페르소나 ---------------- */

/** 컬렉션 하나에 대한 목록·추가·수정·삭제 경로를 한 번에 만듭니다. */
function crud(name, collection, fields, { beforeRemove } = {}) {
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
    const item = collection.get(req.params.id);
    if (item) beforeRemove?.(item);
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

/**
 * 캐릭터를 지워도 그 캐릭터와 나눈 대화는 계속 이어갈 수 있어야 합니다.
 * 지우기 전에 캐릭터 정보를 대화 안에 복사해 1회성 캐릭터로 바꿔 둡니다.
 * 마음이 바뀌면 대화 상단의 '캐릭터 저장' 으로 다시 목록에 넣을 수 있습니다.
 */
function detachCharacter(character) {
  const copy = { ...CHARACTER_FIELDS.reduce((o, f) => ({ ...o, [f]: String(character[f] ?? '') }), {}), id: null };
  for (const chat of store.chats.all()) {
    if (chat.characterId !== character.id || chat.character) continue;
    chat.character = { ...copy };
    chat.characterId = null;
    store.chats.save(chat.id);
  }
}

crud('characters', store.characters, CHARACTER_FIELDS, { beforeRemove: detachCharacter });
crud('personas', store.personas, ['name', 'description']);

/* ---------------- 랜덤 페르소나 ---------------- */

/**
 * 1단계 — 씨앗 태그만 굴립니다. 모델을 부르지 않으므로 즉시 끝나고 요청 제한도 걸지 않습니다.
 * body: { seeds?, only?: ['trait', ...] }  only 를 주면 그 항목만 다시 굴립니다.
 */
app.post('/api/personas/roll', (req, res) => {
  const keep = sanitizeSeeds(req.body?.seeds || {});
  const only = Array.isArray(req.body?.only)
    ? req.body.only.filter((k) => SEED_KEYS.includes(k))
    : null;
  const adult = Boolean(req.body?.adult);
  res.json({ seeds: rollSeeds(keep, only?.length ? only : null, adult), fields: SEED_FIELDS });
});

/**
 * 2단계 — 씨앗 태그를 모델에 넘겨 소개 문단을 받습니다.
 * 엔진이 없거나 실패하면 태그만으로 만든 문장을 대신 돌려줍니다 (fallback: true).
 * adult 가 켜져 있으면 대화의 성인 프리셋과 같은 규칙을 씁니다 — 로컬 엔진으로만 나갑니다.
 */
app.post('/api/personas/generate', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const adult = Boolean(req.body?.adult);
  const seeds = rollSeeds(sanitizeSeeds(req.body?.seeds || {}), null, adult);
  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);

  const bail = (reason) => res.json({
    seeds,
    name: seeds.name,
    description: fallbackDescription(seeds),
    fallback: true,
    reason
  });

  if (!config || !config.model) return bail('엔진이나 모델이 설정되지 않았습니다.');
  const verdict = checkBaseUrl(config.baseUrl);
  if (!verdict.ok) return bail(verdict.reason);
  if (!config.apiKey && !isLocalUrl(config.baseUrl)) return bail(`${config.label} API 키가 비어 있습니다.`);
  // 대화의 성인 프리셋과 같은 규칙: 외부 API 로는 성인 태그를 내보내지 않습니다.
  if (adult && !isLocalUrl(config.baseUrl)) {
    return bail(`성인 페르소나 생성은 로컬 엔진으로만 가능합니다. 지금 선택된 엔진은 로컬 주소가 아닙니다 (${config.label}).`);
  }

  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  // 소개 한 문단이면 충분하므로 길이를 짧게 잡고, 온도는 설정값을 따릅니다.
  const params = { ...s.params, maxTokens: Math.min(s.params.maxTokens ?? 2048, 700) };
  const stripper = makeThoughtStripper({});
  let text = '';
  try {
    const stream = streamChat({
      provider,
      config,
      system: withThinking(genSystem(adult), false),
      messages: [{ role: 'user', content: buildGenPrompt(seeds) }],
      params,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      text += stripper.feed(chunk);
      if (looksRepetitive(text)) { controller.abort(); break; }
    }
    text += stripper.flush();
  } catch (e) {
    finished = true;
    if (controller.signal.aborted) return;
    return bail(e.message);
  }

  finished = true;
  const description = cleanGenerated(text);
  if (!description) return bail('모델이 빈 응답을 보냈습니다.');
  res.json({ seeds, name: seeds.name, description, fallback: false });
}));

/** 내장 캐릭터 중 아직 없는 것만 추가합니다. 기존 캐릭터는 손대지 않습니다. */
app.post('/api/characters/seed', (req, res) => {
  const added = store.addMissingBuiltins();
  res.json({ added, characters: store.characters.all() });
});

/**
 * 줄글 설명 하나를 캐릭터 시트로 바꿔 돌려줍니다. 저장은 하지 않습니다 —
 * 화면의 입력 칸을 채워 주기만 하고, 사람이 고친 뒤 기존 저장 버튼으로 넣습니다.
 * body: { brief, current?, provider? }  current 는 사용자가 이미 채워 둔 칸(그대로 유지됩니다).
 */
app.post('/api/characters/draft', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const brief = String(req.body?.brief || '').trim().slice(0, 4000);
  if (!brief) return res.status(400).json({ error: '어떤 캐릭터인지 먼저 적어 주세요.' });

  const current = {};
  for (const { key } of CHAR_GEN_FIELDS) {
    const value = req.body?.current?.[key];
    if (typeof value === 'string' && value.trim()) current[key] = value.trim().slice(0, 2000);
  }

  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  if (!config || !config.model) {
    return res.status(400).json({ error: '설정에서 엔진과 모델을 먼저 선택해 주세요.' });
  }
  const verdict = checkBaseUrl(config.baseUrl);
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });
  if (!config.apiKey && !isLocalUrl(config.baseUrl)) {
    return res.status(400).json({ error: `${config.label} API 키가 비어 있습니다. 설정에서 입력해 주세요.` });
  }

  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  // 구조화된 라벨 출력이 목적이라, 롤플레이용 온도보다 낮게 고정합니다.
  // 온도가 높을수록 라벨을 바꿔 쓰거나 형식을 벗어나는 일이 잦아집니다.
  const params = {
    ...s.params,
    temperature: Math.min(s.params.temperature ?? 1, 0.5),
    maxTokens: Math.max(s.params.maxTokens ?? 2048, 1500)
  };

  /** 지금까지 정해진 값(known) 이후의 빈칸만 채우도록 한 번 부릅니다. */
  const ask = async (known) => {
    // 라벨 형식 텍스트는 "성격:", "말투:" 처럼 짧은 줄이 반복되는 모양이라
    // 반복 감지가 오작동하기 쉬워, 이 엔드포인트에서는 반복 감지를 쓰지 않습니다.
    // 대신 maxTokens 로 상한을 잡아 둡니다.
    const stripper = makeThoughtStripper({});
    let out = '';
    const stream = streamChat({
      provider,
      config,
      system: withThinking(CHAR_GEN_SYSTEM, false),
      messages: [{ role: 'user', content: buildCharPrompt(brief, known) }],
      params,
      signal: controller.signal
    });
    for await (const chunk of stream) out += stripper.feed(chunk);
    return out + stripper.flush();
  };

  let text;
  try {
    text = await ask(current);
  } catch (e) {
    finished = true;
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: describeFailure(e, provider, config) });
  }

  let character = mergeCharacters(current, parseCharacter(text));
  let lastText = text;

  // 첫 시도에서 알맹이(성격/소개/배경/말투 중 하나)가 안 나왔으면, 이미 채워진 항목은
  // 그대로 두고 남은 빈칸만 한 번 더 요청합니다. 매번 처음부터 다시 시키는 것보다
  // 빈칸만 채우게 하는 쪽이 형식이 훨씬 안정적으로 나옵니다.
  if (!looksUsable(character)) {
    try {
      const retryText = await ask(character);
      lastText = retryText;
      character = mergeCharacters(character, parseCharacter(retryText));
    } catch (e) {
      if (controller.signal.aborted) { finished = true; return; }
      // 재시도 자체가 실패해도 첫 시도 결과는 살아 있으니 계속 진행합니다.
    }
  }

  finished = true;

  if (!looksUsable(character)) {
    // 그래도 라벨을 못 읽었으면 빈 칸으로 돌려보내는 대신, 모델이 실제로 쓴 글을
    // 추가 설정 칸에 남겨서 손으로라도 옮길 거리를 줍니다. 재시도가 있었다면
    // 그쪽이 더 최근 시도이므로 재시도의 원문을 씁니다.
    character = roughFallback(character, lastText);
    return res.json({
      character,
      fallback: true,
      reason: '모델이 형식을 지키지 않아 일부만 채워졌습니다. 나머지는 직접 채우거나 다시 시도해 보세요.'
    });
  }
  res.json({ character, fallback: false });
}));

/* ---------------- 대화 ---------------- */

/** 대화에 박혀 있는 1회성 캐릭터가 우선입니다. */
const characterOf = (chat) => chat.character || store.characters.get(chat.characterId);

const presetOf = (id) => {
  const s = store.settings;
  return s.presets.find((p) => p.id === id) || s.presets.find((p) => p.id === s.activePresetId) || s.presets[0];
};

app.get('/api/chats', (req, res) => {
  // 최근에 대화한 순서로 보여 줍니다. 오래된 대화를 이어가면 위로 올라옵니다.
  const chats = store.chats.all().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  res.json(chats.map(({ messages, ...rest }) => {
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

app.post('/api/chats/:id/generate', generateLimit, wrap(async (req, res) => {
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

  /*
   * 다시 생성: 마지막 assistant 응답을 빼고 보냅니다.
   * 실제로 지우는 건 새 응답이 만들어진 뒤입니다. 검사에 걸리거나 생성이 실패해도
   * 이전 응답이 그대로 남도록.
   */
  const regenerate = Boolean(req.body?.regenerate);
  const trailingAssistants = (list) => {
    let n = 0;
    while (n < list.length && list[list.length - 1 - n].role === 'assistant') n += 1;
    return n;
  };
  const basis = regenerate
    ? { ...chat, messages: chat.messages.slice(0, chat.messages.length - trailingAssistants(chat.messages)) }
    : chat;

  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  if (!config) return res.status(400).json({ error: `설정되지 않은 엔진: ${provider}` });
  if (!config.model) return res.status(400).json({ error: '설정에서 모델을 먼저 선택해 주세요.' });

  const verdict = checkBaseUrl(config.baseUrl);
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });
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
  const history = buildHistory(basis, s.historyLimit);

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
  // '중지' 는 연결을 끊지 않고 이 컨트롤러만 멈춥니다. 그래야 쓰다 만 답변을
  // 저장한 뒤 화면에도 돌려줄 수 있습니다.
  const run = { controller };
  running.set(chat.id, run);

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
  if (running.get(chat.id) === run) running.delete(chat.id);
  if (text.trim()) {
    // 새 응답이 생겼으니 이제 이전 응답을 걷어냅니다.
    if (regenerate) chat.messages.splice(chat.messages.length - trailingAssistants(chat.messages));
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

/** 생성 중인 대화. 대화 id → { controller } */
const running = new Map();

/** 진행 중인 생성을 멈춥니다. 지금까지 쓴 내용은 저장되고 화면에도 남습니다. */
app.post('/api/chats/:id/stop', (req, res) => {
  const run = running.get(req.params.id);
  if (!run) return res.json({ stopped: false });
  run.controller.abort();
  res.json({ stopped: true });
});

/**
 * 못 쓰는 모델이면 기록해 두고, 사람이 읽을 만한 안내로 바꿔 돌려줍니다.
 * 같은 모델을 다시 고르지 않도록 이후 목록에서 빠집니다.
 */
function describeFailure(error, provider, config) {
  const gone = readsAsModelGone(error);
  if (!gone) return error.message;

  // config 는 키를 채워 넣은 사본이므로, 기록은 저장된 원본 쪽에 남겨야 합니다.
  const stored = store.settings.providers[provider] || config;
  const list = stored.unavailableModels || (stored.unavailableModels = []);
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
