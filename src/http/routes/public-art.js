/** 로그인 없이 보는 캐릭터 그림(서명된 주소). 디스코드 아바타용. 일은 PublicArt 서비스가 합니다. */
export class PublicArtRoutes {
  constructor({ publicArt }) {
    this.publicArt = publicArt;
  }

  mount(app) {
    app.get('/pub/art/:id/:file', (req, res) => {
      const file = this.publicArt.pathFor(req.params.id, req.params.file, req.query.s);
      if (!file) return res.status(404).end();
      // 서명한 주소는 공개용이라 앞단 캐시에 남아도 됩니다. 그림이 바뀌면 파일 이름(주소)도 바뀝니다.
      res.sendFile(file, { cacheControl: false, headers: { 'Cache-Control': 'public, max-age=2592000, immutable' } }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }
}
