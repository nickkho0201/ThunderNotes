import type { MessageHeader, MessagesApi } from "../api/browser";
import { messageReference } from "./locator";
import { normalizeMessageSearch, normalizedMessageFields } from "./search";
import { searchMessages, type MessageSearchPage, type MessageSearchResult } from "./platform";

export const MESSAGE_SEARCH_PAGE_LIMIT = 64;
export const MESSAGE_SEARCH_HEADER_LIMIT = 6400;
interface Candidate { header: MessageHeader; signature: string; fields?: string[] }
/** Operation counters for deterministic performance tests; never persisted/sent. */
export interface MessageSearchStats {
  apiQueries: number; pageHits: number; windowVisits: number;
  processedHeaders: number; normalizedFields: number; normalizedQueries: number; matchTests: number;
}
/** A short-lived metadata snapshot. Each replay still spends the same 64 logical
 * windows, so cache hits cannot widen/narrow the reference traversal's coverage. */
export class MessageSearchSession {
  private readonly pages = new Map<string, Promise<MessageSearchPage>>();
  private readonly candidates = new Map<number, Candidate>();
  private byHeader = new WeakMap<MessageHeader, Candidate>();
  private closed = false;
  readonly stats: MessageSearchStats = { apiQueries: 0, pageHits: 0, windowVisits: 0, processedHeaders: 0,
    normalizedFields: 0, normalizedQueries: 0, matchTests: 0 };
  constructor(private readonly api: MessagesApi, private readonly now = Date.now()) {}
  get cacheSize(): { pages: number; headers: number } { return { pages: this.pages.size, headers: this.candidates.size }; }
  dispose(): void { this.closed = true; this.pages.clear(); this.candidates.clear(); this.byHeader = new WeakMap(); }
  private prepare(header: MessageHeader): MessageHeader {
    const signature = JSON.stringify([header.headerMessageId, header.subject, header.author, header.date.getTime(),
      header.recipients, header.ccList, header.bccList]);
    let candidate = this.candidates.get(header.id);
    if (!candidate || candidate.signature !== signature) { candidate = { header, signature }; this.byHeader.set(header, candidate); }
    this.candidates.delete(header.id); this.candidates.set(header.id, candidate);
    if (this.candidates.size > MESSAGE_SEARCH_HEADER_LIMIT) this.candidates.delete(this.candidates.keys().next().value!);
    return candidate.header;
  }
  private matches(header: MessageHeader, needle: string): boolean {
    this.stats.matchTests++;
    if (!needle) return true;
    let candidate = this.byHeader.get(header);
    if (!candidate) { const prepared = this.prepare(header); candidate = this.byHeader.get(prepared)!; }
    if (!candidate.fields) { candidate.fields = normalizedMessageFields(candidate.header); this.stats.normalizedFields += candidate.fields.length; }
    return candidate.fields.some(field => field.includes(needle));
  }
  /** Provisional matches only: never assume the cached corpus is exhaustive. */
  cached(query: string): MessageHeader[] {
    if (this.closed) return [];
    this.stats.normalizedQueries++; const needle = normalizeMessageSearch(query);
    return [...this.candidates.values()].filter(candidate => this.matches(candidate.header, needle)).map(candidate => candidate.header)
      .sort((a, b) => b.date.getTime() - a.date.getTime() || a.id - b.id).slice(0, 50);
  }
  async search(query: string, signal?: AbortSignal): Promise<MessageSearchResult> {
    if (this.closed) throw new DOMException("Closed", "AbortError");
    this.stats.normalizedQueries++;
    return searchMessages(this.api, query, signal, this.now, {
      page: (from, to) => this.page(from, to), matches: (header, needle) => this.matches(header, needle),
    });
  }
  private page(from: number, to: number): Promise<MessageSearchPage> {
    if (this.closed) return Promise.reject(new DOMException("Closed", "AbortError"));
    this.stats.windowVisits++; const key = `${from}:${to}`; const cached = this.pages.get(key);
    if (cached) { this.stats.pageHits++; this.pages.delete(key); this.pages.set(key, cached); return cached; }
    this.stats.apiQueries++;
    const pending = (async () => {
      const page = await this.api.query({ fromDate: new Date(from), toDate: new Date(to), messagesPerPage: 100 });
      let result: MessageSearchPage;
      try {
        if (this.closed) throw new DOMException("Closed", "AbortError");
        this.stats.processedHeaders += page.messages.length;
        result = { full: Boolean(page.id), messages: page.messages.filter(header => messageReference(header)).map(header => this.prepare(header)) };
      } finally { if (page.id) await this.api.abortList(page.id).catch(() => {}); }
      if (this.closed) throw new DOMException("Closed", "AbortError");
      return result;
    })().catch(error => { if (this.pages.get(key) === pending) this.pages.delete(key); throw error; });
    this.pages.set(key, pending);
    if (this.pages.size > MESSAGE_SEARCH_PAGE_LIMIT) this.pages.delete(this.pages.keys().next().value!);
    return pending;
  }
}
