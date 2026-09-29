/** 설정, 모델 목록, 통신 로그. */
import { listModels, supportsWebSearch } from '../../providers.js';
import { listLogs, clearLogs } from '../../logs.js';
import { checkBaseUrl, maskProviders } from '../../security.js';
import { DEFAULT_SYSTEM_TEMPLATE, BUILTIN_TEMPLATES } from '../../content/templates.js';
import { BUILTIN_CHARACTERS } from '../../content/characters.js';
import {
  imageConfig, GEMINI_RATIOS, OPENAI_SIZES, OPENAI_QUALITIES, looksLikeWorkflow, CORE_BLOCK_TERMS, CORE_NEGATIVE, COMMON_SAMPLERS, COMMON_SCHEDULERS
} from '../../image.js';
import { cleanLoreSettings, LORE_DEFAULTS } from '../../lorebook.js';
import { isObj } from '../../services/records.js';
import { wrap, fail } from '../helpers.js';

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

const clampTo = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);

export class SettingsRoutes {
  constructor({ store, auth, engines, limits }) {
    Object.assign(this, { store, auth, engines, limits });
  }

  mount(app) {
    app.get('/api/settings', (req, res) => res.json(this.payload()));
    app.put('/api/settings', ownerFieldsOnly, (req, res) => this.update(req, res));
    app.get('/api/models', this.limits.models, wrap((req, res) => this.models(req, res)));
    // 대화 내용은 담지 않습니다 — 요청 대상 주소·상태 코드·걸린 시간·오류 메시지뿐입니다.
    app.get('/api/logs', this.auth.requireOwner, (req, res) => res.json({ logs: listLogs() }));
    app.delete('/api/logs', this.auth.requireOwner, (req, res) => { clearLogs(); res.json({ ok: true }); });
    // 감춰 둔 모델 기록을 지웁니다. 계정 상태가 바뀌었을 때 씁니다.
    app.delete('/api/providers/:key/unavailable', this.auth.requireOwner, (req, res) => this.clearUnavailable(req, res));
  }

  /**
   * 설정에 읽기 전용 정보를 덧붙여 내려보냅니다.
   * GET 과 PUT 이 같은 모양을 돌려줘야, 저장한 뒤에도 화면이 이 값들을 잃지 않습니다.
   */
  payload() {
    const s = this.store.settings;
    const webSearchCapable = {};
    for (const key of Object.keys(s.providers)) webSearchCapable[key] = supportsWebSearch(key, this.engines.config(key));
    return {
      ...s,
      // API 키는 브라우저로 내보내지 않습니다. 들어 있는지 여부만 알려 줍니다.
      providers: maskProviders(s.providers),
      // 예전 설정 파일에는 새로 생긴 항목(gemini 등)이 없어서 기본값을 채워 보냅니다.
      image: imageConfig(s.image),
      webSearchCapable,
      defaultTemplate: DEFAULT_SYSTEM_TEMPLATE,
      // 내장 틀의 원본 내용. 설정에서 '기본 내용 가져오기' 로 되돌릴 때 씁니다.
      builtinTemplates: BUILTIN_TEMPLATES(),
      // 내장 캐릭터 이름. 캐릭터 목록의 '기본' 탭이 빠진 캐릭터 수를 셀 때 씁니다.
      builtinCharacters: BUILTIN_CHARACTERS.map((c) => c.name),
      // 그림 필터 중 고칠 수 없는 부분(모든 대화에 적용). 이미지 설정 창에 읽기 전용으로 보여 줍니다.
      imageCore: { blockTerms: CORE_BLOCK_TERMS, negative: CORE_NEGATIVE },
      // ComfyUI 에 연결하기 전 이미지 탭의 샘플러·스케줄러 목록. 연결 확인을 누르면 실제 목록으로 바뀝니다.
      imageLists: { samplers: COMMON_SAMPLERS, schedulers: COMMON_SCHEDULERS }
    };
  }

