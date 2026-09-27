/**
 * Prefix every console line with a wall-clock timestamp.
 *
 * Imported for side effects, first, before anything that logs.
 *
 * Why this exists: the overlay behaved intermittently during a stream and the
 * logs could not answer basic questions — when did each song change, how long
 * did generation take, did a request fall back. Untimestamped lines in a
 * closed terminal are not evidence. Correlating overlay behaviour with what
 * the viewer saw needs times on every line.
 *
 * Patching console rather than introducing a logging dependency keeps every
 * existing call site working untouched.
 */
const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

console.log = (...args: unknown[]) => original.log(stamp(), ...args);
console.warn = (...args: unknown[]) => original.warn(stamp(), "WARN", ...args);
console.error = (...args: unknown[]) => original.error(stamp(), "ERROR", ...args);

export {};
