import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchMessages, type MessageSearchResult } from "../src/messages/platform.ts";
import { messageReference } from "../src/messages/locator.ts";
import type { MessageHeader, MessagesApi } from "../src/api/browser.ts";
import { MessageSearchSession } from "../src/messages/search-session.ts";

const NOW = 1790942400000;
interface Counts { queries: number; headers: number; normalizations: number; matches: number }
const counts = (): Counts => ({ queries: 0, headers: 0, normalizations: 0, matches: 0 });
function universe(size: number): MessageHeader[] {
  return Array.from({ length: size }, (_, i) => ({ id: i + 1, headerMessageId: `${i + 1}@test`,
    subject: i % 17 === 0 ? 'ООО "СИСТЕМЫ ОХЛАЖДЕНИЯ"' : `Request ${i}`,
    author: i % 29 === 0 ? "Никифоров Антон <a.nikiforov@ogo1.ru>" : `Sender ${i} <sender${i}@mail.test>`,
    recipients: ["Recipient <n.khoruzhy@cooling.systems>", "Other <other@test>"],
    ccList: ["Copy <copy@test>"], bccList: ["Blind <blind@test>"], date: new Date(NOW - i * 3600000) })).reverse();
}
function fake(data: MessageHeader[], metrics = counts()): MessagesApi & { metrics: Counts } {
  return { metrics, async query(q) {
    metrics.queries++;
    const rows = data.filter(m => (!q.fromDate || m.date >= q.fromDate) && (!q.toDate || m.date <= q.toDate));
    const messages = rows.slice(0, 100).map(m => ({ ...m, recipients: m.recipients?.slice() }));
    metrics.headers += messages.length;
    return { messages, id: rows.length > 100 ? `list-${metrics.queries}` : null };
  }, async continueList() { throw new Error("Reference uses bounded windows, not continuation"); }, async abortList() {} };
}
/** Frozen 85a7e48 traversal/matching, independent of the optimized implementation.
 * Keep the 64 logical-window budget and limit fallback, including inclusive overlaps. */
async function referenceSearch(api: MessagesApi, query: string, metrics = counts()): Promise<MessageSearchResult> {
  const normalize = (value: string) => { metrics.normalizations++; return value.normalize("NFC").toLowerCase().trim().replace(/\s+/gu, " "); };
  const matches = (m: MessageHeader) => { metrics.matches++; const needle = normalize(query);
    const recipients = [...new Set([...(m.recipients ?? []), ...(m.ccList ?? []), ...(m.bccList ?? [])])];
    return !needle || [m.subject, m.author, ...recipients].some(value => normalize(value).includes(needle)); };
  const results = new Map<number, MessageHeader>(); let calls = 0, limited = false;
  const visit = async (from: number, to: number): Promise<void> => {
    if (calls >= 64) { limited = true; return; }
    const found = new Map<number, MessageHeader>(); calls++;
    const page = await api.query({ fromDate: new Date(from), toDate: new Date(to), messagesPerPage: 100 });
    const full = Boolean(page.id);
    try { for (const message of page.messages) if (messageReference(message)) found.set(message.id, message); }
    finally { if (page.id) await api.abortList(page.id).catch(() => {}); }
    if (full && to - from > 1) {
      const middle = Math.floor((from + to) / 2); await visit(middle, to);
      if (results.size < 50 && !limited) await visit(from, middle);
      if (limited) for (const message of found.values()) if (matches(message)) results.set(message.id, message);
    } else { limited ||= full; for (const message of found.values()) if (matches(message)) results.set(message.id, message); }
  };
  let to = NOW + 366 * 86400000, span = 30 * 86400000;
  while (results.size < 50 && to > 0 && !limited) { const from = Math.max(0, Math.min(NOW, to) - span); await visit(from, to); to = from; span *= 4; }
  return { messages: [...results.values()].sort((a, b) => b.date.getTime() - a.date.getTime() || a.id - b.id).slice(0, 50), limited };
}
const ids = (result: MessageSearchResult) => result.messages.map(m => m.id);

describe("message search reference profiling", () => {
  for (const size of [300, 3000]) it(`profiles repeated API and normalization work for ${size} synthetic messages`, async t => {
    const data = universe(size); const api = fake(data); const local = counts(); const report: unknown[] = [];
    for (const query of ["", "a", "a.", "a.n", "a.ni", "a.nik", "a.nik", "с", "си", "системы", "cooling.systems", "absent"]) {
      const before = { ...api.metrics, normalizations: local.normalizations, matches: local.matches };
      const expected = await referenceSearch(api, query, local);
      assert.deepEqual(ids(await searchMessages(fake(data), query, undefined, NOW)), ids(expected));
      report.push({ query, queries: api.metrics.queries - before.queries, headers: api.metrics.headers - before.headers,
        normalizations: local.normalizations - before.normalizations, matches: local.matches - before.matches, results: expected.messages.length, limited: expected.limited });
    }
    t.diagnostic(JSON.stringify({ size, reference: report }));
  });
});

