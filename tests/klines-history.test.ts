import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createKlinesStore } from "../backend/src/gateway/klinesStore.js";
import { createKlineCrawler, CRAWL_PAGE } from "../backend/src/gateway/klineCrawler.js";

/**
 * M5b: deep history, gathered a page at a time and kept on disk.
 *
 * The venue answers at most 1000 candles per request and refuses this host from
 * time to time, so what has to be proven is not "did we get candles" but "did
 * the pages join without a duplicate or a hole", "did a 403 cost us the cursor",
 * "does a restart continue or start over", and "does RAM stay bounded while the
 * disk keeps the depth".
 */

const silentLogger = { info() {}, warn() {}, error() {} };
const MIN = 60_000;
/** Anchored to the hour so a bar's own span is never in doubt, and far enough in
 *  the past that no fixture can be mistaken for the future. */
const BASE = Math.floor(1_700_000_000_000 / MIN) * MIN;
/** The same anchor on the hour grid, for the windows that are not 1 m: an hourly
 *  bar opens at 00 minutes, and a bar that does not is rejected as malformed. */
const HOUR = Math.floor(1_700_000_000_000 / 3600e3) * 3600e3;
/** New end of a window that has to still count as reaching the present. */
const NOW = Math.floor(Date.now() / MIN) * MIN;

let seq = 0;
/** Each store gets its own window directory, so no test can read another's files. */
function mirror(tag: string) {
  seq += 1;
  return join(tmpdir(), `ct-hist-${process.pid}-${seq}-${tag}.json`);
}

function store(tag: string, opts: { hotWindows?: number; depthTargets?: Record<string, number> } = {}) {
  return createKlinesStore({ file: mirror(tag), logger: silentLogger, ...opts });
}

function candleAt(openTime: number) {
  return {
    interval: "1m", openTime, closeTime: openTime + MIN - 1,
    open: "1", high: "2", low: "0.5", close: "1.5", volume: "3", closed: true,
  };
}
/** A bar `n` minutes before the present: what a restored window needs to still
 *  be allowed to answer a "what is recent" read. */
function recent(n: number) {
  return candleAt(NOW - n * MIN);
}

/** Ascending run of `count` candles ending at `endOpen` (inclusive). */
function run(count: number, endOpen: number) {
  return Array.from({ length: count }, (_, i) => candleAt(endOpen - (count - 1 - i) * MIN));
}

/** `count` candles ending at the present. A window the crawl is allowed to
 *  *finish*: a gap is measured against now, so the same twenty bars parked in
 *  2023 are a window with three years of market missing in front of it, and the
 *  crawl's job is now to refuse to call that complete. */
function liveRun(count: number) {
  return run(count, NOW);
}

/** Floor a requested `end` onto a bar boundary: Bybit never returns a candle
 *  that opens after the `end` it was given, and a fixture that ignores that
 *  would hand the store candles that do not exist. */
function alignDown(t: number) {
  return BASE + Math.floor((t - BASE) / MIN) * MIN;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000, what = "condition") {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * A stand-in for the gateway's fetcher, answering the way Bybit's kline REST
 * does — at most `limit` bars, newest at or before `endTime`, aligned to the
 * interval — out of a fixed history the test owns. It never invents a candle:
 * the crawl sees exactly the range the fixture holds.
 */
function venue(history: { from?: number; until?: number } = {}) {
  const from = history.from ?? BASE;
  const lastOpen = history.until ?? NOW;
  const calls: { limit: number; endTime: number | null }[] = [];
  return {
    calls,
    async fetchPage(_sym: string, _iv: string, limit: number, endTime: number | null) {
      calls.push({ limit, endTime });
      const end = alignDown(endTime === null || endTime === undefined ? lastOpen : Math.min(endTime, lastOpen));
      const count = Math.max(0, Math.min(limit, Math.floor((end - from) / MIN) + 1));
      return { data: count === 0 ? [] : run(count, end), source: "venue" };
    },
  };
}

/* ── the crawl ─────────────────────────────────────────────────────────── */

test("crawl: 1000-candle pages join with no duplicated boundary and no hole", async () => {
  const s = store("walk", { depthTargets: { "1m": 4000 } });
  // What the client's own first page landed: the newest 1000 bars, up to now.
  s.remember("BTCUSDT", "1m", liveRun(1000));
  const v = venue();
  const c = createKlineCrawler({ store: s, fetchPage: v.fetchPage, logger: silentLogger, gapMs: 5 });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "complete", 4000, "the depth target");
    assert.equal(v.calls.length, 3, "one page per step, three to reach the target");
    assert.equal(v.calls[0]!.endTime, NOW - 999 * MIN - 1, "the first page starts one ms before the oldest bar held");
    assert.equal(v.calls[1]!.endTime, NOW - 1999 * MIN - 1, "the next from where the last one ended");
    assert.equal(v.calls[2]!.endTime, NOW - 2999 * MIN - 1);
    assert.ok(v.calls.every((call) => call.limit === CRAWL_PAGE), "each page is the venue's own 1000 ceiling");

    const all = s.candlesBefore("BTCUSDT", "1m", NOW, 4000)!;
    assert.equal(all.length, 4000);
    assert.equal(new Set(all.map((k) => k.openTime)).size, 4000, "no bar is held twice");
    assert.equal(all[all.length - 1]!.openTime - all[0]!.openTime, 3999 * MIN, "and no bar is missing between them");
    assert.equal(s.progress("BTCUSDT", "1m").venueBars, 4000, "every one of them came from the venue");
    assert.equal(s.progress("BTCUSDT", "1m").gap, null, "a window this deep is also this unbroken");
  } finally { c.stop(); }
});

