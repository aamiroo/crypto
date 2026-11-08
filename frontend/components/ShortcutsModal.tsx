"use client";

import { useUiStore } from "@/lib/store/uiStore";
import { SHORTCUTS } from "@/lib/hooks/useKeyboardShortcuts";
import { CloseIcon } from "@/components/icons/ToolIcons";

export function ShortcutsModal() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-full max-w-md rounded-xl border p-4"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Keyboard Shortcuts</h2>
          <button onClick={() => setOpen(false)} className="icon-btn h-6 w-6" aria-label="Close"><CloseIcon size={13} /></button>
        </div>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {SHORTCUTS.map((s, i) => (
            <div key={`${i}-${s.keys}`} className="flex items-center justify-between gap-3 rounded px-2 py-1.5" style={{ background: "var(--bg-surface)" }}>
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{s.label}</span>
              <kbd className="rounded border px-1.5 py-0.5 text-[10px] font-semibold" style={{ borderColor: "var(--border-strong)", color: "var(--text-primary)", background: "var(--bg-primary)" }}>{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
