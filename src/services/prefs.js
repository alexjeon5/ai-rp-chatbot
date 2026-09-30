/**
 * 계정별 설정. data/prefs/<userId>.json 에 한 사람의 값만 둡니다.
 * 저장된 값 아래에 코드의 기본값을 깔아서, 새로 생긴 항목은 자동으로 채워집니다 (JsonDoc 과 같은 규칙).
 *
 * 엔진 주소·키, 이미지, 성인 모드 클라우드 허용처럼 서버 하나에 하나뿐인 값은 여기 없고 settings.json 에 있습니다.
 * 두 쪽을 합쳐 보여 주는 일은 services/settings.js 의 Settings 가 합니다.
 */
import { merge } from '../db.js';
import { BUILTIN_TEMPLATES, DEFAULT_SYSTEM_TEMPLATE, ASSISTANT_PROMPT } from '../content/templates.js';
import { SAFE_ID, isObj } from './records.js';

/** 계정마다 따로 두는 설정 항목. dev 는 이 중 particleFix·markup·theme 만입니다 (adultCloud 는 공용). */
export const PREF_KEYS = [
  'activeProvider', 'activePersonaId', 'activePresetId', 'presets', 'askModeOnNewChat', 'historyLimit',
  'params', 'assistant', 'memory', 'lorebook', 'dev'
];

export const defaultPrefs = () => ({
  // 비워 두면 공용 기본 엔진(settings.json 의 defaultProvider)을 씁니다.
  activeProvider: null,
  activePersonaId: null,
  historyLimit: 40,
  activePresetId: 'default',
  askModeOnNewChat: true,
  // 기억할 메시지 수 밖으로 밀려난 대화를 자동으로 요약해 둘지.
  memory: { autoSummarize: true, autoFacts: true },
  // 로어북(세계관 설정집). 최근 몇 개 메시지에서 키워드를 찾고, 붙이는 글은 몇 토큰까지 허용할지.
  lorebook: { scanDepth: 4, tokenBudget: 1200 },
  presets: BUILTIN_TEMPLATES(),
  params: { temperature: 1.0, maxTokens: 2048, topP: 0.95, topK: 64, repeatPenalty: 1.1 },
  assistant: {
    systemPrompt: ASSISTANT_PROMPT,
    webSearch: false,
    thinking: false,
    params: { temperature: 0.7, maxTokens: 2048, topP: 0.95, topK: 40, repeatPenalty: 1.05 }
  },
  dev: {
    particleFix: true,
    markup: { asterisk: true, paren: true, speaker: true, quote: true },
    theme: {
      bg: '#15111a',
      panel: '#1d1822',
      line: '#372f42',
      text: '#ede7ee',
      muted: '#9c90a8',
      accent: '#d9b168',
      fontSans: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
      fontSerif: "'Gowun Batang', 'Nanum Myeongjo', serif",
      fontSize: 15
    }
  }
});

/**
 * 계정 준비(AccountSetup)가 남기는 부기. 화면으로 보내지 않습니다.
 *   onboarded       기본 페르소나·내장 캐릭터를 넣어 준 계정인지
 *   seededPersonas  넣어 준 적 있는 내장 페르소나 이름. 사용자가 지운 것이 되살아나지 않게 합니다
 */
export const BOOK_KEYS = ['onboarded', 'seededPersonas'];

/** 어떤 설정 묶음에서 계정별 항목만 골라 냅니다. dev 의 adultCloud 는 공용이라 뺍니다. */
export function pickPrefs(source = {}) {
  const out = {};
  for (const key of PREF_KEYS) if (key in source) out[key] = structuredClone(source[key]);
  if (isObj(out.dev)) delete out.dev.adultCloud;
  return out;
}

/**
 * 대화 모드 틀 목록을 다듬습니다. 앱을 올린 뒤 새로 생긴 내장 틀을 채우고, 옛 이름을 새 이름으로 바꾸고,
 * 내장 틀을 정해진 순서로 앞에 모읍니다. legacyTemplate 은 틀 목록이 생기기 전의 systemTemplate 입니다.
 * @param {{ presets?: object[], activePresetId?: string }} p  고칠 설정 (그 자리에서 바꿉니다)
 */
