import 'dotenv/config';
import {
  App,
  BlockAction,
  ButtonAction,
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
} from '@slack/bolt';
import Redis from 'ioredis';

/* ------------ Env + sanity ------------ */
const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_LEVEL_TOKEN,
  REDIS_URL,
  PORT = '3000',
} = process.env as Record<string, string>;
const QUEUE_MAX_AGE_HOURS_DEFAULT = 12;
const rawQueueMaxAgeHours = process.env.QUEUE_MAX_AGE_HOURS;
let QUEUE_MAX_AGE_MS: number | null =
  QUEUE_MAX_AGE_HOURS_DEFAULT * 60 * 60 * 1000;
if (rawQueueMaxAgeHours !== undefined) {
  const parsed = Number(rawQueueMaxAgeHours);
  if (Number.isFinite(parsed)) {
    QUEUE_MAX_AGE_MS =
      parsed > 0 ? parsed * 60 * 60 * 1000 : null; // <=0 disables pruning
  }
}

if (!SLACK_SIGNING_SECRET || !SLACK_BOT_TOKEN || !SLACK_APP_LEVEL_TOKEN) {
  console.error(
    'Missing env vars. Needed: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, SLACK_APP_LEVEL_TOKEN'
  );
  process.exit(1);
}
const NODE_ENV = process.env.NODE_ENV ?? 'development';

/* ------------ Redis ------------ */
const redis = new Redis(REDIS_URL || 'redis://127.0.0.1:6379');
redis.on('error', (err) => {
  console.error('[redis] error:', err?.message || err);
});

/* ------------ Bolt App (Socket Mode) ------------ */
const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: Boolean(SLACK_APP_LEVEL_TOKEN),
  appToken: SLACK_APP_LEVEL_TOKEN,
  port: Number(PORT),
});

/* ------------ Helpers: storage & formatting ------------ */
const keyFor = (teamId: string, channelId: string) =>
  `queue:${teamId}:${channelId}`;
const lastMessageKeyFor = (teamId: string, channelId: string) =>
  `queue:last-message:${teamId}:${channelId}`;

async function pruneStaleQueueEntries(teamId: string, channelId: string) {
  if (!QUEUE_MAX_AGE_MS) return;
  const cutoff = Date.now() - QUEUE_MAX_AGE_MS;
  if (cutoff <= 0) return;
  const key = keyFor(teamId, channelId);
  await redis.zremrangebyscore(key, 0, cutoff);
}

async function joinQueue(teamId: string, channelId: string, userId: string) {
  await pruneStaleQueueEntries(teamId, channelId);
  const key = keyFor(teamId, channelId);
  const now = Date.now();
  const added = await redis.zadd(key, 'NX', now, userId);
  return added === 1;
}

async function leaveQueue(teamId: string, channelId: string, userId: string) {
  await pruneStaleQueueEntries(teamId, channelId);
  const key = keyFor(teamId, channelId);
  const removed = await redis.zrem(key, userId);
  return removed === 1;
}

async function listQueue(teamId: string, channelId: string) {
  await pruneStaleQueueEntries(teamId, channelId);
  const key = keyFor(teamId, channelId);
  return redis.zrange(key, 0, -1);
}

async function popNext(teamId: string, channelId: string) {
  await pruneStaleQueueEntries(teamId, channelId);
  const key = keyFor(teamId, channelId);
  while (true) {
    const first = (await redis.zrange(key, 0, 0))[0];
    if (!first) return null;
    const removed = await redis.zrem(key, first);
    if (removed === 1) return first;
    // rare race: loop and try again
  }
}

function queueBlocks(
  title: string,
  users: string[],
  opts?: { queueNote?: string }
) {
  const textLines = users.length
    ? users.map((u, i) => `${i + 1}. <@${u}>`).join('\n')
    : '_No one is in the queue yet._';

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: textLines } },
  ];

  if (opts?.queueNote) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: opts.queueNote },
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            'View queue with `/queue-deploy` and join with `/queue-deploy join`',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Join' },
          action_id: 'queue_join',
          value: 'join',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Leave' },
          action_id: 'queue_leave',
          value: 'leave',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Refresh' },
          action_id: 'queue_refresh',
          value: 'refresh',
        },
      ],
    }
  );

  return blocks;
}

