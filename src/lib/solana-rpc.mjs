import { sleep } from './http.mjs';

const endpoints = [
  process.env.SOLANA_RPC_URL,
  'https://solana-rpc.publicnode.com',
  'https://solana.api.onfinality.io/public',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);

let cursor = 0;

export async function solanaRpc(method, params, attempts = 7) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const endpoint = endpoints[cursor++ % endpoints.length];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
      return payload.result;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(Math.min(2_500, 150 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function getConfirmedTransaction(signature) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const transaction = await solanaRpc('getTransaction', [signature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }], 3);
    if (transaction) return transaction;
    await sleep(250 * (attempt + 1));
  }
  throw new Error(`Confirmed transaction unavailable: ${signature}`);
}

