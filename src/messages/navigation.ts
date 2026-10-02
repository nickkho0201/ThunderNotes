import type { StorageArea } from "../api/browser";
import { isMessageReference, type MessageReference } from "./locator";

export interface MessageIntent { id: string; reference: MessageReference; createdAt: number }
const INTENT_KEY = "thundernotes.messageNavigation.v1";
/** Acked delivery queue, not a relationship database. Short leases select one
 * page; after a crash or background restart an unacked intent can be retried. */
export class MessageNavigation {
  private tail: Promise<unknown> = Promise.resolve();
  private lease: { id: string; page: string; expires: number } | null = null;
  private memory: MessageIntent[] = [];
  constructor(private readonly storage?: StorageArea, private readonly now = () => Date.now()) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(run, run); this.tail = work.catch(() => {}); return work;
  }
  private async read(): Promise<MessageIntent[]> {
    const raw = this.storage ? (await this.storage.get(INTENT_KEY))[INTENT_KEY] : this.memory;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is MessageIntent => item && typeof item.id === "string" && isMessageReference(item.reference) &&
      typeof item.createdAt === "number" && item.createdAt > this.now() - 86400000).slice(0, 100);
  }
  private async write(intents: MessageIntent[]): Promise<void> {
    if (this.storage) await this.storage.set({ [INTENT_KEY]: intents }); else this.memory = intents;
  }
  enqueue(reference: MessageReference): Promise<void> {
    return this.serial(async () => {
      const intents = await this.read();
      if (!intents.some(intent => intent.reference.locator.headerMessageId === reference.locator.headerMessageId)) {
        if (intents.length >= 100) throw new Error("Navigation queue full");
        intents.push({ id: crypto.randomUUID(), reference, createdAt: this.now() }); await this.write(intents);
      }
    });
  }
  next(page: string): Promise<MessageIntent | null> {
    return this.serial(async () => {
      const intent = (await this.read())[0]; if (!intent) return null;
      if (this.lease && this.lease.expires > this.now() && this.lease.page !== page) return null;
      this.lease = { id: intent.id, page, expires: this.now() + 30000 }; return intent;
    });
  }
  ack(page: string, id: string): Promise<void> {
    return this.serial(async () => {
      if (this.lease?.page !== page || this.lease.id !== id) return;
      await this.write((await this.read()).filter(intent => intent.id !== id)); this.lease = null;
    });
  }
}
