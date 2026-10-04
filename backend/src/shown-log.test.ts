import { ShownLog } from "./shown-log";
import { Fact } from "./types";

const fact = (text: string, source?: string): Fact => ({ text, delaySeconds: 0, durationSeconds: 8, position: { top: "8%", left: "33%" }, ...(source ? { source } : {}) });
const song = { title: "Logged Song", artist: "Logged Artist" };

describe("the [Shown] log", () => {
  // console.log is already muted for all tests (test-setup.ts): read that mock, don't replace it.
  const log = console.log as unknown as jest.Mock;
  const lines = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[Shown]"));
  beforeEach(() => log.mockClear());

  it("logs each fact with its source, in the format scripts read", () => {
    new ShownLog().log(song, [fact("One.", "Wikipedia: Logged Song"), fact("Two.")]);
    expect(lines()).toEqual(['[Shown] "Logged Song" (Wikipedia: Logged Song): One.', '[Shown] "Logged Song" (no source): Two.']);
  });

  it("logs a batch once, however many overlays get it or catch up on it", () => {
    const shown = new ShownLog();
    const batch = [fact("One."), fact("Two."), fact("Three.")];
    shown.log(song, batch);
    shown.log(song, batch);
    shown.log(song, batch.slice(1));
    expect(lines()).toHaveLength(3);
    // New facts for the same play (the streamer saved some) are logged.
    shown.log(song, [fact("Two."), fact("Four.")]);
    expect(lines()).toHaveLength(4);
  });

  it("logs the same facts again on the song's next play", () => {
    const shown = new ShownLog();
    shown.log(song, [fact("One.")]);
    shown.newPlay();
    shown.log(song, [fact("One.")]);
    expect(lines()).toHaveLength(2);
  });
});
