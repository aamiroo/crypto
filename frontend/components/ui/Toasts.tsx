"use client";

import type { ReactNode } from "react";
import { useToastStore } from "@/lib/store/toastStore";
import type { ToastKind } from "@/lib/types";
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from "@/components/icons/ToolIcons";

const COLORS: Record<ToastKind, string> = {
  success: "var(--success)",
  error: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--info)",
};

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckIcon size={10} />,
  error: <CloseIcon size={10} />,
  warning: <WarningIcon size={10} />,
  info: <InfoIcon size={10} />,
};

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast-in pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg"
          style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
          role="status"
        >
          <span
            className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
            style={{ background: COLORS[t.kind], color: "#fff" }}
          >
            {ICONS[t.kind]}
          </span>
          <span className="flex-1 leading-snug" style={{ color: "var(--text-secondary)" }}>{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="icon-btn h-4 w-4 flex-shrink-0" aria-label="Dismiss"><CloseIcon size={9} /></button>
        </div>
      ))}
    </div>
  );
}
