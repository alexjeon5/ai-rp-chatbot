/** 설정 창의 이미지 탭 (장면 그리기 — ComfyUI 또는 Google Gemini). */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { makeCombo } from '../select.js';
import { $, esc, on } from '../core/dom.js';

/** 목록으로 select 를 채웁니다. 지금 값이 목록에 없어도 사라지지 않게 맨 앞에 둡니다. */
function fillChoice(id, list, current) {
  const items = current && !list.includes(current) ? [current, ...list] : list;
  $(id).innerHTML = items
    .map((v) => `<option value="${esc(v)}">${esc(v)}${list.includes(v) ? '' : ' (목록에 없음)'}</option>`)
    .join('');
  $(id).value = current || items[0] || '';
}

/** 회사 API 로 그리는 곳과, 설정 창에서 그 칸들의 id 앞머리 (i-gmodel, i-ostatus …). */
const API_IDS = { gemini: 'g', openai: 'o' };

export class ImageSettings {
  constructor(app) {
    this.state = app.state;
    // 연결 확인으로 받아 온 ComfyUI 의 실제 샘플러·스케줄러 목록. 없으면 서버가 준 흔한 목록을 씁니다.
    this.comfyLists = null;
    // undefined: 건드리지 않음, null: 기본으로 되돌림, object: 새로 올린 것
    this.draftWorkflow = undefined;
    // 체크포인트 입력칸. 연결 확인으로 받은 목록에서 고르거나 이름을 직접 적습니다.
    this.checkpoints = [];

    // 불러오기로 받은 회사별 이미지 모델 목록.
    this.apiModels = { gemini: [], openai: [] };

    on('i-enabled', 'change', () => this.paintOptions());
    on('i-backend', 'change', () => this.paintBackend());
    on('i-pstyle', 'change', () => this.paintPromptStyle());
    for (const [backend, p] of Object.entries(API_IDS)) {
      makeCombo($(`i-${p}model`), {
        items: () => this.apiModels[backend],
        emptyText: '불러오기를 누르면 이 키로 쓸 수 있는 이미지 모델이 나옵니다. 이름을 직접 적어도 됩니다.',
        noMatchText: (q) => `'${q}' 와 일치하는 모델이 없습니다. 적은 이름을 그대로 써도 됩니다.`
      });
      on(`i-${p}models`, 'click', () => this.loadApiModels(backend));
    }
    this.combo = makeCombo($('i-checkpoint'), {
      items: () => this.checkpoints,
      emptyText: '연결 확인을 누르면 ComfyUI 의 체크포인트 목록이 나옵니다. 이름을 직접 적어도 됩니다.',
      noMatchText: (q) => `'${q}' 와 일치하는 체크포인트가 없습니다. 적은 이름을 그대로 써도 됩니다.`
    });
    on('i-check', 'click', () => this.check());
    on('i-workflow-upload', 'click', () => {
      $('i-workflow-file').value = '';
      $('i-workflow-file').click();
    });
    on('i-workflow-file', 'change', (e) => this.upload(e.target.files?.[0]));
    on('i-workflow-reset', 'click', () => {
      this.draftWorkflow = null;
      this.paintWorkflowStatus();
    });
  }

  paintSamplerChoices(sampler, scheduler) {
    const lists = this.comfyLists || this.state.settings.imageLists || { samplers: [], schedulers: [] };
    fillChoice('i-sampler', lists.samplers || [], sampler);
    fillChoice('i-scheduler', lists.schedulers || [], scheduler);
    $('i-lists-note').textContent = this.comfyLists
      ? `ComfyUI 에서 받은 목록입니다 — 샘플러 ${lists.samplers.length}개, 스케줄러 ${lists.schedulers.length}개.`
      : '샘플러·스케줄러는 흔히 쓰는 목록입니다. 연결 확인을 누르면 ComfyUI 가 실제로 지원하는 목록으로 바뀝니다.';
  }

  paintWorkflowStatus() {
    const wf = this.draftWorkflow === undefined ? this.state.settings.image?.workflow : this.draftWorkflow;
    $('i-workflow-status').textContent = wf
      ? `올린 워크플로 사용 중 — 노드 ${Object.keys(wf).length}개${this.draftWorkflow ? ' (저장 전)' : ''}`
      : '기본 SDXL 워크플로 사용 중 — 체크포인트만 고르면 됩니다';
  }

