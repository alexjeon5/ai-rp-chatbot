/** 엔진 설정을 읽고, 쓸 수 있는지 가리고, 부르는 곳. */
import { streamChat, readsAsModelGone } from '../providers.js';
import { makeThoughtStripper, looksRepetitive } from '../sanitize.js';
import { isLocalUrl, checkBaseUrl, resolveApiKey } from '../security.js';

export class Engines {
  constructor(store, usage) {
    this.store = store;
    this.usage = usage;
  }

  /** 엔진 설정을 쓸 때는 항상 이걸 거칩니다. 환경변수 키가 우선 적용됩니다. */
  config(key) {
    const cfg = this.store.settings.providers[key];
    return cfg ? { ...cfg, apiKey: resolveApiKey(key, cfg) } : null;
  }

  /** 엔진을 쓸 수 있는지 봅니다. 문제가 있으면 사람이 읽을 안내를, 없으면 null 을 돌려줍니다. */
  problem(config, provider) {
    if (!config) return `설정되지 않은 엔진: ${provider}`;
    if (!config.model) return '설정에서 모델을 먼저 선택해 주세요.';
    const verdict = checkBaseUrl(config.baseUrl);
    if (!verdict.ok) return verdict.reason;
    if (!config.apiKey && !isLocalUrl(config.baseUrl)) {
      return `${config.label} API 키가 비어 있습니다. 설정에서 입력해 주세요.`;
    }
    return null;
  }

  /**
   * 성인 대화를 이 엔진으로 보내도 되는지. 기본은 로컬 엔진만 허용합니다.
   * 개발자 설정에서 경고를 확인하고 클라우드 허용을 켜 두면 외부 API 로도 보냅니다.
   */
  adultAllowed(config) {
    return isLocalUrl(config?.baseUrl || '') || this.store.settings.dev?.adultCloud === true;
  }

  adultBlocked(preset, config) {
    return `'${preset.name}' 모드는 로컬 엔진으로만 보낼 수 있습니다.\n` +
      `지금 선택된 엔진은 로컬 주소가 아닙니다 (${config.label}).\n` +
      '설정에서 엔진을 LM Studio 로 바꾸거나, 대화 상단에서 다른 모드를 선택하세요.';
  }

  /** 엔진 문제, 그다음 대화 모드의 성인 규칙을 봅니다. */
  check(config, provider, preset) {
    return this.problem(config, provider) ||
      (preset.adult && !this.adultAllowed(config) ? this.adultBlocked(preset, config) : null);
  }

  /**
   * 못 쓰는 모델이면 기록해 두고, 사람이 읽을 만한 안내로 바꿔 돌려줍니다.
   * 같은 모델을 다시 고르지 않도록 이후 목록에서 빠집니다.
   */
  describeFailure(error, provider, config) {
    const gone = readsAsModelGone(error);
    if (!gone) return error.message;

    // config 는 키를 채워 넣은 사본이므로, 기록은 저장된 원본 쪽에 남겨야 합니다.
    const stored = this.store.settings.providers[provider] || config;
    const list = stored.unavailableModels || (stored.unavailableModels = []);
    if (config.model && !list.includes(config.model)) {
      list.push(config.model);
      this.store.saveSettings();
    }

    const lines = [`이 계정에서 쓸 수 없는 모델입니다 (${config.model}). 목록에서 감췄습니다.`];
    if (gone.replacement) lines.push(`API 가 권하는 대체 모델: ${gone.replacement}`);
    lines.push('설정에서 모델을 다시 선택해 주세요. 불러오기를 누르면 쓸 수 있는 모델만 나옵니다.');
    return lines.join('\n');
  }

  /**
   * 엔진에 한 번 묻고, 사고 블록을 걸러 낸 답 전체를 돌려줍니다.
   * stopOnRepeat 면 같은 말을 되풀이할 때 controller 를 멈추고 거기까지만 씁니다.
   */
  async complete({ controller, stopOnRepeat = false, userId = null, ...request }) {
    const stripper = makeThoughtStripper({});
    const meter = this.usage?.meter({ ...request, userId });
    let text = '';
    try {
      for await (const chunk of streamChat({ ...request, onUsage: meter?.onUsage, signal: controller.signal })) {
        text += stripper.feed(chunk);
        if (stopOnRepeat && looksRepetitive(text)) { controller.abort(); break; }
      }
    } finally {
      meter?.record(text);
    }
    return text + stripper.flush();
  }
}
