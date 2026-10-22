import { create } from "zustand";
import type { AlertCondition, PriceAlert } from "@/lib/types";
import { loadPersisted, persist, isRecord } from "@/lib/store/persist";

const KEY = "ct_alerts";

interface AlertsStore {
  alerts: PriceAlert[];
  addAlert: (a: Omit<PriceAlert, "id" | "createdAt">) => PriceAlert;
  removeAlert: (id: string) => void;
  clearTriggered: () => void;
  clearAll: () => void;
  /**
   * Evaluate every active alert for `symbol` against `price`.
   * Returns alerts that just fired and updates their state.
   */
  evaluate: (symbol: string, price: number) => PriceAlert[];
}

let seq = 0;

/** Alerts are evaluated on every ticker tick, so an entry without a symbol, a
 *  known condition or a finite price has to go — the rest of the list works. */
function sanitizeAlerts(value: unknown): PriceAlert[] {
  if (!Array.isArray(value)) return [];
  const out: PriceAlert[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { id, symbol, condition, price } = item;
    if (typeof id !== "string" || !id) continue;
    if (typeof symbol !== "string" || !symbol) continue;
    if (condition !== "above" && condition !== "below") continue;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    out.push({
      id,
      symbol,
      condition,
      price,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      ...(typeof item.triggeredAt === "number" ? { triggeredAt: item.triggeredAt } : {}),
      ...(typeof item.triggeredPrice === "number" ? { triggeredPrice: item.triggeredPrice } : {}),
    });
  }
  return out;
}

export const useAlertsStore = create<AlertsStore>((set, get) => ({
  alerts: sanitizeAlerts(loadPersisted<unknown>(KEY, [])),

  addAlert: (a) => {
    const alert: PriceAlert = { ...a, id: `a-${Date.now()}-${++seq}`, createdAt: Date.now() };
    set((s) => {
      const alerts = [...s.alerts, alert];
      persist(KEY, alerts);
      return { alerts };
    });
    return alert;
  },

  removeAlert: (id) =>
    set((s) => {
      const alerts = s.alerts.filter((a) => a.id !== id);
      persist(KEY, alerts);
      return { alerts };
    }),

  clearTriggered: () =>
    set((s) => {
      const alerts = s.alerts.filter((a) => !a.triggeredAt);
      persist(KEY, alerts);
      return { alerts };
    }),

  clearAll: () => {
    persist(KEY, []);
    set({ alerts: [] });
  },

  evaluate: (symbol, price) => {
    if (!Number.isFinite(price) || price <= 0) return [];
    const { alerts } = get();
    const fired: PriceAlert[] = [];
    let changed = false;
    const next = alerts.map((a) => {
      if (a.symbol !== symbol || a.triggeredAt) return a;
      const hit = a.condition === "above" ? price >= a.price : price <= a.price;
      if (!hit) return a;
      changed = true;
      const updated: PriceAlert = { ...a, triggeredAt: Date.now(), triggeredPrice: price };
      fired.push(updated);
      return updated;
    });
    if (changed) {
      persist(KEY, next);
      set({ alerts: next });
    }
    return fired;
  },
}));

/** Compact UI glyph for a condition. Uses ≥ / ≤ (not > / <) to mirror the
 *  inclusive `>=` / `<=` trigger in `evaluate`, so the label matches reality. */
export function conditionLabel(c: AlertCondition): string {
  return c === "above" ? "≥" : "≤";
}
