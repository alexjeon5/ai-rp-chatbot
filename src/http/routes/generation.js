/** 모델에게 글을 쓰게 하는 경로: 답변, 기억 요약, 자동 기억, 대신 쓰기. */
import { uid } from '../../db.js';
import { streamChat, supportsWebSearch } from '../../providers.js';
import { fillVars, withThinking } from '../../prompt.js';
import { makeThoughtStripper, looksRepetitive } from '../../sanitize.js';
import { nextRatio } from '../../context.js';
import {
  addSwipe, syncSwipe, joinContinuation, CONTINUE_PROMPT, withAuthorNote,
  pendingForSummary, takeChunk, SUMMARY_MIN, SUMMARY_SYSTEM, buildSummaryPrompt, cleanSummary,
  FACT_EVERY, factsWindow, turnsSinceFacts, FACTS_SYSTEM, buildFactsPrompt, parseFactOps, applyFactOps,
  invalidateFacts, impersonatePrompt, cleanImpersonation
} from '../../chat-ops.js';
import { choicesPrompt, parseChoices, CHOICE_COUNT } from '../../choices.js';
import { rawPromptTokens } from '../../services/chat-context.js';
import { extractDirectives, resolveScene, sceneTags, checkTag } from '../../../public/js/shared/scene-tags.js';
import { wrap, fail, abortOnClose, EventStream } from '../helpers.js';

const LOOP_NOTICE = '\n\n(같은 말이 되풀이되어 생성을 멈췄습니다. 재전송을 누르거나, 설정에서 반복 억제 값을 올려 보세요.)';

export class GenerationRoutes {
  constructor({ store, access, engines, context, jobs, limits, attachments, usage }) {
    Object.assign(this, { store, access, engines, context, jobs, limits, attachments, usage });
  }

  mount(app) {
    const post = (path, fn) => app.post(path, this.limits.generate.middleware, wrap((req, res) => fn.call(this, req, res)));
    post('/api/chats/:id/generate', this.generate);
    post('/api/chats/:id/summarize', this.summarize);
    post('/api/chats/:id/impersonate', this.impersonate);
    post('/api/chats/:id/choices', this.choices);
    post('/api/chats/:id/facts/extract', this.extractFacts);
  }

