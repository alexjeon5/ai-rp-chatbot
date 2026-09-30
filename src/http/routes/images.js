/** 장면 그리기 (ComfyUI · Google Gemini · OpenAI). */
import { readFile } from 'node:fs/promises';
import { withThinking } from '../../prompt.js';
import { sniffImage } from '../../services/attachments.js';
import { checkBaseUrl } from '../../security.js';
import { listModels } from '../../providers.js';
import {
  imageConfig, DEFAULT_WORKFLOW, fillWorkflow, composePrompt, splitTags, CORE_NEGATIVE,
  IMAGE_PROMPT_SYSTEM, IMAGE_RETRY_PROMPT, buildImageMessages, parseSceneOutput, previewOutput, seedOf,
  IMAGE_DESCRIBE_SYSTEM, IMAGE_DESCRIBE_RETRY_PROMPT, buildDescribeMessages, parseDescription,
  coreViolationsText, GEMINI_RATIOS, renderGemini, renderOpenAi, listOpenAiImageModels,
  listSamplers, listCheckpoints, renderImage, freeMemory
} from '../../image.js';
import { wrap, fail, abortOnClose, EventStream, sendImage } from '../helpers.js';

/** 한 메시지에 남겨 둘 그림 수. 넘으면 오래된 것부터 지웁니다. */
const IMAGES_PER_MESSAGE = 6;

/** 회사 API 로 그리는 곳. 키와 주소는 같은 이름의 엔진 설정(설정 → 엔진)에서 가져옵니다. */
const API_BACKENDS = { gemini: 'Google Gemini', openai: 'OpenAI' };

const blockedMessage = (terms) =>
  `미성년으로 읽힐 수 있는 표현이 있어 그리지 않았습니다: ${terms.join(', ')}\n` +
  '이 차단은 설정에서 끌 수 없습니다. 캐릭터 외형이나 장면을 확인해 주세요.';

export class ImageRoutes {
  constructor({ store, access, settings, auth, engines, context, jobs, images, limits, art }) {
    Object.assign(this, { store, access, settings, auth, engines, context, jobs, images, limits, art });
  }

  mount(app) {
    app.get('/api/image/checkpoints', this.auth.requireOwner, this.limits.models.middleware, wrap((req, res) => this.checkpoints(req, res)));
    app.get('/api/image/models/:backend', this.auth.requireOwner, this.limits.models.middleware, wrap((req, res) => this.apiModels(req, res)));
    app.get('/api/images/:chatId/:file', (req, res) => this.file(req, res));
    app.delete('/api/chats/:id/messages/:mid/images/:imgId', (req, res) => this.remove(req, res));
    app.post('/api/chats/:id/messages/:mid/image', this.limits.generate.middleware, wrap((req, res) => this.draw(req, res)));
  }

  /** ComfyUI 에 연결해 체크포인트 목록을 받아 봅니다. 설정 창의 '연결 확인'. query: baseUrl */
  async checkpoints(req, res) {
    const baseUrl = String(req.query.baseUrl || this.settings.shared.image?.baseUrl || '').trim();
    const verdict = checkBaseUrl(baseUrl);
    if (!baseUrl || !verdict.ok) return fail(res, 400, verdict.reason || 'ComfyUI 주소를 입력해 주세요.');
    // 샘플러 목록은 덤입니다. 못 받아도 체크포인트 확인은 성공으로 칩니다.
    const [checkpoints, lists] = await Promise.all([
      listCheckpoints(baseUrl),
      listSamplers(baseUrl).catch(() => ({ samplers: [], schedulers: [] }))
    ]);
    res.json({ checkpoints, ...lists });
  }

  /** 설정 → 엔진의 키로 그 회사의 이미지 모델 목록을 받습니다. */
  async apiModels(req, res) {
    const backend = req.params.backend;
    if (!API_BACKENDS[backend]) return fail(res, 404, '모르는 그리는 곳입니다.');
    const config = this.engines.config(backend);
    const problem = this.apiProblem(backend, config);
    if (problem) return fail(res, 400, problem);
    const models = backend === 'openai'
      ? await listOpenAiImageModels(config)
      : (await listModels('gemini', config)).filter((m) => /image/i.test(m));
    res.json({ models });
  }

