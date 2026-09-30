/**
 * 디스코드 봇 켜기. 웹 서버와 같은 프로세스에서, 같은 서비스 묶음(createServices)을 씁니다.
 * DISCORD_TOKEN 이 없으면 아무것도 하지 않습니다. 봇이 실패해도 웹은 계속 돕니다.
 *
 *   DISCORD_TOKEN       봇 토큰 (개발자 포털 → Bot)
 *   DISCORD_GUILD_IDS   명령을 올릴 서버 id (쉼표로 여럿). 비우면 전역 명령 — 반영에 시간이 걸릴 수 있습니다
 *
 * 개발자 포털에서 켤 것: Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT (스레드의 말을 읽으려면 필요)
 * 봇 권한: 채널 보기, 메시지 보내기, 공개·비공개 스레드 만들기, 스레드에 메시지 보내기, 메시지 기록 보기, 반응 추가,
 *         웹훅 관리(캐릭터 이름·그림으로 말하기. 없으면 봇 이름으로 말합니다)
 *   PUBLIC_BASE_URL     밖에서 들어오는 주소(https://…). 있으면 캐릭터 프로필·표정 그림을 서명된 주소로 붙입니다
 */
import { COMMANDS } from './commands.js';
import { ThreadBindings, ChannelBindings } from './bindings.js';

export const discordConfig = (env = process.env) => ({
  token: (env.DISCORD_TOKEN || '').trim(),
  guildIds: (env.DISCORD_GUILD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
});

/**
 * @param {{ services: ReturnType<typeof import('../services/index.js').createServices>, env?: object, log?: Console }} o
 * @returns {Promise<{ client: import('discord.js').Client, controller: import('./controller.js').DiscordController, stop: () => Promise<void> } | null>}
 */
export async function startDiscord({ services, env = process.env, log = console }) {
  const { token, guildIds } = discordConfig(env);
  if (!token) return null;
  // 봇을 쓰지 않는 서버는 discord.js 를 불러오지도 않습니다. 메모리를 아낍니다.
  const { Client, Events, GatewayIntentBits, Partials } = await import('discord.js');
  const { DiscordController } = await import('./controller.js');
  const { Webhooks } = await import('./webhooks.js');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    // 비공개 스레드의 메시지는 캐시에 없는 채널에서 올 수 있습니다.
    partials: [Partials.Channel]
  });
  const webhooks = new Webhooks({ applicationId: () => client.application?.id || null, log });
  const doc = services.store.discordDoc;
  const controller = new DiscordController({ services, bindings: new ThreadBindings(doc), channels: new ChannelBindings(doc), webhooks, log });

  client.once(Events.ClientReady, async (ready) => {
    services.discordLinks.bot = { enabled: true, name: ready.user.username };
    log.log(`디스코드 봇: ${ready.user.tag} 로 접속했습니다.`);
    try {
      if (guildIds.length) {
        for (const id of guildIds) await ready.application.commands.set(COMMANDS, id);
        log.log(`디스코드 명령을 서버 ${guildIds.length}곳에 올렸습니다.`);
      } else {
        await ready.application.commands.set(COMMANDS);
        log.log('디스코드 명령을 전역으로 올렸습니다. 모든 서버에 보이기까지 시간이 걸릴 수 있습니다.');
      }
    } catch (e) {
      log.error(`디스코드 명령을 올리지 못했습니다 — ${e.message}`);
    }
  });
  client.on(Events.InteractionCreate, (interaction) => controller.onInteraction(interaction));
  client.on(Events.MessageCreate, (message) => controller.onMessage(message).catch((e) => log.error(e)));
  client.on(Events.Error, (e) => log.error(`디스코드 오류 — ${e.message}`));
  // 역할이나 채널 권한을 바꾸면(웹훅 관리 권한을 줌) 막혔던 채널을 바로 다시 묻습니다.
  for (const event of [Events.GuildRoleUpdate, Events.GuildRoleCreate, Events.ChannelUpdate]) client.on(event, () => webhooks.retry());

  try {
    await client.login(token);
  } catch (e) {
    log.error(`디스코드 봇에 접속하지 못했습니다 (${e.message}) 웹은 그대로 돕니다.`);
    client.destroy();
    return null;
  }
  return {
    client,
    controller,
    stop: async () => {
      services.discordLinks.bot = { enabled: false, name: '' };
      await client.destroy();
    }
  };
}