test("crawl: it stops asking once the depth target is met", async () => {
  const s = store("target", { depthTargets: { "1m": 30 } });
  s.remember("BTCUSDT", "1m", liveRun(20));
  const v = venue({ from: NOW - 99 * MIN, until: NOW });
  const c = createKlineCrawler({ store: s, fetchPage: v.fetchPage, logger: silentLogger, page: 10, gapMs: 5 });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "complete", 3000, "the window to complete");
    assert.equal(v.calls.length, 1, "one page takes it from 20 bars to the 30 it asked for");
    assert.equal(s.progress("BTCUSDT", "1m").bars, 30);
    assert.equal(c.trigger("BTCUSDT", "1m"), false, "a complete window is not crawled again");
    await sleep(30);
    assert.equal(v.calls.length, 1, "and no scheduled step fires either");
  } finally { c.stop(); }
});

test("crawl: a venue page that ends the range is history, and is recorded as such", async () => {
  const s = store("ended");
  s.remember("BTCUSDT", "1m", liveRun(12));
  // Eleven bars older than the window holds and nothing older than them: the
  // fixture's whole range is twenty-three minutes, ending at the present.
  const v = venue({ from: NOW - 22 * MIN, until: NOW });
  const c = createKlineCrawler({ store: s, fetchPage: v.fetchPage, logger: silentLogger, page: 10, gapMs: 5 });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "exhausted", 3000, "the fixture's whole history to be walked");
    const after = s.progress("BTCUSDT", "1m");
    assert.equal(after.bars, 23, "the twelve held, then a full page of ten, then the last bar standing");
    assert.equal(v.calls.length, 2);
    assert.equal(after.nextRetryAt, 0, "an ended range has no next attempt to schedule");
    assert.ok(after.exhaustedAt > 0, "and when it ended is recorded, separate from how deep we are");
    assert.equal(c.trigger("BTCUSDT", "1m"), false, "nothing asks that pair again");
    await sleep(40);
    assert.equal(v.calls.length, 2, "ended means ended: no third page, no retry storm");
  } finally { c.stop(); }
});

test("crawl: a refusal is a wait, never the end of history", async () => {
  const s = store("refused");
  s.remember("BTCUSDT", "1m", liveRun(12));
  const before = s.progress("BTCUSDT", "1m").cursor;
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 20,
    async fetchPage() { throw new Error("Bybit HTTP 403"); },
  });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "waiting", 3000, "the refusal to be recorded");
    const p = s.progress("BTCUSDT", "1m");
    assert.notEqual(p.status, "exhausted", "a 403 must never be recorded as the end of history");
    assert.equal(p.cursor, before, "the cursor is left exactly where the failed page belongs");
    assert.equal(p.bars, 12, "and nothing is thrown away because the venue said no");
    assert.match(p.lastError ?? "", /403/);
    assert.ok(p.nextRetryAt > Date.now(), "it says when to try again");
    assert.equal(p.attempts, 1);
  } finally { c.stop(); }
});

test("crawl: a lane that will not go out, or our own mirror, teaches nothing", async () => {
  const s = store("no-answer");
  s.remember("BTCUSDT", "1m", liveRun(12));
  const owed = s.progress("BTCUSDT", "1m").cursor;
  let mode = "cool";
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 20,
    async fetchPage(_sym, _iv, limit, endTime) {
      if (mode === "cool") return null; // the fetcher's cool-off refused the probe
      return { data: run(limit, alignDown(endTime as number)), source: "mirror" };
    },
  });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "waiting", 3000, "the refused step to settle");
    assert.equal(s.progress("BTCUSDT", "1m").cursor, owed, "a page that never went out concludes nothing");

    mode = "mirror";
    s.markProgress("BTCUSDT", "1m", { status: "idle", nextRetryAt: 0 });
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").lastError === "venue did not answer", 3000, "the mirror page to be declined");
    const p = s.progress("BTCUSDT", "1m");
    assert.notEqual(p.status, "exhausted", "our own memory is not evidence about history");
    assert.equal(p.bars, 12, "and it is not merged as if it were new depth");
    assert.equal(p.cursor, owed);
  } finally { c.stop(); }
});

