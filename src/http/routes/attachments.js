/** 메시지에 붙이는 그림: 올리기, 보기, 보내기 전에 빼기. */
import express from 'express';
import { SAFE_ID } from '../../services/records.js';
import { ATTACHMENT_LIMITS } from '../../services/attachments.js';
import { wrap, fail } from '../helpers.js';

const acceptTypes = ['image/png', 'image/jpeg', 'image/webp'];

export class AttachmentRoutes {
  constructor({ store, attachments, limits }) {
    Object.assign(this, { store, attachments, limits });
  }

  mount(app) {
    const body = express.raw({ type: acceptTypes, limit: ATTACHMENT_LIMITS.bytes });
    app.post('/api/chats/:id/attachments', this.limits.generate, body, wrap((req, res) => this.upload(req, res)));
    app.delete('/api/chats/:id/attachments/:file', (req, res) => this.discard(req, res));
    app.get('/api/uploads/:chatId/:file', (req, res) => this.file(req, res));
  }

  /** 그림 하나를 올립니다. 본문이 그림 파일 그대로입니다. */
  async upload(req, res) {
    const { id } = req.params;
    if (!SAFE_ID.test(id) || !this.store.chats.has(id)) return fail(res, 404, '없는 대화입니다.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'PNG·JPEG·WebP 그림만 붙일 수 있습니다.');
    const saved = await this.attachments.save(id, req.body);
    if (!saved) return fail(res, 400, '그림 파일이 아니거나 지원하지 않는 형식입니다. PNG·JPEG·WebP 만 붙일 수 있습니다.');
    res.json(saved);
  }

  /** 보내지 않고 뺀 그림을 지웁니다. 이미 어느 메시지에 붙은 파일이면 지우지 않습니다. */
  discard(req, res) {
    const { id, file } = req.params;
    const chat = this.store.chats.get(id);
    if (!chat || !this.attachments.isSafe(id, file)) return fail(res, 404, '없는 파일입니다.');
    const used = chat.messages.some((m) => m.attachments?.some((a) => a.file === file));
    if (!used) this.attachments.remove(id, file);
    res.json({ ok: true, kept: used });
  }

  file(req, res) {
    const { chatId, file } = req.params;
    if (!this.attachments.isSafe(chatId, file)) return res.status(404).end();
    res.sendFile(this.attachments.path(chatId, file), { maxAge: '30d', immutable: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}
