import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM, createPumpDecoders } from './pump-decoders.mjs';
import { sleep } from './http.mjs';

export class LiveChain {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.websocketUrls = [
      process.env.SOLANA_WS_URL,
      'wss://solana-rpc.publicnode.com',
      'wss://solana.drpc.org',
      'wss://api.mainnet-beta.solana.com',
    ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
    this.websocketCursor = 0;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.requestKinds = new Map([[1, 'pump'], [2, 'pumpswap']]);
    this.subscriptionKinds = new Map();
    this.pumpQueue = Promise.resolve();
    this.pumpSwapQueue = Promise.resolve();
    this.receivedSequence = 0;
  }

  async start() {
    this.decoders = await createPumpDecoders();
    while (!this.stopping) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.handlers.onError?.(error);
        await sleep(Math.min(10_000, 1_000 * 2 ** this.reconnectAttempts++));
      }
    }
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const websocketUrl = this.websocketUrls[this.websocketCursor++ % this.websocketUrls.length];
      const socket = new WebSocket(websocketUrl);
      this.socket = socket;
      let opened = false;
      let settled = false;
      const rejectInitial = (error) => {
        if (!opened && !settled) {
          settled = true;
          reject(error);
        }
      };
      const initial = setTimeout(() => {
        socket.terminate();
        rejectInitial(new Error(`Solana WebSocket connection timed out: ${websocketUrl}`));
      }, 15_000);
      socket.once('open', () => {
        clearTimeout(initial);
        opened = true;
        settled = true;
        this.reconnectAttempts = 0;
        socket.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }],
        }));
        socket.send(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
          params: [{ mentions: [PUMPSWAP_PROGRAM] }, { commitment: 'confirmed' }],
        }));
        this.handlers.onHealth?.({ type: 'connected', at: Date.now(), endpoint: websocketUrl });
        resolve();
      });
      socket.on('message', (data) => {
        const receivedAtMs = Date.now();
        const receivedSequence = ++this.receivedSequence;
        let message;
        try { message = JSON.parse(data.toString()); } catch (error) {
          this.handlers.onError?.(error);
          return;
        }
        if (message.id && message.result != null) {
          const kind = this.requestKinds.get(message.id);
          if (kind) this.subscriptionKinds.set(message.result, kind);
          return;
        }
        const kind = this.subscriptionKinds.get(message.params?.subscription);
        const queueName = kind === 'pumpswap' ? 'pumpSwapQueue' : 'pumpQueue';
        this[queueName] = this[queueName]
          .then(() => this.handleMessage(message, { receivedAtMs, receivedSequence, kind }))
          .catch((error) => this.handlers.onError?.(error));
      });
      socket.on('error', (error) => {
        clearTimeout(initial);
        if (opened) this.handlers.onError?.(error);
        rejectInitial(new Error(`${error.message} (${websocketUrl})`));
      });
      socket.on('close', () => {
        clearTimeout(initial);
        if (opened) {
          this.handlers.onHealth?.({ type: 'disconnected', at: Date.now(), endpoint: websocketUrl });
          if (!this.stopping) this.scheduleReconnect();
        } else {
          rejectInitial(new Error(`Solana WebSocket closed before connecting: ${websocketUrl}`));
        }
      });
    });
  }

  async handleMessage(message, received) {
    const notification = message.params?.result;
    const kind = received.kind;
    if (!notification || notification.value?.err || !kind) return;
    if (kind === 'pumpswap') {
      for (const event of this.decoders.decodePumpSwapEvents(notification, received)) {
        await this.handlers.onSwap?.(event);
      }
      return;
    }
    const logs = notification.value?.logs ?? [];
    if (!logs.some((log) => /Program log: Instruction: Migrate(?:V2)?$/i.test(log))) return;
    const signature = notification.value.signature;
    const migration = await this.decoders.resolveMigration(signature);
    if (migration) await this.handlers.onMigration?.(migration);
  }

  scheduleReconnect() {
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++);
    setTimeout(() => this.connect().catch((error) => {
      this.handlers.onError?.(error);
      if (!this.stopping) this.scheduleReconnect();
    }), delay).unref();
  }

  stop() {
    this.stopping = true;
    this.socket?.close();
  }
}