test("crawl: after a 403 the next page continues from the preserved cursor", async () => {
  const s = store("resume-after-error", { depthTargets: { "1m": 100 } });
  s.remember("BTCUSDT", "1m", liveRun(40));
  let blocked = true;
  const asked: (number | null)[] = [];
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 20,
    async fetchPage(_sym, _iv, limit, endTime) {
      asked.push(endTime);
      if (blocked) throw new Error("Bybit HTTP 403");
      return { data: run(limit, alignDown(endTime as number)), source: "venue" };
    },
  });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "waiting", 3000, "the refusal");
    blocked = false;
    const owed = s.progress("BTCUSDT", "1m").cursor;
    await until(() => s.progress("BTCUSDT", "1m").bars >= 70, 4000, "the crawl to pick the pages back up");
    assert.ok(asked.includes(owed), `the recovered crawl asks for the owed page (${owed}), not a new range`);
    const all = s.candlesBefore("BTCUSDT", "1m", NOW, 200)!;
    assert.equal(new Set(all.map((k) => k.openTime)).size, all.length, "the retried page did not duplicate a bar");
    assert.equal(all[all.length - 1]!.openTime - all[0]!.openTime, (all.length - 1) * MIN, "and did not skip one");
    assert.equal(s.progress("BTCUSDT", "1m").attempts, 0, "a page that landed clears the failure streak");
  } finally { c.stop(); }
});

test("crawl: a restart resumes from the stored cursor instead of starting over", async () => {
  const file = mirror("restart");
  const a = createKlinesStore({ file, logger: silentLogger, depthTargets: { "1m": 100 } });
  a.remember("ETHUSDT", "1m", Array.from({ length: 40 }, (_, i) => recent(i)));
  const v = venue({ from: NOW - 499 * MIN, until: NOW });
  const ca = createKlineCrawler({ store: a, fetchPage: v.fetchPage, logger: silentLogger, page: 10, gapMs: 5 });
  try {
    ca.trigger("ETHUSDT", "1m");
    await until(() => a.progress("ETHUSDT", "1m").bars >= 60, 3000, "two pages");
    ca.stop();
  } finally { ca.stop(); }
  const held = a.progress("ETHUSDT", "1m");
  await a.flush();

  // The process is gone: a fresh store, freshly loaded from those files.
  const b = await createKlinesStore({ file, logger: silentLogger, depthTargets: { "1m": 100 } }).load();
  const after = b.progress("ETHUSDT", "1m");
  assert.equal(after.bars, held.bars, "the depth already collected is restored, not re-fetched");
  assert.equal(after.cursor, held.cursor, "and so is the point the next page starts at");
  assert.equal(after.pages, held.pages);
  assert.equal(after.status, "idle", "a step that was mid-page when the process died is not crawling any more");
  assert.equal(after.venueBars, held.venueBars, "and how much of it the venue really served");

  const asked: (number | null)[] = [];
  const cb = createKlineCrawler({
    store: b, logger: silentLogger, page: 10, gapMs: 5,
    async fetchPage(_sym, _iv, limit, endTime) {
      asked.push(endTime);
      return { data: run(limit, alignDown(endTime as number)), source: "venue" };
    },
  });
  try {
    cb.trigger("ETHUSDT", "1m");
    await until(() => b.progress("ETHUSDT", "1m").bars >= held.bars + 10, 3000, "the resumed page");
    assert.deepEqual(asked, [held.cursor], "it asks for exactly the page the old process had not got yet");
    const all = b.candlesBefore("ETHUSDT", "1m", NOW, 500)!;
    assert.equal(new Set(all.map((k) => k.openTime)).size, all.length, "and joining it leaves no duplicate");
    assert.equal(all[all.length - 1]!.openTime - all[0]!.openTime, (all.length - 1) * MIN, "nor a hole");
  } finally { cb.stop(); }
});

test("crawl: one window never crawls twice, however many callers want it", async () => {
  const s = store("single", { depthTargets: { "1m": 1000 } });
  s.remember("BTCUSDT", "1m", liveRun(50));
  let inFlight = 0;
  let maxConcurrent = 0;
  const calls: number[] = [];
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 10,
    async fetchPage(_sym, _iv, limit, endTime) {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      calls.push(endTime as number);
      await sleep(20);
      inFlight -= 1;
      return { data: run(limit, alignDown(endTime as number)), source: "venue" };
    },
  });
  try {
    assert.equal(c.trigger("BTCUSDT", "1m"), true);
    for (let i = 0; i < 10; i++) assert.equal(c.trigger("BTCUSDT", "1m"), false, "an already-scheduled window is left alone");
    await until(() => s.progress("BTCUSDT", "1m").bars >= 80, 3000, "several pages");
    assert.equal(maxConcurrent, 1, "never two pages of one window at a time");
    assert.equal(new Set(calls).size, calls.length, "and never the same page twice");
  } finally { c.stop(); }
});

