/** Prefix every console line with a wall-clock time. Import first, for side effects. */
const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function stamp(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

console.log = (...args: unknown[]) => original.log(stamp(), ...args);
console.warn = (...args: unknown[]) => original.warn(stamp(), "WARN", ...args);
console.error = (...args: unknown[]) => original.error(stamp(), "ERROR", ...args);

export {};
