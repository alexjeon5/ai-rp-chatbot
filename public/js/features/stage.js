/** 비주얼 노벨 화면: 대화 위쪽에 배경과 캐릭터 그림을 깔고, 답변의 표정·장소 표식에 맞춰 바꿉니다. */
import { $, on, storage } from '../core/dom.js';
import { extractDirectives, matchLabel } from '../shared/scene-tags.js';

const EMPTY = { expression: '', place: '' };

export class Stage {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.shown = { ...EMPTY };
    this.layer = 0;
    this.el = $('vn-stage');
    this.el.classList.toggle('is-compact', storage.get('vnCompact') === '1');
    on('vn-stage', 'click', () => {
      const compact = this.el.classList.toggle('is-compact');
      storage.set('vnCompact', compact ? '1' : '0');
    });
  }

  get active() {
    const { chat } = this.state;
    return Boolean(chat?.vn && chat.kind !== 'assistant');
  }

  /** 대화에 남은 마지막 표정·장소로 화면을 맞춥니다. 대화를 열거나 답변이 바뀔 때 부릅니다. */
  sync() {
    const { chat } = this.state;
    this.el.hidden = !this.active;
    if (!this.active) {
      this.shown = { ...EMPTY };
      return;
    }
    const scene = { ...EMPTY };
    for (let i = chat.messages.length - 1; i >= 0 && !(scene.expression && scene.place); i--) {
      const s = chat.messages[i].role === 'assistant' ? chat.messages[i].scene : null;
      if (!s) continue;
      scene.expression ||= s.expression || '';
      scene.place ||= s.place || '';
    }
    this.apply(scene);
    this.paintHint();
  }

  /** 답변이 오는 동안 이미 닫힌 표식이 있으면 바로 화면에 반영합니다. */
  live(text) {
    if (!this.active) return;
    const found = extractDirectives(text);
    const next = { ...this.shown };
    const expression = matchLabel(found.expression, this.expressionLabels());
    if (expression !== null) next.expression = expression;
    const place = matchLabel(found.place, this.state.backgrounds.map((b) => b.name));
    if (place !== null) next.place = place;
    this.apply(next);
  }

  expressionLabels() {
    return (this.state.characterOf(this.state.chat)?.expressions || []).map((e) => e.label);
  }

  apply({ expression, place }) {
    const { state } = this;
    const character = state.characterOf(state.chat);
    if (place !== this.shown.place || !this.el.querySelector('.vn-bg.on')) this.setBackground(place);
    if (expression !== this.shown.expression || !this.el.querySelector('.vn-sprite').firstChild) this.setSprite(character, expression);
    this.shown = { expression, place };
    $('vn-place').textContent = place ? `📍 ${place}` : '';
    $('vn-place').hidden = !place;
    $('vn-mood').textContent = expression;
    $('vn-mood').hidden = !expression;
  }

  setBackground(place) {
    const url = this.state.backgroundUrl(place);
    const layers = this.el.querySelectorAll('.vn-bg');
    const next = layers[this.layer ^ 1];
    next.style.backgroundImage = url ? `url("${url}")` : '';
    next.classList.add('on');
    layers[this.layer].classList.remove('on');
    this.layer ^= 1;
    this.el.classList.toggle('has-bg', Boolean(url));
  }

  setSprite(character, expression) {
    const box = this.el.querySelector('.vn-sprite');
    const art = character?.expressions?.find((e) => e.label === expression);
    const file = art?.file || character?.portrait;
    box.replaceChildren();
    if (file && character?.id) {
      const img = document.createElement('img');
      img.alt = character.name || '';
      img.src = `/api/character-art/${character.id}/${file}`;
      box.append(img);
    } else {
      const face = document.createElement('span');
      face.className = 'vn-face';
      face.textContent = character?.avatar || '◦';
      box.append(face);
    }
  }

  /** 그림이 하나도 없으면 무엇을 채우면 되는지 알려 줍니다. */
  paintHint() {
    const character = this.state.characterOf(this.state.chat);
    const needs = !character?.expressions?.length && !this.state.backgrounds.length;
    $('vn-hint').hidden = !needs;
  }
}
