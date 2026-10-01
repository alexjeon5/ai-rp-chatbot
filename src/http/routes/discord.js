/** 디스코드 계정 잇기: 연결 상태, 1회용 코드 받기, 연결 끊기. 일은 DiscordLinks 서비스가 합니다. */
import { wrap, fail } from '../helpers.js';

export class DiscordRoutes {
  constructor({ discordLinks }) {
    Object.assign(this, { discordLinks });
  }

  mount(app) {
    const links = this.discordLinks;
    app.get('/api/discord/link', wrap((req, res) => res.json(links.status(req.user))));
    app.post('/api/discord/link-code', wrap((req, res) => {
      // 로그인을 잠시 꺼 둔 동안(auth off)은 누구나 주인으로 들어옵니다. 그 틈에 남의 디스코드가 주인 계정에 영영 붙지 않게 막습니다.
      if (req.authBypass) return fail(res, 403, '로그인을 잠시 꺼 둔 동안에는 디스코드를 이을 수 없습니다. 로그인을 켜고 다시 해 주세요.');
      res.json(links.issueCode(req.user));
    }));
    app.delete('/api/discord/link', wrap((req, res) => res.json({ ok: true, removed: links.unlink(req.user) })));
  }
}
