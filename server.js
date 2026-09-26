import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, uid, flushAll, merge, DEFAULT_SYSTEM_TEMPLATE, BUILTIN_TEMPLATES } from './src/store.js';
import { streamChat, listModels, readsAsModelGone, supportsWebSearch } from './src/providers.js';
import { listLogs, clearLogs } from './src/logs.js';
import { buildSystem, fillVars, withThinking } from './src/prompt.js';
import { makeThoughtStripper, looksRepetitive } from './src/sanitize.js';
import { planContext, contextLimitOf, estimateTokens, nextRatio } from './src/context.js';
import {
  IMAGE_DEFAULTS, DEFAULT_WORKFLOW, looksLikeWorkflow, fillWorkflow, composePrompt, splitTags,
  IMAGE_PROMPT_SYSTEM, IMAGE_RETRY_PROMPT, buildImageMessages, parseSceneOutput, previewOutput, seedOf,
  listSamplers, COMMON_SAMPLERS, COMMON_SCHEDULERS,
  listCheckpoints, renderImage,
  freeMemory, CORE_BLOCK_TERMS, CORE_NEGATIVE
} from './src/image.js';
import { mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import {
  addSwipe, showSwipe, syncSwipe, joinContinuation, CONTINUE_PROMPT, withAuthorNote,
  pendingForSummary, takeChunk, SUMMARY_MIN, SUMMARY_SYSTEM, buildSummaryPrompt, cleanSummary, MEMORY_MAX_CHARS,
  FACT_EVERY, factsWindow, turnsSinceFacts, FACTS_SYSTEM, buildFactsPrompt, parseFactOps, applyFactOps,
  invalidateFacts, cleanFacts, impersonatePrompt, cleanImpersonation
} from './src/chat-ops.js';
import { rollSeeds, sanitizeSeeds, SEED_FIELDS, SEED_KEYS } from './src/persona-seeds.js';
import { GEN_SYSTEM, genSystem, buildGenPrompt, cleanGenerated, fallbackDescription } from './src/persona-gen.js';
import {
  CHAR_GEN_SYSTEM, CHAR_FIELDS as CHAR_GEN_FIELDS, buildCharPrompt, parseCharacter, looksUsable,
  mergeCharacters, roughFallback
} from './src/character-gen.js';
import {
  isLocalUrl, checkBaseUrl, resolveApiKey, maskProviders, rateLimit, sameOrigin
} from './src/security.js';
import { createAuth } from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1';

await store.load();
const auth = await createAuth({ host: HOST });

const app = express();

// 리버스 프록시(Nginx Proxy Manager) 뒤에 있으면 켭니다.
// 켜야 요청 제한이 프록시 IP 하나가 아니라 실제 접속자 기준으로 걸립니다.
//
// 환경변수는 늘 문자열이라, "1" 을 그대로 넘기면 Express 는 이를 홉 수가 아니라 주소 "1" 로 읽고
// 아무도 믿지 않습니다. 숫자만 있으면 숫자로 바꿔 넘깁니다. 주소(예: "192.168.0.20")는 그대로 둡니다.
const trustProxy = (process.env.TRUST_PROXY || '').trim();
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// 백업 불러오기는 대화가 쌓이면 수십 MB 가 되므로 그 경로만 한도를 넉넉히 둡니다.
const jsonBody = express.json({ limit: '2mb' });
const importBody = express.json({ limit: '64mb' });
app.use((req, res, next) => (req.path === '/api/import' ? importBody : jsonBody)(req, res, next));

/* ---------------- 로그인 ---------------- */

// 쿠키를 보고 req.user 를 채웁니다. 이 줄 아래의 모든 곳에서 누가 보낸 요청인지 알 수 있습니다.
app.use(auth.attachUser);
// 로그인하지 않았으면 첫 화면 대신 로그인 페이지로 보냅니다.
app.use(auth.pageGate);
app.use('/api', sameOrigin);

// 로그인 시도는 IP 기준으로 셉니다. IP 를 속이는 경우는 auth.js 의 전체 실패 상한이 막습니다.
const loginLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: '로그인 시도가 너무 잦습니다. 15분 뒤에 다시 시도해 주세요.'
});
app.post('/api/login', loginLimit, (req, res) => auth.login(req, res).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: '로그인을 처리하지 못했습니다.' });
}));
app.post('/api/logout', auth.logout);

// 여기부터 /api 는 전부 로그인해야 쓸 수 있습니다. 위 두 경로만 예외입니다.
app.use('/api', auth.requireAuth);
app.get('/api/me', auth.me);

app.use(express.static(path.join(__dirname, 'public')));

// 밖으로 요청을 내보내는 경로만 제한합니다. 화면 조작은 막지 않습니다.
// 로그인한 뒤라 사용자 기준으로 셉니다. 헤더를 속여 IP 를 바꿔도 제한을 피할 수 없습니다.
const byUser = (req) => req.user && `user:${req.user.id}`;
const generateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: '요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.',
  keyOf: byUser
});
const modelsLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: '모델 목록 요청이 너무 잦습니다. 잠시 뒤에 다시 시도해 주세요.',
  keyOf: byUser
});

/**
 * 주인만 바꿀 수 있는 설정 항목을 멤버의 요청에서 걸러 냅니다.
 * 설정 창은 모든 탭을 한 번에 보내므로, 거절하지 않고 조용히 빼야 멤버도 나머지 설정을 저장할 수 있습니다.
 *   providers / removeProviders : 엔진 주소와 API 키
 *   image                       : ComfyUI 주소
 *   dev.adultCloud              : 성인 대화를 클라우드 엔진으로 보내는 허용 (막히는 건 주인의 API 키)
 */
function ownerFieldsOnly(req, res, next) {
  if (req.user?.role === 'owner' || !req.body) return next();
  delete req.body.providers;
  delete req.body.removeProviders;
  delete req.body.image;
  if (req.body.dev) delete req.body.dev.adultCloud;
  next();
}

/** 엔진 설정을 쓸 때는 항상 이걸 거칩니다. 환경변수 키가 우선 적용됩니다. */
function engineConfig(providerKey) {
  const cfg = store.settings.providers[providerKey];
  if (!cfg) return null;
  return { ...cfg, apiKey: resolveApiKey(providerKey, cfg) };
}

const settings = () => store.settings;

/**
 * 성인 대화를 이 엔진으로 보내도 되는지. 기본은 로컬 엔진만 허용합니다.
 * 개발자 설정에서 경고를 확인하고 클라우드 허용을 켜 두면 외부 API 로도 보냅니다.
 */
const adultAllowed = (config) =>
  isLocalUrl(config?.baseUrl || '') || settings().dev?.adultCloud === true;

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
    builtinTemplates: BUILTIN_TEMPLATES(),
    // 그림 필터 중 고칠 수 없는 부분(모든 대화에 적용). 이미지 설정 창에 읽기 전용으로 보여 줍니다.
    imageCore: { blockTerms: CORE_BLOCK_TERMS, negative: CORE_NEGATIVE },
    // ComfyUI 에 연결하기 전 이미지 탭의 샘플러·스케줄러 목록. 연결 확인을 누르면 실제 목록으로 바뀝니다.
    imageLists: { samplers: COMMON_SAMPLERS, schedulers: COMMON_SCHEDULERS }
  };
}

