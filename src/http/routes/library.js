/** 캐릭터와 페르소나: 목록·추가·수정·삭제, 그리고 모델에게 채우게 하는 기능들. */
import { CHARACTER_FIELDS } from '../../content/characters.js';
import { withThinking } from '../../prompt.js';
import { isLocalUrl, checkBaseUrl } from '../../security.js';
import { rollSeeds, sanitizeSeeds, SEED_FIELDS, SEED_KEYS } from '../../persona-seeds.js';
import { genSystem, buildGenPrompt, cleanGenerated, fallbackDescription } from '../../persona-gen.js';
import {
  CHAR_GEN_SYSTEM, CHAR_FIELDS as CHAR_GEN_FIELDS, buildCharPrompt, parseCharacter, looksUsable, mergeCharacters, roughFallback
} from '../../character-gen.js';
import { characterFields, PERSONA_FIELDS, normalizePersona } from '../../services/records.js';
import { wrap, fail, abortOnClose } from '../helpers.js';

export class LibraryRoutes {
  constructor({ store, engines, limits }) {
    Object.assign(this, { store, engines, limits });
  }

  mount(app) {
    this.crud(app, 'characters', this.store.characters, CHARACTER_FIELDS, { beforeRemove: (c) => this.detachCharacter(c) });
    this.crud(app, 'personas', this.store.personas, PERSONA_FIELDS, { normalize: normalizePersona });
    app.post('/api/personas/roll', (req, res) => this.rollPersona(req, res));
    app.post('/api/personas/generate', this.limits.generate, wrap((req, res) => this.generatePersona(req, res)));
    // 내장 캐릭터 중 아직 없는 것만 추가합니다. 기존 캐릭터는 손대지 않습니다.
    app.post('/api/characters/seed', (req, res) => {
      const added = this.store.addMissingBuiltins();
      res.json({ added, characters: this.store.characters.all() });
    });
    app.post('/api/characters/draft', this.limits.generate, wrap((req, res) => this.draftCharacter(req, res)));
  }

  /** 컬렉션 하나에 대한 목록·추가·수정·삭제 경로를 한 번에 만듭니다. */
  crud(app, name, collection, fields, { beforeRemove, normalize = (x) => x } = {}) {
    app.get(`/api/${name}`, (req, res) => res.json(collection.all()));

    app.post(`/api/${name}`, (req, res) => {
      const draft = {};
      for (const f of fields) draft[f] = req.body?.[f] ?? '';
      if (!String(draft.name ?? '').trim()) return fail(res, 400, '이름을 입력해 주세요.');
      res.json(collection.add(normalize(draft)));
    });

    app.put(`/api/${name}/:id`, (req, res) => {
      const patch = {};
      for (const f of fields) if (f in (req.body || {})) patch[f] = req.body[f];
      if ('name' in patch && !String(patch.name ?? '').trim()) return fail(res, 400, '이름을 입력해 주세요.');
      const item = collection.update(req.params.id, normalize(patch));
      if (!item) return fail(res, 404, '없는 항목입니다.');
      res.json(item);
    });

    app.delete(`/api/${name}/:id`, wrap(async (req, res) => {
      const item = collection.get(req.params.id);
      if (item) beforeRemove?.(item);
      if (!(await collection.remove(req.params.id))) return fail(res, 404, '없는 항목입니다.');
      res.json({ ok: true });
    }));
  }

  /**
   * 캐릭터를 지워도 그 캐릭터와 나눈 대화는 계속 이어갈 수 있어야 합니다.
   * 지우기 전에 캐릭터 정보를 대화 안에 복사해 1회성 캐릭터로 바꿔 둡니다.
   * 마음이 바뀌면 대화 상단의 '캐릭터 저장' 으로 다시 목록에 넣을 수 있습니다.
   */
  detachCharacter(character) {
    const copy = { ...characterFields(character), id: null };
    const chats = this.store.chats;
    for (const chat of chats.all()) {
      if (Array.isArray(chat.castIds) && chat.castIds.includes(character.id)) {
        chat.castIds = chat.castIds.filter((id) => id !== character.id);
        chats.save(chat.id);
      }
      if (chat.characterId !== character.id || chat.character) continue;
      chat.character = { ...copy };
      chat.characterId = null;
      chats.save(chat.id);
    }
  }

  /**
   * 랜덤 페르소나 1단계 — 씨앗 태그만 굴립니다. 모델을 부르지 않으므로 즉시 끝나고 요청 제한도 걸지 않습니다.
   * body: { seeds?, only?: ['trait', ...], adult? }  only 를 주면 그 항목만 다시 굴립니다.
   */
  rollPersona(req, res) {
    const keep = sanitizeSeeds(req.body?.seeds || {});
    const only = Array.isArray(req.body?.only) ? req.body.only.filter((k) => SEED_KEYS.includes(k)) : null;
    res.json({ seeds: rollSeeds(keep, only?.length ? only : null, Boolean(req.body?.adult)), fields: SEED_FIELDS });
  }