  /** 이미지 설정을 검사해 반영합니다. 문제가 있으면 안내 문구를 돌려주고 아무것도 바꾸지 않습니다. */
  applyImage(s, body) {
    const next = imageConfig(s.image);
    if (['comfyui', 'gemini', 'openai'].includes(body.backend)) next.backend = body.backend;
    if (body.promptStyle === 'tags' || body.promptStyle === 'prose') next.promptStyle = body.promptStyle;
    // 회사 API 설정: 모델 이름·스타일은 공통, 나머지는 그 회사가 받는 값만.
    for (const [key, label] of [['gemini', 'Gemini'], ['openai', 'OpenAI']]) {
      const g = body[key];
      if (!g || typeof g !== 'object') continue;
      if (typeof g.model === 'string') {
        const model = g.model.trim();
        if (model.length > 200 || /[^\w.\-]/.test(model)) return `${label} 이미지 모델 이름이 올바르지 않습니다.`;
        next[key].model = model;
      }
      if (typeof g.style === 'string') next[key].style = g.style.slice(0, 2000);
    }
    if (body.gemini && typeof body.gemini === 'object') {
      if (['', '1K', '2K', '4K'].includes(body.gemini.imageSize)) next.gemini.imageSize = body.gemini.imageSize;
      if (GEMINI_RATIOS.includes(body.gemini.aspectRatio)) next.gemini.aspectRatio = body.gemini.aspectRatio;
    }
    if (body.openai && typeof body.openai === 'object') {
      if (OPENAI_SIZES.includes(body.openai.size)) next.openai.size = body.openai.size;
      if (OPENAI_QUALITIES.includes(body.openai.quality)) next.openai.quality = body.openai.quality;
    }
    if (typeof body.baseUrl === 'string') {
      const verdict = checkBaseUrl(body.baseUrl.trim());
      if (!verdict.ok) return `ComfyUI 주소를 쓸 수 없습니다.\n${verdict.reason}`;
      next.baseUrl = body.baseUrl.trim();
    }
    for (const [k, lo, hi] of [['width', 256, 2048], ['height', 256, 2048], ['steps', 1, 150], ['cfg', 0, 30]]) {
      const v = clampTo(body[k], lo, hi);
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

  update(req, res) {
    const s = this.store.settings;
    const body = req.body || {};

    // 설정 창은 모든 탭을 한 번에 보냅니다. 거부할 값이 하나라도 있으면 아무것도 바꾸지 않도록 먼저 검사합니다.
    for (const [key, cfg] of Object.entries(body.providers || {})) {
      if (cfg?.baseUrl === undefined) continue;
      const verdict = checkBaseUrl(String(cfg.baseUrl));
      if (!verdict.ok) return fail(res, 400, `'${key}' 엔진 주소를 쓸 수 없습니다.\n${verdict.reason}`);
    }
    if (body.image && typeof body.image === 'object') {
      const problem = this.applyImage(s, body.image);
      if (problem) return fail(res, 400, problem);
    }

    Object.assign(s, {
      activeProvider: body.activeProvider ?? s.activeProvider,
      activePersonaId: body.activePersonaId ?? s.activePersonaId,
      historyLimit: body.historyLimit ?? s.historyLimit,
      activePresetId: body.activePresetId ?? s.activePresetId,
      askModeOnNewChat: typeof body.askModeOnNewChat === 'boolean' ? body.askModeOnNewChat : s.askModeOnNewChat
    });
    if (Array.isArray(body.presets) && body.presets.length) {
      s.presets = body.presets
        .filter((p) => p && p.id && p.name)
        .map((p) => ({ id: p.id, name: p.name, template: String(p.template ?? ''), adult: Boolean(p.adult) }));
      if (!s.presets.some((p) => p.id === s.activePresetId)) s.activePresetId = s.presets[0].id;
    }
    if (body.params) Object.assign(s.params, body.params);
    for (const [key, cfg] of Object.entries(body.providers || {})) this.applyProvider(s, key, cfg);
    if (Array.isArray(body.removeProviders)) {
      for (const key of body.removeProviders) {
        if (s.providers[key] && !s.providers[key].builtin) delete s.providers[key];
      }
      if (!s.providers[s.activeProvider]) s.activeProvider = 'lmstudio';
    }
    if (body.assistant) {
      const a = body.assistant;
      if (typeof a.systemPrompt === 'string') s.assistant.systemPrompt = a.systemPrompt;
      if (typeof a.webSearch === 'boolean') s.assistant.webSearch = a.webSearch;
      if (typeof a.thinking === 'boolean') s.assistant.thinking = a.thinking;
      if (a.params) Object.assign(s.assistant.params, a.params);
    }
    if (typeof body.memory?.autoSummarize === 'boolean') s.memory.autoSummarize = body.memory.autoSummarize;
    if (typeof body.memory?.autoFacts === 'boolean') s.memory.autoFacts = body.memory.autoFacts;
    if (isObj(body.lorebook)) s.lorebook = cleanLoreSettings(body.lorebook, { ...LORE_DEFAULTS, ...s.lorebook });
    if (body.dev) {
      const d = body.dev;
      if (typeof d.particleFix === 'boolean') s.dev.particleFix = d.particleFix;
      if (typeof d.adultCloud === 'boolean') s.dev.adultCloud = d.adultCloud;
      if (d.markup) Object.assign(s.dev.markup, d.markup);
      if (d.theme) Object.assign(s.dev.theme, d.theme);
    }
    this.store.saveSettings();
    res.json(this.payload());
  }

  /** 엔진 하나를 고치거나, 없던 이름이면 커스텀 엔진으로 추가합니다. */
  applyProvider(s, key, cfg) {
    if (s.providers[key]) {
      // 이 기록은 서버가 실제 오류를 보고 쌓는 것이라, 클라이언트 사본으로 덮지 않습니다.
      // hasApiKey / keyFromEnv 는 서버가 만들어 내보낸 표시용 값이라 되돌려 받지 않습니다.
      const { unavailableModels, hasApiKey, keyFromEnv, apiKey, ...safe } = cfg || {};
      Object.assign(s.providers[key], safe);
      /*
       * 키는 마스킹해서 내려보내므로, 화면에서 돌아오는 값은 대개 빈 문자열입니다. 그대로 덮으면 저장해 둔 키가 지워집니다.
       *   빈 값 → 그대로 둠,  null → 지우기 (화면의 '키 지우기'),  그 외 → 새 키로 교체
       */
      if (apiKey === null) s.providers[key].apiKey = '';
      else if (typeof apiKey === 'string' && apiKey.trim()) s.providers[key].apiKey = apiKey.trim();
    } else if (cfg && cfg.label) {
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

  async models(req, res) {
    const provider = req.query.provider || this.store.settings.activeProvider;
    const config = this.engines.config(provider);
    if (!config) return fail(res, 400, `설정되지 않은 엔진: ${provider}`);
    // 저장된 값이라도 한 번 더 봅니다. 허용 목록이 바뀌었거나 settings.json 을 직접 고친 경우가 있습니다.
    const verdict = checkBaseUrl(config.baseUrl);
    if (!verdict.ok) return fail(res, 400, verdict.reason);
    res.json({ models: await listModels(provider, config) });
  }

  clearUnavailable(req, res) {
    const cfg = this.store.settings.providers[req.params.key];
    if (!cfg) return fail(res, 404, '없는 엔진입니다.');
    const count = (cfg.unavailableModels || []).length;
    cfg.unavailableModels = [];
    this.store.saveSettings();
    res.json({ cleared: count });
  }
}
