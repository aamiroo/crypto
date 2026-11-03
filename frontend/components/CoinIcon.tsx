"use client";

import { useState, useMemo } from "react";
import { baseAsset } from "@/lib/utils/symbol";

/** 32px colour PNGs keyed by the lowercased ticker. The host this pointed at
 *  before (`gh/nicehash/…`) resolves to nothing, so every icon errored and the
 *  terminal ran entirely on its fallback tiles. This set covers the long-standing
 *  majors; anything newer or renamed keeps the monogram. */
const ICON_BASE = "https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color";

const SIZES = { xs: 14, sm: 18, md: 22, lg: 28, xl: 36 };

interface CoinIconProps {
  symbol: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/** Every caller prints the asset name next to the icon, so the mark is
 *  decorative: a tile spelling "SO" in front of "SOL" reads as a glitch.
 *
 *  The monogram is the base layer and the logo is painted over it once it
 *  arrives, never the other way round. A watchlist row is 24px tall and most
 *  assets have no entry in this icon set, so waiting on the network first left
 *  a blank gap in the column for as long as the request took — which is what
 *  made the list look like a mockup of a list. */
export function CoinIcon({ symbol, size = "md", className = "" }: CoinIconProps) {
  const [loaded, setLoaded] = useState(false);
  const asset = useMemo(() => baseAsset(symbol), [symbol]);
  const px = SIZES[size];

  return (
    <span
      aria-hidden
      className={`relative inline-flex flex-shrink-0 items-center justify-center rounded-[4px] font-semibold leading-none ${className}`}
      style={{
        width: px,
        height: px,
        fontSize: Math.max(8, px * 0.5),
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
      }}
    >
      {asset.slice(0, 1)}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ICON_BASE}/${asset.toLowerCase()}.png`}
        alt=""
        width={px}
        height={px}
        className="absolute inset-0 h-full w-full rounded-[3px]"
        style={{ opacity: loaded ? 1 : 0 }}
        onLoad={() => setLoaded(true)}
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}