  /** 회사 API 로 그릴 수 있는지. 채팅 모델은 안 봅니다 — 그림 모델은 이미지 설정에 따로 있습니다. */
  apiProblem(backend, config) {
    const label = API_BACKENDS[backend];
    if (!config) return `설정에 ${label} 엔진이 없습니다.`;
    const verdict = checkBaseUrl(config.baseUrl);
    if (!verdict.ok) return verdict.reason;
    if (!config.apiKey) return `${label} API 키가 비어 있습니다. 설정 → 엔진에서 ${label} 엔진을 고르고 키를 넣어 주세요.`;
    return null;
  }

  /** 그린 그림 파일. 대화 id 와 파일 이름을 엄격히 검사해 data/images 밖으로 못 나가게 하고, 대화를 볼 수 있어야 보냅니다. */
  file(req, res) {
    const { chatId, file } = req.params;
    sendImage(res, this.images.isSafe(chatId, file) && this.access.findChat(req.user, chatId) && this.images.path(chatId, file));
  }

  remove(req, res) {
    const { chat, msg } = this.access.findMessage(req.user, req.params.id, req.params.mid) || {};
    const img = msg?.images?.find((x) => x.id === req.params.imgId);
    if (!img) return fail(res, 404, '없는 그림입니다.');
    msg.images = msg.images.filter((x) => x !== img);
    this.images.remove(chat.id, img.file);
    this.store.chats.save(chat.id);
    res.json({ ok: true });
  }