/* ── durability: files, eviction, corruption ───────────────────────────── */

test("store: eviction leaves the bytes on disk and reloads them on the next read", async () => {
  const file = mirror("lru");
  const s = createKlinesStore({ file, logger: silentLogger, hotWindows: 2 });
  for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    s.remember(sym, "1m", Array.from({ length: 50 }, (_, i) => recent(i)));
  }
  // The touch order decides who keeps bytes, not who keeps metadata.
  assert.equal(s.hotCount(), 2, "the hot-window cap holds the RAM");
  assert.equal(s.size(), 3, "while every window is still tracked");
  const cold = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].find((sym) => !s.isLoaded(sym, "1m"))!;
  assert.equal(s.progress(cold, "1m").bars, 50, "a cold window still knows its depth");
  assert.equal(s.candles(cold, "1m", 50)!.length, 50, "and reading it brings the bars back from disk");
  assert.equal(s.isLoaded(cold, "1m"), true);
  assert.equal(s.hotCount(), 2, "without letting a third window stay hot");

  await s.flush();
  const dir = `${file.replace(/\.json$/, "")}.d`;
  assert.deepEqual(readdirSync(dir).sort(), ["BTCUSDT_1m.json.gz", "ETHUSDT_1m.json.gz", "SOLUSDT_1m.json.gz"]);
  assert.ok(readdirSync(dir).every((n) => !n.endsWith(".tmp")), "no half-written file is left behind");

  const back = await createKlinesStore({ file, logger: silentLogger, hotWindows: 2 }).load();
  assert.equal(back.size(), 3);
  assert.equal(back.metrics().bars, 150, "eviction is not deletion: all three windows come back complete");
  assert.equal(back.hotCount(), 2, "and the restored store obeys the same cap");
});

test("store: an active crawl keeps its bytes and its cursor through eviction", () => {
  const s = store("crawling-lru", { hotWindows: 1 });
  s.remember("BTCUSDT", "1m", liveRun(30));
  s.markProgress("BTCUSDT", "1m", { status: "crawling" });
  const cursor = s.progress("BTCUSDT", "1m").cursor;
  s.remember("ETHUSDT", "1m", liveRun(30));
  s.remember("SOLUSDT", "1m", liveRun(30));
  assert.equal(cursor, NOW - 29 * MIN - 1, "one ms before the oldest bar the window holds");
  assert.equal(s.isLoaded("BTCUSDT", "1m"), true, "a window with a page in flight is never the LRU's victim");
  assert.equal(s.progress("BTCUSDT", "1m").cursor, cursor, "so the page merges against the window it belongs to");
  assert.equal(s.hotCount(), 1, "everything else still obeys the cap");
});

test("store: one corrupt window costs one window", async () => {
  const file = mirror("corrupt");
  const a = createKlinesStore({ file, logger: silentLogger });
  a.remember("BTCUSDT", "1m", Array.from({ length: 40 }, (_, i) => recent(i)));
  a.remember("ETHUSDT", "1m", Array.from({ length: 40 }, (_, i) => recent(i)));
  await a.flush();
  const dir = `${file.replace(/\.json$/, "")}.d`;
  writeFileSync(join(dir, "ETHUSDT_1m.json.gz"), Buffer.from("this is not gzip at all"));

  const warnings: string[] = [];
  const b = await createKlinesStore({
    file, logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} },
  }).load();
  assert.equal(b.candles("BTCUSDT", "1m", 500)!.length, 40, "the healthy one is untouched");
  assert.equal(b.progress("ETHUSDT", "1m").bars, 0, "the broken one starts empty");
  assert.ok(warnings.some((w) => /unreadable|skipped/.test(w)), "and says so in the log");

  // Recovery: the next venue page for that pair replaces the junk with real bars.
  b.remember("ETHUSDT", "1m", Array.from({ length: 12 }, (_, i) => recent(i)));
  await b.flush();
  const c = await createKlinesStore({ file, logger: silentLogger }).load();
  assert.equal(c.candles("ETHUSDT", "1m", 500)!.length, 12);
  assert.equal(c.candles("BTCUSDT", "1m", 500)!.length, 40, "and the neighbour is still intact");
});

