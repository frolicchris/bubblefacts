/**
 * What the musician reads when something fails: what happened and what to
 * do, in plain words. Network codes, HTTP statuses and parser messages stay
 * in the log (`errorDetail`), where problem reports pick them up.
 */

export interface PlainOptions {
  /** Who BubbleFacts was talking to, as the musician knows it: "Twitch", "StreamerSongList". */
  service?: string;
  /** Said when nothing more specific fits. */
  fallback?: string;
}

export const SOMETHING_WENT_WRONG = "Something went wrong. Try again, and if it keeps happening, use Report a problem under Help.";

const NETWORK = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "EPIPE",
  "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const TIMEOUT = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NO_SPACE = new Set(["ENOSPC", "EDQUOT"]);
const NOT_ALLOWED = new Set(["EACCES", "EPERM", "EROFS", "EBUSY"]);
const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** JavaScript's and the runtime's own errors: their messages are for programmers, whatever they say. */
const BUILT_IN = new Set(["TypeError", "SyntaxError", "RangeError", "ReferenceError", "AbortError", "TimeoutError", "DOMException", "SystemError"]);

/** Words that only make sense to a programmer. A message without them was written for the musician. */
const TECHNICAL =
  /\bE[A-Z]{3,}\b|\bUND_ERR|fetch failed|Unexpected (token|end|character)|\bJSON\b|is not (a function|defined|iterable)|Cannot read propert|\bundefined\b|\b(Type|Syntax|Reference|Range|Abort)Error\b|^\s*at .+:\d+|\(\d{3}\)|\bHTTP\b|status code|\bsocket\b|aborted due to|operation was aborted|ERR_[A-Z_]+|\b(?:127\.0\.0\.1|localhost):\d+/im;

/** An error and the errors it wraps (fetch puts the real one in `cause`). */
function chain(err: unknown): Array<{ name: string; message: string; code: string }> {
  const out: Array<{ name: string; message: string; code: string }> = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e != null; i++) {
    if (typeof e === "object") {
      const o = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
      out.push({ name: String(o.name ?? ""), message: String(o.message ?? ""), code: String(o.code ?? "") });
      e = o.cause;
    } else {
      out.push({ name: "", message: String(e), code: "" });
      break;
    }
  }
  return out;
}

export const looksTechnical = (text: string): boolean => TECHNICAL.test(text);

/** The sentence for a request that never got an answer. */
export const cantReach = (service = ""): string =>
  service
    ? `BubbleFacts can't reach ${service} right now. Check your internet connection, then try again.`
    : "BubbleFacts can't reach the internet right now. Check your connection, then try again.";

/** The plain sentence to show for `err`. A message the code already wrote in plain words is kept as it is. */
export function plainError(err: unknown, opts: PlainOptions = {}): string {
  const parts = chain(err);
  const codes = new Set(parts.map((p) => p.code).filter(Boolean));
  const has = (set: Set<string>) => [...codes].some((c) => set.has(c));
  const all = parts.map((p) => `${p.name} ${p.message}`).join(" ");
  const who = opts.service || "";
  // Written for the musician already: kept as it is.
  const own = parts[0];
  if (own && own.message.trim() && !own.code && !BUILT_IN.has(own.name) && !looksTechnical(own.message)) return own.message.trim();

  if (has(NO_SPACE) || /no space left/i.test(all)) return "There isn't enough free disk space. Free up some space, then try again.";
  if (has(NOT_ALLOWED) || /permission denied|operation not permitted/i.test(all)) {
    return "Your computer didn't let BubbleFacts use a file it needs. Quit and reopen BubbleFacts, then try again.";
  }
  if (has(MISSING) || /no such file or directory/i.test(all)) return "BubbleFacts couldn't find that file. Check where it is, then try again.";
  if (has(TIMEOUT) || parts.some((p) => p.name === "TimeoutError") || /timed? ?out due|timeout/i.test(all)) {
    return `${who || "The internet connection"} took too long to answer. Check your connection, then try again.`;
  }
  if (has(NETWORK) || /fetch failed|network|getaddrinfo|socket hang up/i.test(all)) {
    return cantReach(who);
  }
  if (parts.some((p) => p.name === "SyntaxError") || /Unexpected (token|end)|\bJSON\b/.test(all)) {
    return `${who || "A server"} sent an answer BubbleFacts can't read. Try again in a minute.`;
  }
  return opts.fallback ?? SOMETHING_WENT_WRONG;
}

/** Everything technical about `err`, on one line, for the log. */
export function errorDetail(err: unknown): string {
  return chain(err)
    .map((p) => [p.name && p.name !== "Error" ? p.name : "", p.code, p.message].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" <- ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

/** An error with a plain message for the window and a technical cause for the log. */
export const plainWithDetail = (message: string, detail: string) => new Error(message, { cause: detail });
