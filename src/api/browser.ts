/**
 * Minimal, hand-written type surface for the Thunderbird APIs ThunderNotes uses.
 *
 * Only the parts we actually call are declared, and every signature is derived
 * from the official Thunderbird 156 (Manifest V3) documentation:
 *   - spaces: https://webextension-api.thunderbird.net/en/latest/spaces.html
 *   - theme:  https://webextension-api.thunderbird.net/en/latest/theme.html
 *   - i18n:   https://webextension-api.thunderbird.net/en/latest/i18n.html
 *
 * Keeping this local (instead of `@types/webextension-polyfill`) means the
 * compile step needs no ambient Thunderbird typings and the surface stays
 * explicitly reviewable.
 */

export interface ThemeIcons {
  /** Icon for LIGHT themes (i.e. the DARK-coloured icon). Confusing, but that is the API. */
  dark: string;
  /** Icon for DARK themes (i.e. the LIGHT-coloured icon). */
  light: string;
  /** Icon size in px. Thunderbird documents 16 (required set) and 32 (high-DPI). */
  size: number;
}

export type ColorArray = [number, number, number, number];

export interface SpaceButtonProperties {
  /** A string describing a colour, or an RGBA array. Reset with `null`. */
  badgeBackgroundColor?: string | ColorArray | null;
  /** Badge text. Removed with `null`. */
  badgeText?: string | null;
  /** Fallback icon path(s) when no theme icon matches. */
  defaultIcons?: string | Record<string, string> | null;
  /** Light/dark icon sets. At least one entry with `size: 16` must be supplied. */
  themeIcons?: ThemeIcons[] | null;
  /** Tooltip of the toolbar button / label in the overflow menu. */
  title?: string | null;
}

export interface SpaceTabProperties {
  url?: string;
  cookieStoreId?: string;
  linkHandler?: string;
}

export interface Space {
  id: number;
  isBuiltIn: boolean;
  isSelfOwned: boolean;
  name: string;
  extensionId?: string;
}

export interface SpacesQueryInfo {
  extensionId?: string;
  isBuiltIn?: boolean;
  isSelfOwned?: boolean;
  name?: string;
}

export interface SpacesApi {
  create(
    name: string,
    tabProperties: string | SpaceTabProperties,
    buttonProperties?: SpaceButtonProperties
  ): Promise<Space>;
  get(spaceId: number): Promise<Space>;
  query(queryInfo?: SpacesQueryInfo): Promise<Space[]>;
  update(
    spaceId: number,
    tabProperties: string | SpaceTabProperties | SpaceButtonProperties,
    buttonProperties?: SpaceButtonProperties
  ): Promise<void>;
  remove(spaceId: number): Promise<void>;
  open(spaceId: number, windowId?: number): Promise<unknown>;
}

export interface ThemeColorValue {
  [key: string]: string | ColorArray | undefined;
}

export interface ThemeType {
  colors?: ThemeColorValue | null;
  images?: Record<string, unknown> | null;
  properties?: Record<string, string | undefined> | null;
}

export interface ThemeUpdateInfo {
  theme: ThemeType;
  windowId?: number;
}

export interface ThemeApi {
  getCurrent(windowId?: number): Promise<ThemeType>;
  onUpdated: {
    addListener(listener: (updateInfo: ThemeUpdateInfo) => void): void;
    removeListener(listener: (updateInfo: ThemeUpdateInfo) => void): void;
    hasListener(listener: (updateInfo: ThemeUpdateInfo) => void): boolean;
  };
}

export interface I18nApi {
  getMessage(messageName: string, substitutions?: string | string[]): string;
  getUILanguage(): string;
}

export interface RuntimeApi {
  getURL(path: string): string;
  getManifest(): { version: string; [key: string]: unknown };
  onInstalled: {
    addListener(listener: (details: { reason: string }) => void): void;
  };
  onStartup: {
    addListener(listener: () => void): void;
  };
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response?: unknown) => void
      ) => boolean | void
    ): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
  lastError?: { message?: string };
}

/** The extension message-tab surface, as returned by `tabs.create`. */
export interface TabsApi {
  create(createProperties: { url?: string; active?: boolean }): Promise<unknown>;
  query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
}

/** A single key/value store area (`storage.local`). */
export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface StorageApi {
  local: StorageArea;
  onChanged?: {
    addListener(
      listener: (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        areaName: string
      ) => void
    ): void;
  };
}

export interface DownloadItem {
  id: number;
  state: "in_progress" | "interrupted" | "complete";
  error?: string;
}

export interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

/** Only the Downloads surface needed for explicit local backup Save As. */
export interface DownloadsApi {
  download(options: { url: string; filename: string; saveAs: true }): Promise<number>;
  search(query: { id: number }): Promise<DownloadItem[]>;
  onChanged: {
    addListener(listener: (delta: DownloadDelta) => void): void;
    removeListener(listener: (delta: DownloadDelta) => void): void;
  };
}

export interface ThunderbirdBrowser {
  spaces?: SpacesApi;
  theme?: ThemeApi;
  i18n: I18nApi;
  runtime: RuntimeApi;
  tabs?: TabsApi;
  storage?: StorageApi;
  downloads?: DownloadsApi;
}

/**
 * Global accessor. In Thunderbird extension contexts `browser` is injected as a
 * global; in Node (unit tests) it is absent and the optional namespaces are
 * `undefined`, which every caller must tolerate.
 */
export function getBrowser(): ThunderbirdBrowser | undefined {
  return (globalThis as { browser?: ThunderbirdBrowser }).browser;
}

/** Same global, but throws when the API is missing (for code paths that need it). */
export function requireBrowser(): ThunderbirdBrowser {
  const api = getBrowser();
  if (!api) throw new Error("[ThunderNotes] Thunderbird `browser` API is not available");
  return api;
}

declare global {
  // Thunderbird injects this global into every extension context.
  // eslint-disable-next-line no-var
  var browser: ThunderbirdBrowser | undefined;
}

export {};