function leaveQueueNote(leaverId: string, nextUserId: string | null) {
  if (!nextUserId) {
    return `<@${leaverId}> has left the queue.`;
  }
  return `<@${leaverId}> has left the queue.\n<@${nextUserId}> it is now your turn!`;
}

async function clearQueueMessage(teamId: string, channel: string, client: any) {
  const key = lastMessageKeyFor(teamId, channel);
  const ts = await redis.get(key);
  if (!ts) return false;
  try {
    await client.chat.delete({ channel, ts });
  } catch (err: any) {
    const slackError = err?.data?.error;
    if (slackError !== 'message_not_found' && slackError !== 'cant_delete_message') {
      console.error('[queue] failed to delete queue message:', err);
      throw err;
    }
  }
  await redis.del(key);
  return true;
}

async function postOrUpdateQueueView({
  client,
  channel,
  teamId,
  title = 'Channel Queue',
  ts,
  queueNote,
}: {
  client: any;
  channel: string;
  teamId: string;
  title?: string;
  ts?: string;
  queueNote?: string;
}) {
  const users = await listQueue(teamId, channel);
  const blocks = queueBlocks(title, users, { queueNote });
  const lastMessageKey = lastMessageKeyFor(teamId, channel);
  const storedTs = await redis.get(lastMessageKey);
  const targetTs = ts ?? storedTs ?? undefined;

  if (targetTs) {
    try {
      const updateResult = await client.chat.update({
        channel,
        ts: targetTs,
        blocks,
        text: 'Queue updated',
      });
      const updatedTs = updateResult?.ts ?? targetTs;
      await redis.set(lastMessageKey, updatedTs);
      return updateResult;
    } catch (err: any) {
      const slackError = err?.data?.error;
      if (slackError !== 'message_not_found' && slackError !== 'cant_update_message') {
        console.error('[queue] failed to update queue message:', err);
      }
      // fall through to post a fresh message
      if (slackError === 'message_not_found' || slackError === 'cant_update_message') {
        await redis.del(lastMessageKey);
      }
    }
  }

  const result = await client.chat.postMessage({
    channel,
    blocks,
    text: 'Queue',
  });

  if (result?.ts) {
    await redis.set(lastMessageKey, result.ts);
  } else {
    await redis.del(lastMessageKey);
  }

  return result;
}

/* ------------ Notify when first-in-line changes ------------ */
async function firstUser(teamId: string, channelId: string) {
  await pruneStaleQueueEntries(teamId, channelId);
  const key = keyFor(teamId, channelId);
  const users = await redis.zrange(key, 0, 0);
  return users[0] ?? null;
}

async function notifyNowFirst({
  client,
  channelId,
  userId,
  alsoDM = process.env.NOTIFY_DM === 'true',
}: {
  client: any;
  channelId: string;
  userId: string;
  alsoDM?: boolean;
}) {
  // Channel mention
  await client.chat.postMessage({
    channel: channelId,
    text: `<@${userId}> you're now first in the deploy queue!`,
  });

  // Optional DM
  if (alsoDM) {
    const im = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: im.channel.id,
      text: `Heads up — you're now first in the *deploy queue* for <#${channelId}>.`,
    });
  }
}
/** Wrap a mutating op; if #1 changed, notify the new #1.
 *  Set suppressWhenBeforeNull=true to skip notifying when the queue was empty.
 */
async function withFirstChangeNotify(
  client: any,
  teamId: string,
  channelId: string,
  op: () => Promise<void>,
  opts?: { suppressWhenBeforeNull?: boolean }
) {
  const before = await firstUser(teamId, channelId);
  await op();
  const after = await firstUser(teamId, channelId);

  if (after && after !== before) {
    if (opts?.suppressWhenBeforeNull && !before) {
      return; // queue was empty -> don't ping on first join
    }
    await notifyNowFirst({ client, channelId, userId: after });
  }
}

