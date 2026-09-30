/** 백업 내려받기·불러오기. */
import { Backup } from '../../services/backup.js';
import { isObj } from '../../services/records.js';
import { fail } from '../helpers.js';

export class BackupRoutes {
  constructor({ store, access, auth }) {
    this.auth = auth;
    this.backup = new Backup(store, access);
  }

  mount(app) {
    app.get('/api/export', (req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="rp-chat-backup.json"');
      res.json(this.backup.export(req.user));
    });
    // 지금은 데이터를 모두가 같이 쓰므로, 설정까지 덮을 수 있는 불러오기는 주인만 합니다.
    app.post('/api/import', this.auth.requireOwner, (req, res) => {
      const { data, includeSettings } = req.body || {};
      if (!isObj(data)) return fail(res, 400, '백업 파일 형식이 아닙니다.');
      if (![data.characters, data.personas, data.chats].some(Array.isArray)) {
        return fail(res, 400, '백업 파일에 캐릭터·페르소나·대화가 하나도 없습니다.');
      }
      res.json(this.backup.import(req.user, data, includeSettings));
    });
  }
}
