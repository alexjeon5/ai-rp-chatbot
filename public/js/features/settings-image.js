/** 설정 창의 이미지 탭 (ComfyUI 장면 그리기). */
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

export class ImageSettings {
  constructor(app) {
    this.state = app.state;
    // 연결 확인으로 받아 온 ComfyUI 의 실제 샘플러·스케줄러 목록. 없으면 서버가 준 흔한 목록을 씁니다.
    this.comfyLists = null;
    // undefined: 건드리지 않음, null: 기본으로 되돌림, object: 새로 올린 것
    this.draftWorkflow = undefined;
    // 체크포인트 입력칸. 연결 확인으로 받은 목록에서 고르거나 이름을 직접 적습니다.
    this.checkpoints = [];

    on('i-enabled', 'change', () => this.paintOptions());
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

  fill() {
    const { settings } = this.state;
    const img = settings.image || {};
    this.draftWorkflow = undefined;
    $('i-enabled').checked = Boolean(img.enabled);
    this.paintOptions();
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