  /**
   * body: { regenerate?, continue?, provider? }
   *   (기본)      마지막 턴 다음에 새 답변을 씁니다
   *   regenerate  마지막 답변의 다른 버전을 한 장 더 씁니다. 이전 버전은 넘겨보기로 남습니다
   *   continue    마지막 답변 끝에 이어 씁니다
   */
  async generate(req, res) {
    const s = this.store.settings;
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    const assistant = chat.kind === 'assistant';

    // 뒤에서 돌던 요약·기억 확인이 있으면 멈춥니다. 로컬 엔진은 한 번에 하나만 처리해서,
    // 그대로 두면 답변이 그만큼 늦게 시작합니다. 멈춘 작업은 다음 기회에 다시 돕니다.
    this.jobs.pauseBackground(chat.id);

    const mode = req.body?.continue ? 'continue' : req.body?.regenerate ? 'regenerate' : 'new';
    const last = chat.messages[chat.messages.length - 1];
    // 마지막이 사용자 턴이면 재전송은 그냥 새로 쓰기(실패한 요청 다시 보내기)와 같습니다.
    const target = mode !== 'new' && last?.role === 'assistant' ? last : null;
    if (mode === 'continue' && !target) {
      return fail(res, 400, '이어 쓸 답변이 없습니다. 마지막 메시지가 AI 의 답변일 때만 이어 쓸 수 있습니다.');
    }

    const provider = req.body?.provider || s.activeProvider;
    const config = this.engines.config(provider);
    const problem = this.engines.problem(config, provider);
    if (problem) return fail(res, 400, problem);

    // 다른 버전을 쓸 때는 지금 답변을 빼고 보냅니다. 실제로 바꾸는 건 새 버전이 생긴 뒤입니다.
    const basis = mode === 'regenerate' && target ? { ...chat, messages: chat.messages.slice(0, -1) } : chat;

    let system;
    let sceneCtx = null;
    let params = s.params;
    let webSearch = false;
    let thinking = false;
    if (assistant) {
      params = s.assistant.params;
      // 웹 검색은 '켜 두면 되는 엔진에서만 쓴다' 는 선호입니다. 화면도 못 하는 엔진에서는 꺼진 것으로 보여 주므로,
      // 검색을 켜 둔 채 Ollama 처럼 못 하는 엔진으로 바꿨다면 막지 않고 검색 없이 답합니다.
      webSearch = Boolean(s.assistant.webSearch) && supportsWebSearch(provider, config);
      thinking = Boolean(s.assistant.thinking) && mode !== 'continue';
      system = withThinking(s.assistant.systemPrompt, thinking);
    } else {
      const ctx = this.context.roleplay(chat, { basis });
      if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.');
      if (ctx.preset.adult && !this.engines.adultAllowed(config)) return fail(res, 400, this.engines.adultBlocked(ctx.preset, config));
      system = this.context.replySystem(ctx);
      sceneCtx = ctx.scene ? this.context.sceneNames(chat) : null;
    }

    // 토큰 한도 안에 들어가는 만큼만 최근 메시지부터 보냅니다.
    const plan = this.context.plan(chat, { provider, basis, extra: mode === 'continue' ? CONTINUE_PROMPT : '' });
    let history = plan.history;
    // 지난 답변에서는 표식을 떼어 저장했으니, 보낼 때 다시 붙여 줍니다. 안 그러면 모델이 표식 형식을 잊습니다.
    if (sceneCtx) history = this.withSceneTags(history, plan.keptIds, chat);
    if (mode === 'continue') history.push({ role: 'user', content: CONTINUE_PROMPT });
    if (plan.note) history = withAuthorNote(history, plan.note);
    const rawPrompt = rawPromptTokens(system, history);
    // 첫 대사도 없는 캐릭터에서 인사말을 다시 뽑는 경우처럼, 보낼 턴이 하나도 없을 수 있습니다.
    if (!history.length) history.push({ role: 'user', content: '(장면을 시작한다)' });

    // 붙인 그림은 보내기 직전에 파일에서 읽어 넣습니다. 토큰 어림은 위에서 이미 끝났습니다.
    history = await this.attachments.inline(chat.id, history);

    const out = new EventStream(res);
    // 화면의 컨텍스트 게이지를 먼저 채웁니다.
    out.send({ context: plan.usage });

    // 엔진이 실제 프롬프트 토큰 수를 알려 주면 어림 보정값을 갱신하고 게이지에도 알려 줍니다.
    const meter = this.usage.meter({ provider, config, promptEstimate: rawPrompt });
    const onUsage = (used) => {
      meter.onUsage(used);
      const { promptTokens } = used;
      if (!promptTokens) return;
      const ratio = nextRatio(s.tokenRatio?.[provider], promptTokens, rawPrompt);
      s.tokenRatio = { ...(s.tokenRatio || {}), [provider]: ratio };
      this.store.saveSettings();
      out.send({ context: { ...plan.usage, actual: promptTokens } });
    };

    // '중지' 는 연결을 끊지 않고 이 컨트롤러만 멈춥니다. 그래야 쓰다 만 답변을 저장한 뒤 화면에도 돌려줄 수 있습니다.
    const controller = abortOnClose(res);
    const run = { controller };
    this.jobs.running.set(chat.id, run);

    let text = '';
    let thought = '';
    let loopStopped = false;
    const sources = [];
    const onThought = (t) => {
      // 생각을 껐는데도 사고 조각을 보내는 엔진이 있습니다. 여기서 한 번 더 막습니다.
      if (!thinking || !t) return;
      thought += t;
      out.send({ thought: t });
    };
    // 로컬 모델의 사고 블록은 사고를 껐을 때도 나오므로, 켰을 때만 화면으로 넘깁니다.
    const stripper = makeThoughtStripper({ onThought: thinking ? onThought : undefined });
    try {
      const stream = streamChat({
        provider, config, system, messages: history, params, webSearch, sources, thinking, onThought, onUsage,
        signal: controller.signal
      });
      for await (const chunk of stream) {
        const clean = stripper.feed(chunk);
        if (!clean) continue;
        text += clean;
        out.send({ delta: clean });
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
        out.send({ delta: tail });
      }
      // 출처는 본문에 섞지 않습니다. 구글 근거 링크는 길고 읽을 수도 없어 접어서 보여 줍니다.
      if (sources.length) out.send({ sources });
    } catch (e) {
      if (!controller.signal.aborted) out.send({ error: this.engines.describeFailure(e, provider, config) });
    }

    if (loopStopped) {
      text += LOOP_NOTICE;
      out.send({ delta: LOOP_NOTICE });
    }

    controller.finish();
    meter.record(text);
    if (this.jobs.running.get(chat.id) === run) this.jobs.running.delete(chat.id);
    if (!text.trim()) {
      out.send({ done: true, message: null });
      return out.end();
    }

    out.send({ done: true, message: this.saveReply(chat, { mode, target, text, thought, sources, provider, config, names: sceneCtx }) });
    out.end();
  }

