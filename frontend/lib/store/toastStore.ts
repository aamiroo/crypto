import { create } from "zustand";
import type { Toast, ToastKind } from "@/lib/types";

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, ttlMs?: number) => void;
  dismiss: (id: string) => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, ttlMs = 4000) => {
    const id = `t-${++seq}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, createdAt: Date.now() }] }));
    if (ttlMs > 0) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttlMs);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience accessor usable from non-React modules (alerts, ws client). */
export const toast = (kind: ToastKind, message: string, ttlMs?: number) =>
  useToastStore.getState().push(kind, message, ttlMs);
