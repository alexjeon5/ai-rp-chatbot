/** JSON·PNG·CHARX 캐릭터 카드를 가져오고 JSON·CHARX 파일로 내려받습니다. */
import { CardError } from '../../png-card.js';
import { wrap, fail } from '../helpers.js';

export class CharacterCardRoutes {
  constructor({ cards }) {
    this.cards = cards;
  }

  mount(app) {
    app.post('/api/characters/import', wrap((req, res) => this.importCard(req, res)));
    app.get('/api/characters/:id/export', wrap((req, res) => this.exportCard(req, res)));
  }

  /** body: { card }, { png } (base64, 선택으로 줄인 그림 portrait) 또는 { charx } (base64). 만든 캐릭터와 함께 온 로어북, 옮기지 못한 정보를 돌려줍니다. */
  async importCard(req, res) {
    try {
      res.json(await this.cards.import(req.user, req.body));
    } catch (err) {
      if (err instanceof CardError) return fail(res, 400, err.message);
      throw err;
    }
  }

  async exportCard(req, res) {
    if (req.query.format === 'charx') {
      const out = await this.cards.exportCharx(req.user, req.params.id);
      res.set('Content-Disposition', `attachment; filename="card.charx"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
      return res.type('application/zip').send(out.data);
    }
    const out = this.cards.export(req.user, req.params.id);
    res.set('Content-Disposition', `attachment; filename="card.json"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.type('application/json').send(JSON.stringify(out.card, null, 2));
  }
}
