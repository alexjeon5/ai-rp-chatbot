/** 장면 그리기 (ComfyUI). */
import { withThinking } from '../../prompt.js';
import { checkBaseUrl } from '../../security.js';
import {
  IMAGE_DEFAULTS, DEFAULT_WORKFLOW, fillWorkflow, composePrompt, splitTags,
  IMAGE_PROMPT_SYSTEM, IMAGE_RETRY_PROMPT, buildImageMessages, parseSceneOutput, previewOutput, seedOf,
  listSamplers, listCheckpoints, renderImage, freeMemory
} from '../../image.js';
import { wrap, fail, abortOnClose, EventStream } from '../helpers.js';

/** 한 메시지에 남겨 둘 그림 수. 넘으면 오래된 것부터 지웁니다. */
const IMAGES_PER_MESSAGE = 6;

export class ImageRoutes {
  constructor({ store, auth, engines, context, jobs, images, limits }) {
    Object.assign(this, { store, auth, engines, context, jobs, images, limits });
  }

  mount(app) {
    app.get('/api/image/checkpoints', this.auth.requireOwner, this.limits.models, wrap((req, res) => this.checkpoints(req, res)));
    app.get('/api/images/:chatId/:file', (req, res) => this.file(req, res));
    app.delete('/api/chats/:id/messages/:mid/images/:imgId', (req, res) => this.remove(req, res));
    app.post('/api/chats/:id/messages/:mid/image', this.limits.generate, wrap((req, res) => this.draw(req, res)));
  }

  /** ComfyUI 에 연결해 체크포인트 목록을 받아 봅니다. 설정 창의 '연결 확인'. query: baseUrl */
  async checkpoints(req, res) {
    const baseUrl = String(req.query.baseUrl || this.store.settings.image?.baseUrl || '').trim();
    const verdict = checkBaseUrl(baseUrl);
    if (!baseUrl || !verdict.ok) return fail(res, 400, verdict.reason || 'ComfyUI 주소를 입력해 주세요.');
    // 샘플러 목록은 덤입니다. 못 받아도 체크포인트 확인은 성공으로 칩니다.
    const [checkpoints, lists] = await Promise.all([
      listCheckpoints(baseUrl),
      listSamplers(baseUrl).catch(() => ({ samplers: [], schedulers: [] }))
    ]);
    res.json({ checkpoints, ...lists });
  }