describe("equivalent bounded session search and deterministic reuse", () => {
  for (const size of [300, 3000]) it(`preserves reference results while reusing metadata for ${size} messages`, async t => {
    const data = universe(size); const api = fake(data); const session = new MessageSearchSession(api, NOW); const report: unknown[] = [];
    for (const query of ["", "a", "a.", "a.n", "a.ni", "a.nik", "a.nik", "с", "си", "системы", "cooling.systems", "absent"]) {
      const before = { ...session.stats }; const expectedApi = fake(data); const expected = await referenceSearch(expectedApi, query);
      const cached = session.cached(query); const actual = await session.search(query);
      assert.deepEqual(ids(actual), ids(expected)); assert.equal(actual.limited, expected.limited);
      assert.equal(session.stats.windowVisits - before.windowVisits, expectedApi.metrics.queries);
      report.push({ query, queries: session.stats.apiQueries - before.apiQueries, headers: session.stats.processedHeaders - before.processedHeaders,
        fieldNormalizations: session.stats.normalizedFields - before.normalizedFields, queryNormalizations: session.stats.normalizedQueries - before.normalizedQueries,
        pageHits: session.stats.pageHits - before.pageHits, matchTests: session.stats.matchTests - before.matchTests, cachedResults: cached.length });
      assert.ok(session.cacheSize.pages <= 64); assert.ok(session.cacheSize.headers <= 6400);
    }
    assert.ok(api.metrics.queries < 100); t.diagnostic(JSON.stringify({ size, optimized: report })); session.dispose();
  });
  it("cuts progressive API calls and does not repeat normalized-field work", async () => {
    const data = universe(3000); const queries = ["", "a", "a.", "a.n", "a.ni", "a.nik"]; const old = fake(data); const api = fake(data); const session = new MessageSearchSession(api, NOW);
    for (const query of queries) {
      const expected = await referenceSearch(old, query); assert.deepEqual(ids(await session.search(query)), ids(expected));
    }
    const before = { ...session.stats }; await session.search("a.nik");
    assert.equal(session.stats.apiQueries, before.apiQueries); assert.equal(session.stats.normalizedFields, before.normalizedFields);
    assert.ok(api.metrics.queries * 3 < old.metrics.queries); assert.ok(session.stats.processedHeaders * 3 < old.metrics.headers);
  });
  it("handles duplicates, overlaps, all participant fields and Unicode without coverage changes", async () => {
    const data = universe(350); data.push(data[0]!, data[12]!); data[10]!.subject = "E\u0301    spaced";
    const session = new MessageSearchSession(fake(data), NOW);
    for (const query of ["  СиСтЕмЫ  ", "a.niki", "cooling.systems", "никифор", "recipient", "copy@", "blind@", "é spaced", "missing"]) {
      const expected = await referenceSearch(fake(data), query); const actual = await session.search(query);
      assert.deepEqual(ids(actual), ids(expected)); assert.equal(actual.limited, expected.limited);
    }
  });
  it("keeps the same pathological identical-date 64-window fallback", async () => {
    const data = universe(300); for (const header of data) header.date = new Date(NOW);
    const session = new MessageSearchSession(fake(data), NOW);
    for (const query of ["", "a.n", "absent"]) {
      const expected = await referenceSearch(fake(data), query); const actual = await session.search(query);
      assert.deepEqual(ids(actual), ids(expected)); assert.equal(actual.limited, expected.limited);
    }
  });
  it("evicts pages/headers at fixed bounds and clears the session", async () => {
    const data = universe(7000); const session = new MessageSearchSession(fake(data), NOW);
    // Drive exact disjoint windows through the same cache interface as traversal.
    const access = session as unknown as { page(from: number, to: number): Promise<unknown> };
    for (let i = 0; i < 70; i++) await access.page(NOW - (i * 100 + 99) * 3600000, NOW - i * 100 * 3600000);
    assert.deepEqual(session.cacheSize, { pages: 64, headers: 6400 });
    const before = session.stats.apiQueries; await access.page(NOW - 99 * 3600000, NOW); assert.equal(session.stats.apiQueries, before + 1);
    session.dispose(); assert.deepEqual(session.cacheSize, { pages: 0, headers: 0 }); assert.deepEqual(session.cached("a"), []);
    await assert.rejects(session.search("a"), { name: "AbortError" });
  });
  it("shares pending pages across queries and retains useful work after query cancellation", async () => {
    const api = fake(universe(30)); const normal = api.query; let release!: () => void; let first = true;
    api.query = async q => { if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } return normal(q); };
    const session = new MessageSearchSession(api, NOW); const controller = new AbortController();
    const old = session.search("old", controller.signal); const rejected = assert.rejects(old, { name: "AbortError" }); controller.abort();
    const current = session.search("a"); release(); await rejected; const actual = await current;
    assert.deepEqual(ids(actual), ids(await referenceSearch(fake(universe(30)), "a")));
    const before = session.stats.apiQueries; await session.search("a"); assert.equal(session.stats.apiQueries, before);
    assert.ok(session.stats.pageHits > 0);
  });
  it("does not repopulate a closed session from a late API response", async () => {
    let resolve!: (page: { messages: MessageHeader[]; id: string }) => void; const aborted: string[] = [];
    const api: MessagesApi = { query: () => new Promise(done => { resolve = done; }), async continueList() { throw new Error("unused"); }, async abortList(id) { aborted.push(id); } };
    const session = new MessageSearchSession(api, NOW); const search = session.search("a"); const rejection = assert.rejects(search, { name: "AbortError" });
    session.dispose(); resolve({ messages: universe(1), id: "late" }); await rejection;
    assert.deepEqual(session.cacheSize, { pages: 0, headers: 0 }); assert.deepEqual(aborted, ["late"]);
  });
  it("retries failures instead of caching an error as an empty result", async () => {
    const api = fake(universe(10)); const normal = api.query; let failed = false;
    api.query = q => { if (!failed) { failed = true; return Promise.reject(new Error("Temporary")); } return normal(q); };
    const session = new MessageSearchSession(api, NOW); await assert.rejects(session.search("a"));
    assert.deepEqual(ids(await session.search("a")), ids(await referenceSearch(fake(universe(10)), "a")));
  });
  it("cannot repopulate the cache if disposed while native list finalization is pending", async () => {
    let finalized!: () => void; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const api: MessagesApi = { async query() { return { messages: universe(1), id: "finalizing" }; },
      async continueList() { throw new Error("unused"); }, async abortList() { started(); await new Promise<void>(resolve => { finalized = resolve; }); } };
    const session = new MessageSearchSession(api, NOW); const search = session.search("a"); const rejection = assert.rejects(search, { name: "AbortError" });
    await ready; session.dispose(); finalized(); await rejection; assert.deepEqual(session.cacheSize, { pages: 0, headers: 0 });
  });
});

