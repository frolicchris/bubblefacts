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

/**
 * The live feed is for OBS. A web page open in the musician's browser can't
 * fake the Host header, but it can open a WebSocket to this computer, and the
 * browser then sends that page's own address as Origin. Allowed: OBS's Local
 * File address, a page this server served itself (the Browser source URL in
 * the manual setup), and programs other than browsers, which send no Origin.
 */
export const OBS_LOCAL_FILE = "http://absolute";

export function allowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  const o = origin.trim().toLowerCase();
  if (o === OBS_LOCAL_FILE) return true;
  try {
    const url = new URL(o);
    return (url.protocol === "http:" || url.protocol === "https:") && !!hostHeader && url.host === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}
