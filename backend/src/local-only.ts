// The server answers only to this computer. A web page can point its own domain at 127.0.0.1 (DNS rebinding),
// but the Host header still names that domain: anything but a loopback name on our port is turned away
// Only while listening on loopback: setting HOST wider is the user's choice
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function allowedHost(hostHeader: string | undefined, port: number, bindHost: string): boolean {
  if (!LOOPBACK.has(bindHost)) return true;
  if (!hostHeader) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim().toLowerCase());
  return !!m && LOOPBACK.has(m[1]) && Number(m[2] ?? 80) === port;
}

// The live feed is for OBS. A page in the musician's browser can't fake Host but can open a WebSocket here,
// and then sends its own address as Origin. Allowed: OBS's Local File address, a page this server
// served (the manual setup's Browser source), and non-browsers, which send no Origin
const OBS_LOCAL_FILE = "http://absolute";

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