app.get('/api/settings', (req, res) => res.json(settingsPayload()));

/** 이미지 설정을 검사해 반영합니다. 문제가 있으면 안내 문구를 돌려주고 아무것도 바꾸지 않습니다. */
function applyImageSettings(s, body) {
  const img = { ...IMAGE_DEFAULTS(), ...(s.image || {}) };
  const next = { ...img, adult: { ...img.adult } };
  if (typeof body.baseUrl === 'string') {
    const verdict = checkBaseUrl(body.baseUrl.trim());
    if (!verdict.ok) return `ComfyUI 주소를 쓸 수 없습니다.\n${verdict.reason}`;
    next.baseUrl = body.baseUrl.trim();
  }
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
  for (const [k, lo, hi] of [['width', 256, 2048], ['height', 256, 2048], ['steps', 1, 150], ['cfg', 0, 30]]) {
    const v = num(body[k], lo, hi);
    if (v !== undefined) next[k] = k === 'cfg' ? v : Math.round(v / (k === 'steps' ? 1 : 8)) * (k === 'steps' ? 1 : 8);
  }
  for (const k of ['checkpoint', 'sampler', 'scheduler', 'prefix', 'negative']) {
    if (typeof body[k] === 'string') next[k] = body[k].slice(0, 4000);
  }
  for (const k of ['enabled', 'freeAfter', 'reviewTags']) if (typeof body[k] === 'boolean') next[k] = body[k];
  if (body.workflow === null) next.workflow = null;
  else if (body.workflow !== undefined) {
    if (!looksLikeWorkflow(body.workflow)) {
      return '워크플로 형식이 아닙니다. ComfyUI 에서 "Save (API Format)" 으로 내보낸 JSON 을 올려 주세요.';
    }
    next.workflow = body.workflow;
  }
  if (body.adult && typeof body.adult === 'object') {
    for (const k of ['forceTags', 'blockTags', 'extraNegative']) {
      if (typeof body.adult[k] === 'string') next.adult[k] = body.adult[k].slice(0, 4000);
    }
  }
  s.image = next;
  return null;
}

