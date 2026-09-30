/** 설정, 모델 목록, 통신 로그. 설정을 합치고 나누는 일은 Settings 서비스가 합니다. */
import { listModels } from '../../providers.js';
import { listLogs, clearLogs } from '../../logs.js';
import { checkBaseUrl } from '../../security.js';
import { wrap, fail } from '../helpers.js';

export class SettingsRoutes {
  constructor({ store, settings, auth, engines, limits }) {
    Object.assign(this, { store, settings, auth, engines, limits });
  }

  mount(app) {
    app.get('/api/settings', wrap((req, res) => res.json(this.settings.payload(req.user))));
    // 주인이 아니면 엔진·이미지 같은 공용 항목은 조용히 빠지고 나머지(계정별 설정)만 저장됩니다.
    app.put('/api/settings', wrap((req, res) => res.json(this.settings.update(req.user, req.body || {}))));
    app.get('/api/models', this.limits.models.middleware, wrap((req, res) => this.models(req, res)));
    // 대화 내용은 담지 않습니다 — 요청 대상 주소·상태 코드·걸린 시간·오류 메시지뿐입니다.
    app.get('/api/logs', this.auth.requireOwner, (req, res) => res.json({ logs: listLogs() }));
    app.delete('/api/logs', this.auth.requireOwner, (req, res) => { clearLogs(); res.json({ ok: true }); });
    // 감춰 둔 모델 기록을 지웁니다. 계정 상태가 바뀌었을 때 씁니다.
    app.delete('/api/providers/:key/unavailable', this.auth.requireOwner, (req, res) => this.clearUnavailable(req, res));
  }

  async models(req, res) {
    const provider = req.query.provider || this.settings.providerFor(req.user);
    const config = this.engines.config(provider);
    if (!config) return fail(res, 400, `설정되지 않은 엔진: ${provider}`);
    // 저장된 값이라도 한 번 더 봅니다. 허용 목록이 바뀌었거나 settings.json 을 직접 고친 경우가 있습니다.
    const verdict = checkBaseUrl(config.baseUrl);
    if (!verdict.ok) return fail(res, 400, verdict.reason);
    res.json({ models: await listModels(provider, config) });
  }

  clearUnavailable(req, res) {
    const cfg = this.settings.shared.providers[req.params.key];
    if (!cfg) return fail(res, 404, '없는 엔진입니다.');
    const count = (cfg.unavailableModels || []).length;
    cfg.unavailableModels = [];
    this.store.saveSettings();
    res.json({ cleared: count });
  }
}
