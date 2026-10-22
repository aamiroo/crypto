export class Sequencer {
  /** Counters live only for this process: a restart resumes at 1, and that gap is
   *  absorbed by the client's resubscribe-on-mismatch path rather than by state
   *  carried over from the previous run. */
  constructor() { this.seqs = new Map(); }

  /** One counter per topic key, so a seq is only comparable with other seqs of the
   *  same channel+symbol+interval — that is what makes `seq !== prev + 1` a sound
   *  gap test on the client. */
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
