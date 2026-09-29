/** 앱 진입점. 상태와 기능 객체들을 만들어 서로 이어 주고, 첫 화면을 띄웁니다. */
import { api } from './api.js';
import * as ui from './ui.js';
import { enhanceSelects } from './select.js';
import { $, on } from './core/dom.js';
import { AppState } from './core/state.js';
import { applyTheme } from './features/theme.js';
import { Toolbar } from './features/toolbar.js';
import { ChatList } from './features/chat-list.js';
import { SearchPanel } from './features/search.js';
import { Drawing } from './features/drawing.js';
import { ChatView } from './features/chat-view.js';
import { Composer } from './features/composer.js';
import { AttachTray } from './features/attach.js';
import { Pwa } from './features/pwa.js';
import { Memory } from './features/memory.js';
import { CastDialog } from './features/cast.js';
import { NewChat } from './features/new-chat.js';
import { Characters } from './features/characters.js';
import { CardTransfer } from './features/card-transfer.js';
import { Personas } from './features/personas.js';
import { Lorebooks } from './features/lorebooks.js';
import { ChatLoreDialog } from './features/chat-lore.js';
import { Settings } from './features/settings.js';

class App {
  constructor() {
    this.state = new AppState();
    this.toolbar = new Toolbar(this);
    this.list = new ChatList(this);
    this.search = new SearchPanel(this);
    // 그림 크게 보기는 메시지 편집보다 먼저 #messages 클릭을 받아야 하므로 ChatView 보다 먼저 만듭니다.
    this.drawing = new Drawing(this);
    this.view = new ChatView(this);
    this.attach = new AttachTray(this);
    this.composer = new Composer(this);
    this.memory = new Memory(this);
    this.cast = new CastDialog(this);
    this.newChat = new NewChat(this);
    this.characters = new Characters(this);
    this.cardTransfer = new CardTransfer(this);
    this.personas = new Personas(this);
    this.lorebooks = new Lorebooks(this);
    this.chatLore = new ChatLoreDialog(this);
    this.settings = new Settings(this);

    // 두 메뉴 모두 바깥을 누르면 닫습니다.
    document.addEventListener('mousedown', (e) => {
      if (!$('chat-menu').hidden && !e.target.closest('.chat-menu')) this.view.toggleMenu(false);
      if (!$('row-menu').hidden && !e.target.closest('#row-menu')) this.list.closeRowMenu();
    });
    on('btn-logout', 'click', async () => {
      if (this.state.run && !confirm('답변을 쓰는 중입니다. 로그아웃하면 여기서 멈춥니다. 계속할까요?')) return;
      await api.logout().catch(() => {});
      location.replace('/login.html');
    });
  }

  async boot() {
    const { state } = this;
    [state.settings, state.characters, state.personas, state.lorebooks, state.chats] = await Promise.all([
      api.settings(), api.characters(), api.personas(), api.lorebooks(), api.chats()
    ]);
    applyTheme(state.settings.dev);
    this.paintAccount();
    this.paintAdultRules();
    this.characters.paint();
    this.list.paintMode();
    this.list.paintAdultToggle();
    this.list.paint(null);
    this.toolbar.paintModelBadge();
    const last = localStorage.getItem('lastChat');
    const candidates = state.visibleChats();
    if (last && candidates.some((c) => c.id === last)) await this.view.open(last);
    else if (candidates.length) await this.view.open(candidates[0].id);
    else this.view.close();
  }

  /** 로그아웃 버튼에 누구로 들어와 있는지 적어 둡니다. 로그인을 끈 개발 모드면 버튼을 숨깁니다. */
  async paintAccount() {
    try {
      const { user, authDisabled } = await api.me();
      $('btn-logout').hidden = Boolean(authDisabled);
      $('btn-logout').title = `${user.name} 로그아웃`;
    } catch {
      // 계정 표시는 부가 정보라, 실패해도 앱은 그대로 씁니다.
    }
  }

  /** 설정·페르소나 창의 성인 안내 문구를 지금 규칙에 맞춥니다. */
  paintAdultRules() {
    const cloud = this.state.adultCloud;
    $('s-preset-adult-rule').textContent = cloud
      ? '클라우드 허용이 켜져 있어, 선택한 외부 API 엔진으로도 보냅니다.'
      : '로컬(LM Studio) 엔진으로만 보냅니다. 외부 API 로는 전송되지 않습니다.';
    $('p-adult-rule').textContent = cloud
      ? '문장 만들기는 선택한 엔진으로 보냅니다 (클라우드 허용 켜짐).'
      : '문장 만들기는 로컬(LM Studio) 엔진으로만 보냅니다.';
  }
}

new Pwa().register();
const app = new App();
enhanceSelects();
ui.watchScroll();
app.boot().catch((e) => ui.showError(`앱을 시작하지 못했습니다 — ${e.message}`));