  /** 장면 그리기를 켰을 때만 ComfyUI 설정을 보여 줍니다. 숨겨도 입력값은 남아 저장 때 함께 갑니다. */
  paintOptions() {
    $('i-options').hidden = !$('i-enabled').checked;
  }

  /** 고른 곳의 설정만 보여 줍니다. 숨긴 쪽 입력값도 저장 때 함께 갑니다. */
  paintBackend() {
    const backend = $('i-backend').value;
    $('i-comfy').hidden = backend !== 'comfyui';
    for (const b of Object.keys(API_IDS)) $(`i-${b}`).hidden = backend !== b;
    this.paintPromptStyle();
  }

  /**
   * ComfyUI 의 프롬프트 방식에 맞춰 '앞에 붙일' 칸의 이름과 안내를 바꿉니다.
   * 붙일·지울 태그를 다루는 성인 대화 필터는 ComfyUI 태그 방식에만 보입니다.
   */
  paintPromptStyle() {
    const prose = $('i-pstyle').value === 'prose';
    $('i-adult-filter').hidden = $('i-backend').value !== 'comfyui' || prose;
    $('i-prefix-label').innerHTML = prose
      ? '앞에 붙일 글 <small class="field-hint">— 그림 스타일. 장면 묘사 앞에 붙습니다</small>'
      : '앞에 붙일 태그 <small class="field-hint">— 품질 태그. Pony 계열이면 score_9, score_8_up, …</small>';
    $('i-pstyle-note').textContent = prose
      ? 'AI 가 장면을 영어 문장으로 묘사해 보냅니다. Z-Image·Flux 는 모델·텍스트 인코더·VAE 파일이 나뉘어 있어 기본 워크플로로는 그릴 수 없습니다. ' +
        'ComfyUI 에서 그 모델의 워크플로를 Save (API Format) 으로 내보내, 프롬프트 칸에 {{prompt}} 를 적어 올려 주세요.'
      : 'AI 가 장면을 Danbooru 태그로 옮기고, 캐릭터의 외형 태그와 앞에 붙일 태그를 합쳐 보냅니다.';
  }

  async loadApiModels(backend) {
    const p = API_IDS[backend];
    $(`i-${p}status`).textContent = '모델 목록을 받는 중…';
    try {
      const { models } = await api.imageApiModels(backend);
      this.apiModels[backend] = models;
      if (!$(`i-${p}model`).value && models.length) $(`i-${p}model`).value = models[0];
      $(`i-${p}status`).textContent = models.length
        ? `이미지 모델 ${models.length}개를 받았습니다. 입력칸을 누르면 목록이 나옵니다.`
        : '이 키로 쓸 수 있는 이미지 모델이 없습니다.';
    } catch (e) {
      $(`i-${p}status`).textContent = `받지 못했습니다 — ${e.message}`;
    }
  }

  fill() {
    const { settings } = this.state;
    const img = settings.image || {};
    const gem = img.gemini || {};
    const oai = img.openai || {};
    this.draftWorkflow = undefined;
    $('i-enabled').checked = Boolean(img.enabled);
    this.paintOptions();
    $('i-backend').value = ['gemini', 'openai'].includes(img.backend) ? img.backend : 'comfyui';
    $('i-pstyle').value = img.promptStyle === 'prose' ? 'prose' : 'tags';
    this.paintBackend();
    $('i-gmodel').value = gem.model || '';
    $('i-gsize').value = gem.imageSize || '';
    $('i-gratio').value = gem.aspectRatio || '2:3';
    $('i-gstyle').value = gem.style || '';
    $('i-omodel').value = oai.model || '';
    $('i-osize').value = oai.size || '1024x1536';
    $('i-oquality').value = oai.quality || 'auto';
    $('i-ostyle').value = oai.style || '';
    $('i-baseurl').value = img.baseUrl || '';
    $('i-checkpoint').value = img.checkpoint || '';
    const size = `${img.width}x${img.height}`;
    const sel = $('i-size');
    if (![...sel.options].some((o) => o.value === size)) sel.add(new Option(`지금 값 ${img.width}×${img.height}`, size));
    sel.value = size;
    $('i-steps').value = img.steps;
    $('i-cfg').value = img.cfg;
    this.paintSamplerChoices(img.sampler || 'euler_ancestral', img.scheduler || 'normal');
    $('i-prefix').value = img.prefix || '';
    $('i-negative').value = img.negative || '';
    $('i-free').checked = img.freeAfter !== false;
    $('i-review').checked = img.reviewTags !== false;
    $('i-force').value = img.adult?.forceTags || '';
    $('i-block').value = img.adult?.blockTags || '';
    $('i-extra-neg').value = img.adult?.extraNegative || '';
    $('i-core-terms').textContent = `차단: ${(settings.imageCore?.blockTerms || []).join(', ')} · 17세 이하 나이 표기`;
    $('i-core-neg').textContent = `늘 붙는 네거티브: ${settings.imageCore?.negative || ''}`;
    this.paintWorkflowStatus();
  }

