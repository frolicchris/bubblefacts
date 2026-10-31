/* Which Settings fields belong to the song source that's picked. Plain functions, so a test can run them. */
(function () {
  "use strict";

  /** The fields each song source shows. Anything else under "Your song list" is hidden while it's picked. */
  const SOURCE_FIELDS = {
    streamersonglist: ["channel", "token", "tokenKind"],
    streamelements: ["seChannel", "seJwt"],
    nowplaying: ["nowPlayingPreset", "nowPlayingFile", "nowPlayingFormat"],
  };
  /** Only "Another app's file" asks for a file and how its line reads; Streamling and Nightbot know both. */
  const OWN_FILE_FIELDS = ["nowPlayingFile", "nowPlayingFormat"];

  /** Whether a field is on screen with this source and file card picked. Fields outside the song list always are. */
  function fieldShown(name, source, preset) {
    for (const [owner, fields] of Object.entries(SOURCE_FIELDS)) {
      if (!fields.includes(name)) continue;
      if (owner !== source) return false;
      return !(OWN_FILE_FIELDS.includes(name) && preset !== "none");
    }
    return true;
  }

  /**
   * The changes to save with a song source picked: its own fields as shown, and none from the
   * sources it replaced. A field that isn't sent keeps what's saved, so a path typed under
   * "Another app's file" can't be saved after Streamling is picked.
   */
  function sourceChanges(changes) {
    const kept = {};
    for (const [name, value] of Object.entries(changes)) {
      if (fieldShown(name, changes.songSource, changes.nowPlayingPreset)) kept[name] = value;
    }
    return kept;
  }

  window.SongSource = { fieldShown, sourceChanges };
})();
