import { discordChannels, postDiscord } from './lib/discord.mjs';

if (!process.argv.includes('--send')) {
  console.error('Refusing to transmit. Re-run with: npm run discord:smoke -- --send');
  process.exitCode = 1;
} else {
  const only = process.argv.find((argument) => argument.startsWith('--only='))?.split('=')[1];
  const selectedChannels = only ? discordChannels.filter((channel) => channel === only) : discordChannels;
  if (selectedChannels.length === 0) throw new Error(`Unknown Discord channel key: ${only}`);
  for (const channel of selectedChannels) {
    await postDiscord(channel, {
      title: `Connection verified: ${channel}`,
      description: 'This channel is connected to Axiom Forward Lab. Future messages here will remain paper-research events until live trading is explicitly designed and separately authorized.',
      color: 0x45e6b0,
      threadName: channel === 'caseStudies' ? 'Connection check' : undefined,
    });
    console.log(`${channel}: sent`);
  }
}
