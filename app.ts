import 'dotenv/config';
import {
  App,
  BlockAction,
  ButtonAction,
  OverflowAction,
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

const QUEUE_REPOST_THRESHOLD_DEFAULT = 5;
const rawQueueRepostThreshold = process.env.QUEUE_REPOST_THRESHOLD;
let QUEUE_REPOST_THRESHOLD: number | null = QUEUE_REPOST_THRESHOLD_DEFAULT;

if (rawQueueMaxAgeHours !== undefined) {
  const parsed = Number(rawQueueMaxAgeHours);
  if (Number.isFinite(parsed)) {
    QUEUE_MAX_AGE_MS = parsed > 0 ? parsed * 60 * 60 * 1000 : null;
  }
}
if (rawQueueRepostThreshold !== undefined) {
  const parsed = Number(rawQueueRepostThreshold);
  if (Number.isFinite(parsed)) {
    if (parsed < 0) QUEUE_REPOST_THRESHOLD = null; // disable if < 0
    else QUEUE_REPOST_THRESHOLD = Math.floor(parsed);
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
redis.on('error', (err) =>
  console.error('[redis] error:', err?.message || err)
);

/* ------------ Bolt App ------------ */
const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: Boolean(SLACK_APP_LEVEL_TOKEN),
  appToken: SLACK_APP_LEVEL_TOKEN,
  port: Number(PORT),
});

/* ------------ Helpers ------------ */
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
  }
}

/* ------------ Message blocks ------------ */
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
          text: 'View queue with `/deploy-queue` and join with `/deploy-queue join`',
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
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Leave' },
          action_id: 'queue_leave',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Refresh' },
          action_id: 'queue_refresh',
        },
        {
          type: 'overflow',
          action_id: 'queue_more',
          options: [
            {
              text: { type: 'plain_text', text: 'Delete message' },
              value: 'delete',
            },
          ],
        },
      ],
    }
  );
  return blocks;
}

function leaveQueueNote(leaverId: string, nextUserId: string | null) {
  return nextUserId
    ? `<@${leaverId}> has left the queue.\n<@${nextUserId}> it is now your turn!`
    : `<@${leaverId}> has left the queue.`;
}

async function queueMessageNeedsRepost({
  client,
  channel,
  ts,
  threshold,
}: {
  client: any;
  channel: string;
  ts: string;
  threshold: number;
}): Promise<boolean> {
  try {
    const res = await client.conversations.history({
      channel,
      oldest: ts,
      inclusive: false, // exclude the queue message itself
      limit: Math.max(1, Math.min(100, threshold + 1)),
    });

    if (!res || (res as any).ok !== true) {
      console.error('[queue] history: unexpected response', res);
      return false;
    }

    const messages = Array.isArray((res as any).messages)
      ? (res as any).messages
      : [];
    const visible = messages.filter(
      (m: any) => m?.type === 'message' && m?.subtype !== 'tombstone'
    );

    return visible.length > threshold;
  } catch (err: any) {
    const code = err?.data?.error || err?.code || err?.message || String(err);
    if (
      code === 'missing_scope' ||
      code === 'not_in_channel' ||
      code === 'not_in_conversation'
    ) {
      console.error(
        '[queue] conversations.history failed:',
        code,
        '→ For public channels add channels:history; for private add groups:history; also ensure the bot is invited.'
      );
    } else {
      console.error('[queue] conversations.history failed:', code);
    }
    return false;
  }
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

  let cachedTs = await redis.get(lastMessageKey);
  const effectiveTs = ts ?? cachedTs ?? undefined;
  let forceNewMessage = false;

  // Decide whether to repost to bottom
  if (
    effectiveTs &&
    QUEUE_REPOST_THRESHOLD !== null &&
    QUEUE_REPOST_THRESHOLD >= 0
  ) {
    const needsRepost = await queueMessageNeedsRepost({
      client,
      channel,
      ts: effectiveTs,
      threshold: QUEUE_REPOST_THRESHOLD,
    });
    if (needsRepost) {
      let deleted = false;
      try {
        await client.chat.delete({ channel, ts: effectiveTs });
        deleted = true;
      } catch (err: any) {
        const code = err?.data?.error;
        if (code === 'message_not_found') {
          deleted = true;
        } else if (code !== 'cant_delete_message') {
          console.error('[queue] chat.delete failed:', code || err);
        }
      }
      if (deleted) {
        await redis.del(lastMessageKey);
        cachedTs = null;
        forceNewMessage = true;
      }
    }
  }

  // Try to update the clicked message in-place first
  if (!forceNewMessage && ts) {
    try {
      await client.chat.update({ channel, ts, blocks, text: 'Queue updated' });
      await redis.set(lastMessageKey, ts);
      return { ts };
    } catch (err: any) {
      const code = err?.data?.error;
      if (code !== 'message_not_found' && code !== 'cant_update_message')
        console.error('[queue] chat.update failed:', code || err);
    }
  }

  // If we have a cached message, try updating it
  if (!forceNewMessage && cachedTs && (ts === undefined || cachedTs !== ts)) {
    try {
      await client.chat.update({
        channel,
        ts: cachedTs,
        blocks,
        text: 'Queue updated',
      });
      await redis.set(lastMessageKey, cachedTs);
      return { ts: cachedTs };
    } catch (err: any) {
      const code = err?.data?.error;
      if (code !== 'message_not_found' && code !== 'cant_update_message')
        console.error('[queue] chat.update (cachedTs) failed:', code || err);
    }
  }

  // Fall back to new message (bottom of channel)
  const result = await client.chat.postMessage({
    channel,
    blocks,
    text: 'Queue',
  });
  const newTs: string | undefined = (result as any)?.ts;
  if (newTs) await redis.set(lastMessageKey, newTs);
  else await redis.del(lastMessageKey);
  return result;
}

