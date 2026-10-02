/** Geometry, not bubbling target identity, distinguishes text from empty space. */
export function emptyPreviewHit(surface: HTMLElement, event: MouseEvent): boolean {
  const target = event.target as Node | null;
  if (!target || !surface.contains(target)) return false;
  const inside = (rect: DOMRect): boolean => rect.width > 0 && rect.height > 0 &&
    event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  const doc = surface.ownerDocument;
  // Interactive links and painted code/table surfaces have their own meaning.
  if ((target as Element).closest?.("a, button, input, select, textarea, pre, table, [contenteditable], [role=button]")) return false;
  if (!doc.createTreeWalker || !doc.createRange) return target === surface;
  const walker = doc.createTreeWalker(surface, 4 /* SHOW_TEXT */);
  const range = doc.createRange();
  if (!range.getClientRects) return target === surface; // headless DOM, no layout
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    if (Array.from(range.getClientRects()).some(inside)) return false;
  }
  // Non-text leaves (images, rules, controls) are content too. No tag allowlist.
  for (const element of surface.querySelectorAll<HTMLElement>("*")) {
    if (!element.childNodes.length && Array.from(element.getClientRects()).some(inside)) return false;
  }
  return true;
}
