// What the overlay and the app window's plain scripts find on `window`, so `tsc` can check them
// (tsconfig.scripts.json). Only for the type check: nothing here is loaded or shipped.

interface Window {
  /** The app's functions, from desktop/src/preload.ts. Open for now: the sandboxed preload passes an inline object */
  bubbleFacts: any;
  /** desktop/renderer/a11y.js */
  A11y: { lightAnnouncement(...args: any[]): any; counterStep(...args: any[]): any };
  /** desktop/renderer/banner.js */
  Banner: { bannerFor(...args: any[]): any; twitchButtons(...args: any[]): any };
  /** desktop/renderer/song-source.js */
  SongSource: { fieldShown(...args: any[]): any; sourceChanges(...args: any[]): any };
  /** desktop/renderer/songs-report.js */
  SongsReport: { readyLine(...args: any[]): any; requestsLine(...args: any[]): any; stateLine(...args: any[]): any; whenSaid(...args: any[]): any };
  /** OBS's browser source API, only there inside OBS */
  obsstudio?: any;
}
