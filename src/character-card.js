/**
 * 캐릭터 카드(Character Card V1·V2·V3)와 이 앱의 캐릭터·로어북 사이의 변환. 저장소를 모르는 순수 규칙입니다.
 *
 * 카드의 `description` 은 외형·성격·배경이 한데 든 긴 글이라 이 앱의 `personality` 로 받습니다.
 * 이 앱에서 내보낸 카드는 원래 칸을 `extensions.rpchat` 에 함께 담아, 다시 불러올 때 그대로 되살립니다.
 */
import { CHARACTER_FIELDS } from './content/characters.js';
import { CardError } from './png-card.js';
import { isObj, str, characterFields } from './services/records.js';

export const CARD_SPEC = 'chara_card_v2';
const KNOWN_SPECS = new Set(['chara_card_v2', 'chara_card_v3']);

/** 예전 카드의 <USER>/<BOT>, 줄바꿈 형식을 이 앱의 자리표시자에 맞춥니다. */
const text = (v) => str(v).replace(/\r\n?/g, '\n').replace(/<USER>/gi, '{{user}}').replace(/<BOT>/gi, '{{char}}').trim();

/** 대화 예시의 <START> 구분줄은 빈 줄로 바꿉니다. */
const example = (v) => text(v).replace(/^[ \t]*<START>[ \t]*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();

const list = (v) => (Array.isArray(v) ? v : str(v).split(',')).map((x) => str(x).trim()).filter(Boolean);

const priorityOf = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.min(100, Math.max(0, Math.round(Number(v)))) : 50);

/** 카드 로어북의 항목 하나 → cleanEntry 가 받는 모양 */
function entryFromCard(e) {
  if (!isObj(e)) return null;
  return {
    title: str(e.comment || e.name),
    keys: list(e.keys),
    secondaryKeys: e.selective === false ? [] : list(e.secondary_keys),
    content: text(e.content),
    enabled: e.enabled !== false && e.disable !== true,
    constant: e.constant === true,
    caseSensitive: e.case_sensitive === true,
    priority: priorityOf(e.priority)
  };
}

/** 카드의 character_book → cleanLorebook 이 받는 모양. 항목이 없으면 null. */
export function bookFromCard(book, fallbackName) {
  if (!isObj(book) || !Array.isArray(book.entries) || !book.entries.length) return null;
  return {
    name: str(book.name).trim() || fallbackName,
    description: str(book.description),
    entries: book.entries.map(entryFromCard).filter(Boolean)
  };
}

/** 이 앱의 로어북들 → 카드의 character_book 하나. 항목은 순서대로 이어 붙입니다. */
export function bookToCard(books, fallbackName) {
  const entries = books.flatMap((b) => b.entries || []);
  if (!entries.length) return null;
  return {
    name: books.length === 1 ? books[0].name : fallbackName,
    description: books.length === 1 ? books[0].description || '' : '',
    recursive_scanning: false,
    extensions: {},
    entries: entries.map((e, i) => ({
      id: i,
      keys: e.keys,
      secondary_keys: e.secondaryKeys || [],
      comment: e.title,
      name: e.title,
      content: e.content,
      enabled: e.enabled,
      constant: e.constant,
      selective: Boolean(e.secondaryKeys?.length),
      case_sensitive: e.caseSensitive,
      priority: e.priority,
      insertion_order: 100 - e.priority,
      position: 'before_char',
      extensions: {}
    }))
  };
}

/** 카드의 data 부분(1판은 카드 전체) → 이 앱의 캐릭터 칸 */
function fieldsFromCard(data) {
  const main = text(data.description);
  const personality = text(data.personality);
  const notes = [text(data.system_prompt), text(data.post_history_instructions)].filter(Boolean).join('\n\n');
  return {
    name: text(data.name),
    avatar: '',
    tags: list(data.tags).join(', '),
    description: '',
    appearance: '',
    personality: [main, personality].filter(Boolean).join('\n\n'),
    speech: '',
    scenario: text(data.scenario),
    greeting: text(data.first_mes),
    exampleDialogue: example(data.mes_example),
    notes
  };
}

/**
 * 카드 JSON 을 해석합니다.
 * @returns {{character: object, book: object|null, dropped: string[]}} dropped 는 옮기지 못한 정보의 안내 글
 */
export function parseCard(raw) {
  if (!isObj(raw)) throw new CardError('캐릭터 카드 형식이 아닙니다.');
  const v2 = KNOWN_SPECS.has(raw.spec) && isObj(raw.data);
  if (!v2 && !str(raw.name).trim()) throw new CardError('캐릭터 카드 형식이 아닙니다.');
  const data = v2 ? raw.data : raw;

  const own = data.extensions?.rpchat?.character;
  const character = isObj(own) && str(own.name).trim() ? characterFields(own) : fieldsFromCard(data);
  if (!character.name.trim()) throw new CardError('이름이 없는 카드입니다.');

  const dropped = [];
  if (list(data.alternate_greetings).length) dropped.push(`대체 첫 대사 ${list(data.alternate_greetings).length}개`);
  if (!isObj(own) && text(data.creator_notes)) dropped.push('제작자 메모');
  return { character, book: bookFromCard(data.character_book, `${character.name} 세계관`), dropped };
}

/**
 * 캐릭터 → V2 카드. 이 앱의 칸은 카드 표준 칸에 풀어 담고, 원래 칸은 extensions.rpchat 에 그대로 둡니다.
 * @param {object} character
 * @param {object[]} books 이 캐릭터에 묶인 로어북들
 */
export function buildCard(character, books = []) {
  const c = characterFields(character);
  const description = [
    c.personality,
    c.speech && `말투: ${c.speech}`,
    c.appearance && `외형: ${c.appearance}`,
    c.notes && `추가 설정: ${c.notes}`
  ].filter(Boolean).join('\n\n');
  const data = {
    name: c.name,
    description,
    personality: '',
    scenario: c.scenario,
    first_mes: c.greeting,
    mes_example: c.exampleDialogue,
    creator_notes: c.description,
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: list(c.tags),
    creator: '',
    character_version: '',
    extensions: { rpchat: { character: Object.fromEntries(CHARACTER_FIELDS.map((f) => [f, c[f]])) } }
  };
  const book = bookToCard(books, `${c.name} 세계관`);
  if (book) data.character_book = book;
  return { spec: CARD_SPEC, spec_version: '2.0', data };
}
