import { discordChannels, postDiscord } from './lib/discord.mjs';

if (!process.argv.includes('--send')) {
  console.error('Refusing to transmit. Re-run with: npm run discord:smoke -- --send');
  process.exitCode = 1;
} else {
  for (const channel of discordChannels) {
    await postDiscord(channel, {
      title: `Connection verified: ${channel}`,
      description: 'This channel is connected to Axiom Forward Lab. Future messages here will remain paper-research events until live trading is explicitly designed and separately authorized.',
      color: 0x45e6b0,
    });
    console.log(`${channel}: sent`);
  }
}

