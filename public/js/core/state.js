/** 앱 상태. 서버에서 받은 데이터의 사본과, 그걸로 계산하는 값들. */

// 줄마다 말풍선으로 보여 줄 모드. 직접 만든 모드는 해당하지 않습니다.
const MESSENGER_PRESETS = new Set(['messenger', 'adult-messenger']);

/** 로컬 주소인지. 성인 틀 대화에서 고를 수 있는 엔진을 가립니다. (서버 판정과 같은 규칙) */
export const isLocalUrl = (url = '') =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);

export class AppState {
  settings = null;
  characters = [];
  personas = [];
  chats = [];
  chat = null;
  // 진행 중인 생성. { chatId, controller, stopped, done }
  run = null;
  editingCharacterId = null;
  hideAdult = localStorage.getItem('hideAdult') === '1';
  // 대화 목록 대신 보관함을 보고 있는가
  showArchived = false;
  mode = localStorage.getItem('mode') === 'assistant' ? 'assistant' : 'rp';
  // 입력창 아래 게이지가 마지막으로 받은 값
  context = null;

  characterOf(chat) {
    return chat?.character || this.characters.find((c) => c.id === chat?.characterId);
  }

  personaOf(chat) {
    return this.personas.find((p) => p.id === chat?.personaId) ||
      this.personas.find((p) => p.id === this.settings?.activePersonaId);
  }

  presetOf(chat) {
    const s = this.settings;
    return s.presets.find((p) => p.id === chat?.presetId) || s.presets.find((p) => p.id === s.activePresetId);
  }

  isBubbles(chat) {
    return chat?.kind !== 'assistant' && MESSENGER_PRESETS.has(this.presetOf(chat)?.id);
  }

  /** 이 대화에 함께 등장하는 캐릭터들. 목록에서 지워진 것은 빠집니다. */
  castOf(chat) {
    return (chat?.castIds || []).map((id) => this.characters.find((c) => c.id === id)).filter(Boolean);
  }

  /** 답변 위에 붙는 이름. 여럿이 함께 나오면 이름을 이어 붙입니다. */
  charLabel(chat) {
    return [this.characterOf(chat)?.name, ...this.castOf(chat).map((c) => c.name)].filter(Boolean).join(' · ') || '상대';
  }

  /** 목록 한 줄(서버가 붙여 준 adult·presetName 등)로 본 지금 대화. */
  get listedChat() {
    return this.chats.find((c) => c.id === this.chat?.id);
  }

  /** 개발자 설정에서 경고를 확인하고 성인 모드의 클라우드 허용을 켰는지. */
  get adultCloud() {
    return this.settings?.dev?.adultCloud === true;
  }

  /** 성인 대화를 이 엔진으로 보낼 수 있는지. (서버의 adultAllowed 와 같은 규칙) */
  adultAllowed(cfg) {
    return isLocalUrl(cfg?.baseUrl) || this.adultCloud;
  }

  /** 지금 모드(롤플레이/어시스턴트)의 대화. 보관 여부는 가리지 않습니다. */
  modeChats() {
    return this.chats.filter((c) => (this.mode === 'assistant' ? c.kind === 'assistant' : c.kind !== 'assistant'));
  }

  /** 목록에 보일 대화. 평소에는 보관하지 않은 것만 마지막 대화 순으로, 보관함이면 최근에 보관한 순으로. */
  visibleChats() {
    const list = this.modeChats().filter((c) => Boolean(c.archivedAt) === this.showArchived);
    return this.showArchived ? list.sort((a, b) => b.archivedAt - a.archivedAt) : list;
  }

  /** 실제로 화면에 그려지는 대화. '성인 숨기기'로 가린 것까지 뺍니다. */
  listedChats() {
    return this.visibleChats().filter((c) => !(this.hideAdult && c.adult));
  }
}