  /** 보낼 기록의 assistant 턴 앞에 그 답변의 화면 표식을 되살려 붙입니다. history 와 keptIds 는 같은 순서입니다. */
  withSceneTags(history, keptIds, chat) {
    const byId = new Map(chat.messages.map((m) => [m.id, m]));
    return history.map((turn, i) => {
      const msg = turn.role === 'assistant' ? byId.get(keptIds[i]) : null;
      const head = sceneTags(msg?.scene);
      const tail = checkTag(msg?.check);
      if (!head && !tail) return turn;
      return { ...turn, content: [head, turn.content, tail].filter(Boolean).join('\n') };
    });
  }

  /**
   * 다 쓴 답변을 대화에 넣습니다. 생성하는 동안 사용자가 그 메시지를 지웠다면 새 메시지로 붙입니다.
   * names 는 화면 표식이 켜진 대화의 고를 수 있는 이름들입니다. 있으면 본문에서 표식을 떼어 msg.scene·msg.check 로 둡니다.
   */
  saveReply(chat, { mode, target, text, thought, sources, provider, config, names = null }) {
    const alive = target && chat.messages.includes(target);
    let msg;
    let scene = null;
    let check = null;
    if (names) {
      const found = extractDirectives(text);
      text = found.text;
      scene = resolveScene(found, names);
      check = found.check || null;
      if (!text.trim()) return null;
    }
    if (mode === 'continue' && alive) {
      target.content = joinContinuation(target.content, text);
      if (scene) target.scene = { ...target.scene, ...scene };
      if (check) target.check = check;
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
      if (scene) variant.scene = scene;
      if (check) variant.check = check;
      if (mode === 'regenerate' && alive) {
        invalidateFacts(chat, target);
        msg = addSwipe(target, variant);
      } else {
        msg = { id: uid(), role: 'assistant', ...variant };
        chat.messages.push(msg);
      }
    }
    chat.updatedAt = Date.now();
    this.store.chats.save(chat.id);
    return msg;
  }

  /**
   * 롤플레이 대화의 뒤 작업(요약·기억)이 모델을 부르기 전 공통 검사.
   * 통과하면 { ctx, provider, config } 를, 막히면 응답을 보내고 null 을 돌려줍니다.
   * auto 면 엔진 문제로 막혀도 대화를 막지 않도록 reply({ skipped, reason }) 으로 넘어갑니다.
   */
  engineFor(req, res, chat, { auto, reply }) {
    const ctx = this.context.roleplay(chat);
    if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.') && null;
    const provider = req.body?.provider || this.store.settings.activeProvider;
    const config = this.engines.config(provider);
    const problem = this.engines.check(config, provider, ctx.preset);
    if (problem) return (auto ? reply({ skipped: true, reason: problem }) : fail(res, 400, problem)) && null;
    return { ctx, provider, config };
  }

