/**
 * 설정 보기·저장. 공용 설정(settings.json)과 계정별 설정(data/prefs/<id>.json)을 합쳐 한 모양으로 보여 주고,
 * 저장할 때는 다시 나눠 담습니다. 화면은 예전처럼 설정 하나만 봅니다.
 *
 *   공용, 주인만 바꿈   providers(엔진 주소·키·모델), image, dev.adultCloud, defaultProvider
 *   공용, 서버가 씀     tokenRatio (엔진별 토큰 어림 보정)
 *   계정별             prefs.js 의 PREF_KEYS
 */
import { supportsWebSearch } from '../providers.js';
import { checkBaseUrl, maskProviders } from '../security.js';
import { DEFAULT_SYSTEM_TEMPLATE, BUILTIN_TEMPLATES } from '../content/templates.js';
import { BUILTIN_CHARACTERS } from '../content/characters.js';
import {
  imageConfig, GEMINI_RATIOS, OPENAI_SIZES, OPENAI_QUALITIES, looksLikeWorkflow, CORE_BLOCK_TERMS, CORE_NEGATIVE, COMMON_SAMPLERS, COMMON_SCHEDULERS
} from '../image.js';
import { cleanLoreSettings, LORE_DEFAULTS } from '../lorebook.js';
import { isObj } from './records.js';
import { AppError } from './errors.js';

const clampTo = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);

/** 엔진이 하나도 없을 때 마지막으로 기대는 엔진. 내장이라 지울 수 없습니다. */
const FALLBACK_PROVIDER = 'lmstudio';

export class Settings {
  /**
   * @param {{ store, prefs: import('./prefs.js').UserPrefs, engines: import('./engines.js').Engines }} deps
   */
  constructor({ store, prefs, engines }) {
    Object.assign(this, { store, prefs, engines });
  }

  /** 공용 설정(settings.json). */
  get shared() {
    return this.store.settings;
  }

  static canManage(actor) {
    return actor?.role === 'owner';
  }

  /** 이 사람이 쓸 엔진. 고른 엔진이 없거나 지워졌으면 공용 기본 엔진을 씁니다. */
  providerFor(actor) {
    const { providers, defaultProvider } = this.shared;
    const chosen = this.prefs.of(actor).activeProvider;
    if (chosen && providers[chosen]) return chosen;
    return providers[defaultProvider] ? defaultProvider : FALLBACK_PROVIDER;
  }

  /**
   * 이 사람에게 적용되는 설정 전체. 읽기 전용으로 씁니다 — 고칠 때는 update() 나 prefs 를 거칩니다.
   * 대화에 관한 설정은 요청한 사람이 아니라 그 대화의 주인(access.ownerOf(chat))으로 부릅니다.
   */
  view(actor) {
    const shared = this.shared;
    const { id, createdAt, ...mine } = this.prefs.of(actor);
    return {
      ...mine,
      activeProvider: this.providerFor(actor),
      defaultProvider: shared.defaultProvider,
      providers: shared.providers,
      image: shared.image,
      tokenRatio: shared.tokenRatio,
      dev: { ...mine.dev, adultCloud: shared.dev?.adultCloud === true }
    };
  }

