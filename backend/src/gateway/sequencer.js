export class Sequencer {
  constructor() { this.seqs = new Map(); }

  next(channel, symbol, interval) {
    const key = topicKey(channel, symbol, interval);
    const v = (this.seqs.get(key) || 0) + 1;
    this.seqs.set(key, v);
    return v;
  }
}

/** Must match the client's topicKey (frontend/lib/ws/client.ts). */
function topicKey(channel, symbol, interval) {
  return interval ? `${channel}:${symbol}:${interval}` : `${channel}:${symbol}`;
}
