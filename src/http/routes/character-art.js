/** 캐릭터의 프로필 그림과 표정 그림: 올리기, 빼기, 보기. */
import express from 'express';
import { ART_LIMITS, ArtError } from '../../services/character-art.js';
import { wrap, fail } from '../helpers.js';

const acceptTypes = ['image/png', 'image/jpeg', 'image/webp'];

export class CharacterArtRoutes {
  constructor({ access, art }) {
    Object.assign(this, { access, art });
  }

  mount(app) {
    const body = express.raw({ type: acceptTypes, limit: ART_LIMITS.bytes });
    app.put('/api/characters/:id/portrait', body, this.guard((req) => this.art.setPortrait(req.params.id, req.body)));
    app.delete('/api/characters/:id/portrait', this.guard((req) => this.art.clearPortrait(req.params.id)));
    // 표정 이름은 한글이라 경로 대신 쿼리로 받습니다.
    app.put('/api/characters/:id/expressions', body, this.guard((req) => this.art.setExpression(req.params.id, req.query.label, req.body)));
    app.delete('/api/characters/:id/expressions', this.guard((req) => this.art.removeExpression(req.params.id, req.query.label)));
    app.get('/api/character-art/:id/:file', (req, res) => this.file(req, res));
  }

  /** 일을 하고 바뀐 캐릭터를 돌려줍니다. ArtError 는 사람이 읽을 안내로 바꿉니다. */
  guard(work) {
    return wrap(async (req, res) => {
      try {
        res.json(await work(req));
      } catch (err) {
        if (err instanceof ArtError) return fail(res, err.status, err.message);
        throw err;
      }
    });
  }

  file(req, res) {
    const { id, file } = req.params;
    if (!this.art.isSafe(id, file) || !this.access.findCharacter(req.user, id)) return res.status(404).end();
    res.sendFile(this.art.path(id, file), { maxAge: '30d', immutable: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