  /**
   * 화면으로 보낼 설정. 읽기 전용 정보를 덧붙이고 API 키는 가립니다.
   * GET 과 PUT 이 같은 모양을 돌려줘야, 저장한 뒤에도 화면이 이 값들을 잃지 않습니다.
   */
  payload(actor) {
    const s = this.view(actor);
    const webSearchCapable = {};
    for (const key of Object.keys(s.providers)) webSearchCapable[key] = supportsWebSearch(key, this.engines.config(key));
    return {
      ...s,
      // API 키는 브라우저로 내보내지 않습니다. 들어 있는지 여부만 알려 줍니다.
      providers: maskProviders(s.providers),
      // 예전 설정 파일에는 새로 생긴 항목(gemini 등)이 없어서 기본값을 채워 보냅니다.
      image: imageConfig(s.image),
      webSearchCapable,
      // 엔진·이미지 같은 공용 설정을 바꿀 수 있는지. 화면이 주인 전용 칸을 보일지 정합니다.
      canManage: Settings.canManage(actor),
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

  /**
   * 설정 창의 저장. 설정 창은 모든 탭을 한 번에 보내므로:
   *   - 주인이 아니면 공용 항목(엔진·이미지·클라우드 허용·기본 엔진)은 거절하지 않고 조용히 뺍니다. 나머지는 저장됩니다
   *   - 거부할 값이 하나라도 있으면 아무것도 바꾸지 않도록 먼저 검사합니다
   * @returns 저장한 뒤의 payload
   */
  update(actor, body = {}) {
    const shared = this.shared;
    const manage = Settings.canManage(actor);

    let image = null;
    if (manage) {
      for (const [key, cfg] of Object.entries(body.providers || {})) {
        if (cfg?.baseUrl === undefined) continue;
        const verdict = checkBaseUrl(String(cfg.baseUrl));
        if (!verdict.ok) throw new AppError(`'${key}' 엔진 주소를 쓸 수 없습니다.\n${verdict.reason}`);
      }
      if (isObj(body.image)) {
        const checked = this.checkImage(shared.image, body.image);
        if (typeof checked === 'string') throw new AppError(checked);
        image = checked;
      }
    }

    if (manage) this.applyShared(shared, body, image);
    this.applyPrefs(this.prefs.of(actor), body, actor);
    return this.payload(actor);
  }

  /** 주인만 바꾸는 공용 항목. */
  applyShared(s, body, image) {
    if (image) s.image = image;
    for (const [key, cfg] of Object.entries(body.providers || {})) this.applyProvider(s, key, cfg);
    if (Array.isArray(body.removeProviders)) {
      for (const key of body.removeProviders) {
        if (s.providers[key] && !s.providers[key].builtin) delete s.providers[key];
      }
    }
    if (typeof body.defaultProvider === 'string' && s.providers[body.defaultProvider]) s.defaultProvider = body.defaultProvider;
    if (!s.providers[s.defaultProvider]) s.defaultProvider = FALLBACK_PROVIDER;
    if (typeof body.dev?.adultCloud === 'boolean') s.dev.adultCloud = body.dev.adultCloud;
    this.store.saveSettings();
  }

  /** 계정마다 따로 두는 항목. */
  applyPrefs(p, body, actor) {
    Object.assign(p, {
      activeProvider: body.activeProvider ?? p.activeProvider,
      activePersonaId: body.activePersonaId ?? p.activePersonaId,
      historyLimit: body.historyLimit ?? p.historyLimit,
      activePresetId: body.activePresetId ?? p.activePresetId,
      askModeOnNewChat: typeof body.askModeOnNewChat === 'boolean' ? body.askModeOnNewChat : p.askModeOnNewChat
    });
    if (Array.isArray(body.presets) && body.presets.length) {
      p.presets = body.presets
        .filter((x) => x && x.id && x.name)
        .map((x) => ({ id: x.id, name: x.name, template: String(x.template ?? ''), adult: Boolean(x.adult) }));
      if (!p.presets.some((x) => x.id === p.activePresetId)) p.activePresetId = p.presets[0].id;
    }
    if (body.params) Object.assign(p.params, body.params);
    if (body.assistant) {
      const a = body.assistant;
      if (typeof a.systemPrompt === 'string') p.assistant.systemPrompt = a.systemPrompt;
      if (typeof a.webSearch === 'boolean') p.assistant.webSearch = a.webSearch;
      if (typeof a.thinking === 'boolean') p.assistant.thinking = a.thinking;
      if (a.params) Object.assign(p.assistant.params, a.params);
    }
    if (typeof body.memory?.autoSummarize === 'boolean') p.memory.autoSummarize = body.memory.autoSummarize;
    if (typeof body.memory?.autoFacts === 'boolean') p.memory.autoFacts = body.memory.autoFacts;
    if (isObj(body.lorebook)) p.lorebook = cleanLoreSettings(body.lorebook, { ...LORE_DEFAULTS, ...p.lorebook });
    if (body.dev) {
      const d = body.dev;
      if (typeof d.particleFix === 'boolean') p.dev.particleFix = d.particleFix;
      if (d.markup) Object.assign(p.dev.markup, d.markup);
      if (d.theme) Object.assign(p.dev.theme, d.theme);
    }
    this.prefs.save(actor);
  }

  /**
   * 이미지 설정을 검사해 새 값을 만듭니다. 문제가 있으면 안내 문구(문자열)를 돌려주고, 저장된 값은 건드리지 않습니다.
   */
  checkImage(current, body) {
    const next = imageConfig(current);
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
    for (const k of ['enabled', 'freeAfter', 'reviewTags', 'useReference']) if (typeof body[k] === 'boolean') next[k] = body[k];
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
    return next;
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

  /** 엔진이 알려 준 실제 토큰 수로 고친 어림 보정값. 엔진의 성질이라 모두가 같이 씁니다. */
  noteTokenRatio(provider, ratio) {
    const s = this.shared;
    s.tokenRatio = { ...(s.tokenRatio || {}), [provider]: ratio };
    this.store.saveSettings();
  }
}
