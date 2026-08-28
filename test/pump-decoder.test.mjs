import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePumpSwapEvents } from '../src/lib/pump-decoders.mjs';

const audited67Sell = 'Pi83CqUD3CoGrpFqAAAAAFqQjg8kAAAAAAAAAAAAAAAFbbZn8AAAAAAAAAAAAAAAj3DiSRSsAACzNgmYEQAAAHqNigQAAAAAFAAAAAAAAAA7UwIAAAAAAAUAAAAAAAAAz5QAAAAAAAA/OogEAAAAAByafAQAAAAAlQ7OSv1K+S4g5OrRAiaFL/S3UqEKhknxALxyZr4IRbnreLHlA49J5EfrfV6/xPbO8blaSlc96RcKI9cnlaSE5UsF1ZFpuQTnHxEm1IUEApXfKrDSXKNLVZPMl81N6ju8+xQzCzj8q8CI4AJp4Ejb8pJGCZXImfJ4WBZzVOaWnIGDhHQpLmdalLQ27LCpmIlCMoqD3cYjOAKWEmfFzWEXy6JjF6U7oP1oxMlT7DDw4JuOc2h1HLKBVIbK4+mdCvndrPQLG2GVqGapfOyfg7142gk3vrC0esMUoQ++KXQHSUwAAAAAAAAAAAAAAAAAAAAAXwAAAAAAAABUCwsAAAAAAIgTAAAAAAAAZ0oAAAAAAABvQh4YBAAAAAAAAAAAAAAAARsRqAoijAMA';

test('official event decoder preserves audited 67 reserve and fee integers exactly', () => {
  const [event] = decodePumpSwapEvents({
    context: { slot: 123 },
    value: { signature: 'audited-signature', logs: [`Program data: ${audited67Sell}`] },
  }, { receivedAtMs: 456, receivedSequence: 7 });

  assert.equal(event.side, 'sell');
  assert.equal(event.baseReserveRaw, '189203138900111');
  assert.equal(event.quoteReserveRaw, '75565184691');
  assert.equal(event.virtualQuoteReservesRaw, '17584505455');
  assert.equal(event.baseAmountRaw, '154879823962');
  assert.equal(event.userQuoteAmountRaw, '75274780');
  assert.deepEqual([
    event.lpFeeBasisPoints,
    event.protocolFeeBasisPoints,
    event.coinCreatorFeeBasisPoints,
    event.cashbackFeeBasisPoints,
  ], [20, 5, 0, 95]);
  assert.equal(event.receivedAtMs, 456);
  assert.equal(event.receivedSequence, 7);
});