test("store: a window is rewritten only when its content actually moved", async () => {
  const s = store("write-once");
  s.remember("BTCUSDT", "1m", Array.from({ length: 100 }, (_, i) => recent(i)));
  await s.flush();
  assert.equal(s.metrics().writes, 1, "one page, one file");

  // The stream rewrites the newest bar's values continuously, and the refresh
  // re-answers the same tail page: none of that is new history, so none of it
  // may re-compress a ten-thousand-candle window. The retry clock is excluded
  // for the same reason — a blocked venue moves it every few hundred ms.
  s.remember("BTCUSDT", "1m", Array.from({ length: 100 }, (_, i) => recent(i)));
  s.append("BTCUSDT", "1m", { ...recent(0), close: "999", volume: "999" });
  s.markProgress("BTCUSDT", "1m", { nextRetryAt: Date.now() + 5000, attempts: 1 });
  await s.flush();
  assert.equal(s.metrics().writes, 1, "an unchanged window is never rewritten on a timer");

  // New depth is a real change, and costs exactly one write.
  s.append("BTCUSDT", "1m", recent(101));
  await s.flush();
  assert.equal(s.metrics().writes, 2, "a new bar is a real change, and gets one write");

  // So is a history state the crawl settled into, because that is what a
  // restart has to resume from.
  s.markProgress("BTCUSDT", "1m", { status: "waiting", lastError: "Bybit HTTP 403" });
  await s.flush();
  assert.equal(s.metrics().writes, 3, "a status transition is worth persisting once");
  s.markProgress("BTCUSDT", "1m", { status: "waiting", lastError: "Bybit HTTP 403" });
  await s.flush();
  assert.equal(s.metrics().writes, 3, "and repeating it is not");
});

