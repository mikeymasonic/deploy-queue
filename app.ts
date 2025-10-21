import 'dotenv/config';
import {
  App,
  BlockAction,
  ButtonAction,
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackCommandMiddlewareArgs,
} from '@slack/bolt';
import Redis from 'ioredis';

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APP_LEVEL_TOKEN,
  REDIS_URL,
  PORT = '3000',
} = process.env as Record<string, string>;

// const redis = new Redis(REDIS_URL);
const redis = new Redis(process.env.REDIS_URL!);
redis.on('error', (err) => {
  console.error('[redis] error:', err?.message || err);
});
const NODE_ENV = process.env.NODE_ENV ?? 'development';

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: Boolean(SLACK_APP_LEVEL_TOKEN),
  appToken: SLACK_APP_LEVEL_TOKEN,
  port: Number(PORT),
});

if (
  !process.env.SLACK_SIGNING_SECRET ||
  !process.env.SLACK_BOT_TOKEN ||
  !process.env.SLACK_APP_LEVEL_TOKEN
) {
  console.error(
    'Missing env vars. Needed: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, SLACK_APP_LEVEL_TOKEN'
  );
  process.exit(1);
}

// ---------- Helpers ----------
const keyFor = (teamId: string, channelId: string) =>
  `queue:${teamId}:${channelId}`;

async function joinQueue(teamId: string, channelId: string, userId: string) {
  const key = keyFor(teamId, channelId);
  const now = Date.now();
  // NX avoids duplicates; returns 1 if added, 0 if already present
  const added = await redis.zadd(key, 'NX', now, userId);
  return added === 1;
}

async function leaveQueue(teamId: string, channelId: string, userId: string) {
  const key = keyFor(teamId, channelId);
  const removed = await redis.zrem(key, userId);
  return removed === 1;
}

async function listQueue(teamId: string, channelId: string) {
  const key = keyFor(teamId, channelId);
  return redis.zrange(key, 0, -1); // [userId...]
}

async function popNext(teamId: string, channelId: string) {
  const key = keyFor(teamId, channelId);
  // Use a transaction to get and remove atomically
  while (true) {
    const multi = redis.multi();
    multi.zrange(key, 0, 0);
    const results = await multi.exec();
    const first = (results?.[0]?.[1] as string[] | undefined)?.[0];
    if (!first) return null;
    const removed = await redis.zrem(key, first);
    if (removed === 1) return first;
    // else retry in rare race
  }
}

function queueBlocks(title: string, users: string[]) {
  const textLines = users.length
    ? users.map((u, i) => `${i + 1}. <@${u}>`).join('\n')
    : '_No one is in the queue yet._';

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: textLines } },
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
    },
  ];
}

async function postOrUpdateQueueView({
  client,
  channel,
  teamId,
  title = 'Channel Queue',
  ts,
}: {
  client: any;
  channel: string;
  teamId: string;
  title?: string;
  ts?: string;
}) {
  const users = await listQueue(teamId, channel);
  const blocks = queueBlocks(title, users);
  if (ts) {
    return client.chat.update({ channel, ts, blocks, text: 'Queue updated' });
  }
  return client.chat.postMessage({ channel, blocks, text: 'Queue' });
}

// ---------- Slash command: /queue ----------
app.command(
  '/deploy-queue',
  async ({ ack, command, client, respond, body }) => {
    await ack();
    const teamId = body.team_id;
    const channelId = command.channel_id;
    const userId = command.user_id;

    const [sub, ...rest] = (command.text || '').trim().split(/\s+/);
    const action = (sub || 'show').toLowerCase();

    switch (action) {
      case 'join': {
        const added = await joinQueue(teamId, channelId, userId);
        await respond({
          response_type: 'ephemeral',
          text: added
            ? 'You joined the queue.'
            : 'You are already in the queue.',
        });
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
        break;
      }
      case 'leave': {
        const removed = await leaveQueue(teamId, channelId, userId);
        await respond({
          response_type: 'ephemeral',
          text: removed ? 'You left the queue.' : 'You were not in the queue.',
        });
        await postOrUpdateQueueView({ client, channel: channelId, teamId });
        break;
      }
      case 'next': {
        // Optional: restrict to channel admins or specific roles
        const nextUser = await popNext(teamId, channelId);
        await client.chat.postMessage({
          channel: channelId,
          text: nextUser ? `Next up: <@${nextUser}>` : 'Queue is empty.',
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

// ---------- Button actions ----------
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
  const teamId = body.team?.id!;
  const channelId = body.channel?.id!;
  const userId = body.user.id;
  await joinQueue(teamId, channelId, userId);
  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

handleAction('queue_leave', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team?.id!;
  const channelId = body.channel?.id!;
  const userId = body.user.id;
  await leaveQueue(teamId, channelId, userId);
  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

handleAction('queue_refresh', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team?.id!;
  const channelId = body.channel?.id!;
  await postOrUpdateQueueView({
    client,
    channel: channelId,
    teamId,
    ts: body.message?.ts,
  });
});

// ---------- Start ----------
(async () => {
  await app.start();
  if (NODE_ENV !== 'test') console.log(`⚡️ Queue app running on ${PORT}`);
})();