  /** 그린 그림 파일. 대화 id 와 파일 이름을 엄격히 검사해 data/images 밖으로 못 나가게 합니다. */
  file(req, res) {
    const { chatId, file } = req.params;
    if (!this.images.isSafe(chatId, file)) return res.status(404).end();
    res.sendFile(this.images.path(chatId, file), { maxAge: '30d', immutable: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }

  remove(req, res) {
    const chat = this.store.chats.get(req.params.id);
    const msg = chat?.messages.find((m) => m.id === req.params.mid);
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
   *   prompt     사람이 고친 태그. 주면 LLM 을 건너뛰고 이걸로 그립니다 (필터는 그대로 적용)
   *   negative   사람이 고친 부정 태그. 설정의 네거티브·고정 네거티브는 여기에 늘 더해집니다
   *   checkpoint 이번 한 장만 쓸 체크포인트 ('태그 고쳐 그리기'). 설정의 체크포인트는 바꾸지 않습니다
   *   random     시드를 무작위로. 기본은 캐릭터마다 고정 시드
   *   review     태그까지만 만들어 { done, review: { prompt, negative, removed } } 로 돌려주고 그리지 않습니다.
   *              사람이 확인·수정한 태그를 prompt 로 다시 보내면 그때 그립니다.
   */
  async draw(req, res) {
    const s = this.store.settings;
    const body = req.body;
    const cfg = { ...IMAGE_DEFAULTS(), ...(s.image || {}) };
    const picked = typeof body?.checkpoint === 'string' ? body.checkpoint.trim() : '';
    if (picked) {
      if (picked.length > 300 || /[\u0000-\u001f]/.test(picked)) return fail(res, 400, '체크포인트 이름이 올바르지 않습니다.');
      cfg.checkpoint = picked;
    }
    const chat = this.store.chats.get(req.params.id);
    const msg = chat?.messages.find((m) => m.id === req.params.mid);
    if (!msg) return fail(res, 404, '없는 메시지입니다.');
    if (chat.kind === 'assistant') return fail(res, 400, '어시스턴트 대화에서는 그리지 않습니다.');
    if (!cfg.enabled) return fail(res, 400, '설정 → 이미지 설정에서 장면 그리기를 먼저 켜 주세요.');
    const verdict = checkBaseUrl(cfg.baseUrl);
    if (!verdict.ok) return fail(res, 400, verdict.reason);
    if (!cfg.workflow && !cfg.checkpoint) return fail(res, 400, '이미지 설정에서 체크포인트를 고르거나 워크플로를 올려 주세요.');
    const ctx = this.context.roleplay(chat);
    if (!ctx) return fail(res, 400, '이 대화의 캐릭터가 삭제되었습니다.');
    const adult = Boolean(ctx.preset.adult);
    const typed = typeof body?.prompt === 'string' ? body.prompt.trim() : '';

    // 장면을 태그로 바꾸는 LLM 도 같은 규칙: 성인 대화는 기본적으로 로컬 엔진으로만.
    const provider = s.activeProvider;
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
      // 1) 장면 → 태그
      let sceneTags;
      let sceneNegative = typeof body?.negative === 'string' ? splitTags(body.negative) : [];
      if (typed) {
        sceneTags = splitTags(typed);
      } else {
        const tags = await this.sceneTags({ chat, msg, ctx, provider, config, controller, stage });
        if (tags.failed) return finish({ error: tags.failed });
        ({ tags: sceneTags, negative: sceneNegative } = tags);
      }

      // 2) 조립·필터. 등장인물이 한 명이면 외형 태그를 앞에 확실히 박아 둡니다.
      const appearance = ctx.cast.length ? [] : splitTags(ctx.character.appearance || '');
      const composed = composePrompt({ cfg, sceneTags, sceneNegative, appearance, adult });
      if (composed.blocked) {
        return finish({
          error: `미성년으로 읽힐 수 있는 표현이 있어 그리지 않았습니다: ${composed.blocked.join(', ')}\n` +
            '이 차단은 설정에서 끌 수 없습니다. 캐릭터 외형 태그나 장면을 확인해 주세요.'
        });
      }
      out.send({ prompt: composed.prompt, removed: composed.removed });
      if (body?.review) {
        return finish({ done: true, review: { prompt: composed.prompt, negative: composed.negative, removed: composed.removed } });
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
      const { id, file } = await this.images.save(chat.id, buffer, ext);
      const image = { id, file, prompt: composed.prompt, negative: composed.negative, checkpoint: cfg.checkpoint, seed, at: Date.now() };
      msg.images = [...(msg.images || []), image];
      while (msg.images.length > IMAGES_PER_MESSAGE) this.images.remove(chat.id, msg.images.shift().file);
      this.store.chats.save(chat.id);

      finish({ done: true, image, images: msg.images });
      // 같은 GPU 의 LLM 이 다시 VRAM 을 쓸 수 있게 풉니다. 응답을 보낸 뒤라 기다리지 않습니다.
      if (cfg.freeAfter) freeMemory(cfg.baseUrl);
    } catch (e) {
      if (controller.signal.aborted) { controller.finish(); return; }
      finish({ error: e.message });
    }
  }

  /** 답변 한 장면을 태그로 옮깁니다. 태그 대신 문장을 쓰면 그 답을 보여 주며 한 번 더 요청합니다. */
  async sceneTags({ chat, msg, ctx, provider, config, controller, stage }) {
    stage('prompt', '장면을 태그로 옮기는 중');
    const i = chat.messages.indexOf(msg);
    const before = chat.messages.slice(Math.max(0, i - 1), i).filter((m) => m.role === 'user');
    const userName = ctx.persona?.name || '사용자';
    const scene = [...before, msg]
      .map((m) => `${m.role === 'user' ? userName : ctx.character.name}: ${m.content.trim().slice(-1800)}`)
      .join('\n\n');
    const ask = (messages, temperature) => this.engines.complete({
      provider, config, controller, messages,
      system: withThinking(IMAGE_PROMPT_SYSTEM, false),
      // 생각 블록을 먼저 쓰는 모델도 태그까지 쓸 수 있게 길이를 넉넉히 둡니다.
      params: { ...this.store.settings.params, temperature, maxTokens: 700 }
    });
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
