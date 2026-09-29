import path from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import { Collection, JsonDoc, flushAll, DATA_DIR } from './db.js';
import { IMAGE_DEFAULTS } from './image.js';
import { BUILTIN_TEMPLATES, DEFAULT_SYSTEM_TEMPLATE, ASSISTANT_PROMPT } from './content/templates.js';
import { CHARACTER_FIELDS, characterSig, OLD_BUILTIN_APPEARANCE, BUILTIN_CHARACTERS } from './content/characters.js';
import { BUILTIN_PERSONAS } from './content/personas.js';

/* ---------------- 설정 기본값 ---------------- */

const defaultSettings = () => ({
  activeProvider: 'lmstudio',
  activePersonaId: null,
  historyLimit: 40,
  activePresetId: 'default',
  askModeOnNewChat: true,
  // 기억할 메시지 수 밖으로 밀려난 대화를 자동으로 요약해 둘지.
  memory: { autoSummarize: true, autoFacts: true },
  // 로어북(세계관 설정집). 최근 몇 개 메시지에서 키워드를 찾고, 붙이는 글은 몇 토큰까지 허용할지.
  lorebook: { scanDepth: 4, tokenBudget: 1200 },
  // ComfyUI 로 장면 그리기. src/image.js 의 IMAGE_DEFAULTS 참고.
  image: IMAGE_DEFAULTS(),
  // 엔진별 토큰 어림 보정값. 엔진이 알려 준 실제 토큰 수로 스스로 맞춰 갑니다.
  tokenRatio: {},
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
    // 성인 모드를 클라우드(외부 API) 엔진에도 보낼지. 개발자 설정에서 경고를 확인해야 켜집니다.
    adultCloud: false,
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
  },
  providers: {
    // contextTokens: 모델이 한 번에 받는 토큰 수. LM Studio 는 Context Length 설정과 같게 맞춥니다.
    lmstudio: { label: 'LM Studio', type: 'openai', builtin: true, baseUrl: 'http://localhost:1234/v1', apiKey: 'lm-studio', model: '', contextTokens: 16384, unavailableModels: [] },
    openai: { label: 'OpenAI', type: 'openai', builtin: true, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o', contextTokens: 128000, unavailableModels: [] },
    anthropic: { label: 'Anthropic', type: 'anthropic', builtin: true, baseUrl: 'https://api.anthropic.com/v1', apiKey: '', model: 'claude-sonnet-5', contextTokens: 200000, unavailableModels: [] },
    gemini: { label: 'Google Gemini', type: 'gemini', builtin: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', model: 'gemini-3.8-flash', contextTokens: 1000000, unavailableModels: [] },
    // Ollama Cloud 의 OpenAI 호환 API. 주소를 http://localhost:11434/v1 로 바꾸면 로컬 Ollama 에도 그대로 붙습니다.
    // 클라우드 모델은 한도가 넉넉하지만 요금제 사용량을 아끼려고 컨텍스트를 32K 로 둡니다.
    ollama: { label: 'Ollama', type: 'openai', builtin: true, baseUrl: 'https://ollama.com/v1', apiKey: '', model: 'gemma4:31b', contextTokens: 32768, unavailableModels: [] },
    // Vercel AI Gateway 의 OpenAI 호환 API. 여러 회사의 모델을 'provider/model' 이름 하나로 부릅니다.
    vercel: { label: 'Vercel AI Gateway', type: 'openai', builtin: true, baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: '', model: 'anthropic/claude-sonnet-5', contextTokens: 128000, unavailableModels: [] }
  }
});

/* ---------------- 저장소 ---------------- */

/**
 * 데이터는 항목별 파일로 나뉩니다. 하나를 찾으려고 전체를 뒤질 일이 없고,
 * 편집기로 열어 직접 고치기도 쉽습니다.
 *
 *   data/settings.json
 *   data/characters/<id>.json
 *   data/personas/<id>.json
 *   data/lorebooks/<id>.json
 *   data/chats/<id>.json
 *   data/usage.json     날짜별 토큰 사용량
 */
export class Store {
  constructor(dir = DATA_DIR) {
    this.dir = dir;
    this.settingsDoc = new JsonDoc(path.join(dir, 'settings.json'), defaultSettings);
    this.characters = new Collection(path.join(dir, 'characters'));
    this.personas = new Collection(path.join(dir, 'personas'));
    this.lorebooks = new Collection(path.join(dir, 'lorebooks'), (a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    this.chats = new Collection(path.join(dir, 'chats'));
    this.usageDoc = new JsonDoc(path.join(dir, 'usage.json'), () => ({ days: {} }));
  }

  /** 설정 객체. 고친 뒤에는 saveSettings() 를 부르세요. */
  get settings() {
    return this.settingsDoc.data;
  }

  saveSettings() {
    this.settingsDoc.save();
  }

  async load() {
    await this.migrateFromSingleFile();
    await Promise.all([
      this.settingsDoc.load(),
      this.characters.load(),
      this.personas.load(),
      this.lorebooks.load(),
      this.chats.load(),
      this.usageDoc.load()
    ]);
    this.normalizeSettings();
    this.tagBuiltinCharacters();
    this.syncBuiltinCharacters();

    if (!this.characters.size && !this.personas.size) this.seed();
    this.tagBuiltinPersonas();
    this.addMissingBuiltinPersonas();
    await flushAll();
    return this;
  }

  /** 예전 db.json 한 덩어리를 항목별 파일로 풀어 놓습니다. 한 번만 돕니다. */
  async migrateFromSingleFile() {
    const legacyPath = path.join(this.dir, 'db.json');
    let legacy;
    try {
      legacy = JSON.parse(await readFile(legacyPath, 'utf8'));
    } catch {
      return;
    }

    this.settingsDoc.data = { ...defaultSettings(), ...(legacy.settings || {}) };
    this.saveSettings();
    for (const c of legacy.characters || []) this.characters.add(c);
    for (const p of legacy.personas || []) this.personas.add(p);
    for (const c of legacy.chats || []) this.chats.add(c);
    await flushAll();

    // 원본은 지우지 않고 이름만 바꿔 둡니다. 문제가 생기면 되돌릴 수 있게.
    await rename(legacyPath, `${legacyPath}.migrated`).catch(() => {});
    console.log(`db.json 을 항목별 파일로 옮겼습니다: 캐릭터 ${this.characters.size}개, 대화 ${this.chats.size}개`);
  }

  /** 앱을 올린 뒤 새로 생긴 설정 항목을 채우고, 옛 이름을 정리합니다. */
  normalizeSettings() {
    const s = this.settings;

    const legacy = s.systemTemplate;
    delete s.systemTemplate;
    if (!Array.isArray(s.presets) || !s.presets.length) s.presets = BUILTIN_TEMPLATES();

    const RENAMED = {
      default: ['기본 롤플레이', '롤플레이'],
      novelist: ['소설가 모드', '소설 모드'],
      adult: ['성인 모드 (로컬 전용)', '성인 롤플레이']
    };
    for (const p of s.presets) {
      const pair = RENAMED[p.id];
      if (pair && p.name === pair[0]) p.name = pair[1];
      p.adult = Boolean(p.adult);
    }

    // 성인 모드는 경고를 확인하면 클라우드 엔진으로도 나가므로, 저장된 틀 첫 줄의 '로컬 엔진 전용' 표기를 지웁니다.
    for (const p of s.presets) {
      if (typeof p.template === 'string') p.template = p.template.replace(/^(\[[^\]\n]*?) — 로컬 엔진 전용\]/, '$1]');
    }

    for (const builtin of BUILTIN_TEMPLATES()) {
      if (!s.presets.some((p) => p.id === builtin.id)) s.presets.push(builtin);
    }

    // 내장 모드는 일반/성인이 섞이지 않도록 정해진 순서로 다시 앞쪽에 모읍니다.
    // 사용자가 만든 커스텀 모드는 순서를 건드리지 않고 그 뒤로 보냅니다.
    const order = new Map(BUILTIN_TEMPLATES().map((t, i) => [t.id, i]));
    const builtinPresets = s.presets.filter((p) => order.has(p.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    const customPresets = s.presets.filter((p) => !order.has(p.id));
    s.presets = [...builtinPresets, ...customPresets];

    if (legacy && legacy !== DEFAULT_SYSTEM_TEMPLATE &&
        !s.presets.some((p) => p.template === legacy)) {
      s.presets.push({ id: 'legacy', name: '이전에 쓰던 틀', template: legacy, adult: false });
      s.activePresetId = 'legacy';
    }
    if (!s.presets.some((p) => p.id === s.activePresetId)) s.activePresetId = s.presets[0].id;

    for (const cfg of Object.values(s.providers)) {
      if (!Array.isArray(cfg.unavailableModels)) cfg.unavailableModels = [];
    }
    this.saveSettings();
  }

  /**
   * 내장 캐릭터의 외형 태그를 채웁니다. 외형 태그 칸이 생기기 전에 들어온 캐릭터는 비어 있어서
   * 장면 그리기 때 얼굴이 매번 달라집니다. 이름이 내장 캐릭터와 같고, 태그가 비었거나 예전 기본값
   * 그대로일 때만 바꿉니다 — 사람이 고친 태그와 직접 만든 캐릭터는 그대로 둡니다.
   * builtin 표시가 생기기 전에 들어온 캐릭터용이라 tagBuiltinCharacters() 안에서만 부릅니다.
   */
  fillBuiltinAppearance() {
    const defaults = new Map(BUILTIN_CHARACTERS.map((c) => [c.name, c.appearance]));
    let filled = 0;
    for (const c of this.characters.all()) {
      if (c.builtin) continue;
      const next = defaults.get(c.name);
      const current = String(c.appearance || '').trim();
      if (!next || current === next) continue;
      if (current && !OLD_BUILTIN_APPEARANCE.has(current)) continue;
      this.characters.update(c.id, { appearance: next });
      filled += 1;
    }
    if (filled) console.log(`내장 캐릭터 ${filled}명의 외형 태그를 채웠습니다.`);
    return filled;
  }

  /**
   * builtin 표시가 없던 시절에 들어온 내장 캐릭터를 이름으로 찾아 표시를 붙입니다. 한 번만 돕니다.
   * 지금 내용이 내장 캐릭터와 똑같으면 '손대지 않음', 조금이라도 다르면 '사람이 고침'으로 봅니다 —
   * 예전에 고친 내용을 모르고 덮어쓰는 일이 없게, 애매하면 고친 쪽으로 둡니다.
   */
  tagBuiltinCharacters() {
    const s = this.settings;
    if (s.builtinCharactersTagged) return 0;
    this.fillBuiltinAppearance();

    const byName = new Map(BUILTIN_CHARACTERS.map((c) => [c.name, c]));
    const taken = new Set(this.characters.all().map((c) => c.builtin).filter(Boolean));
    let tagged = 0;
    for (const c of this.characters.all()) {
      const def = byName.get(c.name);
      if (c.builtin || !def || taken.has(def.name)) continue;
      taken.add(def.name);
      this.characters.update(c.id, { builtin: def.name, builtinSig: characterSig(def) });
      tagged += 1;
    }
    s.builtinCharactersTagged = true;
    this.saveSettings();
    return tagged;
  }

  /**
   * 사람이 손대지 않은 내장 캐릭터를 코드의 최신 내용으로 맞춥니다.
   * builtinSig 는 그 캐릭터가 마지막으로 받은 내장 내용의 지문입니다. 지금 내용의 지문이
   * 그것과 같으면 손대지 않은 것이므로 새 내용으로 바꾸고, 다르면 사람이 고친 것이므로 둡니다.
   */
  syncBuiltinCharacters() {
    const byName = new Map(BUILTIN_CHARACTERS.map((c) => [c.name, c]));
    let synced = 0;
    for (const c of this.characters.all()) {
      const def = byName.get(c.builtin);
      if (!def) continue;
      const latest = characterSig(def);
      if (c.builtinSig === latest || characterSig(c) !== c.builtinSig) continue;
      const patch = Object.fromEntries(CHARACTER_FIELDS.map((f) => [f, def[f] ?? '']));
      this.characters.update(c.id, { ...patch, builtinSig: latest });
      synced += 1;
    }
    if (synced) console.log(`내장 캐릭터 ${synced}명을 새 설정으로 바꿨습니다.`);
    return synced;
  }

  /** 아직 없는 내장 캐릭터만 추가합니다. 이름을 바꿨더라도 builtin 표시로 알아보고 건너뜁니다. */
  addMissingBuiltins() {
    const present = new Set(this.characters.all().map((c) => c.builtin).filter(Boolean));
    let added = 0;
    for (const c of BUILTIN_CHARACTERS) {
      if (present.has(c.name)) continue;
      this.characters.add({ ...c, builtin: c.name, builtinSig: characterSig(c) });
      added += 1;
    }
    return added;
  }

  /**
   * director 표시가 생기기 전에 들어온 '감독' 페르소나를 이름으로 찾아 표시를 붙입니다. 한 번만 돕니다.
   * 표시는 페르소나에 남으므로, 그 뒤로 이름을 바꿔도 감독으로 동작합니다.
   */
  tagBuiltinPersonas() {
    const s = this.settings;
    if (s.builtinPersonasTagged) return 0;
    let tagged = 0;
    for (const def of BUILTIN_PERSONAS.filter((p) => p.director)) {
      for (const p of this.personas.all()) {
        if (p.name !== def.name || p.director) continue;
        this.personas.update(p.id, { director: true });
        tagged += 1;
      }
    }
    s.builtinPersonasTagged = true;
    this.saveSettings();
    return tagged;
  }

  /**
   * 내장 페르소나 중 아직 한 번도 넣지 않은 것만 추가합니다. 넣은 이름은 설정에 적어 두어,
   * 사용자가 지운 페르소나가 다음 실행 때 되살아나지 않게 합니다.
   */
  addMissingBuiltinPersonas() {
    const s = this.settings;
    if (!Array.isArray(s.seededPersonas)) s.seededPersonas = [];
    const names = new Set(this.personas.all().map((p) => p.name));
    let added = 0;
    for (const p of BUILTIN_PERSONAS) {
      if (s.seededPersonas.includes(p.name)) continue;
      if (!names.has(p.name)) {
        this.personas.add({ ...p, traits: [...p.traits] });
        added += 1;
      }
      s.seededPersonas.push(p.name);
    }
    this.saveSettings();
    return added;
  }

  seed() {
    const persona = this.personas.add({
      name: '나',
      description: '평범한 대학생. 호기심이 많고 말수가 적은 편이다.'
    });
    this.settings.activePersonaId = persona.id;
    this.saveSettings();
    this.addMissingBuiltins();
  }
}

export const store = new Store();
