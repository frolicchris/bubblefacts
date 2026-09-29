/** One-off checks the app runs for the musician. */

export type ConnectionResult = { ok: true; id: number } | { ok: false; reason: string };

/** Try the channel name and token against StreamerSongList, and explain any failure plainly. */
export async function testSongList(channel: string, token: string, kind: string): Promise<ConnectionResult> {
  if (!channel.trim()) return { ok: false, reason: "Enter your channel name." };
  if (!token.trim()) return { ok: false, reason: "Paste your Streamer Access Token." };
  const scheme = ({ user: "User", bearer: "Bearer" } as Record<string, string>)[kind] ?? "Streamer";
  try {
    const q = new URLSearchParams({ streamer_name: channel.trim(), platform: "twitch" });
    const res = await fetch(`https://api.streamersonglist.com/streamers?${q}`, {
      headers: { Authorization: `${scheme} ${token.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "StreamerSongList didn't accept that token. Copy it again from Settings, then Access." };
    }
    if (res.status === 404) return { ok: false, reason: `StreamerSongList has no channel named "${channel.trim()}".` };
    if (!res.ok) return { ok: false, reason: `StreamerSongList answered with an error (${res.status}). Try again in a minute.` };
    const body = (await res.json()) as { id: number };
    return { ok: true, id: body.id };
  } catch {
    return { ok: false, reason: "Couldn't reach StreamerSongList. Check your internet connection." };
  }
}

/**
 * Compare versions like 2.0.0 and 2.0.0-beta.2 the semver way: a prerelease
 * comes before its release, and prerelease parts compare number by number.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { core: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ? pre.split(".") : [] };
  };
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [np, nq] = [Number(p), Number(q)];
    const d = !isNaN(np) && !isNaN(nq) ? np - nq : p.localeCompare(q);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * A newer release on GitHub, if there is one. Someone on a beta hears about
 * newer betas; someone on a full release only hears about full releases.
 */
export async function newerRelease(current: string): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch("https://api.github.com/repos/frolicchris/bubblefacts/releases?per_page=20", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name: string; draft: boolean; prerelease: boolean }>;
    const onBeta = current.includes("-");
    const newest = releases
      .filter((r) => !r.draft && (onBeta || !r.prerelease))
      .map((r) => r.tag_name.replace(/^v/, ""))
      .sort((a, b) => compareVersions(b, a))[0];
    return newest && compareVersions(newest, current) > 0
      ? { version: newest, url: "https://bubblefacts.frolic.org/download.html" }
      : null;
  } catch {
    return null;
  }
}
