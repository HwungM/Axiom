import { LiveChain } from '../lib/live-chain.mjs';

let count = 0;
const chain = new LiveChain({
  onPumpTrade: async (event) => {
    count += 1;
    console.log(JSON.stringify(event));
    if (count >= 3) {
      chain.stop();
      process.exit(0);
    }
  },
  onError: (error) => console.error(error?.stack ?? error),
});

setTimeout(() => {
  chain.stop();
  console.error('Timed out before receiving three Pump TradeEvents');
  process.exit(1);
}, 30_000).unref();

await chain.start();
await new Promise(() => {});