/* ------------ Notifications ------------ */
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
  await client.chat.postMessage({
    channel: channelId,
    text: `<@${userId}> you're now first in the deploy queue!`,
  });

  if (alsoDM) {
    const im = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: (im as any).channel.id,
      text: `Heads up — you're now first in the *deploy queue* for <#${channelId}>.`,
    });
  }
}

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
    if (opts?.suppressWhenBeforeNull && !before) return;
    await notifyNowFirst({ client, channelId, userId: after });
  }
}

/* ------------ Slash command ------------ */
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
          { suppressWhenBeforeNull: true }
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
          if (removed) nextUserId = await firstUser(teamId, channelId);
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
      default: {
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
      }
    }
  }
);

/* ------------ Button actions ------------ */
function handleAction(
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
    { suppressWhenBeforeNull: true }
  );

  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

app.action<BlockAction<OverflowAction>>(
  'queue_more',
  async ({ ack, action, body, client, respond }) => {
    await ack();
    const selected = action.selected_option?.value;
    if (selected !== 'delete') return;

    const channelId = body.channel?.id;
    const teamId = body.team?.id;
    const ts = body.message?.ts;
    if (!channelId || !ts) return;

    try {
      await client.chat.delete({ channel: channelId, ts });
      if (teamId) await redis.del(lastMessageKeyFor(teamId, channelId));
      if (respond) {
        await respond({
          response_type: 'ephemeral',
          text: 'Queue message deleted.',
        });
      }
    } catch (err) {
      console.error('[queue] chat.delete failed:', err);
      if (respond) {
        await respond({
          response_type: 'ephemeral',
          text: 'Sorry, I could not delete that message.',
        });
      }
    }
  }
);

handleAction('queue_leave', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team!.id!;
  const channelId = body.channel!.id!;
  const userId = body.user.id;

  let removed = false;
  let nextUserId: string | null = null;
  await withFirstChangeNotify(client, teamId, channelId, async () => {
    removed = await leaveQueue(teamId, channelId, userId);
    if (removed) nextUserId = await firstUser(teamId, channelId);
  });

  const queueNote = removed ? leaveQueueNote(userId, nextUserId) : undefined;
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

/* ------------ Error & startup ------------ */
app.error(async (err) => console.error('[bolt] app.error:', err));

(async () => {
  await app.start();
  if (NODE_ENV !== 'test') console.log(`⚡️ Queue app running on ${PORT}`);
})();