  /**
   * 메시지 하나의 장면을 그립니다. 진행 단계를 SSE 로 알려 줍니다.
   * body: { prompt?, negative?, checkpoint?, random?, review? }
   *   prompt     사람이 고친 태그(문장 묘사 방식·회사 API 는 묘사). 주면 LLM 을 건너뛰고 이걸로 그립니다 (필터는 그대로 적용)
   *   negative   사람이 고친 부정 태그. 설정의 네거티브·고정 네거티브는 여기에 늘 더해집니다 (ComfyUI 만)
   *   checkpoint 이번 한 장만 쓸 체크포인트 ('태그 고쳐 그리기'). 설정의 체크포인트는 바꾸지 않습니다 (ComfyUI 만)
   *   random     시드를 무작위로. 기본은 캐릭터마다 고정 시드 (ComfyUI 만 — 회사 API 는 시드를 받지 않습니다)
   *   review     태그(묘사)까지만 만들어 { done, review: { prompt, negative, removed } } 로 돌려주고 그리지 않습니다.
   *              사람이 확인·수정한 것을 prompt 로 다시 보내면 그때 그립니다.
   */
  async draw(req, res) {
    const body = req.body;
    // 그리는 곳(ComfyUI·회사 API)은 공용 설정입니다.
    const cfg = imageConfig(this.settings.shared.image);
    const backend = API_BACKENDS[cfg.backend] ? cfg.backend : 'comfyui';
    const viaApi = backend !== 'comfyui';
    const picked = typeof body?.checkpoint === 'string' ? body.checkpoint.trim() : '';
    if (picked && !viaApi) {
      if (picked.length > 300 || /[\u0000-\u001f]/.test(picked)) return fail(res, 400, '체크포인트 이름이 올바르지 않습니다.');
      cfg.checkpoint = picked;
    }
    const { chat, msg } = this.access.findMessage(req.user, req.params.id, req.params.mid) || {};
    if (!msg) return fail(res, 404, '없는 메시지입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화에서는 그리지 않습니다.');
    if (!cfg.enabled) return fail(res, 400, '설정 → 이미지 설정에서 장면 그리기를 먼저 켜 주세요.');
    const ctx = this.context.roleplay(chat);
    if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.');
    const adult = Boolean(ctx.preset.adult);

    let apiConfig = null;
    if (viaApi) {
      const label = API_BACKENDS[backend];
      apiConfig = this.engines.config(backend);
      const problem = this.apiProblem(backend, apiConfig);
      if (problem) return fail(res, 400, problem);
      if (!cfg[backend].model) return fail(res, 400, `설정 → 이미지에서 ${label} 이미지 모델을 골라 주세요.`);
      // 성인 대화는 대화 답변과 같은 규칙: 클라우드 허용을 켜지 않았으면 외부 API 로 그리지 않습니다.
      if (adult && !this.engines.adultAllowed(apiConfig)) {
        return fail(res, 400, `'${ctx.preset.name}' 모드 대화는 ${label}(외부 API)로 그리지 않습니다.\n` +
          '설정 → 이미지에서 ComfyUI 로 바꾸거나, 개발자 탭에서 클라우드 엔진 제한을 풀어 주세요.');
      }
    } else {
      const verdict = checkBaseUrl(cfg.baseUrl);
      if (!verdict.ok) return fail(res, 400, verdict.reason);
      if (!cfg.workflow && !cfg.checkpoint) return fail(res, 400, '이미지 설정에서 체크포인트를 고르거나 워크플로를 올려 주세요.');
    }
    const typed = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : '';

    // 장면을 태그로 바꾸는 LLM 도 같은 규칙: 성인 대화는 기본적으로 로컬 엔진으로만. 엔진은 대화 주인이 고른 것입니다.
    const provider = this.context.settingsOf(chat).activeProvider;
    const config = this.engines.config(provider);
    if (!typed) {
      const problem = this.engines.check(config, provider, ctx.preset);
      if (problem) return fail(res, 400, problem);
    }

    const out = new EventStream(res);
    const stage = (step, text) => out.send({ stage: step, text });
    const controller = abortOnClose(res);
    // 로컬 GPU 하나를 나눠 쓰므로, 뒤에서 돌던 기억 정리는 미룹니다.
    this.jobs.pauseBackground(chat.id);
    const finish = (payload) => {
      controller.finish();
      out.send(payload);
      out.end();
    };

    try {
      if (viaApi) return await this.drawApi({ backend, body, cfg, chat, msg, ctx, typed, provider, config, apiConfig, controller, out, stage, finish });

      // 1) 장면 → 태그 또는 묘사, 2) 조립·필터
      const scene = { body, cfg, chat, msg, ctx, typed, adult, provider, config, controller, stage };
      const composed = cfg.promptStyle === 'prose' ? await this.composeProse(scene) : await this.composeTags(scene);
      if (composed.failed) return finish({ error: composed.failed });
      if (composed.blocked) return finish({ error: blockedMessage(composed.blocked) });
      // 검토 창과 그림 기록에는 사람이 고칠 부분만 둡니다. 문장 묘사는 앞에 붙는 스타일을 빼고 보여 줍니다.
      const shown = composed.shown ?? composed.prompt;
      out.send({ prompt: shown, removed: composed.removed });
      if (body?.review) {
        return finish({ done: true, review: { prompt: shown, negative: composed.negative, removed: composed.removed } });
      }

      // 3) ComfyUI
      const seed = body?.random ? Math.floor(Math.random() * 4294967295) : seedOf(ctx.character.id || ctx.character.name);
      const workflow = fillWorkflow(cfg.workflow || DEFAULT_WORKFLOW, {
        prompt: composed.prompt, negative: composed.negative, seed,
        width: cfg.width, height: cfg.height, steps: cfg.steps, cfg: cfg.cfg,
        sampler: cfg.sampler, scheduler: cfg.scheduler, checkpoint: cfg.checkpoint
      });
      stage('draw', 'ComfyUI 에 보내는 중');
      const { buffer, ext } = await renderImage(cfg.baseUrl, workflow, { signal: controller.signal, onStage: stage });

      // 4) 저장. 생성하는 동안 메시지가 지워졌으면 파일도 남기지 않습니다.
      if (!chat.messages.includes(msg)) return finish({ error: '그리는 동안 메시지가 삭제되었습니다.' });
      const image = await this.keep(chat, msg, buffer, ext, {
        prompt: shown, negative: composed.negative, checkpoint: cfg.checkpoint, seed,
        ...(cfg.promptStyle === 'prose' ? { style: 'prose' } : {})
      });
      finish({ done: true, image, images: msg.images });
      // 같은 GPU 의 LLM 이 다시 VRAM 을 쓸 수 있게 풉니다. 응답을 보낸 뒤라 기다리지 않습니다.
      if (cfg.freeAfter) freeMemory(cfg.baseUrl);
    } catch (e) {
      if (controller.signal.aborted) { controller.finish(); return; }
      finish({ error: e.message });
    }
  }

  /** 그린 그림을 메시지에 붙여 저장합니다. 한 메시지에 IMAGES_PER_MESSAGE 장까지만 남깁니다. */
  async keep(chat, msg, buffer, ext, fields) {
    const { id, file } = await this.images.save(chat.id, buffer, ext);
    const image = { id, file, ...fields, at: Date.now() };
    msg.images = [...(msg.images || []), image];
    while (msg.images.length > IMAGES_PER_MESSAGE) this.images.remove(chat.id, msg.images.shift().file);
    this.store.chats.save(chat.id);
    return image;
  }