app.put('/api/settings', ownerFieldsOnly, (req, res) => {
  const s = store.settings;
  const body = req.body || {};

  // 설정 창은 모든 탭을 한 번에 보냅니다. 거부할 값이 하나라도 있으면 아무것도 바꾸지 않도록 먼저 검사합니다.
  for (const [key, cfg] of Object.entries(body.providers || {})) {
    if (cfg?.baseUrl === undefined) continue;
    const verdict = checkBaseUrl(String(cfg.baseUrl));
    if (!verdict.ok) {
      return res.status(400).json({ error: `'${key}' 엔진 주소를 쓸 수 없습니다.\n${verdict.reason}` });
    }
  }
  if (body.image && typeof body.image === 'object') {
    const problem = applyImageSettings(s, body.image);
    if (problem) return res.status(400).json({ error: problem });
  }

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
  if (typeof body.memory?.autoSummarize === 'boolean') s.memory.autoSummarize = body.memory.autoSummarize;
  if (typeof body.memory?.autoFacts === 'boolean') s.memory.autoFacts = body.memory.autoFacts;
  if (body.dev) {
    if (typeof body.dev.particleFix === 'boolean') s.dev.particleFix = body.dev.particleFix;
    if (typeof body.dev.adultCloud === 'boolean') s.dev.adultCloud = body.dev.adultCloud;
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
app.get('/api/logs', auth.requireOwner, (req, res) => res.json({ logs: listLogs() }));
app.delete('/api/logs', auth.requireOwner, (req, res) => { clearLogs(); res.json({ ok: true }); });

/* ---------------- 캐릭터 / 페르소나 ---------------- */

/** 컬렉션 하나에 대한 목록·추가·수정·삭제 경로를 한 번에 만듭니다. */
function crud(name, collection, fields, { beforeRemove, normalize = (x) => x } = {}) {
  app.get(`/api/${name}`, (req, res) => res.json(collection.all()));

  app.post(`/api/${name}`, (req, res) => {
    const draft = {};
    for (const f of fields) draft[f] = req.body?.[f] ?? '';
    if (!String(draft.name ?? '').trim()) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    res.json(collection.add(normalize(draft)));
  });

  app.put(`/api/${name}/:id`, (req, res) => {
    const patch = {};
    for (const f of fields) if (f in (req.body || {})) patch[f] = req.body[f];
    if ('name' in patch && !String(patch.name ?? '').trim()) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    const item = collection.update(req.params.id, normalize(patch));
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
  'name', 'avatar', 'tags', 'description', 'appearance', 'personality',
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
    if (Array.isArray(chat.castIds) && chat.castIds.includes(character.id)) {
      chat.castIds = chat.castIds.filter((id) => id !== character.id);
      store.chats.save(chat.id);
    }
    if (chat.characterId !== character.id || chat.character) continue;
    chat.character = { ...copy };
    chat.characterId = null;
    store.chats.save(chat.id);
  }
}

crud('characters', store.characters, CHARACTER_FIELDS, { beforeRemove: detachCharacter });
/**
 * 페르소나 값 정리. 성별·나이는 짧은 글, 특징은 한 줄짜리 항목 목록입니다.
 * 들어온 칸만 고쳐서 돌려주므로 PUT 에서 일부만 보내도 됩니다.
 */
const PERSONA_FIELDS = ['name', 'description', 'gender', 'age', 'traits'];
function normalizePersona(p) {
  const out = { ...p };
  for (const k of ['name', 'description', 'gender', 'age']) {
    if (k in out) out[k] = String(out[k] ?? '').slice(0, k === 'description' ? 4000 : 80);
  }
  if ('traits' in out) {
    const list = Array.isArray(out.traits) ? out.traits : String(out.traits || '').split('\n');
    out.traits = list.map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 30);
  }
  return out;
}
crud('personas', store.personas, PERSONA_FIELDS, { normalize: normalizePersona });

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
 * adult 가 켜져 있으면 대화의 성인 프리셋과 같은 규칙을 씁니다 — 기본은 로컬 엔진으로만 나갑니다.
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
  // 대화의 성인 프리셋과 같은 규칙: 클라우드 허용을 켜지 않았다면 외부 API 로는 성인 태그를 내보내지 않습니다.
  if (adult && !adultAllowed(config)) {
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
  const body = req.body || {};
  if (body.title) chat.title = body.title;
  if (body.personaId !== undefined) chat.personaId = body.personaId;
  if (body.presetId !== undefined) chat.presetId = body.presetId;
  // 기억(요약)과 작가 노트는 사람이 직접 고칠 수 있습니다.
  if (typeof body.memory === 'string') chat.memory = body.memory.slice(0, MEMORY_MAX_CHARS * 2);
  if (typeof body.authorNote === 'string') chat.authorNote = body.authorNote.slice(0, 2000);
  if (Array.isArray(body.facts)) chat.facts = cleanFacts(body.facts);
  if (Array.isArray(body.castIds)) {
    // 함께 등장할 인물. 목록에 있는 캐릭터만, 주인공은 빼고, 겹치지 않게 받습니다.
    chat.castIds = [...new Set(body.castIds)]
      .filter((id) => typeof id === 'string' && id !== chat.characterId && store.characters.has(id))
      .slice(0, 8);
  }
  store.chats.save(chat.id);
  res.json(chat);
});

app.delete('/api/chats/:id', wrap(async (req, res) => {
  // 이 대화에서 그린 그림도 함께 지웁니다.
  if (store.chats.has(req.params.id) && SAFE_ID.test(req.params.id)) {
    await rm(imageDir(req.params.id), { recursive: true, force: true }).catch(() => {});
  }
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
  const before = msg.content;
  msg.content = String(req.body?.content ?? msg.content);
  msg.editedAt = Date.now();
  syncSwipe(msg);
  // 내용이 바뀌었으면 거기서 뽑은 기억을 치우고 다음 확인 때 다시 읽게 합니다.
  if (msg.content !== before) invalidateFacts(chat, msg);
  store.chats.save(chat.id);
  res.json(msg);
});

/** 답변 넘겨보기. body: { index } 보여 줄 장 번호(0부터) */
app.put('/api/chats/:id/messages/:mid/swipe', (req, res) => {
  const chat = store.chats.get(req.params.id);
  const msg = chat?.messages.find((m) => m.id === req.params.mid);
  if (!msg) return res.status(404).json({ error: '없는 메시지입니다.' });
  if (!msg.swipes?.length) return res.status(400).json({ error: '넘겨볼 다른 답변이 없습니다.' });
  const before = msg.swipeIndex;
  showSwipe(msg, req.body?.index);
  if (msg.swipeIndex !== before) invalidateFacts(chat, msg);
  store.chats.save(chat.id);
  res.json(msg);
});

app.delete('/api/chats/:id/messages/:mid', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const i = chat.messages.findIndex((m) => m.id === req.params.mid);
  if (i < 0) return res.status(404).json({ error: '없는 메시지입니다.' });
  const [gone] = chat.messages.splice(i, 1);
  invalidateFacts(chat, gone, { rewind: false });
  for (const img of gone.images || []) removeImageFile(chat.id, img.file);
  store.chats.save(chat.id);
  res.json({ ok: true });
});

/* ---------------- 생성 (SSE) ---------------- */

/**
 * 롤플레이 대화 하나를 보낼 준비물. 생성·요약·미리보기가 같이 씁니다.
 * 캐릭터가 없으면 null 입니다.
 */
function rpContext(chat) {
  const s = settings();
  const character = characterOf(chat);
  if (!character) return null;
  const persona = store.personas.get(chat.personaId) || store.personas.get(s.activePersonaId);
  const preset = presetOf(chat.presetId);
  const cast = castOf(chat);
  const system = buildSystem({
    character,
    persona,
    template: preset.template,
    cast,
    facts: chat.facts,
    memory: chat.memory,
    particleFix: s.dev.particleFix
  });
  return { character, persona, preset, cast, system };
}

/** 함께 등장하는 인물. 목록에서 지워진 캐릭터나 주인공 자신은 빼고 돌려줍니다. */
function castOf(chat) {
  if (!Array.isArray(chat.castIds)) return [];
  return chat.castIds
    .filter((id) => id && id !== chat.characterId)
    .map((id) => store.characters.get(id))
    .filter(Boolean);
}

/**
 * 이 대화를 지금 보낸다면 무엇이 들어가는지. 생성·미리보기·게이지·요약이 같은 계산을 씁니다.
 * 토큰 한도 안에서 최근 메시지부터 채우고, '최대 메시지 수' 는 그 위의 상한입니다.
 * @param {object} [o]
 * @param {object} [o.basis] 히스토리를 뽑을 메시지 묶음 (다시 쓰기면 마지막 답변을 뺀 것)
 * @param {string} [o.extra] 히스토리 뒤에 더 붙는 글 (이어쓰기·대신 쓰기 지시)
 */
function planFor(chat, { provider = settings().activeProvider, basis = chat, extra = '' } = {}) {
  const s = settings();
  const config = engineConfig(provider) || {};
  const assistant = chat.kind === 'assistant';
  const ctx = assistant ? null : rpContext(chat);
  const system = assistant
    ? withThinking(s.assistant.systemPrompt, Boolean(s.assistant.thinking))
    : ctx?.system || '';
  const params = assistant ? s.assistant.params : s.params;
  const note = ctx && chat.authorNote?.trim()
    ? fillVars(chat.authorNote, { char: ctx.character.name, user: ctx.persona?.name, particleFix: s.dev.particleFix })
    : '';
  const plan = planContext(basis.messages, {
    system,
    limit: contextLimitOf(config, isLocalUrl(config.baseUrl || '')),
    reserve: Number(params.maxTokens) || 0,
    maxMessages: Number(s.historyLimit) || 40,
    extra: [note, extra].filter(Boolean).join('\n'),
    ratio: s.tokenRatio?.[provider] || 1
  });
  return { ...plan, ctx, system, note, provider };
}

/** 보정 전 어림. 엔진이 알려 준 실제 토큰 수와 비교해 보정값을 만듭니다. */
const rawPromptTokens = (system, history) =>
  estimateTokens(system) + history.reduce((n, m) => n + estimateTokens(m.content) + 6, 0);

/** 엔진을 쓸 수 있는지 봅니다. 문제가 있으면 사람이 읽을 안내를, 없으면 null 을 돌려줍니다. */
function engineProblem(config, provider) {
  if (!config) return `설정되지 않은 엔진: ${provider}`;
  if (!config.model) return '설정에서 모델을 먼저 선택해 주세요.';
  const verdict = checkBaseUrl(config.baseUrl);
  if (!verdict.ok) return verdict.reason;
  if (!config.apiKey && !isLocalUrl(config.baseUrl)) {
    return `${config.label} API 키가 비어 있습니다. 설정에서 입력해 주세요.`;
  }
  return null;
}

const adultBlocked = (preset, config) =>
  `'${preset.name}' 모드는 로컬 엔진으로만 보낼 수 있습니다.\n` +
  `지금 선택된 엔진은 로컬 주소가 아닙니다 (${config.label}).\n` +
  '설정에서 엔진을 LM Studio 로 바꾸거나, 대화 상단에서 다른 모드를 선택하세요.';

/**
 * body: { regenerate?, continue?, provider? }
 *   (기본)      마지막 턴 다음에 새 답변을 씁니다
 *   regenerate  마지막 답변의 다른 버전을 한 장 더 씁니다. 이전 버전은 넘겨보기로 남습니다
 *   continue    마지막 답변 끝에 이어 씁니다
 */
app.post('/api/chats/:id/generate', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const assistant = chat.kind === 'assistant';

  // 뒤에서 돌던 요약·기억 확인이 있으면 멈춥니다. 로컬 엔진은 한 번에 하나만 처리해서,
  // 그대로 두면 답변이 그만큼 늦게 시작합니다. 멈춘 작업은 다음 기회에 다시 돕니다.
  background.get(chat.id)?.abort();

  const mode = req.body?.continue ? 'continue' : req.body?.regenerate ? 'regenerate' : 'new';
  const last = chat.messages[chat.messages.length - 1];
  // 마지막이 사용자 턴이면 재전송은 그냥 새로 쓰기(실패한 요청 다시 보내기)와 같습니다.
  const target = mode !== 'new' && last?.role === 'assistant' ? last : null;
  if (mode === 'continue' && !target) {
    return res.status(400).json({ error: '이어 쓸 답변이 없습니다. 마지막 메시지가 AI 의 답변일 때만 이어 쓸 수 있습니다.' });
  }

  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  const problem = engineProblem(config, provider);
  if (problem) return res.status(400).json({ error: problem });

  let system;
  let params = s.params;
  let webSearch = false;
  let thinking = false;
  if (assistant) {
    system = s.assistant.systemPrompt;
    params = s.assistant.params;
    // 웹 검색은 '켜 두면 되는 엔진에서만 쓴다' 는 선호입니다. 화면도 못 하는 엔진에서는 꺼진 것으로 보여 주므로,
    // 검색을 켜 둔 채 Ollama 처럼 못 하는 엔진으로 바꿨다면 막지 않고 검색 없이 답합니다.
    webSearch = Boolean(s.assistant.webSearch) && supportsWebSearch(provider, config);
    thinking = Boolean(s.assistant.thinking) && mode !== 'continue';
    system = withThinking(system, thinking);
  } else {
    const ctx = rpContext(chat);
    if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
    if (ctx.preset.adult && !adultAllowed(config)) {
      return res.status(400).json({ error: adultBlocked(ctx.preset, config) });
    }
    system = ctx.system;
  }

  // 다른 버전을 쓸 때는 지금 답변을 빼고 보냅니다. 실제로 바꾸는 건 새 버전이 생긴 뒤입니다.
  const basis = mode === 'regenerate' && target
    ? { ...chat, messages: chat.messages.slice(0, -1) }
    : chat;
  // 토큰 한도 안에 들어가는 만큼만 최근 메시지부터 보냅니다.
  const plan = planFor(chat, { provider, basis, extra: mode === 'continue' ? CONTINUE_PROMPT : '' });
  let history = plan.history;
  if (mode === 'continue') history.push({ role: 'user', content: CONTINUE_PROMPT });
  if (plan.note) history = withAuthorNote(history, plan.note);
  const rawPrompt = rawPromptTokens(system, history);
  // 첫 대사도 없는 캐릭터에서 인사말을 다시 뽑는 경우처럼, 보낼 턴이 하나도 없을 수 있습니다.
  if (!history.length) history.push({ role: 'user', content: '(장면을 시작한다)' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  // 화면의 컨텍스트 게이지를 먼저 채웁니다.
  send({ context: plan.usage });

  // 엔진이 실제 프롬프트 토큰 수를 알려 주면 어림 보정값을 갱신하고 게이지에도 알려 줍니다.
  const onUsage = ({ promptTokens }) => {
    const ratio = nextRatio(s.tokenRatio?.[provider], promptTokens, rawPrompt);
    s.tokenRatio = { ...(s.tokenRatio || {}), [provider]: ratio };
    store.saveSettings();
    send({ context: { ...plan.usage, actual: promptTokens } });
  };

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
      onUsage,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      const clean = stripper.feed(chunk);
      if (!clean) continue;
      text += clean;
      send({ delta: clean });

      // 같은 조각을 끝없이 되풀이하면 최대 길이를 다 채울 때까지 멈추지 않습니다.
      // 이어쓰기는 앞 내용까지 합쳐서 봐야 되풀이를 알아챕니다.
      if (looksRepetitive(mode === 'continue' ? target.content + text : text)) {
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
  if (!text.trim()) {
    send({ done: true, message: null });
    return res.end();
  }

  // 생성하는 동안 사용자가 그 메시지를 지웠다면 새 메시지로 붙입니다.
  const alive = target && chat.messages.includes(target);
  let msg;
  if (mode === 'continue' && alive) {
    target.content = joinContinuation(target.content, text);
    target.continuedAt = Date.now();
    syncSwipe(target);
    // 덧붙은 부분도 다음 기억 확인 때 읽히게 되감습니다. 기존 항목은 그대로 둡니다.
    if (Number(chat.factsUntilAt) >= target.at) chat.factsUntilAt = target.at - 1;
    msg = target;
  } else {
    const variant = { content: text.trim(), at: Date.now(), provider, model: config.model };
    // 사고와 출처는 본문과 따로 둡니다. 다음 턴에 같이 보내지 않으므로 맥락을 잡아먹지 않습니다.
    if (thought.trim()) variant.thought = thought.trim().slice(0, 6000);
    if (sources.length) variant.sources = sources.slice(0, 20);
    if (mode === 'regenerate' && alive) {
      invalidateFacts(chat, target);
      msg = addSwipe(target, variant);
    } else {
      msg = { id: uid(), role: 'assistant', ...variant };
      chat.messages.push(msg);
    }
  }
  chat.updatedAt = Date.now();
  store.chats.save(chat.id);
  send({ done: true, message: msg });
  res.end();
}));

/**
 * 기억 요약. '기억할 메시지 수' 밖으로 밀려난 대화를 요약해 chat.memory 에 둡니다.
 * body: { auto? }  auto 면 밀려난 메시지가 SUMMARY_MIN 개 이상 쌓였을 때만, 한 묶음만 요약합니다.
 * 손으로 누르면 밀린 것을 여러 묶음까지 따라잡습니다.
 */
app.post('/api/chats/:id/summarize', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  if (chat.kind === 'assistant') return res.status(400).json({ error: '어시스턴트 대화는 요약하지 않습니다.' });
  const auto = Boolean(req.body?.auto);

  // 지금 컨텍스트에 들어가는 메시지 수. 그보다 앞은 모델이 못 보므로 요약 대상입니다.
  const keptNow = () => planFor(chat).usage.kept;
  let pending = pendingForSummary(chat, keptNow());
  const reply = (extra = {}) => res.json({
    memory: chat.memory || '',
    summaryUntilAt: chat.summaryUntilAt || 0,
    pending: pendingForSummary(chat, keptNow()).length,
    ...extra
  });
  if (auto && (!s.memory?.autoSummarize || pending.length < SUMMARY_MIN)) return reply({ skipped: true });
  if (auto && running.has(chat.id)) return reply({ skipped: true, reason: '답변을 쓰는 중입니다.' });
  if (!pending.length) return reply({ summarized: 0 });

  const ctx = rpContext(chat);
  if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  const problem = engineProblem(config, provider)
    || (ctx.preset.adult && !adultAllowed(config) ? adultBlocked(ctx.preset, config) : null);
  if (problem) {
    // 자동 요약은 조용히 넘어갑니다. 대화 자체는 막지 않습니다.
    if (auto) return reply({ skipped: true, reason: problem });
    return res.status(400).json({ error: problem });
  }

  const controller = backgroundController(chat.id, res);

  // 요약은 사실 정리라 온도를 낮게, 길이는 요약 상한에 맞춰 둡니다.
  const params = { ...s.params, temperature: Math.min(s.params.temperature ?? 1, 0.4), maxTokens: 1200 };
  const names = {
    char: [ctx.character.name, ...ctx.cast.map((c) => c.name)].join('·'),
    user: ctx.persona?.name || '사용자'
  };
  let rounds = auto ? 1 : 4;
  let summarized = 0;
  try {
    while (pending.length && rounds-- > 0) {
      const chunk = takeChunk(pending);
      const stripper = makeThoughtStripper({});
      let out = '';
      const stream = streamChat({
        provider,
        config,
        system: withThinking(SUMMARY_SYSTEM, false),
        messages: [{ role: 'user', content: buildSummaryPrompt(chat.memory, chunk, names) }],
        params,
        signal: controller.signal
      });
      for await (const piece of stream) out += stripper.feed(piece);
      out = cleanSummary(out + stripper.flush());
      if (!out) throw new Error('모델이 빈 요약을 보냈습니다.');

      chat.memory = out;
      chat.summaryUntilAt = chunk[chunk.length - 1].at || Date.now();
      store.chats.save(chat.id);
      summarized += chunk.length;
      pending = pendingForSummary(chat, keptNow());
    }
  } catch (e) {
    if (controller.signal.aborted) {
      // 새 답변 요청 때문에 멈춘 것이면 연결은 살아 있으니 어디까지 됐는지 알려 줍니다.
      if (!res.destroyed) reply({ skipped: true, summarized, reason: '새 답변을 먼저 쓰느라 멈췄습니다.' });
      return;
    }
    // 여러 묶음 중 앞쪽은 이미 저장됐으니, 어디까지 됐는지와 함께 알려 줍니다.
    if (auto) return reply({ skipped: true, summarized, reason: e.message });
    return res.status(502).json({ error: describeFailure(e, provider, config), summarized });
  } finally {
    if (background.get(chat.id) === controller) background.delete(chat.id);
  }
  reply({ summarized });
}));

/**
 * 대신 쓰기. 내 다음 차례를 AI 가 초안으로 씁니다. 저장하지 않고 조각만 흘려보냅니다.
 * body: { hint?, provider? }  hint 는 입력창에 미리 적어 둔 방향입니다.
 */
app.post('/api/chats/:id/impersonate', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  if (chat.kind === 'assistant') return res.status(400).json({ error: '어시스턴트 대화에서는 쓸 수 없습니다.' });
  const ctx = rpContext(chat);
  if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });

  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  const problem = engineProblem(config, provider)
    || (ctx.preset.adult && !adultAllowed(config) ? adultBlocked(ctx.preset, config) : null);
  if (problem) return res.status(400).json({ error: problem });

  // 로컬 엔진이 한 번에 하나만 처리하므로, 뒤에서 돌던 기억 정리는 미룹니다.
  background.get(chat.id)?.abort();

  const userName = ctx.persona?.name || '사용자';
  const instruction = fillVars(impersonatePrompt({
    hint: req.body?.hint,
    messenger: ['messenger', 'adult-messenger'].includes(ctx.preset.id)
  }), { char: ctx.character.name, user: userName, particleFix: s.dev.particleFix });
  const plan = planFor(chat, { provider, extra: instruction });
  const history = [...plan.history, { role: 'user', content: instruction }];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  // 초안은 짧으면 충분합니다.
  const params = { ...s.params, maxTokens: Math.min(Number(s.params.maxTokens) || 400, 400) };
  const stripper = makeThoughtStripper({});
  let text = '';
  try {
    const stream = streamChat({
      provider,
      config,
      system: ctx.system,
      messages: history,
      params,
      signal: controller.signal
    });
    for await (const chunk of stream) {
      const clean = stripper.feed(chunk);
      if (!clean) continue;
      text += clean;
      send({ delta: clean });
      if (looksRepetitive(text)) { controller.abort(); break; }
    }
    text += stripper.flush();
  } catch (e) {
    if (!controller.signal.aborted) send({ error: describeFailure(e, provider, config) });
  }
  finished = true;
  send({ done: true, draft: cleanImpersonation(text, userName) });
  res.end();
}));

