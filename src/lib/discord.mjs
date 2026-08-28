const channelEnvironment = Object.freeze({
  botStatus: 'DISCORD_WEBHOOK_BOT_STATUS',
  migrationFeed: 'DISCORD_WEBHOOK_MIGRATION_FEED',
  decisionLog: 'DISCORD_WEBHOOK_DECISION_LOG',
  paperTrades: 'DISCORD_WEBHOOK_PAPER_TRADES',
  alerts: 'DISCORD_WEBHOOK_ALERTS',
  dailyReports: 'DISCORD_WEBHOOK_DAILY_REPORTS',
  caseStudies: 'DISCORD_WEBHOOK_CASE_STUDIES',
});

export const discordChannels = Object.freeze(Object.keys(channelEnvironment));

export function validateWebhookUrl(value) {
  if (!value) return { valid: false, reason: 'missing' };
  try {
    const url = new URL(value);
    const validHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
    const parts = url.pathname.split('/').filter(Boolean);
    const validPath = parts[0] === 'api' && parts[1] === 'webhooks' && parts.length >= 4;
    if (!validHost || !validPath || url.protocol !== 'https:') {
      return { valid: false, reason: 'not an official Discord webhook URL' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid URL' };
  }
}

export function discordConfiguration(environment = process.env) {
  return Object.fromEntries(Object.entries(channelEnvironment).map(([channel, variable]) => {
    const value = environment[variable]?.trim() ?? '';
    return [channel, { variable, configured: Boolean(value), ...validateWebhookUrl(value) }];
  }));
}

function trim(value, maximum) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

export async function postDiscord(channel, message, options = {}) {
  const variable = channelEnvironment[channel];
  if (!variable) throw new Error(`Unknown Discord channel key: ${channel}`);
  const webhook = process.env[variable]?.trim();
  if (!webhook) return { sent: false, reason: 'not-configured' };
  const validation = validateWebhookUrl(webhook);
  if (!validation.valid) throw new Error(`${variable}: ${validation.reason}`);
  if (options.dryRun) return { sent: false, reason: 'dry-run' };

  const fields = (message.fields ?? []).slice(0, 25).map((field) => ({
    name: trim(field.name, 256),
    value: trim(field.value, 1_024),
    inline: Boolean(field.inline),
  }));
  const payload = {
    username: 'Axiom Forward Lab',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: trim(message.title, 256),
      description: trim(message.description, 4_096),
      color: message.color ?? 0x7c5cff,
      fields,
      timestamp: message.timestamp ?? new Date().toISOString(),
      footer: { text: trim(message.footer ?? 'PAPER RESEARCH — NO LIVE ORDERS', 2_048) },
    }],
  };

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord ${channel} delivery failed with HTTP ${response.status}`);
  return { sent: true };
}

