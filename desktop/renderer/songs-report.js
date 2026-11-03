/* The Your songs screen's sentences (issue #294). Plain functions, so tests can run them without a window. Information only: nothing here asks the streamer to check or approve anything. */
(function () {
  "use strict";

  const number = (n) => Number(n).toLocaleString("en-US");
  const DAY = 24 * 60 * 60 * 1000;

  /** When the rest will be ready, as a person says it: later today, tomorrow, Thursday, or November 14. */
  function whenSaid(atIso, now) {
    const at = new Date(atIso);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const days = Math.floor((at.getTime() - start.getTime()) / DAY);
    if (days <= 0) return "later today";
    if (days === 1) return "tomorrow";
    if (days < 7) return at.toLocaleDateString("en-US", { weekday: "long" });
    return at.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }

  /** "1,240 of 5,000 songs ready. The rest by about Thursday." */
  function readyLine(c, now = Date.now()) {
    if (!c || !c.total) return "No songs to prepare yet. The songs on your list, and songs played on your stream, show up here.";
    const head = `${number(c.ready)} of ${number(c.total)} songs ready.`;
    if (!c.left) return `${head} Every song has been prepared.`;
    if (c.finish && c.finish.at) {
      const when = whenSaid(c.finish.at, now);
      return `${head} The rest ${when === "later today" ? when : `by about ${when}`}.`;
    }
    if (c.finish && c.finish.hours) return `${head} The rest need about ${c.finish.hours === 1 ? "an hour" : `${number(c.finish.hours)} hours`} of preparing.`;
    return `${head} Once a few songs are done, this says when the rest will be.`;
  }

  /** "Ready songs make up 62% of the requests so far." Empty when no requests are known. */
  function requestsLine(c) {
    if (!c || c.requestsCovered === null || c.requestsCovered === undefined) return "";
    return `Ready songs make up ${Math.round(c.requestsCovered * 100)}% of the requests so far.`;
  }

  const WAITING = {
    off: "Prepare my songs is off. To turn it on, open Settings and check it under Prepare my songs.",
    setup: "Finish setting up BubbleFacts first.",
    "online-ai": "Songs are prepared with the AI on this computer. With an online AI chosen, they aren't prepared.",
    "no-ai": "Waiting for the AI on this computer to be ready.",
    server: "Waiting for BubbleFacts to start.",
    battery: "Waiting: plug your computer in.",
    overlay: "Waiting: BubbleFacts is on your stream in OBS.",
    obs: "Waiting: OBS is open. Preparing carries on when you close it.",
    "obs-unknown": "Waiting: BubbleFacts can't tell right now whether OBS is open, so it holds off and checks again.",
  };

  /** What preparing is doing now. `waiting`: why the app holds it back ("" when free); `server`: what the server said. */
  function stateLine(waiting, server) {
    if (waiting) return WAITING[waiting] || "";
    if (!server) return "Waiting for BubbleFacts to start.";
    if (server.waitingForLookups) return "Preparing. Wikipedia or the music databases aren't answering right now, so it waits a few minutes and tries again.";
    if (server.running && server.current) return `Preparing now: ${server.current.title}.`;
    if (server.running) return "Preparing now.";
    if (server.finished) return "Every song is prepared. New songs are prepared after they first play.";
    return "Starting in a moment.";
  }

  window.SongsReport = { readyLine, requestsLine, stateLine, whenSaid };
})();
