/** 캐릭터: 사이드바 목록(내 캐릭터 / 기본 탭)과 캐릭터 창(편집·복사·이번만 쓰기·AI 로 채우기). */
import { api } from '../api.js';
import * as ui from '../ui.js';
import { $, storage, on } from '../core/dom.js';

const FIELDS = ['avatar', 'name', 'tags', 'description', 'appearance', 'personality',
  'speech', 'scenario', 'greeting', 'exampleDialogue', 'notes'];

/** 캐릭터 창의 칸을 모읍니다. */
const readSheet = () => Object.fromEntries(FIELDS.map((f) => [f, $(`c-${f}`).value.trim()]));

export class Characters {
  constructor(app) {
    this.app = app;
    this.state = app.state;
    this.dialog = $('dlg-character');

    on('character-list', 'click', (e) => {
      const btn = e.target.closest('[data-character]');
      if (!btn) return;
      const ch = this.state.characters.find((c) => c.id === btn.dataset.character);
      if (e.shiftKey) this.openDialog(ch);
      else app.newChat.start({ id: ch.id });
    });
    on('character-list', 'contextmenu', (e) => {
      const btn = e.target.closest('[data-character]');
      if (!btn) return;
      e.preventDefault();
      this.openDialog(this.state.characters.find((c) => c.id === btn.dataset.character));
    });
    on('btn-new-character', 'click', () => this.openDialog(null));
    on('char-tabs', 'click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      this.rememberTab(btn.dataset.tab);
      this.paint();
    });
    on('character-list', 'click', async (e) => {
      if (!e.target.closest('[data-seed-builtins]')) return;
      const { added, characters } = await api.seedCharacters();
      this.state.characters = characters;
      this.paint();
      ui.toast(added ? `기본 캐릭터 ${added}명을 넣었습니다` : '이미 다 들어 있습니다');
    });

    on('c-draft', 'click', () => this.draft());
    on('c-once', 'click', () => {
      const draft = readSheet();
      if (!draft.name) return ui.toast('이름을 입력해 주세요');
      this.dialog.close('cancel');
      app.newChat.start({ inline: draft });
    });
    on('c-cancel', 'click', () => this.dialog.close('cancel'));
    // 칸 내용은 그대로 두고 '새로 만들기' 상태로 바꿉니다. 저장하면 내 캐릭터로 들어갑니다.
    on('c-copy', 'click', () => {
      this.state.editingCharacterId = null;
      $('char-dlg-title').textContent = '캐릭터 만들기';
      $('c-name').value = `${$('c-name').value.trim()} (내 버전)`;
      for (const id of ['c-delete', 'c-copy', 'c-builtin-note']) $(id).hidden = true;
      $('c-once').hidden = false;
      this.note('복사했습니다. 고친 뒤 저장하면 내 캐릭터에 들어갑니다.');
      $('c-name').focus();
    });
    on('c-delete', 'click', () => {
      if (!this.state.editingCharacterId) return;
      if (!confirm('이 캐릭터를 삭제할까요? 이미 나눈 대화는 그대로 남습니다.')) return;
      this.dialog.close('delete');
    });
    this.dialog.addEventListener('close', () => this.onClose());
  }

  /** 마지막으로 본 탭. 처음이면 직접 만든 캐릭터가 있을 때 '내 캐릭터', 없으면 '기본' 입니다. */
  tab() {
    const saved = storage.get('characterTab');
    if (saved === 'mine' || saved === 'builtin') return saved;
    return this.state.characters.some((c) => !c.builtin) ? 'mine' : 'builtin';
  }

  rememberTab(tab) {
    storage.set('characterTab', tab);
  }

  paint() {
    const present = new Set(this.state.characters.map((c) => c.builtin).filter(Boolean));
    const missing = (this.state.settings.builtinCharacters || []).filter((name) => !present.has(name)).length;
    ui.renderCharacterList(this.state.characters, { tab: this.tab(), missing });
  }

  note(text = '') {
    $('c-draft-note').textContent = text;
  }

  openDialog(ch) {
    this.state.editingCharacterId = ch?.id || null;
    $('char-dlg-title').textContent = ch ? `${ch.name} 고치기` : '캐릭터 만들기';
    $('c-delete').hidden = !ch;
    // 기본 캐릭터는 원본을 두고 내 버전을 따로 만들 수 있게 합니다.
    $('c-copy').hidden = !ch?.builtin;
    $('c-builtin-note').hidden = !ch?.builtin;
    // 이미 저장된 캐릭터를 고칠 때는 '이번만 쓰기' 가 뜻이 없습니다.
    $('c-once').hidden = Boolean(ch?.id);
    for (const f of FIELDS) $(`c-${f}`).value = ch?.[f] || '';
    $('c-brief').value = '';
    this.note('');
    this.dialog.showModal();
  }

  /** 줄글 설명으로 칸을 채웁니다. 이미 채워 둔 칸은 모델에게 '정해진 것' 으로 넘기고, 응답에서도 덮어쓰지 않습니다. */
  async draft() {
    const brief = $('c-brief').value.trim();
    if (!brief) return ui.toast('어떤 캐릭터인지 적어 주세요');
    const current = Object.fromEntries(Object.entries(readSheet()).filter(([, v]) => v));
    const btn = $('c-draft');
    btn.disabled = true;
    btn.textContent = '쓰는 중…';
    this.note('모델에 따라 30초 남짓 걸립니다. 형식이 안 맞으면 한 번 더 시도합니다.');
    try {
      const { character, fallback, reason } = await api.draftCharacter(brief, current);
      for (const f of FIELDS) if (character[f]) $(`c-${f}`).value = character[f];
      // fallback 이어도 에러가 아니라, 채워진 만큼만 온 것입니다 — 계속 진행합니다.
      this.note(fallback ? `일부만 채워졌습니다 — ${reason}` : '채웠습니다. 고친 뒤 저장하세요.');
    } catch (e) {
      this.note('');
      ui.toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI 로 채우기';
    }
  }

  async onClose() {
    const { state, app } = this;
    const action = this.dialog.returnValue;
    const id = state.editingCharacterId;
    if (action === 'delete' && id) {
      await api.deleteCharacter(id);
    } else if (action === 'save') {
      const body = readSheet();
      if (!body.name) return ui.toast('이름을 입력해 주세요');
      if (id) await api.updateCharacter(id, body);
      else {
        await api.createCharacter(body);
        // 새로 만든 캐릭터가 바로 보이도록 '내 캐릭터' 탭으로 옮깁니다.
        this.rememberTab('mine');
      }
    } else return;

    state.characters = await api.characters();
    this.paint();
    await app.list.refresh();
    // 서버가 지운 캐릭터의 대화를 1회성 캐릭터로 바꿔 두었으니, 열린 대화를 다시 읽습니다.
    // 고친 경우에도 이름·소개가 화면 곳곳에 반영되도록 같은 길로 다시 그립니다.
    if (state.chat && !state.run && state.chat.kind !== 'assistant') await app.view.open(state.chat.id);
  }
}
