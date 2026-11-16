/* Which Settings fields go with the picked song source; plain functions, so a test can run them */
(function () {
  "use strict";

  /** Each song source's fields; others under "Your song list" hide while it's picked */
  const SOURCE_FIELDS = {
    streamersonglist: ["channel", "token", "tokenKind"],
    streamelements: ["seChannel", "seJwt"],
    nowplaying: ["nowPlayingPreset", "nowPlayingFile", "nowPlayingFormat"],
  };
  /** Only "Another app's file" asks for a file and its line format; Streamling and Nightbot know both */
  const OWN_FILE_FIELDS = ["nowPlayingFile", "nowPlayingFormat"];

  /** A field is on screen with this source and file card picked; fields outside the song list always are */
  function fieldShown(name, source, preset) {
    for (const [owner, fields] of Object.entries(SOURCE_FIELDS)) {
      if (!fields.includes(name)) continue;
      if (owner !== source) return false;
      return !(OWN_FILE_FIELDS.includes(name) && preset !== "none");
    }
    return true;
  }

  /**
   * Changes to save: the picked source's fields as shown, none from the others. An unsent field keeps
   * what's saved, so a path typed under "Another app's file" can't be saved once Streamling is picked
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