/* ---------------- 장면 그리기 (ComfyUI) ---------------- */

const IMAGE_FILE = /^[a-z0-9]{6,32}\.(png|jpg|webp)$/;
/** 한 메시지에 남겨 둘 그림 수. 넘으면 오래된 것부터 지웁니다. */
const IMAGES_PER_MESSAGE = 6;

const imageDir = (chatId) => path.join(store.dir, 'images', chatId);

function removeImageFile(chatId, file) {
  if (!SAFE_ID.test(chatId) || !IMAGE_FILE.test(file || '')) return;
  unlink(path.join(imageDir(chatId), file)).catch(() => {});
}

/** ComfyUI 에 연결해 체크포인트 목록을 받아 봅니다. 설정 창의 '연결 확인'. query: baseUrl */
app.get('/api/image/checkpoints', auth.requireOwner, modelsLimit, wrap(async (req, res) => {
  const baseUrl = String(req.query.baseUrl || settings().image?.baseUrl || '').trim();
  const verdict = checkBaseUrl(baseUrl);
  if (!baseUrl || !verdict.ok) return res.status(400).json({ error: verdict.reason || 'ComfyUI 주소를 입력해 주세요.' });
  // 샘플러 목록은 덤입니다. 못 받아도 체크포인트 확인은 성공으로 칩니다.
  const [checkpoints, lists] = await Promise.all([
    listCheckpoints(baseUrl),
    listSamplers(baseUrl).catch(() => ({ samplers: [], schedulers: [] }))
  ]);
  res.json({ checkpoints, ...lists });
}));

