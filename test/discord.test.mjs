import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { discordChannels, discordConfiguration, validateWebhookUrl } from '../src/lib/discord.mjs';

test('the eight agreed Discord destinations are stable', () => {
  assert.deepEqual(discordChannels, [
    'botStatus',
    'migrationFeed',
    'decisionLog',
    'paperTrades',
    'alerts',
    'dailyReports',
    'caseStudies',
    'pnl',
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

test('PnL notifications are close-only for baseline and size shadows', async () => {
  const source = await fs.readFile(new URL('../src/paper-engine.mjs', import.meta.url), 'utf8');
  const openSection = source.slice(source.indexOf('async executeCandidate'), source.indexOf('mark(position)'));
  assert.equal(openSection.includes("postDiscord('pnl'"), false);
  assert.equal(source.match(/postDiscord\('pnl'/g)?.length, 2);
});

test('closed-trade case studies expose auditable entry and exit market caps', async () => {
  const source = await fs.readFile(new URL('../src/paper-engine.mjs', import.meta.url), 'utf8');
  const caseStudySection = source.slice(source.indexOf("postDiscord('caseStudies'"), source.indexOf('async closeShadowPosition'));
  assert.match(caseStudySection, /Entry average-fill MC/);
  assert.match(caseStudySection, /Exit average-fill MC/);
  assert.match(caseStudySection, /Execution evidence/);
  assert.match(caseStudySection, /MC method/);
});
