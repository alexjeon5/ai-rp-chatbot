import path from 'node:path';
import { readFile, rename } from 'node:fs/promises';
import { Collection, JsonDoc, flushAll, DATA_DIR } from './db.js';
import { IMAGE_DEFAULTS } from './image.js';
import { CHARACTER_FIELDS, characterSig, OLD_BUILTIN_APPEARANCE, BUILTIN_CHARACTERS } from './content/characters.js';
import { BUILTIN_PERSONAS } from './content/personas.js';
import { normalizePresets } from './services/prefs.js';

/* ---------------- 설정 기본값 ---------------- */

/**
 * 서버에 하나뿐인 공용 설정. 계정마다 다른 값(엔진 고르기·모드·파라미터·테마 등)은
 * data/prefs/<계정 id>.json 에 따로 둡니다 — services/prefs.js 참고.
 */
const defaultSettings = () => ({
  // 새 계정이나 엔진을 고르지 않은 계정이 쓰는 엔진. 주인이 설정 → 엔진에서 바꿉니다.
  defaultProvider: 'lmstudio',
  // ComfyUI 로 장면 그리기. src/image.js 의 IMAGE_DEFAULTS 참고.
  image: IMAGE_DEFAULTS(),
  // 엔진별 토큰 어림 보정값. 엔진이 알려 준 실제 토큰 수로 스스로 맞춰 갑니다.
  tokenRatio: {},
  dev: {
    // 성인 모드를 클라우드(외부 API) 엔진에도 보낼지. 개발자 설정에서 경고를 확인해야 켜집니다.
    adultCloud: false
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
 *   data/settings.json           공용 설정 (엔진·이미지 등)
 *   data/prefs/<계정 id>.json     계정별 설정
 *   data/characters/<id>.json
 *   data/personas/<id>.json
 *   data/lorebooks/<id>.json
 *   data/chats/<id>.json
 *   data/backgrounds/<id>.json   배경 그림 목록 (그림 파일은 data/backgrounds/img/)
 *   data/usage.json     날짜별 토큰 사용량
 *   data/discord.json   디스코드 연결: 계정 연결, 연결 코드, 스레드와 대화 (src/services/discord-links.js)
 */
export class Store {
  constructor(dir = DATA_DIR) {
    this.dir = dir;
    this.settingsDoc = new JsonDoc(path.join(dir, 'settings.json'), defaultSettings);
    this.characters = new Collection(path.join(dir, 'characters'));
    this.personas = new Collection(path.join(dir, 'personas'));
    this.lorebooks = new Collection(path.join(dir, 'lorebooks'), (a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    this.chats = new Collection(path.join(dir, 'chats'));
    this.backgrounds = new Collection(path.join(dir, 'backgrounds'), (a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    this.prefs = new Collection(path.join(dir, 'prefs'));
    this.usageDoc = new JsonDoc(path.join(dir, 'usage.json'), () => ({ days: {} }));
    this.discordDoc = new JsonDoc(path.join(dir, 'discord.json'), () => ({ links: {}, codes: {}, threads: {} }));
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
      this.backgrounds.load(),
      this.prefs.load(),
      this.usageDoc.load(),
      this.discordDoc.load()
    ]);
    this.normalizeSettings();
    this.tagBuiltinCharacters();
    this.syncBuiltinCharacters();
    this.tagBuiltinPersonas();
    // 기본 페르소나와 내장 캐릭터·페르소나는 계정마다 따로 받습니다 (services/account-setup.js).
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

    // 계정별로 나누기 전의 설정 파일에는 모드 틀 같은 계정별 값이 아직 남아 있습니다 (legacyPrefs 참고).
    // 옮겨 가기 전까지는 예전처럼 다듬어 둡니다.
    const legacy = s.systemTemplate;
    delete s.systemTemplate;
    if (legacy || Array.isArray(s.presets)) normalizePresets(s, legacy);

    if (!s.providers[s.defaultProvider]) s.defaultProvider = 'lmstudio';

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

  /**
   * 아직 없는 내장 캐릭터만 추가합니다. 이름을 바꿨더라도 builtin 표시로 알아보고 건너뜁니다.
   * @param {object[]} existing 비교할 캐릭터들 (한 계정의 캐릭터). 기본은 전부
   * @param {(c) => object} [prepare] 넣기 전에 손볼 것 (주인 적기)
   */
  addMissingBuiltins(existing = this.characters.all(), prepare = (c) => c) {
    const present = new Set(existing.map((c) => c.builtin).filter(Boolean));
    let added = 0;
    for (const c of BUILTIN_CHARACTERS) {
      if (present.has(c.name)) continue;
      this.characters.add(prepare({ ...c, builtin: c.name, builtinSig: characterSig(c) }));
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
}

export const store = new Store();
