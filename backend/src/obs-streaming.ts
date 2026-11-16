/**
 * OBS tells a Browser source when the stream starts and stops (obs-browser's
 * `obsStreamingStarted` and `obsStreamingStopped` events, and
 * `window.obsstudio.getStatus`). The overlay passes it on as
 * `{ type: "obs_streaming", streaming }`, the one message an overlay sends, so
 * the credit bubble goes out as the stream goes live (credit.ts) rather than
 * only after a break in facts.
 */

export interface ObsStreamingMessage {
  type: "obs_streaming";
  streaming: boolean;
}

/** Longer than this is not the overlay's message. */
const MAX_MESSAGE_CHARS = 200;

/** The overlay's one message, or null for anything else, which is ignored. */
export function parseOverlayMessage(raw: string): ObsStreamingMessage | null {
  if (raw.length > MAX_MESSAGE_CHARS) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown> | null;
    const ok = !!m && typeof m === "object" && !Array.isArray(m) && m.type === "obs_streaming" && typeof m.streaming === "boolean" && Object.keys(m).length === 2;
    return ok ? { type: "obs_streaming", streaming: m!.streaming as boolean } : null;
  } catch {
    return null;
  }
}

/** True for the overlay's `{ type: "drew" }`: a bubble went on its page. Anything else is not. */
export function isDrewMessage(raw: string): boolean {
  if (raw.length > MAX_MESSAGE_CHARS) return false;
  try {
    const m = JSON.parse(raw) as Record<string, unknown> | null;
    return !!m && typeof m === "object" && !Array.isArray(m) && m.type === "drew" && Object.keys(m).length === 1;
  } catch {
    return false;
  }
}

/**
 * Whether OBS is streaming, from what overlays report. Every overlay reports
 * (one per scene that shows it, and the vertical one), and one that reloads
 * reports again, so only a change from not streaming, or not known, to
 * streaming is a stream going live. "Not streaming" from an overlay that never
 * said it was live is ignored while another one says it is: a second copy of
 * OBS that only records would otherwise reset it, and the live overlay's next
 * reload would count as going live again.
 */
export class ObsStreaming {
  private streaming: boolean | undefined;
  /** Overlays (by connection) that said OBS is streaming, since it last stopped. */
  private live = new Set<number>();

  /** `restored`: what the session file says, after a restart in the middle of a stream. */
  constructor(restored?: boolean) {
    this.streaming = restored;
  }

  /** What's known, for the session file: undefined until an overlay says. */
  get state(): boolean | undefined {
    return this.streaming;
  }

  /**
   * An overlay disconnected (OBS closed, or the source reloads): it no longer vouches for the stream,
   * so an overlay that reopens and says "not streaming" is believed. A reload reports again anyway.
   */
  forget(client: number): void {
    this.live.delete(client);
  }

  /** True when this report, from overlay `client`, means the stream just went live. */
  report(streaming: boolean, client: number): boolean {
    if (!streaming) {
      if (this.live.size && !this.live.has(client)) return false;
      this.streaming = false;
      this.live.clear();
      return false;
    }
    this.live.add(client);
    const wentLive = this.streaming !== true;
    this.streaming = true;
    return wentLive;
  }
}

/** How long an overlay has to say whether OBS is streaming before the log says it hasn't. */
export const STATUS_WAIT_MS = 10_000;

/**
 * Notes an overlay that connects and never says whether OBS is streaming: it's
 * outside OBS, or the Browser source's Page permissions keep it from asking, so
 * the credit falls back to its own timing. `heard` when it reports; `cancel`
 * when it disconnects.
 */
export function watchForStatus(onSilent: () => void, waitMs = STATUS_WAIT_MS, timer: typeof setTimeout = setTimeout): { heard: () => void; cancel: () => void } {
  let pending: ReturnType<typeof setTimeout> | null = timer(() => {
    pending = null;
    onSilent();
  }, waitMs);
  (pending as { unref?: () => void } | null)?.unref?.();
  const stop = () => {
    if (pending) clearTimeout(pending);
    pending = null;
  };
  return { heard: stop, cancel: stop };
}
