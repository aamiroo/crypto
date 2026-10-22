// In-process pub/sub bus. Replaces NATS for single-process deployment.
// Subject shape: "market.<venue>.<symbol>.<channel>"
// Kept intentionally compatible with the NATS subject convention so
// the gateway bridge code is a drop-in if we ever need to scale back to NATS.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {
  /** Subjects match exactly — there are no NATS `*`/`>` wildcards here — so the
   *  shared shape is a naming convention and every listener still binds the full
   *  subject string it wants. */
  constructor() {
    super();
    // The gateway registers one listener per (venue, symbol, channel); with
    // hundreds of instruments that is several thousand subjects, so the
    // default 11-listener warning is noise rather than a leak signal.
    this.setMaxListeners(0);
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