test("store: a disk that will not take the write is not reported as saved", async () => {
  const dir = join(tmpdir(), `ct-hist-${process.pid}-${++seq}-ro`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const s = createKlinesStore({ dir, logger: silentLogger });
  s.remember("BTCUSDT", "1m", Array.from({ length: 10 }, (_, i) => recent(i)));
  await s.flush();
  assert.equal(s.metrics().writes, 1, "the window starts out savable");
  chmodSync(dir, 0o500); // read and traverse, no writes
  try {
    const warned: string[] = [];
    const t = createKlinesStore({
      dir, logger: { info() {}, warn: (m: string) => warned.push(m), error() {} },
    });
    t.remember("BTCUSDT", "1m", Array.from({ length: 20 }, (_, i) => recent(i)));
    await t.flush();
    assert.equal(t.metrics().writes, 0, "nothing reached disk");
    assert.ok(warned.some((w) => /write failed/.test(w)), "and the failure is logged");
    assert.equal(t.candles("BTCUSDT", "1m", 500)!.length, 20, "the mirror still serves the chart from RAM");
    assert.notEqual(t.progress("BTCUSDT", "1m").status, "complete", "a failed save never looks like a done window");

    chmodSync(dir, 0o700);
    t.append("BTCUSDT", "1m", recent(21));
    await t.flush();
    assert.equal(t.metrics().writes, 1, "the same window is written once the disk answers again");
    assert.equal(existsSync(join(dir, "BTCUSDT_1m.json.gz")), true);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: a window it cannot read is never overwritten with an empty one", async () => {
  const dir = join(tmpdir(), `ct-hist-${process.pid}-${++seq}-unreadable`);
  mkdirSync(dir, { recursive: true });
  const s = createKlinesStore({ dir, logger: silentLogger });
  s.remember("BTCUSDT", "1m", Array.from({ length: 20 }, (_, i) => recent(i)));
  await s.flush();
  assert.equal(s.candles("BTCUSDT", "1m", 500)!.length, 20);

  // The window file is replaced by a directory: the read fails for a reason that
  // says nothing at all about the bytes the window used to hold.
  rmSync(join(dir, "BTCUSDT_1m.json.gz"));
  mkdirSync(join(dir, "BTCUSDT_1m.json.gz"));
  const warned: string[] = [];
  const t = createKlinesStore({ dir, logger: { info() {}, warn: (m: string) => warned.push(m), error() {} } });
  await t.load();
  assert.ok(warned.some((w) => /skipped/.test(w)), "the boot pass says the window could not be read");
  assert.equal(t.candles("BTCUSDT", "1m", 500), null, "and does not serve it as an empty one");

  // A fresh venue page for that pair must not be allowed to shallow it either.
  t.remember("BTCUSDT", "1m", [recent(0)]);
  await t.flush();
  assert.ok(warned.some((w) => /unreadable/.test(w)));
  assert.equal(t.metrics().writes, 0, "so it writes nothing over the path it cannot read");
  assert.equal(statSync(join(dir, "BTCUSDT_1m.json.gz")).isDirectory(), true);

  // Once the path answers again, the same window is writable as normal.
  rmSync(join(dir, "BTCUSDT_1m.json.gz"), { recursive: true });
  t.remember("BTCUSDT", "1m", [recent(1)]);
  await t.flush();
  assert.equal(statSync(join(dir, "BTCUSDT_1m.json.gz")).isFile(), true, "and it recovers without help");
  rmSync(dir, { recursive: true, force: true });
});

/* ── migration from the pre-M5b single-file mirror ─────────────────────── */

test("migration: the legacy mirror is split into windows and kept, not deleted", async () => {
  const file = mirror("mig");
  const dir = `${file.replace(/\.json$/, "")}.d`;
  const legacy = `${file}.legacy`;
  mkdirSync(dir, { recursive: true });
  const tuple = (openTime: number) => [openTime, "1", "2", "0.5", "1.5", "3"];
  // Newest bar first, the order a venue page is written in: the migration owns
  // putting each window back into a sorted run.
  writeFileSync(legacy, JSON.stringify({
    "BTCUSDT|1m": { at: Date.now(), current: true, venue: true, candles: Array.from({ length: 25 }, (_, i) => tuple(NOW - i * MIN)) },
    "ETHUSDT|1m": { at: Date.now(), current: true, venue: true, candles: Array.from({ length: 7 }, (_, i) => tuple(NOW - i * MIN)) },
    "GARBAGE|1m": { at: Date.now(), candles: "not even an array" },
    "OLDUSDT|1m": { at: Date.now() - 9 * 3600e3, current: true, venue: true, candles: Array.from({ length: 5 }, (_, i) => tuple(NOW - (i + 400) * MIN)) },
  }));

  const s = await createKlinesStore({ file, legacyFile: legacy, logger: silentLogger }).load();
  assert.equal(s.candles("BTCUSDT", "1m", 500)!.length, 25, "the old pages are still usable history");
  assert.equal(s.candles("ETHUSDT", "1m", 500)!.length, 7);
  assert.equal(s.venueBacked("BTCUSDT", "1m"), true);
  assert.equal(s.progress("BTCUSDT", "1m").cursor, NOW - 24 * MIN - 1, "and each window knows where a crawl picks up");
  assert.equal(s.candles("OLDUSDT", "1m", 500), null, "a window that no longer reaches the present keeps its depth but loses the live edge");
  assert.equal(s.progress("OLDUSDT", "1m").bars, 5, "and its five bars are still there for a scroll-back to find");
  assert.equal(existsSync(join(dir, "BTCUSDT_1m.json.gz")), true);
  assert.equal(existsSync(join(dir, "GARBAGE_1m.json.gz")), false, "junk in the legacy file is skipped, not migrated");
  assert.equal(existsSync(`${legacy}.migrated`), true, "the original is renamed, never deleted");
  assert.equal(existsSync(legacy), false);

  // Idempotent: a second boot with the retired file still beside it changes
  // nothing and fails nothing.
  const t = await createKlinesStore({ file, legacyFile: legacy, logger: silentLogger }).load();
  assert.equal(t.candles("BTCUSDT", "1m", 500)!.length, 25);
});

test("migration: an existing window file is never shallowed by the legacy mirror", async () => {
  const file = mirror("mig-deep");
  const dir = `${file.replace(/\.json$/, "")}.d`;
  const legacy = `${file}.legacy`;
  const a = createKlinesStore({ file, logger: silentLogger });
  a.remember("BTCUSDT", "1m", Array.from({ length: 60 }, (_, i) => recent(i)));
  await a.flush();
  mkdirSync(dir, { recursive: true });
  writeFileSync(legacy, JSON.stringify({
    "BTCUSDT|1m": { at: Date.now(), current: true, venue: true, candles: [NOW - 5 * MIN, "1", "2", "0.5", "1.5", "3"] },
  }));

  const b = await createKlinesStore({ file, legacyFile: legacy, logger: silentLogger }).load();
  assert.equal(b.candles("BTCUSDT", "1m", 500)!.length, 60, "the deeper per-window file wins");
  assert.equal(existsSync(legacy), true, "and the legacy mirror stays put until the migration is complete");
});

/* ── the gateway's side of it: same lane, same rules ────────────────────── */

test("store: a stale window keeps its history but stops claiming the live edge", async () => {
  const file = mirror("stale");
  const a = createKlinesStore({ file, logger: silentLogger });
  // Three months of 1h bars, plus a live 1m tail that never got a new bar.
  a.remember("BTCUSDT", "1h", Array.from({ length: 30 }, (_, i) => candleAt(HOUR + i * 3600e3)));
  await a.flush();
  const b = await createKlinesStore({ file, logger: silentLogger }).load();
  assert.equal(b.progress("BTCUSDT", "1h").bars, 30, "restored depth");
  assert.equal(b.candles("BTCUSDT", "1h", 500), null, "too old to be the recent window");
  assert.equal(b.candlesBefore("BTCUSDT", "1h", HOUR + 29 * 3600e3, 10)!.length, 10, "but exactly what a scroll-back asks for");
});

/* ── the holes a downtime leaves behind ────────────────────────────────── */

/**
 * A gateway that was down while the market kept printing comes back with a
 * window that is full of holes: the bars either side of the outage are
 * neighbours in the array, so the chart paints a continuous axis over an absent
 * afternoon and a depth count that says "complete". What has to be proven is
 * that the store can see the absence, that the crawl digs for it before it digs
 * for more depth, and that nothing about a hole is ever recorded as the end of
 * history.
 */

test("gap: a window as deep as the policy asked, and hollow in the middle", () => {
  const s = store("hollow", { depthTargets: { "1m": 22 } });
  // Twelve bars up to this minute, ten that stopped an hour ago: the count is at
  // the target, and the chart has a hole in the middle of it.
  s.remember("BTCUSDT", "1m", [...liveRun(12), ...run(10, NOW - 60 * MIN)]);
  const p = s.progress("BTCUSDT", "1m");
  assert.equal(p.bars, 22, "as deep as the policy asked");
  assert.equal(p.gap?.bars, 48, "and forty-eight minutes of market never mirrored");
  assert.equal(p.gap?.from, NOW - 59 * MIN, "the run starts at the first slot after the old group");
  assert.equal(p.gap?.to, NOW - 12 * MIN, "and ends at the last slot before the recent one");
  assert.equal(p.current, true, "the tail it does hold still reaches the present");
});

test("gap: the crawl digs for the hole before it digs for depth", async () => {
  const s = store("fill", { depthTargets: { "1m": 60 } });
  s.remember("BTCUSDT", "1m", [...liveRun(12), ...run(10, NOW - 60 * MIN)]);
  const v = venue({ from: NOW - 4000 * MIN, until: NOW });
  const c = createKlineCrawler({ store: s, fetchPage: v.fetchPage, logger: silentLogger, page: 10, gapMs: 5 });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").gap === null, 3000, "the hole to be filled");
    assert.equal(v.calls[0]!.endTime, NOW - 12 * MIN, "the first ask is the newest end of the hole, not the depth cursor");
    assert.ok(v.calls[0]!.limit < CRAWL_PAGE, "and it asks for the size of the hole, not a full page");

    const all = s.candles("BTCUSDT", "1m", 1000)!;
    assert.equal(new Set(all.map((k) => k.openTime)).size, all.length, "nothing arrived twice");
    assert.equal(all[all.length - 1]!.openTime - all[0]!.openTime, (all.length - 1) * MIN, "and nothing is missing between them");
    await until(() => s.progress("BTCUSDT", "1m").status === "complete", 3000, "the finished window to be labelled");
    assert.equal(s.progress("BTCUSDT", "1m").gap, null, "deep and unbroken, which is the only way to be finished");
  } finally { c.stop(); }
});

test("gap: a frozen tail is healed and the live edge is earned back", async () => {
  const s = store("frozen", { depthTargets: { "1m": 1000 } });
  s.remember("BTCUSDT", "1m", run(20, NOW - 300 * MIN)); // five hours of silence
  const before = s.progress("BTCUSDT", "1m");
  assert.equal(before.current, false, "five hours behind is history, not the live edge");
  assert.equal(before.gap?.bars, 299, "and every minute since the last bar is absent");

  const v = venue({ from: NOW - 1000 * MIN, until: NOW });
  const c = createKlineCrawler({ store: s, fetchPage: v.fetchPage, logger: silentLogger, page: 100, gapMs: 5 });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").current === true, 3000, "the venue to bring the window back to now");
    assert.equal(v.calls[0]!.endTime, NOW - MIN, "the ask is the newest missing minute");
    await until(() => s.progress("BTCUSDT", "1m").gap === null, 4000, "the whole silence to be filled");
    const all = s.candles("BTCUSDT", "1m", 5000)!;
    assert.equal(all[all.length - 1]!.openTime, NOW - MIN, "the heal ends at the newest missing minute — the bar covering now is still forming and belongs to the stream");
    assert.equal(all[all.length - 1]!.openTime - all[0]!.openTime, (all.length - 1) * MIN, "with every bar in between");
  } finally { c.stop(); }
});

