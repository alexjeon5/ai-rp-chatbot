/** 대화 하나를 모델에 보낼 준비물 — 캐릭터·페르소나·모드, 시스템 프롬프트, 토큰 예산. */
import { buildSystem, fillVars, withThinking } from '../prompt.js';
import { planContext, contextLimitOf, estimateTokens, IMAGE_TOKENS } from '../context.js';
import { isLocalUrl } from '../security.js';
import { sceneBlock } from '../scene-prompt.js';

/** 보정 전 어림. 엔진이 알려 준 실제 토큰 수와 비교해 보정값을 만듭니다. */
export const rawPromptTokens = (system, history) =>
  estimateTokens(system) + history.reduce((n, m) => n + estimateTokens(m.content) + 6 + IMAGE_TOKENS * (m.attachments?.length || 0), 0);

export class ChatContext {
  constructor(store, engines, lore, backgrounds) {
    this.store = store;
    this.engines = engines;
    this.lore = lore;
    this.backgrounds = backgrounds;
  }

  get settings() {
    return this.store.settings;
  }

  /** 대화에 박혀 있는 1회성 캐릭터가 우선입니다. */
  characterOf(chat) {
    return chat.character || this.store.characters.get(chat.characterId);
  }

  presetOf(id) {
    const s = this.settings;
    return s.presets.find((p) => p.id === id) || s.presets.find((p) => p.id === s.activePresetId) || s.presets[0];
  }

  /** 함께 등장하는 인물. 목록에서 지워진 캐릭터나 주인공 자신은 빼고 돌려줍니다. */
  castOf(chat) {
    if (!Array.isArray(chat.castIds)) return [];
    return chat.castIds
      .filter((id) => id && id !== chat.characterId)
      .map((id) => this.store.characters.get(id))
      .filter(Boolean);
  }

  /** 이 대화에서 화면 표식으로 고를 수 있는 이름들. 표정은 주인공 캐릭터의 표정 그림, 장소는 배경 그림 이름입니다. */
  sceneNames(chat) {
    if (!chat.vn) return { expressions: [], places: [] };
    const character = this.characterOf(chat);
    return {
      expressions: (character?.expressions || []).map((e) => e.label),
      places: this.backgrounds ? this.backgrounds.names() : []
    };
  }

  /**
   * 롤플레이 대화 하나를 보낼 준비물. 캐릭터가 없으면 null 입니다.
   * basis 는 세계관 키워드를 찾을 메시지 묶음입니다 (다시 쓰기면 지워질 마지막 답변을 뺀 것).
   */
  roleplay(chat, { basis = chat } = {}) {
    const s = this.settings;
    const character = this.characterOf(chat);
    if (!character) return null;
    const persona = this.store.personas.get(chat.personaId) || this.store.personas.get(s.activePersonaId);
    const preset = this.presetOf(chat.presetId);
    const cast = this.castOf(chat);
    const system = buildSystem({
      character, persona, template: preset.template, cast,
      lore: this.lore.block(chat, basis.messages),
      facts: chat.facts, memory: chat.memory, particleFix: s.dev.particleFix
    });
    // 화면 표식 안내는 답변을 쓸 때만 뒤에 덧붙입니다. 대신 쓰기·요약 같은 다른 요청에는 섞이지 않게 system 과 따로 둡니다.
    const scene = chat.vn || chat.dice ? sceneBlock({ name: character.name, ...this.sceneNames(chat), dice: Boolean(chat.dice) }) : '';
    return { character, persona, preset, cast, system, scene };
  }

  /** 답변을 쓸 때 실제로 보내는 시스템 프롬프트. */
  replySystem(ctx) {
    return [ctx.system, ctx.scene].filter(Boolean).join('\n\n');
  }

  /** 이름을 채운 작가 노트. 없거나 캐릭터가 없으면 빈 글입니다. */
  authorNote(chat, ctx) {
    if (!ctx || !chat.authorNote?.trim()) return '';
    return fillVars(chat.authorNote, { char: ctx.character.name, user: ctx.persona?.name, particleFix: this.settings.dev.particleFix });
  }

  /** 요약·기억 요청에 쓰는 이름. 여럿이 함께 나오면 이름을 이어 붙입니다. */
  names(ctx) {
    return {
      char: [ctx.character.name, ...ctx.cast.map((c) => c.name)].join('·'),
      user: ctx.persona?.name || '사용자'
    };
  }

  /**
   * 이 대화를 지금 보낸다면 무엇이 들어가는지. 생성·미리보기·게이지·요약이 같은 계산을 씁니다.
   * 토큰 한도 안에서 최근 메시지부터 채우고, '최대 메시지 수' 는 그 위의 상한입니다.
   * @param {object} [o]
   * @param {object} [o.basis] 히스토리를 뽑을 메시지 묶음 (다시 쓰기면 마지막 답변을 뺀 것)
   * @param {string} [o.extra] 히스토리 뒤에 더 붙는 글 (이어쓰기·대신 쓰기 지시)
   */
  plan(chat, { provider = this.settings.activeProvider, basis = chat, extra = '' } = {}) {
    const s = this.settings;
    const config = this.engines.config(provider) || {};
    const assistant = chat.kind === 'assistant';
    const ctx = assistant ? null : this.roleplay(chat, { basis });
    const system = assistant
      ? withThinking(s.assistant.systemPrompt, Boolean(s.assistant.thinking))
      : (ctx && this.replySystem(ctx)) || '';
    const params = assistant ? s.assistant.params : s.params;
    const note = this.authorNote(chat, ctx);
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
}
