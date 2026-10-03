import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { InAppNotificationCenter } from "../src/ui/notification-center.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function harness() {
  const { document, window } = parseHTML(`<!doctype html>
    <div id="notifications" role="status" aria-live="polite" aria-relevant="additions" hidden></div>`);
  const root = document.getElementById("notifications") as HTMLElement;
  const center = new InAppNotificationCenter(root, { closeLabel: "Dismiss" });
  const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { root, center, click };
}

describe("in-app notification center", () => {
  it("renders a typed card with separate title, message, icon and accessible close", () => {
    const h = harness();
    h.center.notify({ type: "success", title: "Reminder set", message: "10/3/2026, 9:25 AM", autoDismissMs: null });
    const card = h.root.querySelector<HTMLElement>(".tn-notification")!;
    assert.equal(h.root.hidden, false);
    assert.equal(h.root.getAttribute("role"), "status");
    assert.equal(h.root.getAttribute("aria-live"), "polite");
    assert.equal(card.dataset.type, "success");
    assert.equal(card.querySelector(".tn-notification__title")?.textContent, "Reminder set");
    assert.equal(card.querySelector(".tn-notification__message")?.textContent, "10/3/2026, 9:25 AM");
    assert.equal(card.querySelector(".tn-notification__icon")?.getAttribute("aria-hidden"), "true");
    const close = card.querySelector<HTMLButtonElement>("button")!;
    assert.equal(close.type, "button");
    assert.equal(close.getAttribute("aria-label"), "Dismiss");
  });

  it("stacks consecutive notifications without replacing earlier cards", () => {
    const h = harness();
    const first = h.center.notify({ type: "info", title: "First", autoDismissMs: null });
    const second = h.center.notify({ type: "warning", title: "Second", message: "Details", autoDismissMs: null });
    assert.deepEqual([...h.root.children].map((card) => card.id), [first, second]);
    assert.equal(h.root.childElementCount, 2);
  });

  it("auto-dismisses transient cards independently", async () => {
    const h = harness();
    h.center.notify({ type: "success", title: "Short", autoDismissMs: 10 });
    h.center.notify({ type: "error", title: "Persistent" });
    await wait(20);
    assert.equal(h.root.childElementCount, 1);
    assert.equal(h.root.querySelector<HTMLElement>(".tn-notification")?.dataset.type, "error");
    assert.equal(h.root.hidden, false);
  });

  it("supports manual close and hides the empty stack", () => {
    const h = harness();
    h.center.notify({ type: "warning", title: "Check this", autoDismissMs: null });
    h.click(h.root.querySelector("button")!);
    assert.equal(h.root.childElementCount, 0);
    assert.equal(h.root.hidden, true);
  });
});