describe("supplementary synthetic latency measurements", () => {
  it("reports API wait versus local work without fragile timing thresholds", async t => {
    const data = universe(3000);
    const delayed = () => {
      const api = fake(data); const query = api.query; let apiMs = 0;
      api.query = async q => { const start = performance.now(); await new Promise(resolve => setTimeout(resolve, 2));
        try { return await query(q); } finally { apiMs += performance.now() - start; } };
      return { api, wait: () => apiMs };
    };
    const baseline = delayed(), optimized = delayed(); const session = new MessageSearchSession(optimized.api, NOW); const report: unknown[] = [];
    for (const query of ["", "a.nik", "a.nik"]) {
      let start = performance.now(); const oldWait = baseline.wait(), oldCalls = baseline.api.metrics.queries;
      const expected = await referenceSearch(baseline.api, query); const oldMs = performance.now() - start;
      const cachedStart = performance.now(); session.cached(query); const cachedMs = performance.now() - cachedStart;
      start = performance.now(); const newWait = optimized.wait(), newCalls = optimized.api.metrics.queries;
      const actual = await session.search(query); const newMs = performance.now() - start;
      assert.deepEqual(ids(actual), ids(expected));
      report.push({ query, reference: { queries: baseline.api.metrics.queries - oldCalls, totalMs: +oldMs.toFixed(2), apiWaitMs: +(baseline.wait() - oldWait).toFixed(2) },
        optimized: { queries: optimized.api.metrics.queries - newCalls, totalMs: +newMs.toFixed(2), apiWaitMs: +(optimized.wait() - newWait).toFixed(2), firstCachedMs: +cachedMs.toFixed(2) } });
    }
    t.diagnostic(JSON.stringify({ syntheticApiDelayMs: 2, timings: report }));
  });
});
