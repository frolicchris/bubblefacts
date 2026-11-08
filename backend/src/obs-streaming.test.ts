import { ObsStreaming, parseOverlayMessage } from "./obs-streaming";

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
  it("counts only a change to streaming, however many overlays report it", () => {
    const obs = new ObsStreaming();
    // Not streaming yet: two overlays connect before going live.
    expect([obs.report(false), obs.report(false)]).toEqual([false, false]);
    // Live: the first report is the stream going live, the second overlay's and a reload's are not.
    expect([obs.report(true), obs.report(true), obs.report(true)]).toEqual([true, false, false]);
    // Stopped, then live again: another stream.
    expect([obs.report(false), obs.report(true)]).toEqual([false, true]);
  });

  it("takes a stream already live when the app starts as going live", () => {
    expect(new ObsStreaming().report(true)).toBe(true);
  });
});
