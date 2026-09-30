/** 캐릭터의 프로필 그림과 표정 그림: 올리기, 빼기, 보기. 일은 CharacterArt 서비스가 합니다. */
import express from 'express';
import { ART_LIMITS } from '../../services/character-art.js';
import { wrap, sendImage } from '../helpers.js';

const acceptTypes = ['image/png', 'image/jpeg', 'image/webp'];

export class CharacterArtRoutes {
  constructor({ art }) {
    this.art = art;
  }

  mount(app) {
    const art = this.art;
    const body = express.raw({ type: acceptTypes, limit: ART_LIMITS.bytes });
    // 일을 하고 바뀐 캐릭터를 돌려줍니다.
    app.put('/api/characters/:id/portrait', body, wrap(async (req, res) => res.json(await art.setPortrait(req.user, req.params.id, req.body))));
    app.delete('/api/characters/:id/portrait', wrap(async (req, res) => res.json(await art.clearPortrait(req.user, req.params.id))));
    // 표정 이름은 한글이라 경로 대신 쿼리로 받습니다.
    app.put('/api/characters/:id/expressions', body, wrap(async (req, res) => res.json(await art.setExpression(req.user, req.params.id, req.query.label, req.body))));
    app.delete('/api/characters/:id/expressions', wrap(async (req, res) => res.json(await art.removeExpression(req.user, req.params.id, req.query.label))));
    app.get('/api/character-art/:id/:file', (req, res) => {
      const { id, file } = req.params;
      sendImage(res, art.canServe(req.user, id, file) && art.path(id, file));
    });
  }
}
