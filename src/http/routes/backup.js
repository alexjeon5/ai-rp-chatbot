/** 백업 내려받기·불러오기. */
import { Backup } from '../../services/backup.js';
import { isObj } from '../../services/records.js';
import { fail } from '../helpers.js';

export class BackupRoutes {
  constructor({ store, access, settings }) {
    this.backup = new Backup(store, access, settings);
  }

  mount(app) {
    app.get('/api/export', (req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="rp-chat-backup.json"');
      res.json(this.backup.export(req.user));
    });
    // 불러온 항목은 불러온 사람의 것이 되고 설정도 그 사람의 설정에만 들어가므로, 멤버도 불러올 수 있습니다.
    app.post('/api/import', (req, res) => {
      const { data, includeSettings } = req.body || {};
      if (!isObj(data)) return fail(res, 400, '백업 파일 형식이 아닙니다.');
      if (![data.characters, data.personas, data.chats].some(Array.isArray)) {
        return fail(res, 400, '백업 파일에 캐릭터·페르소나·대화가 하나도 없습니다.');
      }
      res.json(this.backup.import(req.user, data, includeSettings));
    });
  }
}
