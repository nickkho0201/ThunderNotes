import type { StorageArea, ThemeType } from "../api/browser";
import { modeFromColorScheme, modeFromColors } from "../theme/detect";
import type { ThemeMode, ThemeState } from "../theme/detect";

export const STORED_THEME_MODE_KEY = "thundernotes.resolvedThemeMode";

export async function loadStoredThemeMode(storage: StorageArea | undefined): Promise<ThemeMode | null> {
  if (!storage) return null;
  try {
    const value = (await storage.get(STORED_THEME_MODE_KEY))[STORED_THEME_MODE_KEY];
    return value === "light" || value === "dark" ? value : null;
  } catch (error) {
    console.warn("[ThunderNotes] could not read the last resolved theme", error);
    return null;
  }
}

export async function storeResolvedThemeMode(
  storage: StorageArea | undefined,
  mode: ThemeMode
): Promise<void> {
  if (!storage) return;
  try {
    await storage.set({ [STORED_THEME_MODE_KEY]: mode });
  } catch (error) {
    console.warn("[ThunderNotes] could not remember the resolved theme", error);
  }
}

export interface SpaceThemeSyncDependencies<TRegistration> {
  detect(): Promise<ThemeState>;
  load(): Promise<ThemeMode | null>;
  save(mode: ThemeMode): Promise<void>;
  register(mode: ThemeMode): Promise<TRegistration>;
  apply(mode: ThemeMode): Promise<unknown>;
}

/**
 * Serialises every Space-button mutation and gives a page-resolved mode the last
 * word when it arrives while a worker-side detection/update is still pending.
 */
export class SpaceThemeSync<TRegistration = unknown> {
  private tail: Promise<void> = Promise.resolve();
  private pageMode: ThemeMode | null = null;
  private pageRevision = 0;

  constructor(private readonly dependencies: SpaceThemeSyncDependencies<TRegistration>) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async resolveWorkerMode(fallback?: ThemeMode): Promise<ThemeMode> {
    const detected = await this.dependencies.detect();
    if (detected.source !== "default") return detected.mode;
    return fallback ?? (await this.dependencies.load()) ?? detected.mode;
  }

  /** Register/repair the Space during worker startup. */
  boot(): Promise<TRegistration> {
    const pageRevisionAtStart = this.pageRevision;
    return this.enqueue(async () => {
      let mode = await this.resolveWorkerMode();
      if (this.pageRevision !== pageRevisionAtStart && this.pageMode) {
        mode = this.pageMode;
      }
      return this.dependencies.register(mode);
    });
  }

  /** Apply the exact effective mode already resolved by the Space page. */
  pageResolved(mode: ThemeMode): Promise<void> {
    this.pageMode = mode;
    this.pageRevision += 1;
    return this.enqueue(async () => {
      const effective = this.pageMode ?? mode;
      await this.dependencies.save(effective);
      await this.dependencies.apply(effective);
    });
  }

  /** React to Thunderbird's theme event without racing a newer page message. */
  themeUpdated(theme: ThemeType): Promise<void> {
    const pageRevisionAtStart = this.pageRevision;
    const fromUpdate = modeFromColorScheme(theme) ?? modeFromColors(theme);

    return this.enqueue(async () => {
      let mode = fromUpdate ?? (await this.resolveWorkerMode(this.pageMode ?? undefined));
      if (this.pageRevision !== pageRevisionAtStart && this.pageMode) {
        mode = this.pageMode;
      }
      if (fromUpdate) await this.dependencies.save(mode);
      await this.dependencies.apply(mode);
    });
  }
}
