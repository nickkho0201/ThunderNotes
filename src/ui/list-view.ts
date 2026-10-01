/**
 * Note list view.
 *
 * Renders the filtered note list into a keyed, *windowed* DOM. Windowed
 * rendering (only the rows in view, plus an overscan buffer, with spacer
 * elements above and below) is what keeps the list responsive at the
 * 1 000–10 000 note target, without pulling in a virtualization dependency for
 * a single fixed-row-height list.
 *
 * The row nodes that are in view are reused across renders: only the text and
 * attributes that actually changed are touched, so typing in the editor does not
 * cause a full list rebuild.
 */

import type { Note } from "../notes/model";
import type { IndexedNote, SortField, SortKey } from "../notes/query";
import { sortSpecFor } from "../notes/query";
import { buildNotePreview } from "../notes/preview";
import { formatDateTime, t } from "../i18n";

/**
 * Row height in px. Must match `--tn-row-height` in notes.css; it is only used to
 * size the spacers and to estimate the visible window, and is re-measured from a
 * real row on the first render.
 */
const ROW_HEIGHT = 68;
/** Rows rendered outside the viewport, to smooth fast scrolling. */
const OVERSCAN = 6;

export interface NotesListViewOptions {
  /** Container element (a `<ul>`). */
  listElement: HTMLElement;
  /** Empty-state element shown when there is nothing to display. */
  emptyElement: HTMLElement;
  onSelect: (id: string) => void;
  /** Called when the user activates the selected row (Enter / double click). */
  onActivate?: (id: string) => void;
}

interface RowNodes {
  item: HTMLElement;
  title: HTMLElement;
  excerpt: HTMLElement;
  date: HTMLElement;
  dateLabel: HTMLElement;
  format: HTMLElement;
  /** Cached values, so unchanged rows are not rewritten. */
  c: {
    color: string;
    title: string;
    placeholder: boolean;
    excerpt: string;
    date: string;
    dateLabel: string;
    format: string;
  };
}

function createRow(): RowNodes {
  const item = document.createElement("li");
  item.className = "tn-item";
  item.setAttribute("role", "option");
  item.tabIndex = -1;

  const strip = document.createElement("span");
  strip.className = "tn-item__strip";

  const title = document.createElement("p");
  title.className = "tn-item__title";

  const excerpt = document.createElement("p");
  excerpt.className = "tn-item__excerpt";
  excerpt.hidden = true;

  const meta = document.createElement("p");
  meta.className = "tn-item__meta";

  const format = document.createElement("span");
  format.className = "tn-item__format";
  format.hidden = true;

  const dateLabel = document.createElement("span");
  dateLabel.className = "tn-item__date-label";

  const date = document.createElement("span");
  date.className = "tn-item__date";

  meta.append(format, dateLabel, date);
  item.append(strip, title, excerpt, meta);

  return {
    item,
    title,
    excerpt,
    date,
    dateLabel,
    format,
    c: {
      color: "",
      title: "",
      placeholder: false,
      excerpt: "",
      date: "",
      dateLabel: "",
      format: "",
    },
  };
}

export class NotesListView {
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly onSelect: (id: string) => void;
  private readonly onActivate: ((id: string) => void) | undefined;

  /** Items in display order (filtered + sorted). */
  private items: readonly IndexedNote[] = [];
  private selectedId: string | null = null;
  private emptyMessage = "";

  private readonly rows = new Map<string, RowNodes>();
  private rowHeight = ROW_HEIGHT;
  private rowHeightMeasured = false;
  private scrollTop = 0;
  private viewportHeight = 0;

  /**
   * Which timestamp a row shows. It always follows the active sort field, so the
   * visible date explains the visible order: sorting by creation time and
   * displaying the edit time would look like a broken sort.
   */
  private sortField: SortField = sortSpecFor("created-desc").field;
  /** The full sort key last applied, so a direction change also invalidates. */
  private sortKey: SortKey = "created-desc";

  private windowStart = -1;
  private windowEnd = -1;
  /** Content generation of the currently rendered items. */
  private generation = -1;
  /**
   * Bumped whenever the DOM must be rebuilt regardless of the window bounds:
   * a new item set, a filter change, or a sort change. `render()` compares this
   * against `renderedStructure` instead of guessing from the bounds alone.
   */
  private structure = 0;
  private renderedStructure = -1;

