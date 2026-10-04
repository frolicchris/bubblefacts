import { cantReach, errorDetail, looksTechnical, plainError, plainWithDetail, SOMETHING_WENT_WRONG } from "./plain-errors";

/** What fetch throws when the network is down: the real reason is in `cause`. */
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code }) });
const errno = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });

describe("plainError", () => {
  it("keeps a message the code already wrote in plain words", () => {
    expect(plainError(new Error("That file isn't a BubbleFacts backup."))).toBe("That file isn't a BubbleFacts backup.");
    expect(plainError(new Error("Sign-in timed out. Click Sign in to try again."))).toBe("Sign-in timed out. Click Sign in to try again.");
    expect(plainError(plainWithDetail("Twitch isn't answering right now. Try again in a minute.", "HTTP 503"))).toBe(
      "Twitch isn't answering right now. Try again in a minute."
    );
  });

  it.each([
    ["no connection", fetchFailed("ENOTFOUND"), "Twitch", cantReach("Twitch")],
    ["refused", fetchFailed("ECONNREFUSED"), "", cantReach()],
    ["reset", fetchFailed("ECONNRESET"), "StreamerSongList", cantReach("StreamerSongList")],
    ["bare fetch failed", new TypeError("fetch failed"), "", "BubbleFacts can't reach the internet right now. Check your connection, then try again."],
    ["timeout code", fetchFailed("ETIMEDOUT"), "StreamElements", "StreamElements took too long to answer. Check your connection, then try again."],
    ["AbortSignal.timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "", "The internet connection took too long to answer. Check your connection, then try again."],
    ["not JSON", new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"), "Ollama", "Ollama sent an answer BubbleFacts can't read. Try again in a minute."],
    ["full disk", errno("ENOSPC", "no space left on device, write"), "", "There isn't enough free disk space. Free up some space, then try again."],
    ["not allowed", errno("EACCES", "permission denied, open '/Users/x/file'"), "", "Your computer didn't let BubbleFacts use a file it needs. Quit and reopen BubbleFacts, then try again."],
    ["missing file", errno("ENOENT", "no such file or directory, open '/x'"), "", "BubbleFacts couldn't find that file. Check where it is, then try again."],
  ])("%s", (_name, err, service, expected) => {
    expect(plainError(err, { service })).toBe(expected);
  });

  it("never shows programmer words, and falls back to what to do", () => {
    for (const err of [
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new Error("Download failed: 503 Service Unavailable (503)"),
      new Error("ERR_INVALID_ARG_TYPE"),
      "a string with HTTP 500",
      null,
    ]) {
      expect(plainError(err)).toBe(SOMETHING_WENT_WRONG);
    }
    expect(plainError(new RangeError("Invalid array length"), { fallback: "The download didn't finish." })).toBe("The download didn't finish.");
  });

  it("tells technical text from plain text", () => {
    for (const t of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:11434", "Unexpected token < in JSON", "answered with an error (502)", "    at fetch (node:internal/deps/undici:1:1)"]) {
      expect(looksTechnical(t)).toBe(true);
    }
    for (const t of ["Paste your StreamElements JWT token.", "StreamerSongList has no channel named \"jane\".", "Sign-in was canceled."]) {
      expect(looksTechnical(t)).toBe(false);
    }
  });
});

describe("errorDetail", () => {
  it("keeps the technical side, causes included, for the log", () => {
    expect(errorDetail(fetchFailed("ECONNREFUSED"))).toBe("TypeError fetch failed <- ECONNREFUSED connect ECONNREFUSED 1.2.3.4:443");
    expect(errorDetail(plainWithDetail("Twitch isn't answering right now.", "HTTP 503"))).toBe("Twitch isn't answering right now. <- HTTP 503");
  });
});