  /**
   * 기억 요약. '기억할 메시지 수' 밖으로 밀려난 대화를 요약해 chat.memory 에 둡니다.
   * body: { auto? }  auto 면 밀려난 메시지가 SUMMARY_MIN 개 이상 쌓였을 때만, 한 묶음만 요약합니다.
   * 손으로 누르면 밀린 것을 여러 묶음까지 따라잡습니다.
   */
  async summarize(req, res) {
    const s = this.store.settings;
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화는 요약하지 않습니다.');
    const auto = Boolean(req.body?.auto);

    // 지금 컨텍스트에 들어가는 메시지 수. 그보다 앞은 모델이 못 보므로 요약 대상입니다.
    const keptNow = () => this.context.plan(chat).usage.kept;
    let pending = pendingForSummary(chat, keptNow());
    const reply = (extra = {}) => res.json({
      memory: chat.memory || '',
      summaryUntilAt: chat.summaryUntilAt || 0,
      pending: pendingForSummary(chat, keptNow()).length,
      ...extra
    });
    if (auto && (!s.memory?.autoSummarize || pending.length < SUMMARY_MIN)) return reply({ skipped: true });
    if (auto && this.jobs.running.has(chat.id)) return reply({ skipped: true, reason: '답변을 쓰는 중입니다.' });
    if (!pending.length) return reply({ summarized: 0 });

    const engine = this.engineFor(req, res, chat, { auto, reply });
    if (!engine) return;
    const { ctx, provider, config } = engine;
    const controller = this.jobs.backgroundFor(chat.id, res);
    // 요약은 사실 정리라 온도를 낮게, 길이는 요약 상한에 맞춰 둡니다.
    const params = { ...s.params, temperature: Math.min(s.params.temperature ?? 1, 0.4), maxTokens: 1200 };
    const names = this.context.names(ctx);
    let rounds = auto ? 1 : 4;
    let summarized = 0;
    try {
      while (pending.length && rounds-- > 0) {
        const chunk = takeChunk(pending);
        const out = cleanSummary(await this.engines.complete({
          provider, config, params, controller,
          system: withThinking(SUMMARY_SYSTEM, false),
          messages: [{ role: 'user', content: buildSummaryPrompt(chat.memory, chunk, names) }]
        }));
        if (!out) throw new Error('모델이 빈 요약을 보냈습니다.');

        chat.memory = out;
        chat.summaryUntilAt = chunk[chunk.length - 1].at || Date.now();
        this.store.chats.save(chat.id);
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
      return fail(res, 502, this.engines.describeFailure(e, provider, config), { summarized });
    } finally {
      this.jobs.release(chat.id, controller);
    }
    reply({ summarized });
  }

  /**
   * 대신 쓰기. 내 다음 차례를 AI 가 초안으로 씁니다. 저장하지 않고 조각만 흘려보냅니다.
   * body: { hint?, provider? }  hint 는 입력창에 미리 적어 둔 방향입니다.
   */
  async impersonate(req, res) {
    const s = this.store.settings;
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화에서는 쓸 수 없습니다.');
    const engine = this.engineFor(req, res, chat, {});
    if (!engine) return;
    const { ctx, provider, config } = engine;

    // 로컬 엔진이 한 번에 하나만 처리하므로, 뒤에서 돌던 기억 정리는 미룹니다.
    this.jobs.pauseBackground(chat.id);

    const userName = ctx.persona?.name || '사용자';
    // 감독 페르소나는 이야기 밖의 연출자라, 대신 쓰기도 감독의 대사가 아니라 다음 장면의 행동 지시로 씁니다.
    const director = Boolean(ctx.persona?.director);
    const instruction = fillVars(impersonatePrompt({
      hint: req.body?.hint,
      messenger: ['messenger', 'adult-messenger'].includes(ctx.preset.id),
      director
    }), { char: ctx.character.name, user: userName, particleFix: s.dev.particleFix });
    const plan = this.context.plan(chat, { provider, extra: instruction });

    const past = await this.attachments.inline(chat.id, plan.history);
    const out = new EventStream(res);
    const controller = abortOnClose(res);
    const stripper = makeThoughtStripper({});
    const asked = [...past, { role: 'user', content: instruction }];
    const meter = this.usage.meter({ provider, config, system: ctx.system, messages: asked });
    let text = '';
    try {
      const stream = streamChat({
        provider, config, system: ctx.system,
        messages: asked, onUsage: meter.onUsage,
        // 초안은 짧으면 충분합니다.
        params: { ...s.params, maxTokens: Math.min(Number(s.params.maxTokens) || 400, 400) },
        signal: controller.signal
      });
      for await (const chunk of stream) {
        const clean = stripper.feed(chunk);
        if (!clean) continue;
        text += clean;
        out.send({ delta: clean });
        if (looksRepetitive(text)) { controller.abort(); break; }
      }
      text += stripper.flush();
    } catch (e) {
      if (!controller.signal.aborted) out.send({ error: this.engines.describeFailure(e, provider, config) });
    }
    controller.finish();
    meter.record(text);
    out.send({ done: true, draft: cleanImpersonation(text, userName, { director }) });
    out.end();
  }

  /**
   * 선택지 제안. 내 다음 차례로 할 만한 말·행동 후보를 받습니다. 대화에는 아무것도 저장하지 않습니다.
   * body: { count? }  → { choices: [{ text, check? }] }
   */
  async choices(req, res) {
    const s = this.store.settings;
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화에서는 쓸 수 없습니다.');
    const engine = this.engineFor(req, res, chat, {});
    if (!engine) return;
    const { ctx, provider, config } = engine;
    this.jobs.pauseBackground(chat.id);

    const n = Math.round(Number(req.body?.count)) || CHOICE_COUNT.def;
    const count = Math.min(CHOICE_COUNT.max, Math.max(CHOICE_COUNT.min, n));
    const instruction = fillVars(choicesPrompt({
      messenger: ['messenger', 'adult-messenger'].includes(ctx.preset.id),
      director: Boolean(ctx.persona?.director),
      dice: Boolean(chat.dice),
      count
    }), { char: ctx.character.name, user: ctx.persona?.name || '사용자', particleFix: s.dev.particleFix });
    const plan = this.context.plan(chat, { provider, extra: instruction });
    const past = await this.attachments.inline(chat.id, plan.history);
    const controller = abortOnClose(res);
    let text;
    try {
      text = await this.engines.complete({
        provider, config, controller, system: withThinking(ctx.system, false),
        messages: [...past, { role: 'user', content: instruction }],
        params: { ...s.params, maxTokens: 600 }
      });
    } catch (e) {
      controller.finish();
      if (controller.signal.aborted) return;
      return fail(res, 502, this.engines.describeFailure(e, provider, config));
    }
    controller.finish();
    res.json({ choices: parseChoices(text, count) });
  }

  /**
   * 자동 기억. 최근 대화에서 오래 남겨야 할 사실을 뽑아 chat.facts 에 반영합니다.
   * body: { auto }  auto 면 마지막 확인 뒤 답변이 FACT_EVERY 개 이상 쌓였을 때만 돕니다.
   */
  async extractFacts(req, res) {
    const s = this.store.settings;
    const chat = this.access.findChat(req.user, req.params.id);
    if (!chat) return fail(res, 404, '없는 대화입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화는 기억을 쓰지 않습니다.');
    const auto = Boolean(req.body?.auto);
    const reply = (extra = {}) => res.json({
      facts: chat.facts || [],
      factsUntilAt: chat.factsUntilAt || 0,
      added: [], updated: [], removed: [],
      ...extra
    });

    if (auto && (!s.memory?.autoFacts || turnsSinceFacts(chat) < FACT_EVERY)) return reply({ skipped: true });
    if (auto && this.jobs.running.has(chat.id)) return reply({ skipped: true, reason: '답변을 쓰는 중입니다.' });
    const window = factsWindow(chat);
    if (!window.length) return reply({ skipped: true });

    const engine = this.engineFor(req, res, chat, { auto, reply });
    if (!engine) return;
    const { ctx, provider, config } = engine;
    const controller = this.jobs.backgroundFor(chat.id, res);
    let text;
    try {
      text = await this.engines.complete({
        provider, config, controller,
        system: withThinking(FACTS_SYSTEM, false),
        messages: [{ role: 'user', content: buildFactsPrompt(chat.facts, window, this.context.names(ctx)) }],
        params: { ...s.params, temperature: 0.2, maxTokens: 700 }
      });
    } catch (e) {
      if (controller.signal.aborted) {
        if (!res.writableEnded && !res.destroyed) reply({ skipped: true, reason: '새 답변을 먼저 쓰느라 멈췄습니다.' });
        return;
      }
      if (auto) return reply({ skipped: true, reason: e.message });
      return fail(res, 502, this.engines.describeFailure(e, provider, config));
    } finally {
      this.jobs.release(chat.id, controller);
    }

    // 읽는 동안 사용자가 메시지를 지웠을 수 있으니, 지금 남아 있는 것만 근거로 씁니다.
    const alive = window.filter((m) => chat.messages.includes(m));
    const result = applyFactOps(chat, parseFactOps(text), alive);
    chat.factsUntilAt = window[window.length - 1].at || Date.now();
    this.store.chats.save(chat.id);
    reply(result);
  }
}