  private readonly resizeObserver: ResizeObserver | null = null;

  constructor(options: NotesListViewOptions) {
    this.list = options.listElement;
    this.empty = options.emptyElement;
    this.onSelect = options.onSelect;
    this.onActivate = options.onActivate;

    this.list.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.list.addEventListener("click", (event) => this.onClick(event));
    this.list.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.list.addEventListener("keydown", (event) => this.onKeyDown(event));

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.updateViewport());
      this.resizeObserver.observe(this.list);
    }
    this.updateViewport();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
  }

  private updateViewport(): void {
    this.viewportHeight = this.list.clientHeight;
    this.render();
  }

  // ------------------------------------------------------------------ rendering

  /**
   * Replace the displayed items and re-render.
   *
   * `generation` identifies the *content* of the list, not just its length. When
   * it is unchanged (e.g. a keystroke in the editor that did not alter the
   * visible projection) the already-rendered window is reused; when it changes
   * the window is invalidated so rows are rebuilt.
   *
   * Invalidating matters: `render()` compares only the window bounds, so a
   * changed item set of the same length (an edit, a new sort order, an
   * equal-count search) would otherwise leave stale rows — including stale
   * `data-id`s, which would make a click select a note that is not in the list.
   */
  setItems(items: readonly IndexedNote[], emptyMessage: string, generation: number): void {
    // A different array instance means the caller produced a new projection
    // (re-sorted, re-filtered, or rebuilt after an edit). That is the reliable
    // signal to rebuild the DOM: comparing window bounds or a content generation
    // alone was not enough, because a re-sort keeps the same bounds and can keep
    // the same number of rows.
    const isNewProjection = items !== this.items;
    const messageChanged = emptyMessage !== this.emptyMessage;

    this.items = items;
    this.emptyMessage = emptyMessage;

    if (isNewProjection || generation !== this.generation) {
      this.generation = generation;
      this.invalidate();
    } else if (!messageChanged) {
      // Nothing to do: same projection, same generation, same message. Avoid a
      // pointless rebuild (this is the common `selection`/`save-status` path).
      return;
    }

    const total = items.length * this.rowHeight;
    if (this.scrollTop > total) {
      this.scrollTop = 0;
      this.list.scrollTop = 0;
    }
    this.render();
  }

  /**
   * Force the next render to rebuild the window, even if the bounds are unchanged.
   *
   * Needed when the *projection* changes without the window moving — a new sort
   * order or a filter change shows the same number of rows in the same window but
   * in a different order, and a changed note set keeps the same bounds while the
   * row contents differ.
   */
  invalidate(): void {
    this.windowStart = -1;
    this.windowEnd = -1;
    this.structure += 1;
  }

  /**
   * Tell the view which sort order the items are in.
   *
   * This only decides *which timestamp a row displays*; the ordering itself is
   * the caller's job (it passes an already-sorted item list). Any change of sort
   * **key** — including a direction change — invalidates the window so the rows
   * are rebuilt with the new date and label.
   */
  setSort(sort: SortKey): void {
    if (sort === this.sortKey) return;
    this.sortKey = sort;
    this.sortField = sortSpecFor(sort).field;
    // Every row's label and date may change, and the order certainly does.
    this.invalidate();
    this.render();
  }

  /** Update the highlighted row only (cheap path for selection changes). */
  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    const previous = this.selectedId;
    this.selectedId = id;

    if (previous !== null) {
      const nodes = this.rows.get(previous);
      if (nodes) {
        nodes.item.classList.remove("is-selected");
        nodes.item.setAttribute("aria-selected", "false");
        nodes.item.tabIndex = -1;
      }
    }
    if (id !== null) {
      const nodes = this.rows.get(id);
      if (nodes) {
        nodes.item.classList.add("is-selected");
        nodes.item.setAttribute("aria-selected", "true");
        nodes.item.tabIndex = 0;
      }
    }
    this.ensureSelectedVisible();
  }

  private onScroll(): void {
    this.scrollTop = this.list.scrollTop;
    this.render();
  }

  private computeWindow(): { start: number; end: number } {
    const total = this.items.length;
    if (total === 0) return { start: 0, end: 0 };

    const height = this.viewportHeight > 0 ? this.viewportHeight : 600;
    const first = Math.floor(this.scrollTop / this.rowHeight);
    const visibleCount = Math.ceil(height / this.rowHeight);

    const start = Math.max(0, first - OVERSCAN);
    const end = Math.min(total, first + visibleCount + OVERSCAN);
    return { start, end };
  }

  private render(): void {
    const total = this.items.length;

    if (total === 0) {
      this.list.textContent = "";
      this.list.hidden = true;
      this.empty.hidden = false;
      this.empty.textContent = this.emptyMessage;
      this.rows.clear();
      this.windowStart = -1;
      this.windowEnd = -1;
      this.renderedStructure = this.structure;
      return;
    }

    this.list.hidden = false;
    this.empty.hidden = true;

    const { start, end } = this.computeWindow();
    // The early return is only valid when the window is unchanged *and* nothing
    // has asked for a rebuild. Comparing the bounds alone once left rows in the
    // wrong order, because a sort change keeps the same window while reordering
    // the items.
    if (
      start === this.windowStart &&
      end === this.windowEnd &&
      this.renderedStructure === this.structure &&
      this.list.childElementCount > 0
    ) {
      // Nothing structural changed: only the active row highlight can differ, and
      // that is handled by `setSelected`.
      return;
    }

    const fragment = document.createDocumentFragment();
    const visible = new Set<string>();

    for (let index = start; index < end; index += 1) {
      const entry = this.items[index];
      if (!entry) continue;
      const note = entry.note;
      visible.add(note.id);

      let nodes = this.rows.get(note.id);
      if (!nodes) {
        nodes = createRow();
        this.rows.set(note.id, nodes);
        this.bindRow(nodes, note.id);
      }
      this.updateRow(nodes, note);
      fragment.append(nodes.item);
    }

    // Drop rows that scrolled out of the window.
    for (const [id, nodes] of this.rows) {
      if (!visible.has(id)) {
        nodes.item.remove();
        this.rows.delete(id);
      }
    }

    // Rebuild the window in one shot: spacer + the visible rows + spacer.
    this.list.replaceChildren(
      this.spacer(start),
      fragment,
      this.spacer(total - end)
    );

    this.windowStart = start;
    this.windowEnd = end;
    this.renderedStructure = this.structure;

    if (this.selectedId !== null) {
      const nodes = this.rows.get(this.selectedId);
      if (nodes) {
        nodes.item.classList.add("is-selected");
        nodes.item.setAttribute("aria-selected", "true");
        nodes.item.tabIndex = 0;
      }
    }

    // Calibrate the row height from a real row, once it has been laid out.
    // This keeps windowing correct if the CSS metric ever drifts.
    if (!this.rowHeightMeasured) {
      const first = this.rows.values().next();
      if (!first.done) {
        this.rowHeightMeasured = true;
        const measured = first.value.item.offsetHeight;
        if (measured > 0 && measured !== this.rowHeight) {
          this.rowHeight = measured;
          this.windowStart = -1;
          this.windowEnd = -1;
          this.render();
        }
      }
    }
  }

  private spacer(height: number): HTMLElement {
    const element = document.createElement("li");
    element.className = "tn-spacer";
    element.setAttribute("aria-hidden", "true");
    element.style.height = `${Math.max(0, height * this.rowHeight)}px`;
    element.style.padding = "0";
    element.style.margin = "0";
    element.style.listStyle = "none";
    element.style.pointerEvents = "none";
    return element;
  }

  private bindRow(nodes: RowNodes, id: string): void {
    nodes.item.dataset.id = id;
  }

  private updateRow(nodes: RowNodes, note: Note): void {
    const preview = buildNotePreview(note);
    const placeholder = preview.title.length === 0;
    const title = placeholder ? t("newNote") : preview.title;
    const color = note.color ?? "none";

    // Show the timestamp of the field the list is currently sorted by.
    const dateLabel = this.sortField === "createdAt" ? t("dateCreated") : t("dateUpdated");
    const date = formatDateTime(note[this.sortField], "short");
    const formatLabel = note.format === "markdown" ? "MD" : "";

    const cache = nodes.c;

    if (cache.color !== color) {
      nodes.item.dataset.color = color;
      cache.color = color;
    }

    if (cache.title !== title) {
      nodes.title.textContent = title;
      cache.title = title;
    }

    if (cache.placeholder !== placeholder) {
      nodes.title.classList.toggle("is-placeholder", placeholder);
      cache.placeholder = placeholder;
    }

    if (cache.excerpt !== preview.excerpt) {
      nodes.excerpt.textContent = preview.excerpt;
      nodes.excerpt.hidden = preview.excerpt.length === 0;
      cache.excerpt = preview.excerpt;
    }

    if (cache.dateLabel !== dateLabel) {
      nodes.dateLabel.textContent = dateLabel;
      cache.dateLabel = dateLabel;
    }

    if (cache.date !== date) {
      nodes.date.textContent = date;
      cache.date = date;
    }

    if (cache.format !== formatLabel) {
      nodes.format.textContent = formatLabel;
      nodes.format.hidden = formatLabel.length === 0;
      cache.format = formatLabel;
    }
  }

  // ------------------------------------------------------------------ behaviour

  private idFromEvent(event: Event): string | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const item = target.closest<HTMLElement>(".tn-item");
    const id = item?.dataset.id;
    return id !== undefined && id !== null && id.length > 0 ? id : null;
  }

  private onClick(event: MouseEvent): void {
    const id = this.idFromEvent(event);
    if (id !== null) {
      this.onSelect(id);
      this.rows.get(id)?.item.focus({ preventScroll: true });
    }
  }

  private onDoubleClick(event: MouseEvent): void {
    const id = this.idFromEvent(event);
    if (id !== null) this.onActivate?.(id);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const total = this.items.length;
    if (total === 0) return;

    const currentIndex = this.items.findIndex((entry) => entry.note.id === this.selectedId);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;

    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowDown":
        nextIndex = Math.min(total - 1, baseIndex + 1);
        break;
      case "ArrowUp":
        nextIndex = Math.max(0, baseIndex - 1);
        break;
      case "PageDown":
        nextIndex = Math.min(total - 1, baseIndex + Math.max(1, Math.floor(this.effectiveHeight() / this.rowHeight) - 1));
        break;
      case "PageUp":
        nextIndex = Math.max(0, baseIndex - Math.max(1, Math.floor(this.effectiveHeight() / this.rowHeight) - 1));
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = total - 1;
        break;
      case "Enter": {
        if (this.selectedId !== null) {
          event.preventDefault();
          this.onActivate?.(this.selectedId);
        }
        return;
      }
      default:
        return;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const entry = this.items[nextIndex];
    if (!entry) return;
    this.scrollRowIntoView(nextIndex);
    this.onSelect(entry.note.id);
    // Move real focus with the selection so the list stays keyboard-navigable.
    const nodes = this.rows.get(entry.note.id);
    nodes?.item.focus({ preventScroll: true });
  }

  private effectiveHeight(): number {
    return this.viewportHeight > 0 ? this.viewportHeight : 600;
  }

  private scrollRowIntoView(index: number): void {
    const top = index * this.rowHeight;
    const bottom = top + this.rowHeight;
    const viewTop = this.list.scrollTop;
    const viewBottom = viewTop + this.effectiveHeight();

    if (top < viewTop) {
      this.list.scrollTop = top;
      this.scrollTop = this.list.scrollTop;
    } else if (bottom > viewBottom) {
      this.list.scrollTop = bottom - this.effectiveHeight();
      this.scrollTop = this.list.scrollTop;
    }
  }

  private ensureSelectedVisible(): void {
    if (this.selectedId === null) return;
    const index = this.items.findIndex((entry) => entry.note.id === this.selectedId);
    if (index === -1) return;

    this.scrollRowIntoView(index);

    // If the selected row is not currently materialized, force the window to be
    // rebuilt — otherwise `render()`'s window guard would skip it and the
    // highlight (and the roving tab stop) would never be applied.
    if (!this.rows.has(this.selectedId)) {
      this.windowStart = -1;
      this.windowEnd = -1;
      this.render();
    }
  }
}
