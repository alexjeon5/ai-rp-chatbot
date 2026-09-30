/**
 * 백업 불러오기. 지금 데이터를 지우지 않고 합칩니다.
 * 같은 id 가 이미 있으면 건너뛰므로, 같은 파일을 두 번 불러와도 겹치지 않습니다.
 * id 는 그대로 파일 이름이 되므로 안전한 글자만 받고, 아니면 새로 붙입니다.
 */
import { createHash } from 'node:crypto';
import { uid, merge } from '../db.js';
import { pickPrefs } from './prefs.js';
import { CHARACTER_FIELDS, BUILTIN_CHARACTERS } from '../content/characters.js';
import { cleanFacts, CHAT_FLAGS } from '../chat-ops.js';
import { cleanLorebook } from '../lorebook.js';
import { SAFE_ID, isObj, str, characterFields, normalizePersona } from './records.js';
import { Access } from './access.js';

const characterSignature = (c) => JSON.stringify(CHARACTER_FIELDS.map((f) => str(c[f])));
const personaSignature = (p) => JSON.stringify([str(p.name), str(p.description), str(p.gender), str(p.age), p.traits || []]);

const lorebookSignature = (b) => JSON.stringify([str(b.name), b.entries.map((e) => [e.title, e.keys, e.content])]);

/**
 * 다른 계정이 이미 쓰는 id 를 대신할 id. 불러오는 사람과 원래 id 로 정해지므로,
 * 같은 백업을 두 번 불러오면 두 번째에는 같은 id 가 나와 '이미 있음'으로 건너뜁니다.
 */
const localId = (actor, id) => createHash('sha256').update(`${actor?.id}:${id}`).digest('hex').slice(0, 12);

const cleanCharacter = (raw) => (str(raw.name).trim() ? characterFields(raw) : null);

function cleanPersona(raw) {
  if (!str(raw.name).trim()) return null;
  const persona = normalizePersona({
    name: str(raw.name),
    description: str(raw.description),
    gender: str(raw.gender),
    age: str(raw.age),
    traits: Array.isArray(raw.traits) ? raw.traits.filter((t) => typeof t === 'string') : []
  });
  // 감독 페르소나는 백업을 옮겨도 감독으로 남아야 합니다.
  if (raw.director === true) persona.director = true;
  return persona;
}

/** 로어북 하나. characterIds 는 뒤에서 이 앱의 캐릭터 id 로 맞춰 고칩니다. */
function cleanBook(raw) {
  if (!str(raw.name).trim()) return null;
  return { description: '', global: false, characterIds: [], entries: [], ...cleanLorebook(raw) };
}

