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

/**
 * Whether OBS is streaming, from what overlays report. Every overlay reports
 * (one per scene that shows it, and the vertical one), and one that reloads
 * reports again, so only a change from not streaming, or not known, to
 * streaming is a stream going live. After the app restarts, the first report
 * of a stream already live counts as going live: one more credit, the safe
 * side of "at least once".
 */
export class ObsStreaming {
  private streaming: boolean | undefined;

  /** True when this report means the stream just went live. */
  report(streaming: boolean): boolean {
    const wentLive = streaming && this.streaming !== true;
    this.streaming = streaming;
    return wentLive;
  }
}
