import { ObsStreaming, parseOverlayMessage, STATUS_WAIT_MS, watchForStatus } from "./obs-streaming";

describe("the overlay's one message", () => {
  it("is OBS's streaming state, and nothing else gets through", () => {
    expect(parseOverlayMessage('{"type":"obs_streaming","streaming":true}')).toEqual({ type: "obs_streaming", streaming: true });
    expect(parseOverlayMessage('{"type":"obs_streaming","streaming":false}')).toEqual({ type: "obs_streaming", streaming: false });
    for (const raw of [
      "",
      "not json",
      "null",
      "[]",
      '{"type":"obs_streaming"}',
      '{"type":"obs_streaming","streaming":"yes"}',
      '{"type":"obs_streaming","streaming":true,"extra":1}',
      '{"type":"facts_ready","streaming":true}',
      JSON.stringify({ type: "obs_streaming", streaming: true, pad: "x".repeat(300) }),
    ]) expect(parseOverlayMessage(raw)).toBeNull();
  });
});

describe("telling when the stream goes live", () => {
  const [MAIN, VERTICAL, RECORDER] = [1, 2, 3];

  it("counts only a change to streaming, however many overlays report it", () => {
    const obs = new ObsStreaming();
    // Not streaming yet: two overlays connect before going live
    expect([obs.report(false, MAIN), obs.report(false, VERTICAL)]).toEqual([false, false]);
    // Live: the first report is the stream going live, the second overlay's and a reload's are not
    expect([obs.report(true, MAIN), obs.report(true, VERTICAL), obs.report(true, 4)]).toEqual([true, false, false]);
    // Stopped, then live again: another stream
    expect([obs.report(false, MAIN), obs.report(true, MAIN)]).toEqual([false, true]);
  });

  it("takes a stream already live when the app starts as going live, unless the session says it was", () => {
    expect(new ObsStreaming().report(true, MAIN)).toBe(true);
    // A restart mid-stream: the first overlay to reconnect isn't the stream going live
    const restarted = new ObsStreaming(true);
    expect(restarted.state).toBe(true);
    expect(restarted.report(true, MAIN)).toBe(false);
    // Stream ended while the app was closed: "not streaming" is believed, the next start counts
    const ended = new ObsStreaming(true);
    expect([ended.report(false, MAIN), ended.report(true, MAIN)]).toEqual([false, true]);
  });

  it("ignores \"not streaming\" from an overlay that never said it was live, while another is", () => {
    const obs = new ObsStreaming();
    expect(obs.report(true, MAIN)).toBe(true);
    // A second copy of OBS that only records: its overlay says not streaming
    obs.report(false, RECORDER);
    expect(obs.state).toBe(true);
    // The live overlay reloads (a new connection): not another stream
    expect(obs.report(true, 5)).toBe(false);
    // The live stream stops: that counts
    obs.report(false, MAIN);
    expect(obs.state).toBe(false);
    expect(obs.report(true, MAIN)).toBe(true);
  });

  it("believes \"not streaming\" once the live overlay has gone, so the next stream counts", () => {
    const obs = new ObsStreaming();
    obs.report(true, MAIN);
    // OBS closes while live, then opens again, not streaming yet
    obs.forget(MAIN);
    expect(obs.report(false, 6)).toBe(false);
    expect(obs.state).toBe(false);
    expect(obs.report(true, 6)).toBe(true);
    // A reload of the only live overlay: gone, then back, still live, so not another stream
    obs.forget(6);
    expect(obs.report(true, 7)).toBe(false);
  });
});

describe("an overlay that never says whether OBS is streaming", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("is noted once, after the wait, unless it reports or disconnects first", () => {
    const silent = jest.fn();
    watchForStatus(silent, STATUS_WAIT_MS);
    jest.advanceTimersByTime(STATUS_WAIT_MS - 1);
    expect(silent).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(silent).toHaveBeenCalledTimes(1);

    const reported = jest.fn();
    watchForStatus(reported, STATUS_WAIT_MS).heard();
    const gone = jest.fn();
    watchForStatus(gone, STATUS_WAIT_MS).cancel();
    jest.advanceTimersByTime(STATUS_WAIT_MS * 2);
    expect(reported).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });
});
