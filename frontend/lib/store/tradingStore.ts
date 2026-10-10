import { create } from "zustand";
import type { PaperOrder, Position } from "@/lib/types";

interface TradingState {
  orders: PaperOrder[];
  positions: Position[];
  balance: number;       // USDT
  initialBalance: number;

  placeOrder: (order: Omit<PaperOrder, "id" | "createdAt">) => void;
  cancelOrder: (id: string) => void;
  fillOrders: (symbol: string, price: number) => void;
  reset: () => void;
}

const INIT_BALANCE = 100_000;
let orderId = 0;

export const useTradingStore = create<TradingState>((set, get) => ({
  orders: [],
  positions: [],
  balance: INIT_BALANCE,
  initialBalance: INIT_BALANCE,

  placeOrder: (order) => {
    const id = `paper-${++orderId}`;
    const newOrder: PaperOrder = { ...order, id, createdAt: Date.now() };
    // Market orders fill immediately
    if (order.type === "market") {
      const price = parseFloat(order.price);
      const qty = parseFloat(order.qty);
      const cost = price * qty;
      const state = get();
      if (order.side === "buy") {
        if (state.balance < cost) return; // insufficient
        set((s) => ({
          balance: s.balance - cost,
          orders: [...s.orders, { ...newOrder, status: "filled", filledAt: Date.now(), filledPrice: order.price }],
          positions: mergePosition(s.positions, order.symbol, "long", qty, price),
        }));
      } else {
        set((s) => ({
          balance: s.balance + cost,
          orders: [...s.orders, { ...newOrder, status: "filled", filledAt: Date.now(), filledPrice: order.price }],
          positions: mergePosition(s.positions, order.symbol, "short", qty, price),
        }));
      }
    } else {
      set((s) => ({ orders: [...s.orders, newOrder] }));
    }
  },

  cancelOrder: (id) =>
    set((s) => ({
      orders: s.orders.map((o) => (o.id === id ? { ...o, status: "cancelled" as const } : o)),
    })),

  fillOrders: (symbol, price) => {
    const state = get();
    const toFill = state.orders.filter(
      (o) => o.symbol === symbol && o.status === "open" && o.type === "limit"
    );
    if (toFill.length === 0) return;
    let balance = state.balance;
    const updatedOrders = [...state.orders];
    let positions = [...state.positions];

    for (const o of toFill) {
      const p = parseFloat(o.price);
      const q = parseFloat(o.qty);
      const shouldFill = o.side === "buy" ? price <= p : price >= p;
      if (!shouldFill) continue;
      const cost = p * q;
      if (o.side === "buy" && balance < cost) continue;
      balance = o.side === "buy" ? balance - cost : balance + cost;
      const idx = updatedOrders.findIndex((x) => x.id === o.id);
      if (idx >= 0) updatedOrders[idx] = { ...o, status: "filled", filledAt: Date.now(), filledPrice: String(p) };
      positions = mergePosition(positions, symbol, o.side === "buy" ? "long" : "short", q, p);
    }

    set({ balance, orders: updatedOrders, positions });
  },

  reset: () => set({ orders: [], positions: [], balance: INIT_BALANCE, initialBalance: INIT_BALANCE }),
}));

function mergePosition(
  positions: Position[], symbol: string, side: "long" | "short", qty: number, price: number
): Position[] {
  const existing = positions.find((p) => p.symbol === symbol && p.side === side);
  if (existing) {
    const oldQty = parseFloat(existing.qty);
    const oldEntry = parseFloat(existing.avgEntry);
    const newQty = oldQty + qty;
    const avgEntry = (oldEntry * oldQty + price * qty) / newQty;
    return positions.map((p) =>
      p === existing
        ? { ...p, qty: String(newQty), avgEntry: String(avgEntry), margin: String(newQty * avgEntry * 0.1) }
        : p
    );
  }
  return [...positions, { symbol, side, qty: String(qty), avgEntry: String(price), unrealizedPnl: "0", margin: String(qty * price * 0.1) }];
}