/** 그린 그림 파일. 대화 id 와 파일 이름을 엄격히 검사해 data/images 밖으로 못 나가게 합니다. */
app.get('/api/images/:chatId/:file', (req, res) => {
  const { chatId, file } = req.params;
  if (!SAFE_ID.test(chatId) || !IMAGE_FILE.test(file)) return res.status(404).end();
  res.sendFile(path.join(imageDir(chatId), file), { maxAge: '30d', immutable: true }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.delete('/api/chats/:id/messages/:mid/images/:imgId', (req, res) => {
  const chat = store.chats.get(req.params.id);
  const msg = chat?.messages.find((m) => m.id === req.params.mid);
  const img = msg?.images?.find((x) => x.id === req.params.imgId);
  if (!img) return res.status(404).json({ error: '없는 그림입니다.' });
  msg.images = msg.images.filter((x) => x !== img);
  removeImageFile(chat.id, img.file);
  store.chats.save(chat.id);
  res.json({ ok: true });
});

/**
 * 메시지 하나의 장면을 그립니다. 진행 단계를 SSE 로 알려 줍니다.
 * body: { prompt?, negative?, checkpoint?, random?, review? }
 *   prompt  사람이 고친 태그. 주면 LLM 을 건너뛰고 이걸로 그립니다 (필터는 그대로 적용)
 *   negative 사람이 고친 부정 태그. 설정의 네거티브·고정 네거티브는 여기에 늘 더해집니다
 *   checkpoint 이번 한 장만 쓸 체크포인트 ('태그 고쳐 그리기'). 설정의 체크포인트는 바꾸지 않습니다
 *   random  시드를 무작위로. 기본은 캐릭터마다 고정 시드
 *   review  태그까지만 만들어 { done, review: { prompt, negative, removed } } 로 돌려주고 그리지 않습니다.
 *           사람이 확인·수정한 태그를 prompt 로 다시 보내면 그때 그립니다.
 */
app.post('/api/chats/:id/messages/:mid/image', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const cfg = { ...IMAGE_DEFAULTS(), ...(s.image || {}) };
  const picked = typeof req.body?.checkpoint === 'string' ? req.body.checkpoint.trim() : '';
  if (picked) {
    if (picked.length > 300 || /[\u0000-\u001f]/.test(picked)) return res.status(400).json({ error: '체크포인트 이름이 올바르지 않습니다.' });
    cfg.checkpoint = picked;
  }
  const chat = store.chats.get(req.params.id);
  const msg = chat?.messages.find((m) => m.id === req.params.mid);
  if (!msg) return res.status(404).json({ error: '없는 메시지입니다.' });
  if (chat.kind === 'assistant') return res.status(400).json({ error: '어시스턴트 대화에서는 그리지 않습니다.' });
  if (!cfg.enabled) return res.status(400).json({ error: '설정 → 이미지 설정에서 장면 그리기를 먼저 켜 주세요.' });
  const verdict = checkBaseUrl(cfg.baseUrl);
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });
  if (!cfg.workflow && !cfg.checkpoint) {
    return res.status(400).json({ error: '이미지 설정에서 체크포인트를 고르거나 워크플로를 올려 주세요.' });
  }
  const ctx = rpContext(chat);
  if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
  const adult = Boolean(ctx.preset.adult);
  const typed = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  // 장면을 태그로 바꾸는 LLM 도 같은 규칙: 성인 대화는 기본적으로 로컬 엔진으로만.
  const provider = s.activeProvider;
  const config = engineConfig(provider);
  if (!typed) {
    const problem = engineProblem(config, provider)
      || (adult && !adultAllowed(config) ? adultBlocked(ctx.preset, config) : null);
    if (problem) return res.status(400).json({ error: problem });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const stage = (step, text) => send({ stage: step, text });
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });
  // 로컬 GPU 하나를 나눠 쓰므로, 뒤에서 돌던 기억 정리는 미룹니다.
  background.get(chat.id)?.abort();

  const fail = (text) => {
    finished = true;
    send({ error: text });
    res.end();
  };

  try {
    // 1) 장면 → 태그
    let sceneTags;
    let sceneNegative = typeof req.body?.negative === 'string' ? splitTags(req.body.negative) : [];
    if (typed) {
      sceneTags = splitTags(typed);
    } else {
      stage('prompt', '장면을 태그로 옮기는 중');
      const i = chat.messages.indexOf(msg);
      const before = chat.messages.slice(Math.max(0, i - 1), i).filter((m) => m.role === 'user');
      const scene = [...before, msg]
        .map((m) => `${m.role === 'user' ? (ctx.persona?.name || '사용자') : ctx.character.name}: ${m.content.trim().slice(-1800)}`)
        .join('\n\n');
      const cast = [ctx.character, ...ctx.cast];
      const ask = async (messages, temperature) => {
        const stripper = makeThoughtStripper({});
        let out = '';
        const stream = streamChat({
          provider,
          config,
          system: withThinking(IMAGE_PROMPT_SYSTEM, false),
          messages,
          // 생각 블록을 먼저 쓰는 모델도 태그까지 쓸 수 있게 길이를 넉넉히 둡니다.
          params: { ...s.params, temperature, maxTokens: 700 },
          signal: controller.signal
        });
        for await (const piece of stream) out += stripper.feed(piece);
        return out + stripper.flush();
      };
      const messages = buildImageMessages({ cast, scene, userName: ctx.persona?.name || '사용자' });
      let raw = await ask(messages, 0.4);
      ({ tags: sceneTags, negative: sceneNegative } = parseSceneOutput(raw));
      if (!sceneTags.length) {
        // 태그 대신 문장을 썼으면 그 답을 보여 주며 한 번 더 요청합니다.
        stage('prompt', '태그 형식이 아니라 한 번 더 요청하는 중');
        console.log(`[그림] 태그를 읽지 못함, 다시 요청: ${previewOutput(raw)}`);
        raw = await ask([
          ...messages,
          { role: 'assistant', content: raw.trim() || '(no answer)' },
          { role: 'user', content: IMAGE_RETRY_PROMPT }
        ], 0.2);
        ({ tags: sceneTags, negative: sceneNegative } = parseSceneOutput(raw));
      }
      if (!sceneTags.length) {
        return fail('모델이 태그를 쓰지 못했습니다. 다시 누르거나, 그림이 하나라도 있으면 "태그 고쳐 그리기" 로 직접 적어 주세요.\n' +
          `모델 응답 앞부분: ${previewOutput(raw)}`);
      }
    }

    // 2) 조립·필터. 등장인물이 한 명이면 외형 태그를 앞에 확실히 박아 둡니다.
    const appearance = ctx.cast.length ? [] : splitTags(ctx.character.appearance || '');
    const composed = composePrompt({ cfg, sceneTags, sceneNegative, appearance, adult });
    if (composed.blocked) {
      return fail(`미성년으로 읽힐 수 있는 표현이 있어 그리지 않았습니다: ${composed.blocked.join(', ')}\n` +
        '이 차단은 설정에서 끌 수 없습니다. 캐릭터 외형 태그나 장면을 확인해 주세요.');
    }
    send({ prompt: composed.prompt, removed: composed.removed });
    if (req.body?.review) {
      finished = true;
      send({ done: true, review: { prompt: composed.prompt, negative: composed.negative, removed: composed.removed } });
      return res.end();
    }

    // 3) ComfyUI
    const seed = req.body?.random
      ? Math.floor(Math.random() * 4294967295)
      : seedOf(ctx.character.id || ctx.character.name);
    const workflow = fillWorkflow(cfg.workflow || DEFAULT_WORKFLOW, {
      prompt: composed.prompt,
      negative: composed.negative,
      seed,
      width: cfg.width,
      height: cfg.height,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler: cfg.sampler,
      scheduler: cfg.scheduler,
      checkpoint: cfg.checkpoint
    });
    stage('draw', 'ComfyUI 에 보내는 중');
    const { buffer, ext } = await renderImage(cfg.baseUrl, workflow, { signal: controller.signal, onStage: stage });

    // 4) 저장. 생성하는 동안 메시지가 지워졌으면 파일도 남기지 않습니다.
    if (!chat.messages.includes(msg)) return fail('그리는 동안 메시지가 삭제되었습니다.');
    const id = uid();
    const file = `${id}${Date.now().toString(36)}.${ext}`.toLowerCase();
    await mkdir(imageDir(chat.id), { recursive: true });
    await writeFile(path.join(imageDir(chat.id), file), buffer);
    const image = { id, file, prompt: composed.prompt, negative: composed.negative, checkpoint: cfg.checkpoint, seed, at: Date.now() };
    msg.images = [...(msg.images || []), image];
    while (msg.images.length > IMAGES_PER_MESSAGE) removeImageFile(chat.id, msg.images.shift().file);
    store.chats.save(chat.id);

    finished = true;
    send({ done: true, image, images: msg.images });
    res.end();
    // 같은 GPU 의 LLM 이 다시 VRAM 을 쓸 수 있게 풉니다. 응답을 보낸 뒤라 기다리지 않습니다.
    if (cfg.freeAfter) freeMemory(cfg.baseUrl);
  } catch (e) {
    if (controller.signal.aborted) { finished = true; return; }
    fail(e.message);
  }
}));

