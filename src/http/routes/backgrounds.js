/** 배경 그림: 목록, 올리기, 이름 바꾸기, 지우기, 보기. */
import express from 'express';
import { ART_LIMITS, ArtError } from '../../services/character-art.js';
import { wrap, fail } from '../helpers.js';

export class BackgroundRoutes {
  constructor({ backgrounds }) {
    this.backgrounds = backgrounds;
  }

  mount(app) {
    const raw = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: ART_LIMITS.bytes });
    app.get('/api/backgrounds', (req, res) => res.json(this.backgrounds.list()));
    // 이름은 한글이라 경로 대신 쿼리로 받습니다.
    app.post('/api/backgrounds', raw, this.guard((req) => this.backgrounds.add(req.query.name, req.body)));
    app.put('/api/backgrounds/:id', this.guard((req) => this.backgrounds.rename(req.params.id, req.body?.name)));
    app.delete('/api/backgrounds/:id', this.guard(async (req) => {
      await this.backgrounds.remove(req.params.id);
      return { ok: true };
    }));
    app.get('/api/background-art/:id/:file', (req, res) => this.file(req, res));
  }

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
    if (!this.backgrounds.isSafe(id, file)) return res.status(404).end();
    res.sendFile(this.backgrounds.path(id, file), { maxAge: '30d', immutable: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
