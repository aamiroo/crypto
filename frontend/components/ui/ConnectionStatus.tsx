"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "@/lib/store/marketStore";

const STALE_SEC = 20;

type Phase = "connecting" | "live" | "stale" | "reconnecting";

/** A 1 s tick is needed here: `lastMessageTs` only changes when data arrives, but
 *  "stale" is a claim about the *absence* of data, so the age has to be re-read
 *  from the clock while the store stays quiet. The age lives in state rather than
 *  coming from `Date.now()` during render, so every value in one paint shares an
 *  instant and nothing here depends on which side of a second a re-render lands. */
function usePhase(): { phase: Phase; ageSec: number } {
  const connected = useMarketStore((s) => s.connected);
  const everReceived = useMarketStore((s) => s.lastMessageTs > 0);
  const [ageSec, setAgeSec] = useState(0);

  useEffect(() => {
    const read = () => {
      const ts = useMarketStore.getState().lastMessageTs;
      // -1 until the first frame lands, so the badge can say STALE without
      // claiming a duration it never measured.
      setAgeSec(ts > 0 ? Math.floor((Date.now() - ts) / 1000) : -1);
    };
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, []);

  if (!connected) return { phase: everReceived ? "reconnecting" : "connecting", ageSec };
  if (!everReceived || ageSec >= STALE_SEC) return { phase: "stale", ageSec };
  return { phase: "live", ageSec };
}

const STYLES: Record<Phase, { color: string; label: (a: number) => string; pulse: boolean }> = {
  connecting: { color: "var(--text-muted)", label: () => "CONNECTING", pulse: true },
  live: { color: "var(--success)", label: () => "LIVE", pulse: true },
  stale: { color: "var(--warning)", label: (a) => (a >= 0 ? `STALE ${a}s` : "STALE"), pulse: false },
  reconnecting: { color: "var(--warning)", label: () => "RECONNECTING", pulse: true },
};

export function ConnectionStatus() {
  const { phase, ageSec } = usePhase();
  const s = STYLES[phase];
  return (
    <span
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
      style={{ background: `color-mix(in srgb, ${s.color} 12%, transparent)`, color: s.color }}
      title={phase === "stale"
        ? (ageSec >= 0 ? `No data received for ${ageSec}s` : "No data received yet")
        : "Market data connection"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.pulse ? "pulse-dot" : ""}`} style={{ background: s.color }} />
      {s.label(ageSec)}
    </span>
  );
}
