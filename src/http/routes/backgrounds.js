/** 배경 그림: 목록, 올리기, 이름 바꾸기, 지우기, 보기. 일은 Backgrounds 서비스가 합니다. */
import express from 'express';
import { ART_LIMITS } from '../../services/character-art.js';
import { wrap, sendImage } from '../helpers.js';

export class BackgroundRoutes {
  constructor({ backgrounds }) {
    this.backgrounds = backgrounds;
  }

  mount(app) {
    const backgrounds = this.backgrounds;
    const raw = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: ART_LIMITS.bytes });
    app.get('/api/backgrounds', wrap((req, res) => res.json(backgrounds.list(req.user))));
    // 이름은 한글이라 경로 대신 쿼리로 받습니다.
    app.post('/api/backgrounds', raw, wrap(async (req, res) => res.json(await backgrounds.add(req.user, req.query.name, req.body))));
    app.put('/api/backgrounds/:id', wrap((req, res) => res.json(backgrounds.rename(req.user, req.params.id, req.body?.name))));
    app.delete('/api/backgrounds/:id', wrap(async (req, res) => {
      await backgrounds.remove(req.user, req.params.id);
      res.json({ ok: true });
    }));
    app.get('/api/background-art/:id/:file', (req, res) => {
      const { id, file } = req.params;
      sendImage(res, backgrounds.canServe(req.user, id, file) && backgrounds.path(id, file));
    });
  }
}