/* ------------ Slash command: /deploy-queue ------------ */
app.command(
  '/deploy-queue',
  async ({ ack, command, client, respond, body }) => {
    await ack();
    const teamId = body.team_id;
    const channelId = command.channel_id;
    const userId = command.user_id;

    const [sub] = (command.text || '').trim().split(/\s+/);
    const action = (sub || 'show').toLowerCase();

    switch (action) {
      case 'clear': {
        const deleted = await clearQueueMessage(teamId, channelId, client);
        await respond({
          response_type: 'ephemeral',
          text: deleted
            ? 'Removed the current deploy queue message.'
            : 'No deploy queue message to remove.',
        });
        break;
      }
      case 'join': {
        await withFirstChangeNotify(
          client,
          teamId,
          channelId,
          async () => {
            const added = await joinQueue(teamId, channelId, userId);
            await respond({
              response_type: 'ephemeral',
              text: added
                ? 'You joined the queue.'
                : 'You are already in the queue.',
            });
          },
          { suppressWhenBeforeNull: true } // 👈 skip ping if queue was empty
        );
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
        break;
      }

      case 'leave': {
        let removed = false;
        let nextUserId: string | null = null;
        await withFirstChangeNotify(client, teamId, channelId, async () => {
          removed = await leaveQueue(teamId, channelId, userId);
          await respond({
            response_type: 'ephemeral',
            text: removed
              ? 'You left the queue.'
              : 'You were not in the queue.',
          });
          if (removed) {
            nextUserId = await firstUser(teamId, channelId);
          }
        });
        const queueNote = removed
          ? leaveQueueNote(userId, nextUserId)
          : undefined;
        await postOrUpdateQueueView({
          client,
          channel: channelId,
          teamId,
          queueNote,
        });
        break;
      }
      case 'next': {
        // Announce who is up now (the person popped)
        await withFirstChangeNotify(client, teamId, channelId, async () => {
          const nextUser = await popNext(teamId, channelId);
          await client.chat.postMessage({
            channel: channelId,
            text: nextUser ? `Next up: <@${nextUser}>` : 'Queue is empty.',
          });
        });
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
        break;
      }
      case 'show':
      default: {
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
        break;
      }
    }
  }
);

/* ------------ Button actions ------------ */
async function handleAction(
  actionId: 'queue_join' | 'queue_leave' | 'queue_refresh',
  handler: (
    args: SlackActionMiddlewareArgs<BlockAction<ButtonAction>> &
      AllMiddlewareArgs
  ) => Promise<void>
) {
  app.action(actionId, handler);
}

handleAction('queue_join', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team!.id!;
  const channelId = body.channel!.id!;
  const userId = body.user.id;

  await withFirstChangeNotify(
    client,
    teamId,
    channelId,
    async () => {
      await joinQueue(teamId, channelId, userId);
    },
    { suppressWhenBeforeNull: true } // 👈 skip ping if queue was empty
  );

  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

handleAction('queue_leave', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team!.id!;
  const channelId = body.channel!.id!;
  const userId = body.user.id;

  let removed = false;
  let nextUserId: string | null = null;
  await withFirstChangeNotify(client, teamId, channelId, async () => {
    removed = await leaveQueue(teamId, channelId, userId);
    if (removed) {
      nextUserId = await firstUser(teamId, channelId);
    }
  });

  const queueNote = removed
    ? leaveQueueNote(userId, nextUserId)
    : undefined;

  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
    queueNote,
  });
});

handleAction('queue_refresh', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team!.id!;
  const channelId = body.channel!.id!;
  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

/* ------------ Global error logger (handy) ------------ */
app.error(async (err) => {
  console.error('[bolt] app.error:', err);
});

/* ------------ Start ------------ */
(async () => {
  await app.start();
  if (NODE_ENV !== 'test') console.log(`⚡️ Queue app running on ${PORT}`);
})();