export function normalizePresets(p, legacyTemplate) {
  if (!Array.isArray(p.presets) || !p.presets.length) p.presets = BUILTIN_TEMPLATES();

  const RENAMED = {
    default: ['기본 롤플레이', '롤플레이'],
    novelist: ['소설가 모드', '소설 모드'],
    adult: ['성인 모드 (로컬 전용)', '성인 롤플레이']
  };
  for (const preset of p.presets) {
    const pair = RENAMED[preset.id];
    if (pair && preset.name === pair[0]) preset.name = pair[1];
    preset.adult = Boolean(preset.adult);
  }

  // 성인 모드는 경고를 확인하면 클라우드 엔진으로도 나가므로, 저장된 틀 첫 줄의 '로컬 엔진 전용' 표기를 지웁니다.
  for (const preset of p.presets) {
    if (typeof preset.template === 'string') preset.template = preset.template.replace(/^(\[[^\]\n]*?) — 로컬 엔진 전용\]/, '$1]');
  }

  for (const builtin of BUILTIN_TEMPLATES()) {
    if (!p.presets.some((x) => x.id === builtin.id)) p.presets.push(builtin);
  }

  // 내장 모드는 일반/성인이 섞이지 않도록 정해진 순서로 다시 앞쪽에 모읍니다.
  // 사용자가 만든 커스텀 모드는 순서를 건드리지 않고 그 뒤로 보냅니다.
  const order = new Map(BUILTIN_TEMPLATES().map((t, i) => [t.id, i]));
  const builtinPresets = p.presets.filter((x) => order.has(x.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  const customPresets = p.presets.filter((x) => !order.has(x.id));
  p.presets = [...builtinPresets, ...customPresets];

  if (legacyTemplate && legacyTemplate !== DEFAULT_SYSTEM_TEMPLATE &&
      !p.presets.some((x) => x.template === legacyTemplate)) {
    p.presets.push({ id: 'legacy', name: '이전에 쓰던 틀', template: legacyTemplate, adult: false });
    p.activePresetId = 'legacy';
  }
  if (!p.presets.some((x) => x.id === p.activePresetId)) p.activePresetId = p.presets[0].id;
  return p;
}

export class UserPrefs {
  /**
   * @param {import('../store.js').Store} store  store.prefs 컬렉션을 씁니다 (파일 이름이 곧 계정 id)
   * @param {{ initial?: () => object }} [o]  처음 보는 계정의 시작값. 기본은 코드 기본값입니다
   */
  constructor(store, { initial = () => ({}) } = {}) {
    this.store = store;
    this.initial = initial;
    // 이번 실행에서 기본값을 채워 둔 계정. 파일을 올린 뒤 한 번만 다듬습니다.
    this.ready = new Set();
  }

  get collection() {
    return this.store.prefs;
  }

  /** 저장할 수 있는 계정 id 인지. id 가 곧 파일 이름입니다. */
  static storable(actor) {
    return typeof actor?.id === 'string' && SAFE_ID.test(actor.id);
  }

  /** 기본값 위에 값을 깔고 틀 목록을 다듬은 새 설정. 부기는 그대로 옮깁니다. */
  build(raw = {}) {
    const out = normalizePresets(merge(defaultPrefs(), pickPrefs(raw)));
    for (const key of BOOK_KEYS) if (key in raw) out[key] = raw[key];
    return out;
  }

  /**
   * 이 계정의 설정. 고친 뒤에는 save(actor) 를 부릅니다.
   * 저장할 수 없는 actor(주인이 아직 정해지지 않은 옛 항목의 주인 등)는 시작값을 담은 저장하지 않는 사본을 받습니다.
   */
  of(actor) {
    if (!UserPrefs.storable(actor)) return this.build(this.initial());
    const found = this.collection.get(actor.id);
    if (!found) {
      this.ready.add(actor.id);
      return this.collection.add({ id: actor.id, ...this.build(this.initial()) });
    }
    if (!this.ready.has(actor.id)) {
      this.ready.add(actor.id);
      Object.assign(found, this.build(found));
      this.collection.save(actor.id);
    }
    return found;
  }

  /** 있는지만 봅니다. 없는 계정의 파일을 만들지 않습니다. */
  has(actor) {
    return UserPrefs.storable(actor) && this.collection.has(actor.id);
  }

  /** 계정의 설정 파일을 지웁니다 (계정 데이터를 모두 지울 때). */
  remove(actor) {
    this.ready.delete(actor?.id);
    return UserPrefs.storable(actor) ? this.collection.remove(actor.id) : Promise.resolve(false);
  }

  save(actor) {
    if (UserPrefs.storable(actor)) this.collection.save(actor.id);
  }
}
