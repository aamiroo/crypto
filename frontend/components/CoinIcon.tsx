"use client";

import { useState, useMemo } from "react";
import { baseAsset } from "@/lib/utils/symbol";

const ICON_BASE = "https://cdn.jsdelivr.net/gh/nicehash/cryptocurrency-icons@master/32/color";

/** Map of base assets to CDN icon file names */
const ASSET_MAP: Record<string, string> = {
  BTC: "btc", ETH: "eth", SOL: "sol", XRP: "xrp", DOGE: "doge",
  ADA: "ada", DOT: "dot", AVAX: "avax", MATIC: "matic", LTC: "ltc",
  LINK: "link", UNI: "uni", AAVE: "aave", ATOM: "atom", NEAR: "near",
  FIL: "fil", ICP: "icp", APT: "apt", ARB: "arb", OP: "op",
  TRX: "trx", SEI: "sei", WLD: "wld", PEPE: "pepe", SHIB: "shib",
  FET: "fet", SAND: "sand", MANA: "mana", BNB: "bnb", FTM: "ftm",
  CRV: "crv", MKR: "mkr", GRT: "grt", MINA: "mina", EOS: "eos",
  VET: "vet", XLM: "xlm", XTZ: "xtz", KAVA: "kava", EGLD: "egld",
};

const FALLBACK_COLORS = [
  "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
  "#06b6d4", "#84cc16", "#6366f1", "#ef4444", "#22d3ee",
];

/** Deterministic pick from FALLBACK_COLORS for coins with no known logo, so a
 *  symbol keeps the same tile across renders instead of reshuffling. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const SIZES = { xs: 14, sm: 18, md: 22, lg: 28, xl: 36 };

interface CoinIconProps {
  symbol: string;
  size?: keyof typeof SIZES;
  className?: string;
}

export function CoinIcon({ symbol, size = "md", className = "" }: CoinIconProps) {
  const [error, setError] = useState(false);
  const asset = useMemo(() => baseAsset(symbol), [symbol]);
  const px = SIZES[size];
  const key = ASSET_MAP[asset] ?? asset.toLowerCase();

  if (error) {
    const bg = FALLBACK_COLORS[hashStr(asset) % FALLBACK_COLORS.length];
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full font-bold ${className}`}
        style={{ width: px, height: px, fontSize: px * 0.45, background: bg, color: "#fff", flexShrink: 0 }}
      >
        {asset.slice(0, 2)}
      </span>
    );
  }

  return (
    // Remote icon CDN with local fallback on error; next/image would proxy/optimize
    // arbitrary hosts for tiny icons, which costs more than it saves here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${ICON_BASE}/${key}.png`}
      alt={asset}
      width={px}
      height={px}
      className={`flex-shrink-0 ${className}`}
      style={{ width: px, height: px }}
      onError={() => setError(true)}
      loading="lazy"
    />
  );
}
