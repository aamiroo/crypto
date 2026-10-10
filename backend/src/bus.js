// In-process pub/sub bus. Replaces NATS for single-process deployment.
// Subject shape: "market.<venue>.<symbol>.<channel>"
// Kept intentionally compatible with the NATS subject convention so
// the gateway bridge code is a drop-in if we ever need to scale back to NATS.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(2000);
  }

  /** Publish a JSON-serialisable payload on a subject. */
  pub(subject, data) {
    this.emit(subject, data);
  }
}

export const bus = new Bus();

// Helper: build a NATS-compatible subject string.
export function subject(venue, symbol, channel) {
  return `market.${venue}.${symbol}.${channel}`;
}