test("gap: a short page inside a hole is not the exchange ending history", async () => {
  const s = store("short-middle", { depthTargets: { "1m": 1000 } });
  s.remember("BTCUSDT", "1m", [...liveRun(10), ...run(10, NOW - 60 * MIN)]);
  const before = s.progress("BTCUSDT", "1m").gap!.bars;
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 20,
    // Three bars however many were asked for: a hole answered partially says
    // nothing about where history ends, because the bars after it are already held.
    async fetchPage(_sym, _iv, _limit, endTime) {
      return { data: run(3, alignDown(endTime as number)), source: "venue" };
    },
  });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => (s.progress("BTCUSDT", "1m").gap?.bars ?? 0) < before - 2, 3000, "the hole to shrink");
    const p = s.progress("BTCUSDT", "1m");
    assert.notEqual(p.status, "exhausted", "a partial page inside a hole never ends the range");
    assert.ok(p.gap && p.gap.bars > 0, "and the window stays open while the hole is still there");
  } finally { c.stop(); }
});

test("gap: a hole the venue will not fill is waited out, not spun against", async () => {
  const s = store("unfillable", { depthTargets: { "1m": 1000 } });
  s.remember("BTCUSDT", "1m", [...liveRun(10), ...run(10, NOW - 60 * MIN)]);
  const held = s.progress("BTCUSDT", "1m").bars;
  const asked: (number | null)[] = [];
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 200,
    async fetchPage(_sym, _iv, _limit, endTime) {
      asked.push(endTime);
      // The venue answers with bars the window already holds: the slots inside the
      // hole are not coming, and that is a reason to wait, not a fact about history.
      return { data: run(2, NOW - MIN), source: "venue" };
    },
  });
  try {
    c.trigger("BTCUSDT", "1m");
    await until(() => s.progress("BTCUSDT", "1m").status === "waiting", 3000, "the unfilled page to settle");
    const p = s.progress("BTCUSDT", "1m");
    assert.equal(p.bars, held, "a page of bars we already had deepens nothing");
    assert.equal(p.gap?.bars, 50, "and the hole is still reported, because it is still there");
    assert.ok(p.nextRetryAt > Date.now(), "it says when to ask again instead of asking now");
    assert.equal(p.attempts, 1, "the streak counts a page that fetched nothing");
    assert.match(p.lastError ?? "", /gap/, "with a reason that names the hole");
    await sleep(60);
    assert.equal(asked.length, 1, "and the backoff holds the next probe, not the 5ms crawl gap");
  } finally { c.stop(); }
});

