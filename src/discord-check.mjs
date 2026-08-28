import { discordConfiguration } from './lib/discord.mjs';

const configuration = discordConfiguration();
const rows = Object.entries(configuration).map(([channel, state]) => ({
  channel,
  variable: state.variable,
  status: state.valid ? 'READY' : state.reason.toUpperCase(),
}));
console.table(rows);

if (rows.some((row) => row.status !== 'READY')) {
  console.error('Discord is not ready. Add newly regenerated webhook URLs to .env. Nothing was transmitted.');
  process.exitCode = 1;
} else {
  console.log(`All ${rows.length} Discord destinations are configured. Nothing was transmitted.`);
}
