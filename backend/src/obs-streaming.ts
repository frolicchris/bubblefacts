// Whether OBS is streaming, as the overlay reports it, so the credit goes out as the stream
// goes live, not only after a break in facts (ARCHITECTURE.md: The credit bubble)

export interface ObsStreamingMessage {
  type: "obs_streaming";
  streaming: boolean;
}

const MAX_MESSAGE_CHARS = 200; // longer is not the overlay's message

/** The overlay's one message, or null for anything else (ignored) */
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
 * Whether OBS is streaming. Every overlay reports, and again on reload, so only a change to streaming is going live.
 * "Not streaming" from an overlay never live is ignored while another is (a recording-only second OBS)
 */
export class ObsStreaming {
  private streaming: boolean | undefined;
  /** Overlays (by connection) that said OBS is streaming, since it last stopped */
  private live = new Set<number>();

  /** `restored`: the session file's, after a restart mid-stream */
  constructor(restored?: boolean) {
    this.streaming = restored;
  }

  /** What's known, for the session file: undefined until an overlay says */
  get state(): boolean | undefined {
    return this.streaming;
  }

  /** A disconnected overlay no longer vouches for the stream (a reload reports again anyway) */
  forget(client: number): void {
    this.live.delete(client);
  }

  /** True when this report from overlay `client` means the stream just went live */
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

export const STATUS_WAIT_MS = 10_000; // ms an overlay has to report before the log says it hasn't

/** Calls `onSilent` if an overlay never reports (outside OBS, or Page permissions); `heard` or `cancel` stops it */
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