  read() {
    const [width, height] = $('i-size').value.split('x').map(Number);
    const image = {
      enabled: $('i-enabled').checked,
      backend: $('i-backend').value,
      promptStyle: $('i-pstyle').value,
      openai: {
        model: $('i-omodel').value.trim(),
        size: $('i-osize').value,
        quality: $('i-oquality').value,
        style: $('i-ostyle').value.trim()
      },
      gemini: {
        model: $('i-gmodel').value.trim(),
        imageSize: $('i-gsize').value,
        aspectRatio: $('i-gratio').value,
        style: $('i-gstyle').value.trim()
      },
      baseUrl: $('i-baseurl').value.trim(),
      checkpoint: $('i-checkpoint').value.trim(),
      width,
      height,
      steps: Number($('i-steps').value),
      cfg: Number($('i-cfg').value),
      sampler: $('i-sampler').value || 'euler_ancestral',
      scheduler: $('i-scheduler').value || 'normal',
      prefix: $('i-prefix').value.trim(),
      negative: $('i-negative').value.trim(),
      freeAfter: $('i-free').checked,
      reviewTags: $('i-review').checked,
      adult: {
        forceTags: $('i-force').value.trim(),
        blockTags: $('i-block').value.trim(),
        extraNegative: $('i-extra-neg').value.trim()
      }
    };
    if (this.draftWorkflow !== undefined) image.workflow = this.draftWorkflow;
    return image;
  }

  async check() {
    const baseUrl = $('i-baseurl').value.trim();
    $('i-status').textContent = '연결하는 중…';
    try {
      const { checkpoints, samplers = [], schedulers = [] } = await api.imageCheckpoints(baseUrl);
      // 받은 목록이 있으면 드롭다운을 실제 목록으로 바꿉니다. 고르던 값은 그대로 둡니다.
      if (samplers.length || schedulers.length) {
        const fallback = this.state.settings.imageLists || {};
        this.comfyLists = {
          samplers: samplers.length ? samplers : fallback.samplers || [],
          schedulers: schedulers.length ? schedulers : fallback.schedulers || []
        };
        this.paintSamplerChoices($('i-sampler').value, $('i-scheduler').value);
      }
      this.checkpoints = checkpoints;
      if (!$('i-checkpoint').value && checkpoints.length) $('i-checkpoint').value = checkpoints[0];
      $('i-status').textContent = checkpoints.length
        ? `연결됐습니다 — 체크포인트 ${checkpoints.length}개. 입력칸을 누르면 목록이 나옵니다.`
        : '연결됐지만 체크포인트가 없습니다. ComfyUI 의 models/checkpoints 폴더를 확인해 주세요.';
    } catch (e) {
      $('i-status').textContent = `연결하지 못했습니다 — ${e.message}`;
    }
  }

  async upload(file) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const nodes = Object.values(json || {});
      if (!nodes.length || !nodes.every((n) => n?.class_type && n?.inputs)) {
        return ui.toast('API 형식 워크플로가 아닙니다. ComfyUI 에서 Save (API Format) 으로 내보내 주세요.');
      }
      if (!JSON.stringify(json).includes('{{prompt}}')) {
        ui.toast('워크플로에 {{prompt}} 자리가 없습니다. 긍정 프롬프트 칸에 {{prompt}} 를 적어 두어야 장면이 들어갑니다.');
      }
      this.draftWorkflow = json;
      this.paintWorkflowStatus();
    } catch {
      ui.toast('JSON 파일을 읽지 못했습니다.');
    }
  }
}
