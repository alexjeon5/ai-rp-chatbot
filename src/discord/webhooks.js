/**
 * 캐릭터 이름·그림으로 말하기 위한 웹훅. 채널마다 봇이 만든 웹훅 하나를 찾아 쓰고, 없으면 만듭니다.
 * 스레드에는 부모 채널의 웹훅에 threadId 를 붙여 보냅니다. 봇이 만든 웹훅이라 버튼도 달 수 있습니다(withComponents).
 *
 * 웹훅 관리 권한(Manage Webhooks)이 없으면 null 을 돌려주고, 부르는 쪽은 봇 이름으로 말합니다.
 * 권한이 없던 채널은 1분 동안 다시 묻지 않습니다. 역할·채널 권한이 바뀌면 봇이 retry() 로 바로 다시 묻게 합니다.
 * 웹훅 토큰은 메모리에만 둡니다.
 */
const RETRY_MS = 60_000;
const HOOK_NAME = 'rpChat 캐릭터';

/** 웹훅 이름 규칙: 1~80자, 'discord'·'clyde' 를 품을 수 없고 @ # : ``` 도 안 됩니다. 안 되면 대신 이름. */
export function webhookName(name, fallback = '캐릭터') {
  const clean = String(name ?? '')
    .replace(/[@#:`]/g, '')
    .replace(/discord|clyde/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return !clean || /^(everyone|here)$/i.test(clean) ? fallback : clean;
}

export class Webhooks {
  /**
   * @param {{ applicationId: () => string|null, log?: Pick<Console, 'warn'>, now?: () => number }} o
   */
  constructor({ applicationId, log = console, now = Date.now }) {
    Object.assign(this, { applicationId, log, now });
    /** 채널 id → Webhook */
    this.cache = new Map();
    /** 채널 id → 권한이 없다고 알게 된 시각 */
    this.denied = new Map();
  }

  /** 이 스레드(의 부모 채널)에서 쓸 웹훅. 못 쓰면 null. */
  async for(thread) {
    const channel = thread?.parent;
    if (!channel?.fetchWebhooks) return null;
    const cached = this.cache.get(channel.id);
    if (cached) return cached;
    const since = this.denied.get(channel.id);
    if (since !== undefined && this.now() - since < RETRY_MS) return null;
    try {
      const hooks = await channel.fetchWebhooks();
      const mine = [...hooks.values()].find((h) => h.token && h.applicationId === this.applicationId());
      const hook = mine || await channel.createWebhook({ name: HOOK_NAME, reason: '롤플레이 캐릭터 이름으로 말하기' });
      this.cache.set(channel.id, hook);
      this.denied.delete(channel.id);
      return hook;
    } catch (e) {
      this.log.warn(`#${channel.name || channel.id} 에서 웹훅을 쓸 수 없어 봇 이름으로 말합니다 (${e.message}). 봇에 웹훅 관리 권한을 주면 캐릭터 이름·그림으로 말합니다.`);
      this.denied.set(channel.id, this.now());
      return null;
    }
  }

  /** 권한이 바뀌었을 수 있을 때(역할·채널 설정 변경): 막혔던 채널을 바로 다시 묻습니다. */
  retry() {
    this.denied.clear();
  }

  /** 웹훅이 지워졌을 때(Unknown Webhook) 잊고 다음에 다시 찾습니다. */
  forget(channelId) {
    this.cache.delete(channelId);
  }
}
