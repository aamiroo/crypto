"use client";

import { useEffect, useState } from "react";
import { useMarketStore } from "@/lib/store/marketStore";

const STALE_MS = 20000;

type Phase = "connecting" | "live" | "stale" | "reconnecting";

/** A 1 s tick is needed here: `lastMessageTs` only changes when data arrives, but
 *  "stale" is a claim about the *absence* of data, so the age must be re-read
 *  from the clock even while the store stays quiet. */
function usePhase(): { phase: Phase; ageSec: number } {
  const connected = useMarketStore((s) => s.connected);
  const lastMessageTs = useMarketStore((s) => s.lastMessageTs);
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const age = lastMessageTs ? Date.now() - lastMessageTs : Infinity;
  const ageSec = Number.isFinite(age) ? Math.floor(age / 1000) : -1;

  if (!connected) return { phase: lastMessageTs ? "reconnecting" : "connecting", ageSec };
  if (age > STALE_MS) return { phase: "stale", ageSec };
  return { phase: "live", ageSec };
}

const STYLES: Record<Phase, { color: string; label: (a: number) => string; pulse: boolean }> = {
  connecting: { color: "var(--text-muted)", label: () => "CONNECTING", pulse: true },
  live: { color: "var(--success)", label: () => "LIVE", pulse: true },
  stale: { color: "var(--warning)", label: (a) => `STALE ${a}s`, pulse: false },
  reconnecting: { color: "var(--warning)", label: () => "RECONNECTING", pulse: true },
};

export function ConnectionStatus() {
  const { phase, ageSec } = usePhase();
  const s = STYLES[phase];
  return (
    <span
      className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
      style={{ background: `color-mix(in srgb, ${s.color} 12%, transparent)`, color: s.color }}
      title={phase === "stale" ? `No data received for ${ageSec}s` : "Market data connection"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.pulse ? "pulse-dot" : ""}`} style={{ background: s.color }} />
      {s.label(ageSec)}
    </span>
  );
}