test("gap: a complete label does not outrank a hole in the candles", () => {
  const whole = store("reopen-whole", { depthTargets: { "1m": 22 } });
  whole.remember("BTCUSDT", "1m", liveRun(22));
  whole.markProgress("BTCUSDT", "1m", { status: "complete" });
  const holed = store("reopen-holed", { depthTargets: { "1m": 22 } });
  holed.remember("BTCUSDT", "1m", [...liveRun(12), ...run(10, NOW - 60 * MIN)]);
  holed.markProgress("BTCUSDT", "1m", { status: "complete" });

  const refuse = async () => { throw new Error("never asked"); };
  const a = createKlineCrawler({ store: whole, fetchPage: refuse, logger: silentLogger });
  const b = createKlineCrawler({ store: holed, fetchPage: refuse, logger: silentLogger });
  try {
    assert.equal(a.trigger("BTCUSDT", "1m"), false, "deep and unbroken is finished, and stays finished");
    assert.equal(b.trigger("BTCUSDT", "1m"), true, "the same count with a hole in it is not finished");
  } finally { a.stop(); b.stop(); }
});

test("crawl: a blocked venue is waited out without re-reading the cold window", async () => {
  // The spin this rule exists to stop: while the venue refuses, every pass that
  // cannot go out used to re-arm at crawl speed, and a window whose bytes are on
  // disk paid a read and a gunzip each time to discover nothing had changed.
  const file = mirror("cold-backoff");
  const seed = createKlinesStore({ file, logger: silentLogger, hotWindows: 1 });
  seed.remember("BTCUSDT", "1m", liveRun(30));
  seed.remember("ETHUSDT", "1m", liveRun(30)); // BTC's bytes leave RAM
  await seed.flush();
  const s = await createKlinesStore({ file, logger: silentLogger, hotWindows: 1 }).load();
  assert.equal(s.isLoaded("BTCUSDT", "1m"), false, "the window under test is the cold one");

  let asks = 0;
  const c = createKlineCrawler({
    store: s, logger: silentLogger, page: 10, gapMs: 5, backoffMs: 2_000,
    // What a blocked venue looks like from the crawl: the fetcher fell back to
    // our own memory, which is not a page and not a reason to ask again now.
    async fetchPage() { asks += 1; return { data: [], source: "mirror" }; },
  });
  try {
    assert.equal(c.trigger("BTCUSDT", "1m"), true, "the first demand is allowed through");
    await until(() => s.progress("BTCUSDT", "1m").status === "waiting", 3000, "the first probe to come back");
    const asked = asks;
    const reads = s.metrics().reads;
    assert.equal(c.trigger("BTCUSDT", "1m"), false, "a scheduled retry is not a new demand");
    await sleep(200);
    assert.equal(asks, asked, "and nothing more was asked of the venue while it waits");
    assert.equal(s.metrics().reads, reads, "nor was the cold window read again to find that out");
  } finally { c.stop(); }
});
