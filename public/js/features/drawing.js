/** 장면 그리기: 진행 표시, 태그 검토·고쳐 그리기 창, 그림 도구, 크게 보기. */
import { api, drawImage } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';

/** 회사 API 로 그리는 곳의 화면 이름. 이 곳들은 부정 프롬프트와 체크포인트가 없습니다. */
const API_NAMES = { gemini: 'Gemini', openai: 'OpenAI' };

/** 검토·고쳐 그리기 창의 문구. ComfyUI 태그 방식은 태그를, 그 밖에는 영어 장면 묘사를 고칩니다. */
function tagCopy(image = {}) {
  const api = API_NAMES[image.backend];
  if (api) {
    return {
      label: '장면 묘사 <small class="field-hint">— 한국어로 고쳐 써도 알아듣습니다</small>',
      reviewTitle: '그릴 장면 확인',
      editTitle: '묘사 고쳐 그리기',
      reviewHint: `AI 가 장면을 읽고 쓴 묘사입니다. 고친 뒤 그리기를 누르면 ${api} 로 그립니다.`,
      editHint: `이 그림에 쓴 묘사입니다. 고친 뒤 그리기를 누르면 ${api} 로 다시 그립니다.`,
      foot: '설정의 그림 스타일은 그릴 때 앞에 붙고, 고정 차단 목록도 다시 적용됩니다. Ctrl+Enter 로 바로 그립니다.'
    };
  }
  if (image.promptStyle === 'prose') {
    return {
      label: '장면 묘사 <small class="field-hint">— 영어 문장</small>',
      reviewTitle: '그릴 장면 확인',
      editTitle: '묘사 고쳐 그리기',
      reviewHint: 'AI 가 장면을 읽고 쓴 묘사입니다. 고친 뒤 그리기를 누르세요.',
      editHint: '이 그림에 쓴 묘사와 모델입니다. 고친 뒤 그리기를 누르면 새 시드로 다시 그립니다.',
      foot: '앞에 붙일 글, 설정의 네거티브, 고정 차단 목록·고정 네거티브는 그릴 때 다시 적용됩니다. Ctrl+Enter 로 바로 그립니다.'
    };
  }
  return {
    label: '태그 <small class="field-hint">— 그릴 것. 쉼표로 구분합니다</small>',
    reviewTitle: '그릴 태그 확인',
    editTitle: '태그 고쳐 그리기',
    reviewHint: 'AI 가 장면을 읽고 만든 태그입니다. 빼거나 더할 태그를 고친 뒤 그리기를 누르세요.',
    editHint: '이 그림에 쓴 태그와 모델입니다. 고친 뒤 그리기를 누르면 새 시드로 다시 그립니다.',
    foot: '앞에 붙일 품질 태그, 설정의 네거티브, 필터(고정 차단 목록·고정 네거티브 포함)는 그릴 때 다시 적용됩니다. Ctrl+Enter 로 바로 그립니다.'
  };
}

export class Drawing {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    // 지금 그리는 중인 메시지. 같은 메시지를 두 번 겹쳐 그리지 않게 합니다.
    this.drawingNow = new Set();
    this.tags = $('dlg-tags');
    // '태그 고쳐 그리기' 의 모델 목록. 한 번 받으면 기억해 두고, 창을 열 때마다 새로 받아 바꿉니다.
    this.checkpointList = null;
    // 창을 빨리 닫고 다시 열었을 때 앞서 받던 목록이 새 창을 덮지 않게 합니다.
    this.modelLoad = 0;
    this.lightbox = { links: [], at: 0 };