const cleanSources = (list) => list.filter(isObj)
  .map((x) => ({ url: str(x.url), title: str(x.title) }))
  .filter((x) => /^https?:\/\//i.test(x.url));

/** 답변 한 장이 따로 들고 있는 값(엔진·사고·출처)을 옮겨 담습니다. */
function copyVariantFields(from, to) {
  for (const k of ['provider', 'model', 'thought']) if (typeof from[k] === 'string') to[k] = from[k];
  if (isObj(from.scene)) {
    const scene = {};
    for (const k of ['expression', 'place']) if (typeof from.scene[k] === 'string') scene[k] = from.scene[k].slice(0, 60);
    if (Object.keys(scene).length) to.scene = scene;
  }
  const c = from.check;
  if (isObj(c) && typeof c.label === 'string' && Number.isFinite(c.sides) && Number.isFinite(c.dc)) {
    to.check = { label: c.label.slice(0, 20), sides: c.sides, dc: c.dc };
  }
}

function cleanMessage(m) {
  const msg = {
    id: SAFE_ID.test(str(m.id)) ? m.id : uid(),
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: str(m.content),
    at: Number.isFinite(m.at) ? m.at : Date.now()
  };
  copyVariantFields(m, msg);
  if (Number.isFinite(m.editedAt)) msg.editedAt = m.editedAt;
  if (Array.isArray(m.sources)) msg.sources = cleanSources(m.sources);
  if (Array.isArray(m.swipes) && m.swipes.length) {
    msg.swipes = m.swipes.filter(isObj).slice(-20).map((v) => {
      const out = { content: str(v.content), at: Number.isFinite(v.at) ? v.at : msg.at };
      copyVariantFields(v, out);
      if (Array.isArray(v.sources)) out.sources = cleanSources(v.sources);
      return out;
    });
    msg.swipeIndex = Math.max(0, Math.min(msg.swipes.length - 1, Number(m.swipeIndex) || 0));
  }
  return msg;
}

function cleanChat(raw) {
  if (!Array.isArray(raw.messages)) return null;
  const messages = raw.messages.filter(isObj).map(cleanMessage);
  const chat = {
    kind: raw.kind === 'assistant' ? 'assistant' : 'rp',
    characterId: typeof raw.characterId === 'string' ? raw.characterId : null,
    personaId: typeof raw.personaId === 'string' ? raw.personaId : null,
    title: str(raw.title) || '가져온 대화',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    messages
  };
  for (const k of ['presetId', 'memory', 'authorNote']) if (typeof raw[k] === 'string') chat[k] = raw[k];
  for (const k of CHAT_FLAGS) if (raw[k] === true) chat[k] = true;
  if (Number.isFinite(raw.summaryUntilAt)) chat.summaryUntilAt = raw.summaryUntilAt;
  if (Number.isFinite(raw.archivedAt)) chat.archivedAt = raw.archivedAt;
  if (Array.isArray(raw.facts)) chat.facts = cleanFacts(raw.facts);
  if (Number.isFinite(raw.factsUntilAt)) chat.factsUntilAt = raw.factsUntilAt;
  if (Array.isArray(raw.castIds)) chat.castIds = raw.castIds.filter((id) => typeof id === 'string');
  if (Array.isArray(raw.lorebookIds)) chat.lorebookIds = raw.lorebookIds.filter((id) => typeof id === 'string');
  if (isObj(raw.character)) {
    const c = cleanCharacter(raw.character);
    if (c) chat.character = { ...c, id: null };
  }
  return chat;
}

export class Backup {
  /**
   * @param {object} store
   * @param {Access} access
   * @param {import('./settings.js').Settings} settings 내보낼 설정 보기와, 불러온 설정을 담을 계정별 설정
   */
  constructor(store, access, settings) {
    this.store = store;
    this.access = access || new Access(store);
    this.settings = settings;
  }

  /**
   * actor 의 항목과 actor 의 계정별 설정 사본. 엔진·API 키·이미지 같은 공용 설정은 담지 않습니다.
   * 사용량 기록과 그림 파일(프로필·배경·장면)도 담지 않습니다.
   */
  export(actor) {
    return {
      exportedAt: new Date().toISOString(),
      settings: pickPrefs(this.settings.view(actor)),
      characters: this.access.characters(actor),
      personas: this.access.personas(actor),
      lorebooks: this.access.lorebooks(actor),
      chats: this.access.chats(actor)
    };
  }

  /**
   * @param {string} kind Access 의 종류 이름
   * @param {(raw) => object|null} clean  읽을 수 있는 항목만 골라 다듬습니다.
   * @param {(item) => string} [signature] 내용이 같은지 가리는 열쇠. 새로 설치한 앱은 기본 캐릭터를
   *   다른 id 로 이미 갖고 있으므로, 내용이 똑같으면 같은 항목으로 보고 건너뜁니다. actor 의 항목과만 비교합니다.
   * @param {Map} [remap] 백업의 id → 이 앱의 id. 대화가 가리키는 캐릭터·페르소나를 고칠 때 씁니다.
   */
  importItems(actor, kind, list, clean, { signature, remap } = {}) {
    const collection = this.access.collectionOf(kind);
    let added = 0;
    let skipped = 0;
    const known = new Map(signature ? this.access.list(kind, actor).map((x) => [signature(x), x.id]) : []);
    for (const raw of Array.isArray(list) ? list : []) {
      const item = isObj(raw) ? clean(raw) : null;
      if (!item) { skipped += 1; continue; }
      item.id = SAFE_ID.test(str(raw.id)) ? raw.id : uid();
      if (typeof raw.id === 'string') remap?.set(raw.id, item.id);
      // id 는 파일 이름이라 모든 계정이 한 공간을 씁니다. 그래서 여기만은 Access 가 아니라 저장소 전체를 봅니다.
      // 내 항목이면 이미 불러온 것이라 건너뛰고, 남의 항목이면 내 몫의 다른 id 로 들어옵니다.
      if (collection.has(item.id) && !this.access.find(kind, actor, item.id)) {
        item.id = localId(actor, item.id);
        if (collection.has(item.id) && !this.access.find(kind, actor, item.id)) item.id = uid();
        if (typeof raw.id === 'string') remap?.set(raw.id, item.id);
      }
      if (collection.has(item.id)) { skipped += 1; continue; }
      const same = signature && known.get(signature(item));
      if (same) {
        if (typeof raw.id === 'string') remap?.set(raw.id, same);
        skipped += 1;
        continue;
      }
      if (Number.isFinite(raw.createdAt)) item.createdAt = raw.createdAt;
      // 백업에 적힌 ownerId 는 믿지 않습니다. 불러온 사람의 항목이 됩니다.
      collection.add(this.access.stamp(actor, item));
      added += 1;
    }
    return { added, skipped };
  }

  /** 백업 데이터를 합칩니다. includeSettings 면 샘플링 값·프롬프트·테마 같은 설정도 덮습니다. */
  import(actor, data, includeSettings) {
    const { store } = this;
    const characterIds = new Map();
    const personaIds = new Map();
    // 백업 속 내장 캐릭터는 '기본' 탭 표시를 살립니다. 같은 내장 캐릭터가 이미 있으면 표시 없이 들어옵니다.
    const builtinTaken = new Set(this.access.characters(actor).map((c) => c.builtin).filter(Boolean));
    const builtinNames = new Set(BUILTIN_CHARACTERS.map((c) => c.name));
    const characters = this.importItems(actor, 'character', data.characters, (raw) => {
      const c = cleanCharacter(raw);
      if (c && builtinNames.has(raw.builtin) && !builtinTaken.has(raw.builtin)) {
        builtinTaken.add(raw.builtin);
        c.builtin = raw.builtin;
        c.builtinSig = str(raw.builtinSig);
      }
      return c;
    }, { signature: characterSignature, remap: characterIds });
    const personas = this.importItems(actor, 'persona', data.personas, cleanPersona, { signature: personaSignature, remap: personaIds });
    const lorebookIds = new Map();
    const lorebooks = this.importItems(actor, 'lorebook', data.lorebooks, (raw) => {
      const book = cleanBook(raw);
      if (book) book.characterIds = book.characterIds.map((id) => characterIds.get(id) ?? id);
      return book;
    }, { signature: lorebookSignature, remap: lorebookIds });
    const chats = this.importItems(actor, 'chat', data.chats, (raw) => {
      const chat = cleanChat(raw);
      if (chat?.characterId) chat.characterId = characterIds.get(chat.characterId) ?? chat.characterId;
      if (chat?.personaId) chat.personaId = personaIds.get(chat.personaId) ?? chat.personaId;
      if (chat?.castIds) chat.castIds = chat.castIds.map((id) => characterIds.get(id) ?? id);
      if (chat?.lorebookIds) chat.lorebookIds = chat.lorebookIds.map((id) => lorebookIds.get(id) ?? id);
      return chat;
    });
    const result = { characters, personas, lorebooks, chats, presets: 0, settings: false };

    // 설정은 불러온 사람의 계정별 설정에만 들어갑니다. 공용 설정(엔진·이미지·클라우드 허용)은 받지 않습니다.
    const s = this.settings.prefs.of(actor);
    const saved = isObj(data.settings) ? pickPrefs(data.settings) : {};
    // 가져온 대화가 쓰던 커스텀 모드가 없으면 대화가 엉뚱한 모드로 돌아가므로, 없는 모드는 늘 추가합니다.
    for (const p of Array.isArray(saved.presets) ? saved.presets : []) {
      if (!isObj(p) || !str(p.id) || !str(p.name) || s.presets.some((x) => x.id === p.id)) continue;
      s.presets.push({ id: str(p.id), name: str(p.name), template: str(p.template), adult: Boolean(p.adult) });
      result.presets += 1;
    }

    // 나머지 설정은 원할 때만 덮습니다. 엔진·API 키는 백업에 들어 있지 않고, 들어 있어도 받지 않습니다.
    if (includeSettings) {
      if (Number.isFinite(saved.historyLimit)) s.historyLimit = saved.historyLimit;
      if (typeof saved.askModeOnNewChat === 'boolean') s.askModeOnNewChat = saved.askModeOnNewChat;
      if (typeof saved.activePresetId === 'string' && s.presets.some((p) => p.id === saved.activePresetId)) {
        s.activePresetId = saved.activePresetId;
      }
      const personaId = personaIds.get(saved.activePersonaId) ?? saved.activePersonaId;
      if (this.access.findPersona(actor, personaId)) s.activePersonaId = personaId;
      // 성인 모드 클라우드 허용은 공용이고 경고를 직접 보고 켜야 하므로, pickPrefs 가 이미 뺐습니다.
      for (const key of ['params', 'assistant', 'dev', 'memory', 'lorebook']) {
        if (isObj(saved[key])) s[key] = merge(s[key], saved[key]);
      }
      result.settings = true;
    }
    this.settings.prefs.save(actor);
    return result;
  }
}
