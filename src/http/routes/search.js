/** 대화 검색. */
import { searchChats, SEARCH_LIMITS } from '../../chat-search.js';
import { fail } from '../helpers.js';

export class SearchRoutes {
  constructor({ access, context }) {
    Object.assign(this, { access, context });
  }

  mount(app) {
    app.get('/api/search', (req, res) => this.search(req, res));
  }

  /** GET /api/search?q=검색어&kind=rp|assistant — 결과에 대화 이름과 캐릭터를 붙여 화면이 목록을 다시 뒤지지 않게 합니다. */
  search(req, res) {
    const q = String(req.query.q ?? '');
    if (q.length > SEARCH_LIMITS.queryChars * 3) return fail(res, 400, '검색어가 너무 깁니다.');
    const kind = ['rp', 'assistant'].includes(req.query.kind) ? req.query.kind : undefined;
    const chats = this.access.chats(req.user);
    const byId = new Map(chats.map((c) => [c.id, c]));
    const { terms, hits, truncated } = searchChats(chats, q, { kind });

    const info = new Map();
    const about = (id) => {
      if (!info.has(id)) {
        const chat = byId.get(id);
        const assistant = chat.kind === 'assistant';
        info.set(id, {
          title: chat.title,
          kind: chat.kind || 'rp',
          archived: Boolean(chat.archivedAt),
          adult: assistant ? false : this.context.presetOf(chat).adult,
          character: assistant ? '' : this.context.characterOf(chat)?.name || ''
        });
      }
      return info.get(id);
    };
    res.json({ terms, truncated, hits: hits.map((h) => ({ ...h, ...about(h.chatId) })) });
  }
}
