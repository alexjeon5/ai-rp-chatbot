/** 캐릭터 카드: 파일에서 가져오기, 내려받기. */
import { CardError } from '../../png-card.js';
import { wrap, fail } from '../helpers.js';

export class CharacterCardRoutes {
  constructor({ cards }) {
    this.cards = cards;
  }

  mount(app) {
    app.post('/api/characters/import', wrap((req, res) => this.importCard(req, res)));
    app.get('/api/characters/:id/export', (req, res) => this.exportCard(req, res));
  }

  /** body: { card } 또는 { png } (base64). 만든 캐릭터와 함께 온 로어북, 옮기지 못한 정보를 돌려줍니다. */
  importCard(req, res) {
    try {
      res.json(this.cards.import(req.body));
    } catch (err) {
      if (err instanceof CardError) return fail(res, 400, err.message);
      throw err;
    }
  }

  exportCard(req, res) {
    const out = this.cards.export(req.params.id);
    if (!out) return fail(res, 404, '없는 캐릭터입니다.');
    res.set('Content-Disposition', `attachment; filename="card.json"; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.type('application/json').send(JSON.stringify(out.card, null, 2));
  }
}