    for (const id of ['tg-text', 'tg-negative']) {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.tags.close('draw');
        }
      });
    }
    this.bindLightbox();
  }

  /** 메시지 도구 중 그림에 관한 것. */
  async onTool(btn, turn, msg) {
    const { state, app } = this;
    const act = btn.dataset.act;
    if (act === 'draw') return this.draw(state.chat, msg, turn, { review: state.settings.image?.reviewTags !== false });
    const imgId = btn.closest('[data-img]')?.dataset.img;
    const img = msg.images?.find((x) => x.id === imgId);
    if (!img) return;
    if (act === 'img-redraw') return this.draw(state.chat, msg, turn, { prompt: img.prompt, negative: img.negative, random: true });
    if (act === 'img-edit') {
      const chat = state.chat;
      const edited = await this.askTags({
        prompt: img.prompt || '',
        negative: img.negative || '',
        checkpoint: img.checkpoint || state.settings.image?.checkpoint || ''
      });
      if (!edited) return;
      this.draw(chat, msg, this.liveTurn(chat, msg, turn), { ...edited, random: true });
      return;
    }
    if (act === 'img-del') {
      if (!confirm('이 그림을 지울까요?')) return;
      try {
        await api.deleteImage(state.chat.id, msg.id, imgId);
        msg.images = msg.images.filter((x) => x !== img);
        turn.replaceWith(app.view.turnFor(state.chat, msg));
      } catch (err) {
        ui.toast(`지우지 못했습니다 — ${err.message}`);
      }
    }
  }

  /** 창이 떠 있는 동안 화면이 다시 그려졌을 수 있으니 지금 보이는 답변을 찾습니다. */
  liveTurn(chat, msg, fallback) {
    const live = document.querySelector(`#thread [data-mid="${msg.id}"]`);
    return this.state.chat === chat && live ? live : fallback;
  }

  /* ---------------- 태그 검토·고치기 창 ---------------- */

  /** 모델 select 를 채웁니다. 지금 값이 목록에 없어도 사라지지 않게 맨 앞에 둡니다. */
  paintModelChoice(current) {
    const list = this.checkpointList || [];
    const items = current && !list.includes(current) ? [current, ...list] : list;
    $('tg-checkpoint').innerHTML = items
      .map((v) => `<option value="${esc(v)}">${esc(v)}${this.checkpointList && !list.includes(v) ? ' (목록에 없음)' : ''}</option>`)
      .join('');
    $('tg-checkpoint').value = current || items[0] || '';
  }

  /** 모델 칸을 지금 값으로 보여 주고, ComfyUI 에서 체크포인트 목록을 받아 채웁니다. */
  async loadModelChoice(current) {
    const load = ++this.modelLoad;
    const select = $('tg-checkpoint');
    const note = $('tg-model-note');
    const base = '고른 모델은 이번 그림에만 씁니다. 설정의 체크포인트는 그대로입니다.';
    this.paintModelChoice(current);
    // 올린 워크플로에 {{checkpoint}} 칸이 없으면 모델을 바꿔 보내도 쓰이지 않습니다.
    const wf = this.state.settings.image?.workflow;
    select.disabled = Boolean(wf) && !JSON.stringify(wf).includes('{{checkpoint}}');
    if (select.disabled) {
      note.textContent = '올린 워크플로에 {{checkpoint}} 칸이 없어 모델을 바꿀 수 없습니다. 워크플로 안의 모델로 그립니다.';
      return;
    }
    note.textContent = this.checkpointList ? base : `${base} 체크포인트 목록을 받는 중…`;
    try {
      const { checkpoints } = await api.imageCheckpoints('');
      if (load !== this.modelLoad || !this.tags.open) return;
      this.checkpointList = checkpoints;
      // 목록을 받는 사이 고른 값은 그대로 둡니다.
      this.paintModelChoice(select.value);
      note.textContent = checkpoints.length ? base : `${base} ComfyUI 에 체크포인트가 없습니다.`;
    } catch (e) {
      if (load === this.modelLoad && this.tags.open) note.textContent = `${base} 목록을 받지 못했습니다 — ${e.message}`;
    }
  }

  /**
   * 그릴 태그와 부정 태그를 보여 주고 고치게 합니다.
   * 그리기를 누르면 { prompt, negative, checkpoint? } 를, 취소하면 null 을 돌려줍니다.
   * review 면 🎨 그리기 전 검토(모델 칸 없음), 아니면 '태그 고쳐 그리기' 입니다.
   */
  askTags({ prompt, negative = '', review = false, removed = [], checkpoint = '' }) {
    const dlg = this.tags;
    // 회사 API 는 부정 프롬프트와 체크포인트가 없어서 그 칸을 숨깁니다.
    const image = this.state.settings.image || {};
    const viaApi = Boolean(API_NAMES[image.backend]);
    const copy = tagCopy(image);
    $('tg-title').textContent = review ? copy.reviewTitle : copy.editTitle;
    $('tg-hint').textContent = review ? copy.reviewHint : copy.editHint;
    $('tg-text-label').innerHTML = copy.label;
    $('tg-foot-hint').textContent = copy.foot;
    $('tg-negative-field').hidden = viaApi;
    $('tg-text').value = prompt;
    $('tg-negative').value = negative;
    $('tg-removed').hidden = !removed.length;
    $('tg-removed').textContent = removed.length ? `필터로 뺀 태그: ${removed.join(', ')}` : '';
    // '다음부터 묻지 않기' 는 🎨 그리기의 검토에만 해당합니다.
    $('tg-skip-row').hidden = !review;
    $('tg-skip').checked = false;
    $('tg-model-row').hidden = review || viaApi;
    dlg.returnValue = '';
    dlg.showModal();
    if (!review && !viaApi) this.loadModelChoice(checkpoint);
    $('tg-text').focus();

    return new Promise((resolve) => {
      dlg.addEventListener('close', async () => {
        const tags = $('tg-text').value.trim();
        if (dlg.returnValue !== 'draw' || !tags) return resolve(null);
        if (review && $('tg-skip').checked) {
          try {
            this.state.settings = await api.saveSettings({ image: { reviewTags: false } });
            ui.toast('다음부터 검토 없이 바로 그립니다 — 설정 → 이미지 탭에서 다시 켤 수 있습니다');
          } catch (e) {
            ui.toast(`설정을 저장하지 못했습니다 — ${e.message}`);
          }
        }
        const picked = { prompt: tags, negative: viaApi ? '' : $('tg-negative').value.trim() };
        if (!review && !viaApi && !$('tg-checkpoint').disabled && $('tg-checkpoint').value) picked.checkpoint = $('tg-checkpoint').value;
        resolve(picked);
      }, { once: true });
    });
  }

  /* ---------------- 그리기 ---------------- */

  /**
   * 메시지 하나의 장면을 ComfyUI 로 그립니다. 답변 아래에 자리를 잡고 진행 단계를 보여 줍니다.
   *   prompt 고친 태그(주면 LLM 을 건너뜀) · negative 고친 부정 태그 · checkpoint 이번 한 장만 쓸 모델
   *   random 무작위 시드(다시 그리기) · review 태그까지만 만들고, 사람이 확인·수정한 뒤에 그립니다
   */
  async draw(chat, msg, turn, { prompt, negative, checkpoint, random = false, review = false } = {}) {
    if (!chat || this.drawingNow.has(msg.id)) return;
    this.drawingNow.add(msg.id);
    const box = turn.querySelector('.turn-images') || (() => {
      const div = document.createElement('div');
      div.className = 'turn-images';
      (turn.querySelector('.swipe-nav') || turn.querySelector('.turn-text')).after(div);
      return div;
    })();
    const slot = document.createElement('figure');
    slot.className = 'turn-image is-pending';
    slot.textContent = prompt ? '그리는 중' : '장면을 읽는 중';
    box.prepend(slot);
    const started = Date.now();
    let label = slot.textContent;
    const tick = setInterval(() => { slot.textContent = `${label} · ${Math.round((Date.now() - started) / 1000)}초`; }, 1000);

    let reviewed = null;
    try {
      const result = await drawImage(chat.id, msg.id, {
        prompt, negative, checkpoint, random, review,
        onEvent: (e) => {
          if (e.stage) { label = e.text; slot.textContent = e.text; }
          if (e.prompt) slot.title = e.prompt;
          // 검토 창에서 따로 보여 주므로 토스트는 그릴 때만 띄웁니다.
          if (e.removed?.length && !review) ui.toast(`필터로 뺀 태그: ${e.removed.join(', ')}`);
        }
      });
      if (review && result.review) {
        reviewed = result.review;
        slot.remove();
        return;
      }
      if (!result.images) throw new Error('그림을 받지 못했습니다.');
      msg.images = result.images;
      // 그리는 동안 다른 대화로 옮겼다면 화면은 건드리지 않습니다.
      const live = this.state.chat === chat && document.querySelector(`#thread [data-mid="${msg.id}"]`);
      if (live) live.replaceWith(this.app.view.turnFor(chat, msg));
    } catch (e) {
      slot.className = 'turn-image is-error';
      slot.textContent = `${e.message}\n(눌러서 닫기)`;
      slot.addEventListener('click', () => slot.remove(), { once: true });
    } finally {
      clearInterval(tick);
      this.drawingNow.delete(msg.id);
      if (reviewed) this.reviewAndDraw(chat, msg, turn, reviewed, random);
    }
  }

  /** 검토 창을 띄우고, 그리기를 누르면 고친 태그로 그립니다. */
  async reviewAndDraw(chat, msg, turn, { prompt, negative, removed }, random) {
    const picked = await this.askTags({ prompt, negative, review: true, removed });
    if (picked) this.draw(chat, msg, this.liveTurn(chat, msg, turn), { ...picked, random });
  }

  /* ---------------- 그림 크게 보기 ---------------- */

  paintLightbox() {
    const { links, at } = this.lightbox;
    const link = links[at];
    if (!link) return;
    const img = link.querySelector('img');
    $('lb-img').src = link.href;
    $('lb-prompt').textContent = img?.title || '';
    $('lb-prompt').title = img?.title || '';
    $('lb-original').href = link.href;
    $('lb-count').textContent = links.length > 1 ? `${at + 1} / ${links.length}` : '';
    $('lb-prev').hidden = links.length < 2;
    $('lb-next').hidden = links.length < 2;
  }

  stepLightbox(step) {
    const n = this.lightbox.links.length;
    if (n < 2) return;
    this.lightbox.at = (this.lightbox.at + step + n) % n;
    this.paintLightbox();
  }

  bindLightbox() {
    const dlg = $('dlg-lightbox');
    // 대화에 있는 그림을 화면 순서대로 모아, 누른 그림부터 넘겨 볼 수 있게 엽니다.
    // Ctrl·Shift·가운데 클릭은 브라우저 기본 동작(새 탭·새 창)을 그대로 둡니다.
    on('messages', 'click', (e) => {
      const link = e.target.closest('a.img-open');
      if (!link || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const links = [...document.querySelectorAll('#messages a.img-open')];
      this.lightbox = { links, at: Math.max(0, links.indexOf(link)) };
      this.paintLightbox();
      dlg.showModal();
    });
    on('lb-close', 'click', () => dlg.close());
    on('lb-prev', 'click', () => this.stepLightbox(-1));
    on('lb-next', 'click', () => this.stepLightbox(1));
    // 그림 바깥(어두운 배경)을 누르면 닫습니다.
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.classList.contains('lb-figure')) dlg.close();
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.stepLightbox(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.stepLightbox(1); }
    });
    dlg.addEventListener('close', () => {
      this.lightbox = { links: [], at: 0 };
      $('lb-img').removeAttribute('src');
    });
  }
}
