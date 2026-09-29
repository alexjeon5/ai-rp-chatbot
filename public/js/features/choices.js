/** 선택지 제안과 주사위. 입력창 위 후보 칩, 주사위 팝오버, 답변에 붙는 판정 버튼을 맡습니다. */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, esc, on } from '../core/dom.js';
import { DICE_SIDES } from '../shared/scene-tags.js';
import { rollDice, formatRoll, formatCheck, MAX_COUNT, MAX_MOD } from '../shared/dice.js';

const COUNT = 3;

export class Choices {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.list = [];
    this.pending = null;

    $('dice-sides').innerHTML = DICE_SIDES
      .map((n) => `<button type="button" class="dice-face" data-sides="${n}">d${n}</button>`).join('');

    on('btn-choices', 'click', () => this.suggest());
    on('btn-dice', 'click', () => this.togglePop());
    on('dice-sides', 'click', (e) => {
      const btn = e.target.closest('.dice-face');
      if (btn) this.roll(Number(btn.dataset.sides));
    });
    on('choices-tray', 'click', (e) => {
      if (e.target.closest('.choices-close')) return this.clear();
      const chip = e.target.closest('.choice-chip');
      if (chip) this.pick(Number(chip.dataset.i));
    });
    document.addEventListener('click', (e) => {
      if (!$('dice-pop').hidden && !e.target.closest('.dice-wrap')) this.togglePop(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('dice-pop').hidden) this.togglePop(false);
    });
  }

  togglePop(open = $('dice-pop').hidden) {
    $('dice-pop').hidden = !open;
    $('btn-dice').setAttribute('aria-expanded', String(open));
  }

  /* ---------------- 선택지 ---------------- */

  /** 다음 차례 후보를 받아 칩으로 보입니다. auto 는 답변이 끝난 뒤 저절로 부른 경우로, 실패해도 조용히 넘깁니다. */
  async suggest({ auto = false } = {}) {
    const { state } = this;
    const chat = state.chat;
    if (!chat || chat.kind === 'assistant' || state.run || this.pending) return;
    const btn = $('btn-choices');
    const controller = new AbortController();
    this.pending = controller;
    btn.disabled = true;
    btn.textContent = '제안 받는 중…';
    try {
      const { choices } = await api.suggestChoices(chat.id, COUNT, controller.signal);
      if (state.chat !== chat || state.run || controller.signal.aborted) return;
      this.show(choices || []);
      if (!choices?.length && !auto) ui.toast('제안이 비어 있습니다. 다시 눌러 보세요');
    } catch (e) {
      if (!auto && e.name !== 'AbortError' && state.chat === chat) ui.toast(`선택지를 받지 못했습니다 — ${e.message}`);
    } finally {
      if (this.pending === controller) this.pending = null;
      btn.textContent = '✦ 선택지';
      btn.disabled = Boolean(state.run);
    }
  }

  show(choices) {
    this.list = choices;
    const tray = $('choices-tray');
    tray.hidden = !choices.length;
    tray.innerHTML = choices.map((c, i) => `<button type="button" class="choice-chip" data-i="${i}">
      <span class="choice-text">${esc(c.text)}</span>${c.check
        ? `<span class="choice-check">🎲 ${esc(c.check.label)} d${c.check.sides} · ${c.check.dc}</span>` : ''}</button>`).join('')
      + '<button type="button" class="choices-close" aria-label="선택지 닫기" title="닫기">×</button>';
  }

  /** 칩을 고르면 입력창에 초안으로 들어갑니다. 판정이 붙은 칩은 그 자리에서 굴려 결과 줄을 덧붙입니다. */
  pick(i) {
    const choice = this.list[i];
    if (!choice) return;
    let text = choice.text;
    if (choice.check) {
      const { total } = rollDice({ sides: choice.check.sides });
      text += `\n${formatCheck(choice.check, total)}`;
    }
    this.clear();
    const input = $('input');
    input.value = text;
    this.app.composer.grow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** 칩을 치우고 진행 중이던 제안 요청도 버립니다. 판정 버튼도 지금 상태에 맞춥니다. */
  clear() {
    this.pending?.abort();
    this.list = [];
    const tray = $('choices-tray');
    tray.hidden = true;
    tray.innerHTML = '';
    this.sync();
  }

  /* ---------------- 주사위 ---------------- */

  /** 그냥 굴리기. 결과 문장을 입력창 끝에 붙입니다. */
  roll(sides) {
    const spec = {
      count: this.clampInt($('dice-count').value, 1, MAX_COUNT, 1),
      sides,
      mod: this.clampInt($('dice-mod').value, -MAX_MOD, MAX_MOD, 0)
    };
    $('dice-count').value = spec.count;
    $('dice-mod').value = spec.mod;
    const line = formatRoll(spec, rollDice(spec));
    const input = $('input');
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${line}` : line;
    this.app.composer.grow();
    this.togglePop(false);
    input.focus();
    ui.toast(line);
  }

  clampInt(value, min, max, fallback) {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  /* ---------------- 판정 버튼 ---------------- */

  /** AI 가 요청한 판정을 굴려 결과를 내 메시지로 보냅니다. */
  rollCheck(msg) {
    if (this.state.run || !msg.check) return;
    const { total } = rollDice({ sides: msg.check.sides });
    return this.app.composer.submit(formatCheck(msg.check, total));
  }

  /** 판정 버튼은 마지막 답변에서, 생성이 끝났을 때만 보입니다. */
  sync() {
    const { state } = this;
    const chat = state.chat;
    const last = chat?.messages[chat.messages.length - 1];
    for (const btn of document.querySelectorAll('#thread .check-btn')) {
      btn.hidden = !(chat?.dice && !state.run && btn.closest('.turn')?.dataset.mid === last?.id);
    }
  }
}
