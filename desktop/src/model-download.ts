import { ChecksumMismatch, downloadModel, ModelFile, modelReady, Progress } from "./model";
import type { PlainOptions } from "./plain-errors";

// The built-in AI's download in the background: started whenever it's chosen and missing, tried again on
// its own after a failure, stopped on a switch. model.ts downloads one file once; this keeps at it

/** How far the download is, with the reason it paused after a failure */
export type ModelDownloadProgress = Progress & { error?: string };

/** From main.ts: where the models go, which one is chosen, and how to tell the window */
export interface ModelDownloadDeps {
  modelsDir: string;
  /** The built-in AI is the chosen AI: nothing downloads otherwise */
  wanted: () => boolean;
  chosen: () => ModelFile;
  quitting: () => boolean;
  /** The download moved on, or paused with a reason */
  progress: (p: ModelDownloadProgress) => void;
  /** The chosen model is downloaded and checked */
  ready: () => void;
  /** Something the window shows changed */
  changed: () => void;
  /** A failure in plain words for the window; the technical side goes in the log */
  shown: (where: string, err: unknown, opts?: PlainOptions) => string;
}

export interface ModelDownloader {
  /** Download the AI in the background whenever it's chosen and missing, retrying on its own */
  ensure: () => Promise<void>;
  /** Try again now (the window's Try again), without the wait a failure added */
  tryAgain: () => void;
  /** Stop downloading and forget how far it got; `ensure` starts over */
  stop: () => void;
  /** Stop the download under way, as the app quits */
  abort: () => void;
  /** How far the download is, for the window; null when none is under way */
  progress: () => ModelDownloadProgress | null;
}

export function modelDownloader(deps: ModelDownloadDeps): ModelDownloader {
  let download: AbortController | null = null;
  let modelDownload: ModelDownloadProgress | null = null;
  let downloadRetry: NodeJS.Timeout | null = null;
  let downloadFailures = 0;

  async function ensure(): Promise<void> {
    if (!deps.wanted() || modelReady(deps.modelsDir, deps.chosen()) || download) return;
    if (downloadRetry) clearTimeout(downloadRetry);
    downloadRetry = null;
    download = new AbortController();
    const model = deps.chosen();
    const progress = (p: Progress) => {
      modelDownload = p;
      deps.progress(p);
    };
    try {
      progress({ received: 0, total: model.bytes, phase: "downloading" });
      await downloadModel(deps.modelsDir, progress, download.signal, model);
      downloadFailures = 0;
      modelDownload = null;
      deps.ready();
    } catch (err) {
      if (download.signal.aborted) return;
      downloadFailures++;
      const wait = Math.min(30_000 * downloadFailures, 5 * 60_000);
      const reason = deps.shown("AI download", err, { fallback: "The download stopped. BubbleFacts tries again on its own." });
      modelDownload = { ...(modelDownload ?? { received: 0, total: model.bytes, phase: "downloading" }), error: reason };
      deps.progress(modelDownload);
      if (!(err instanceof ChecksumMismatch)) downloadRetry = setTimeout(() => void ensure(), wait);
    } finally {
      const stopped = download?.signal.aborted;
      download = null;
      deps.changed();
      // Stopped by a switch away and back, or to the other quality: pick up the chosen one
      if (stopped && !deps.quitting() && deps.wanted()) void ensure();
    }
  }

  function stop(): void {
    download?.abort();
    if (downloadRetry) clearTimeout(downloadRetry);
    downloadRetry = null;
    modelDownload = null;
  }

  return {
    ensure,
    tryAgain: () => {
      downloadFailures = 0;
      void ensure();
    },
    stop,
    abort: () => download?.abort(),
    progress: () => modelDownload,
  };
}