  /** ComfyUI · 태그: 장면을 Danbooru 태그로 옮기고 품질·외형 태그와 필터를 적용합니다. */
  async composeTags({ body, cfg, chat, msg, ctx, typed, adult, provider, config, controller, stage }) {
    let sceneTags;
    let sceneNegative = typeof body?.negative === 'string' ? splitTags(body.negative) : [];
    if (typed) {
      sceneTags = splitTags(typed);
    } else {
      const tags = await this.sceneTags({ chat, msg, ctx, provider, config, controller, stage });
      if (tags.failed) return tags;
      ({ tags: sceneTags, negative: sceneNegative } = tags);
    }
    // 등장인물이 한 명이면 외형 태그를 앞에 확실히 박아 둡니다.
    const appearance = ctx.cast.length ? [] : splitTags(ctx.character.appearance || '');
    return composePrompt({ cfg, sceneTags, sceneNegative, appearance, adult });
  }

  /**
   * ComfyUI · 문장 묘사: Z-Image·Flux 처럼 LLM 텍스트 인코더를 쓰는 모델용. '앞에 붙일 글' 뒤에 묘사를 붙입니다.
   * 태그를 다루는 성인 대화 필터(붙일·지울 태그)는 쓰지 않고, 고정 차단과 네거티브는 그대로 적용합니다.
   */
  async composeProse({ body, cfg, chat, msg, ctx, typed, adult, provider, config, controller, stage }) {
    let description = typed;
    if (!description) {
      const got = await this.sceneDescription({ chat, msg, ctx, provider, config, controller, stage });
      if (got.failed) return got;
      description = got.description;
    }
    const prefix = (cfg.prefix || '').trim();
    const bad = coreViolationsText(`${prefix}\n${description}`);
    if (bad.length) return { blocked: bad };
    const negative = splitTags([cfg.negative, CORE_NEGATIVE, adult ? cfg.adult?.extraNegative : '', body?.negative]
      .filter((x) => typeof x === 'string' && x).join(', ')).join(', ');
    return { prompt: [prefix, description].filter(Boolean).join('\n\n'), shown: description, negative, removed: [] };
  }

  /** 회사 API(Gemini · OpenAI): 장면 → 영어 묘사 → 고정 차단 검사 → 그리기. 부정 프롬프트·시드·체크포인트는 없습니다. */
  async drawApi({ backend, body, cfg, chat, msg, ctx, typed, provider, config, apiConfig, controller, out, stage, finish }) {
    const opts = cfg[backend];
    let description = typed;
    if (!description) {
      const got = await this.sceneDescription({ chat, msg, ctx, provider, config, controller, stage });
      if (got.failed) return finish({ error: got.failed });
      description = got.description;
    }
    const style = (opts.style || '').trim();
    const bad = coreViolationsText(`${style}\n${description}`);
    if (bad.length) return finish({ error: blockedMessage(bad) });
    out.send({ prompt: description, removed: [] });
    if (body?.review) return finish({ done: true, review: { prompt: description, negative: '', removed: [] } });

    const prompt = [style, description].filter(Boolean).join('\n\n');
    const reference = cfg.useReference ? await this.referenceOf(ctx.character) : null;
    stage('draw', `${API_BACKENDS[backend]} 가 ${reference ? '프로필 그림을 참고해 ' : ''}그리는 중`);
    const { buffer, ext } = backend === 'openai'
      ? await renderOpenAi({ config: apiConfig, model: opts.model, prompt, size: opts.size, quality: opts.quality, reference, signal: controller.signal })
      : await renderGemini({
        config: apiConfig,
        model: opts.model,
        prompt,
        aspectRatio: GEMINI_RATIOS.includes(opts.aspectRatio) ? opts.aspectRatio : '2:3',
        imageSize: opts.imageSize,
        reference,
        signal: controller.signal
      });
    if (!chat.messages.includes(msg)) return finish({ error: '그리는 동안 메시지가 삭제되었습니다.' });
    const image = await this.keep(chat, msg, buffer, ext, { prompt: description, negative: '', checkpoint: opts.model, backend });
    finish({ done: true, image, images: msg.images });
  }

