/* The one banner at the top of the dashboard: which notice wins, and its words. Plain functions, so tests
   run them without a window. First whatever means bubbles aren't showing, then what is only worth knowing */
(function () {
  "use strict";

  /**
   * `v`: status (the fact server's), health, obs, obsGrace, downloading (its progress in words, or ""),
   * rejected, paused, source (the song source setting), songListDown, twitch ({ ended, about, connected }),
   * showing (bubbles for this song) and ready (its facts are in)
   */
  function bannerFor(v) {
    const status = v.status, h = v.health || {}, twitch = v.twitch || {};
    const onStreamElements = v.source === "streamelements", onFile = v.source === "nowplaying";
    const running = status.state === "running";
    const warn = (title, detail) => ({ kind: "warn", title, detail });
    if (status.state === "failing") return { kind: "bad", title: "Something's wrong", detail: status.message + ". BubbleFacts keeps trying on its own. If this doesn't clear, use Report a problem under Help." };
    if (status.state === "restarting") return warn("Fixing a problem", status.message + ". This fixes itself in a moment.");
    if (v.rejected) {
      return { kind: "bad", title: "Reconnect your song list", detail: onStreamElements ? "StreamElements didn't accept your JWT token. Paste a new one in Settings." : "StreamerSongList needs you to sign in again." };
    }
    if (status.state === "stopped") {
      return warn("Connect your songs", onFile ? "Choose your now playing file in Settings to start."
        : onStreamElements ? "Paste your StreamElements JWT token in Settings to start." : "Sign in with StreamerSongList in Settings to start.");
    }
    if (v.paused) return warn("Bubbles are paused", "BubbleFacts is still following your songs. Click Resume bubbles when you're ready.");
    if (running && !v.obs && v.obsGrace) return warn("Connecting to OBS", "If BubbleFacts is already in OBS, this takes a few seconds.");
    if (running && !v.obs) return warn("Add BubbleFacts to OBS", "Drag the tile below into OBS's Sources list, or open OBS if it's closed.");
    if (running && status.message) {
      // The sign-in was checked and holds: StreamerSongList itself is down or slow
      return warn("Reconnecting", v.songListDown && !onStreamElements && !onFile
        ? "StreamerSongList isn't answering right now. Your sign-in is fine, so there's nothing to do: BubbleFacts keeps trying."
        : status.message + ".");
    }
    if (running && h.songStale) return warn("Waiting for your next song", h.songStale);
    // Twitch About facts stopped: only after a connection ended by itself, and only for a streamer who has
    // Twitch About turned on. Last of the notices: bubbles are still showing
    if (running && twitchEndedNotice(twitch)) {
      return warn("Your Twitch connection ended", "Twitch About facts are paused. Connect Twitch again in Settings to get them back, or turn Twitch About off there.");
    }
    if (running) {
      const title = !h.currentSong ? "Ready for your next song" : v.showing > 0 ? "Showing facts" : v.ready ? "Following your songs" : "Finding facts";
      const waiting = !h.currentSong ? "BubbleFacts will show facts when your next song starts."
        : v.showing > 0 ? "This song's facts pop up on your stream while it plays."
        // Nothing reliable, facts off, a live learn or a failure: the note under On stream now says which
        : v.ready ? "No bubbles for this song. The note below says why."
        : "Looking up facts for this song. They appear in a few seconds.";
      return { kind: "ok", title, detail: v.downloading
        ? `Getting BubbleFacts ready (${v.downloading}). Until then, songs get facts from music databases and your custom facts.`
        : waiting };
    }
    return warn("Getting BubbleFacts ready", "This only takes a moment.");
  }

  /** Whether the ended connection is worth a notice: not once connected again, not with Twitch About turned off */
  const twitchEndedNotice = (twitch) => !!twitch.ended && !!twitch.about && !twitch.connected;

  /**
   * The buttons under Connect Twitch. A connection that ended by itself keeps the Disconnect button, worded
   * as staying disconnected, so the notice can be cleared without connecting again
   */
  function twitchButtons(twitch) {
    return {
      connect: !twitch.connected,
      disconnect: !!twitch.connected || !!twitch.ended,
      disconnectText: twitch.connected ? "Disconnect" : "Stay disconnected",
    };
  }

  window.Banner = { bannerFor, twitchButtons };
})();
