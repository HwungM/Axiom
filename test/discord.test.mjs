import test from 'node:test';
import assert from 'node:assert/strict';
import { discordChannels, discordConfiguration, validateWebhookUrl } from '../src/lib/discord.mjs';

test('the seven agreed Discord destinations are stable', () => {
  assert.deepEqual(discordChannels, [
    'botStatus',
    'migrationFeed',
    'decisionLog',
    'paperTrades',
    'alerts',
    'dailyReports',
    'caseStudies',
  ]);
});

test('only official HTTPS Discord webhook URLs are accepted', () => {
  assert.equal(validateWebhookUrl('https://discord.com/api/webhooks/123/token').valid, true);
  assert.equal(validateWebhookUrl('http://discord.com/api/webhooks/123/token').valid, false);
  assert.equal(validateWebhookUrl('https://example.com/api/webhooks/123/token').valid, false);
});

test('configuration reports missing secrets without exposing them', () => {
  const configuration = discordConfiguration({});
  assert.equal(Object.values(configuration).every((entry) => entry.reason === 'missing'), true);
  assert.equal(JSON.stringify(configuration).includes('/api/webhooks/'), false);
});