  /** 캐릭터의 프로필 그림. 없거나 읽지 못하면 null 이라 참조 없이 그립니다. */
  async referenceOf(character) {
    if (!character?.id || !character.portrait || !this.art.isSafe(character.id, character.portrait)) return null;
    try {
      const buffer = await readFile(this.art.path(character.id, character.portrait));
      const kind = sniffImage(buffer);
      return kind ? { buffer, mime: kind.mime, ext: kind.ext } : null;
    } catch {
      return null;
    }
  }

  /** 답변 한 장면을 대화 조각으로. 바로 앞 내 메시지와 그 답변만 씁니다. */
  sceneOf(chat, msg, ctx) {
    const i = chat.messages.indexOf(msg);
    const before = chat.messages.slice(Math.max(0, i - 1), i).filter((m) => m.role === 'user');
    const userName = ctx.persona?.name || '사용자';
    const scene = [...before, msg]
      .map((m) => `${m.role === 'user' ? userName : ctx.character.name}: ${m.content.trim().slice(-1800)}`)
      .join('\n\n');
    return { scene, userName };
  }

  /** 장면을 태그나 묘사로 옮기는 LLM 호출. 사고 블록을 먼저 쓰는 모델도 끝까지 쓸 수 있게 길이를 넉넉히 둡니다. */
  askScene({ chat, provider, config, controller, system }) {
    const { params } = this.context.settingsOf(chat);
    return (messages, temperature) => this.engines.complete({
      provider, config, controller, messages, userId: chat.ownerId,
      system: withThinking(system, false),
      params: { ...params, temperature, maxTokens: 700 }
    });
  }

  /** 답변 한 장면을 영어 묘사 문단으로 옮깁니다. 형식이 틀리면 한 번 더 요청합니다. */
  async sceneDescription({ chat, msg, ctx, provider, config, controller, stage }) {
    stage('prompt', '장면을 묘사로 옮기는 중');
    const { scene, userName } = this.sceneOf(chat, msg, ctx);
    const ask = this.askScene({ chat, provider, config, controller, system: IMAGE_DESCRIBE_SYSTEM });
    const messages = buildDescribeMessages({ cast: [ctx.character, ...ctx.cast], scene, userName });
    let raw = await ask(messages, 0.5);
    let description = parseDescription(raw);
    if (!description) {
      stage('prompt', '묘사 형식이 아니라 한 번 더 요청하는 중');
      raw = await ask([
        ...messages,
        { role: 'assistant', content: raw.trim() || '(no answer)' },
        { role: 'user', content: IMAGE_DESCRIBE_RETRY_PROMPT }
      ], 0.2);
      description = parseDescription(raw);
    }
    if (!description) {
      return { failed: `모델이 장면 묘사를 쓰지 못했습니다. 다시 눌러 보세요.\n모델 응답 앞부분: ${previewOutput(raw)}` };
    }
    return { description };
  }

  /** 답변 한 장면을 태그로 옮깁니다. 태그 대신 문장을 쓰면 그 답을 보여 주며 한 번 더 요청합니다. */
  async sceneTags({ chat, msg, ctx, provider, config, controller, stage }) {
    stage('prompt', '장면을 태그로 옮기는 중');
    const { scene, userName } = this.sceneOf(chat, msg, ctx);
    const ask = this.askScene({ chat, provider, config, controller, system: IMAGE_PROMPT_SYSTEM });
    const messages = buildImageMessages({ cast: [ctx.character, ...ctx.cast], scene, userName });
    let raw = await ask(messages, 0.4);
    let parsed = parseSceneOutput(raw);
    if (!parsed.tags.length) {
      stage('prompt', '태그 형식이 아니라 한 번 더 요청하는 중');
      console.log(`[그림] 태그를 읽지 못함, 다시 요청: ${previewOutput(raw)}`);
      raw = await ask([
        ...messages,
        { role: 'assistant', content: raw.trim() || '(no answer)' },
        { role: 'user', content: IMAGE_RETRY_PROMPT }
      ], 0.2);
      parsed = parseSceneOutput(raw);
    }
    if (!parsed.tags.length) {
      return {
        failed: '모델이 태그를 쓰지 못했습니다. 다시 누르거나, 그림이 하나라도 있으면 "태그 고쳐 그리기" 로 직접 적어 주세요.\n' +
          `모델 응답 앞부분: ${previewOutput(raw)}`
      };
    }
    return parsed;
  }
}