/**
 * 뒤에서 도는 작업(요약·기억 확인)의 컨트롤러. 대화 id → AbortController
 * 새 답변 요청이 오면 이걸 멈춰 답변이 먼저 나가게 합니다.
 */
const background = new Map();

function backgroundController(chatId, res) {
  background.get(chatId)?.abort();
  const controller = new AbortController();
  background.set(chatId, controller);
  res.on('close', () => {
    if (background.get(chatId) === controller) background.delete(chatId);
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

/**
 * 자동 기억. 최근 대화에서 오래 남겨야 할 사실을 뽑아 chat.facts 에 반영합니다.
 * body: { auto }  auto 면 마지막 확인 뒤 답변이 FACT_EVERY 개 이상 쌓였을 때만 돕니다.
 */
app.post('/api/chats/:id/facts/extract', generateLimit, wrap(async (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  if (chat.kind === 'assistant') return res.status(400).json({ error: '어시스턴트 대화는 기억을 쓰지 않습니다.' });
  const auto = Boolean(req.body?.auto);
  const reply = (extra = {}) => res.json({
    facts: chat.facts || [],
    factsUntilAt: chat.factsUntilAt || 0,
    added: [], updated: [], removed: [],
    ...extra
  });

  if (auto && (!s.memory?.autoFacts || turnsSinceFacts(chat) < FACT_EVERY)) return reply({ skipped: true });
  if (auto && running.has(chat.id)) return reply({ skipped: true, reason: '답변을 쓰는 중입니다.' });
  const window = factsWindow(chat);
  if (!window.length) return reply({ skipped: true });

  const ctx = rpContext(chat);
  if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
  const provider = req.body?.provider || s.activeProvider;
  const config = engineConfig(provider);
  const problem = engineProblem(config, provider)
    || (ctx.preset.adult && !adultAllowed(config) ? adultBlocked(ctx.preset, config) : null);
  if (problem) {
    if (auto) return reply({ skipped: true, reason: problem });
    return res.status(400).json({ error: problem });
  }

  const controller = backgroundController(chat.id, res);
  const params = { ...s.params, temperature: 0.2, maxTokens: 700 };
  const names = {
    char: [ctx.character.name, ...ctx.cast.map((c) => c.name)].join('·'),
    user: ctx.persona?.name || '사용자'
  };
  let text = '';
  try {
    const stripper = makeThoughtStripper({});
    const stream = streamChat({
      provider,
      config,
      system: withThinking(FACTS_SYSTEM, false),
      messages: [{ role: 'user', content: buildFactsPrompt(chat.facts, window, names) }],
      params,
      signal: controller.signal
    });
    for await (const piece of stream) text += stripper.feed(piece);
    text += stripper.flush();
  } catch (e) {
    if (controller.signal.aborted) {
      if (!res.writableEnded && !res.destroyed) reply({ skipped: true, reason: '새 답변을 먼저 쓰느라 멈췄습니다.' });
      return;
    }
    if (auto) return reply({ skipped: true, reason: e.message });
    return res.status(502).json({ error: describeFailure(e, provider, config) });
  } finally {
    if (background.get(chat.id) === controller) background.delete(chat.id);
  }

  // 읽는 동안 사용자가 메시지를 지웠을 수 있으니, 지금 남아 있는 것만 근거로 씁니다.
  const alive = window.filter((m) => chat.messages.includes(m));
  const result = applyFactOps(chat, parseFactOps(text), alive);
  chat.factsUntilAt = window[window.length - 1].at || Date.now();
  store.chats.save(chat.id);
  reply(result);
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
app.delete('/api/providers/:key/unavailable', auth.requireOwner, (req, res) => {
  const cfg = settings().providers[req.params.key];
  if (!cfg) return res.status(404).json({ error: '없는 엔진입니다.' });
  const count = (cfg.unavailableModels || []).length;
  cfg.unavailableModels = [];
  store.saveSettings();
  res.json({ cleared: count });
});

/**
 * 컨텍스트 게이지. 지금 보낸다면 설정·기억 / 대화 / 답변 여유가 한도에서 얼마씩 차지하는지.
 * query: provider (없으면 지금 엔진)
 */
app.get('/api/chats/:id/context', (req, res) => {
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });
  const provider = String(req.query.provider || settings().activeProvider);
  const plan = planFor(chat, { provider });
  res.json({
    ...plan.usage,
    pendingSummary: chat.kind === 'assistant' ? 0 : pendingForSummary(chat, plan.usage.kept).length
  });
});

/** 개발자 설정의 '시스템 프롬프트 미리보기'가 쓰는 엔드포인트입니다. */
app.get('/api/chats/:id/system', (req, res) => {
  const s = settings();
  const chat = store.chats.get(req.params.id);
  if (!chat) return res.status(404).json({ error: '없는 대화입니다.' });

  if (chat.kind === 'assistant') {
    return res.json({ system: s.assistant.systemPrompt, turns: planFor(chat).usage.kept });
  }
  const ctx = rpContext(chat);
  if (!ctx) return res.status(400).json({ error: '이 대화의 캐릭터가 삭제되었습니다.' });
  res.json({
    system: ctx.system,
    turns: planFor(chat).usage.kept,
    authorNote: chat.authorNote?.trim()
      ? fillVars(chat.authorNote, { char: ctx.character.name, user: ctx.persona?.name, particleFix: s.dev.particleFix })
      : ''
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

/*
 * 백업 불러오기. 지금 데이터를 지우지 않고 합칩니다.
 * 같은 id 가 이미 있으면 건너뛰므로, 같은 파일을 두 번 불러와도 겹치지 않습니다.
 * id 는 그대로 파일 이름이 되므로 안전한 글자만 받고, 아니면 새로 붙입니다.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * @param {(raw) => object|null} clean  읽을 수 있는 항목만 골라 다듬습니다.
 * @param {(item) => string} [signature] 내용이 같은지 가리는 열쇠. 새로 설치한 앱은 기본 캐릭터를
 *   다른 id 로 이미 갖고 있으므로, 내용이 똑같으면 같은 항목으로 보고 건너뜁니다.
 * @param {Map} [remap] 백업의 id → 이 앱의 id. 대화가 가리키는 캐릭터·페르소나를 고칠 때 씁니다.
 */
function importItems(collection, list, clean, { signature, remap } = {}) {
  let added = 0;
  let skipped = 0;
  const known = new Map(signature ? collection.all().map((x) => [signature(x), x.id]) : []);
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isObj(raw)) { skipped += 1; continue; }
    const item = clean(raw);
    if (!item) { skipped += 1; continue; }
    item.id = SAFE_ID.test(str(raw.id)) ? raw.id : uid();
    if (typeof raw.id === 'string') remap?.set(raw.id, item.id);
    if (collection.has(item.id)) { skipped += 1; continue; }
    const same = signature && known.get(signature(item));
    if (same) {
      if (typeof raw.id === 'string') remap?.set(raw.id, same);
      skipped += 1;
      continue;
    }
    if (Number.isFinite(raw.createdAt)) item.createdAt = raw.createdAt;
    collection.add(item);
    added += 1;
  }
  return { added, skipped };
}

const characterSignature = (c) => JSON.stringify(CHARACTER_FIELDS.map((f) => str(c[f])));
const personaSignature = (p) => JSON.stringify([str(p.name), str(p.description), str(p.gender), str(p.age), p.traits || []]);

const cleanCharacter = (raw) => {
  if (!str(raw.name).trim()) return null;
  return CHARACTER_FIELDS.reduce((o, f) => ({ ...o, [f]: str(raw[f]) }), {});
};

const cleanPersona = (raw) => {
  if (!str(raw.name).trim()) return null;
  return normalizePersona({
    name: str(raw.name),
    description: str(raw.description),
    gender: str(raw.gender),
    age: str(raw.age),
    traits: Array.isArray(raw.traits) ? raw.traits.filter((t) => typeof t === 'string') : []
  });
};

const cleanSources = (list) => list.filter(isObj)
  .map((x) => ({ url: str(x.url), title: str(x.title) }))
  .filter((x) => /^https?:\/\//i.test(x.url));

const cleanChat = (raw) => {
  if (!Array.isArray(raw.messages)) return null;
  const messages = raw.messages.filter(isObj).map((m) => {
    const msg = {
      id: SAFE_ID.test(str(m.id)) ? m.id : uid(),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: str(m.content),
      at: Number.isFinite(m.at) ? m.at : Date.now()
    };
    for (const k of ['provider', 'model', 'thought']) if (typeof m[k] === 'string') msg[k] = m[k];
    if (Number.isFinite(m.editedAt)) msg.editedAt = m.editedAt;
    if (Array.isArray(m.sources)) msg.sources = cleanSources(m.sources);
    if (Array.isArray(m.swipes) && m.swipes.length) {
      msg.swipes = m.swipes.filter(isObj).slice(-20).map((v) => {
        const out = { content: str(v.content), at: Number.isFinite(v.at) ? v.at : msg.at };
        for (const k of ['provider', 'model', 'thought']) if (typeof v[k] === 'string') out[k] = v[k];
        if (Array.isArray(v.sources)) out.sources = cleanSources(v.sources);
        return out;
      });
      msg.swipeIndex = Math.max(0, Math.min(msg.swipes.length - 1, Number(m.swipeIndex) || 0));
    }
    return msg;
  });
  const chat = {
    kind: raw.kind === 'assistant' ? 'assistant' : 'rp',
    characterId: typeof raw.characterId === 'string' ? raw.characterId : null,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : null,
    title: str(raw.title) || '가져온 대화',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    messages
  };
  if (typeof raw.presetId === 'string') chat.presetId = raw.presetId;
  if (typeof raw.memory === 'string') chat.memory = raw.memory;
  if (typeof raw.authorNote === 'string') chat.authorNote = raw.authorNote;
  if (Number.isFinite(raw.summaryUntilAt)) chat.summaryUntilAt = raw.summaryUntilAt;
  if (Array.isArray(raw.facts)) chat.facts = cleanFacts(raw.facts);
  if (Number.isFinite(raw.factsUntilAt)) chat.factsUntilAt = raw.factsUntilAt;
  if (Array.isArray(raw.castIds)) chat.castIds = raw.castIds.filter((id) => typeof id === 'string');
  if (isObj(raw.character)) {
    const c = cleanCharacter(raw.character);
    if (c) chat.character = { ...c, id: null };
  }
  return chat;
};

// 지금은 데이터를 모두가 같이 쓰므로, 설정까지 덮을 수 있는 불러오기는 주인만 합니다.
app.post('/api/import', auth.requireOwner, (req, res) => {
  const body = req.body || {};
  const data = body.data;
  if (!isObj(data)) return res.status(400).json({ error: '백업 파일 형식이 아닙니다.' });
  if (![data.characters, data.personas, data.chats].some(Array.isArray)) {
    return res.status(400).json({ error: '백업 파일에 캐릭터·페르소나·대화가 하나도 없습니다.' });
  }

  const characterIds = new Map();
  const personaIds = new Map();
  const characters = importItems(store.characters, data.characters, cleanCharacter,
    { signature: characterSignature, remap: characterIds });
  const personas = importItems(store.personas, data.personas, cleanPersona,
    { signature: personaSignature, remap: personaIds });
  const chats = importItems(store.chats, data.chats, (raw) => {
    const chat = cleanChat(raw);
    if (chat?.characterId) chat.characterId = characterIds.get(chat.characterId) ?? chat.characterId;
    if (chat?.personaId) chat.personaId = personaIds.get(chat.personaId) ?? chat.personaId;
    if (chat?.castIds) chat.castIds = chat.castIds.map((id) => characterIds.get(id) ?? id);
    return chat;
  });

  const result = {
    characters,
    personas,
    chats,
    presets: 0,
    settings: false
  };

  const s = store.settings;
  const saved = isObj(data.settings) ? data.settings : {};

  // 가져온 대화가 쓰던 커스텀 모드가 없으면 대화가 엉뚱한 모드로 돌아가므로, 없는 모드는 늘 추가합니다.
  for (const p of Array.isArray(saved.presets) ? saved.presets : []) {
    if (!isObj(p) || !str(p.id) || !str(p.name) || s.presets.some((x) => x.id === p.id)) continue;
    s.presets.push({ id: str(p.id), name: str(p.name), template: str(p.template), adult: Boolean(p.adult) });
    result.presets += 1;
  }

  // 나머지 설정은 원할 때만 덮습니다. 엔진·API 키는 백업에 들어 있지 않고, 들어 있어도 받지 않습니다.
  if (body.includeSettings) {
    if (Number.isFinite(saved.historyLimit)) s.historyLimit = saved.historyLimit;
    if (typeof saved.askModeOnNewChat === 'boolean') s.askModeOnNewChat = saved.askModeOnNewChat;
    if (typeof saved.activePresetId === 'string' && s.presets.some((p) => p.id === saved.activePresetId)) {
      s.activePresetId = saved.activePresetId;
    }
    const personaId = personaIds.get(saved.activePersonaId) ?? saved.activePersonaId;
    if (typeof personaId === 'string' && store.personas.has(personaId)) s.activePersonaId = personaId;
    // 성인 모드 클라우드 허용은 경고를 직접 보고 켜야 하므로 백업에서 옮겨 오지 않습니다.
    const adultCloud = s.dev.adultCloud;
    for (const key of ['params', 'assistant', 'dev', 'memory']) {
      if (isObj(saved[key])) s[key] = merge(s[key], saved[key]);
    }
    s.dev.adultCloud = adultCloud;
    result.settings = true;
  }
  store.saveSettings();
  res.json(result);
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