  /**
   * 2단계 — 씨앗 태그를 모델에 넘겨 소개 문단을 받습니다.
   * 엔진이 없거나 실패하면 태그만으로 만든 문장을 대신 돌려줍니다 (fallback: true).
   * adult 가 켜져 있으면 대화의 성인 프리셋과 같은 규칙을 씁니다 — 기본은 로컬 엔진으로만 나갑니다.
   */
  async generatePersona(req, res) {
    const s = this.store.settings;
    const adult = Boolean(req.body?.adult);
    const seeds = rollSeeds(sanitizeSeeds(req.body?.seeds || {}), null, adult);
    const provider = req.body?.provider || s.activeProvider;
    const config = this.engines.config(provider);
    const bail = (reason) => res.json({ seeds, name: seeds.name, description: fallbackDescription(seeds), fallback: true, reason });

    if (!config || !config.model) return bail('엔진이나 모델이 설정되지 않았습니다.');
    const verdict = checkBaseUrl(config.baseUrl);
    if (!verdict.ok) return bail(verdict.reason);
    if (!config.apiKey && !isLocalUrl(config.baseUrl)) return bail(`${config.label} API 키가 비어 있습니다.`);
    if (adult && !this.engines.adultAllowed(config)) {
      return bail(`성인 페르소나 생성은 로컬 엔진으로만 가능합니다. 지금 선택된 엔진은 로컬 주소가 아닙니다 (${config.label}).`);
    }

    const controller = abortOnClose(res);
    let text;
    try {
      text = await this.engines.complete({
        provider, config, controller, stopOnRepeat: true,
        system: withThinking(genSystem(adult), false),
        messages: [{ role: 'user', content: buildGenPrompt(seeds) }],
        // 소개 한 문단이면 충분하므로 길이를 짧게 잡고, 온도는 설정값을 따릅니다.
        params: { ...s.params, maxTokens: Math.min(s.params.maxTokens ?? 2048, 700) }
      });
    } catch (e) {
      controller.finish();
      if (controller.signal.aborted) return;
      return bail(e.message);
    }
    controller.finish();
    const description = cleanGenerated(text);
    if (!description) return bail('모델이 빈 응답을 보냈습니다.');
    res.json({ seeds, name: seeds.name, description, fallback: false });
  }

  /**
   * 줄글 설명 하나를 캐릭터 시트로 바꿔 돌려줍니다. 저장은 하지 않습니다 —
   * 화면의 입력 칸을 채워 주기만 하고, 사람이 고친 뒤 기존 저장 버튼으로 넣습니다.
   * body: { brief, current?, provider? }  current 는 사용자가 이미 채워 둔 칸(그대로 유지됩니다).
   */
  async draftCharacter(req, res) {
    const s = this.store.settings;
    const brief = String(req.body?.brief || '').trim().slice(0, 4000);
    if (!brief) return fail(res, 400, '어떤 캐릭터인지 먼저 적어 주세요.');

    const current = {};
    for (const { key } of CHAR_GEN_FIELDS) {
      const value = req.body?.current?.[key];
      if (typeof value === 'string' && value.trim()) current[key] = value.trim().slice(0, 2000);
    }

    const provider = req.body?.provider || s.activeProvider;
    const config = this.engines.config(provider);
    if (!config || !config.model) return fail(res, 400, '설정에서 엔진과 모델을 먼저 선택해 주세요.');
    const problem = this.engines.problem(config, provider);
    if (problem) return fail(res, 400, problem);

    const controller = abortOnClose(res);
    /*
     * 지금까지 정해진 값(known) 이후의 빈칸만 채우도록 한 번 부릅니다.
     * 구조화된 라벨 출력이 목적이라 온도를 낮게 고정합니다 — 높을수록 라벨을 바꿔 쓰거나 형식을 벗어납니다.
     * 라벨 형식은 짧은 줄이 반복되는 모양이라 반복 감지가 오작동하기 쉬워, 대신 maxTokens 로 상한을 둡니다.
     */
    const ask = (known) => this.engines.complete({
      provider, config, controller,
      system: withThinking(CHAR_GEN_SYSTEM, false),
      messages: [{ role: 'user', content: buildCharPrompt(brief, known) }],
      params: { ...s.params, temperature: Math.min(s.params.temperature ?? 1, 0.5), maxTokens: Math.max(s.params.maxTokens ?? 2048, 1500) }
    });

    let text;
    try {
      text = await ask(current);
    } catch (e) {
      controller.finish();
      if (controller.signal.aborted) return;
      return fail(res, 502, this.engines.describeFailure(e, provider, config));
    }

    let character = mergeCharacters(current, parseCharacter(text));
    let lastText = text;
    // 첫 시도에서 알맹이가 안 나왔으면 이미 채워진 항목은 두고 남은 빈칸만 한 번 더 요청합니다.
    // 매번 처음부터 다시 시키는 것보다 빈칸만 채우게 하는 쪽이 형식이 훨씬 안정적으로 나옵니다.
    if (!looksUsable(character)) {
      try {
        lastText = await ask(character);
        character = mergeCharacters(character, parseCharacter(lastText));
      } catch {
        if (controller.signal.aborted) { controller.finish(); return; }
        // 재시도 자체가 실패해도 첫 시도 결과는 살아 있으니 계속 진행합니다.
      }
    }
    controller.finish();

    if (!looksUsable(character)) {
      // 그래도 라벨을 못 읽었으면 모델이 실제로 쓴 글을 추가 설정 칸에 남겨 손으로라도 옮길 거리를 줍니다.
      // 재시도가 있었다면 그쪽이 더 최근 시도이므로 재시도의 원문을 씁니다.
      return res.json({
        character: roughFallback(character, lastText),
        fallback: true,
        reason: '모델이 형식을 지키지 않아 일부만 채워졌습니다. 나머지는 직접 채우거나 다시 시도해 보세요.'
      });
    }
    res.json({ character, fallback: false });
  }
}
