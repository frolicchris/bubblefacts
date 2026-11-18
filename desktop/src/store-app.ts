import path from "path";

/**
 * The copy of BubbleFacts installed from the Microsoft Store (an MSIX package). Electron says so with
 * process.windowsStore, true only inside such a package. Everything that differs for it hangs on this
 * one check, so installs from the website behave exactly as before.
 */
export function isStoreApp(proc: { windowsStore?: boolean } = process): boolean {
  return proc.windowsStore === true;
}

/**
 * Where a Store app keeps its data: the BubbleFacts folder in Documents. Windows redirects a packaged
 * app's writes under AppData to a private folder, so OBS could not find the overlay file at the path
 * the app shows.
 */
export function storeDataFolder(documents: string): string {
  return path.join(documents, "BubbleFacts");
}

/** The line shown where an update would be offered: the Store updates a Store app itself. */
export const STORE_UPDATES_LINE = "Updates come through the Microsoft Store.";

/** What to pass app.setLoginItemSettings, or null when this copy must not touch the login items (a Store app). */
export function loginItemSettings(startAtLogin: boolean, store = isStoreApp()): { openAtLogin: boolean; args: string[] } | null {
  return store ? null : { openAtLogin: startAtLogin, args: ["--hidden"] };
}
