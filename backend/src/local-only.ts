/**
 * The server answers only to this computer. A web page can make a browser
 * resolve its own domain name to 127.0.0.1 (DNS rebinding); the Host header
 * still names that domain, so anything but a loopback name on our port is
 * turned away. Someone who set HOST to listen beyond this computer chose that,
 * so the check only applies while listening on loopback.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function allowedHost(hostHeader: string | undefined, port: number, bindHost: string): boolean {
  if (!LOOPBACK.has(bindHost)) return true;
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim().toLowerCase());
  return !!m && LOOPBACK.has(m[1]) && Number(m[2] ?? 80) === port;
}
