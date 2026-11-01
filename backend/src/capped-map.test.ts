import { setCapped } from "./capped-map";

describe("setCapped", () => {
  it("drops the oldest entry once the map passes its cap", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i++) setCapped(m, `k${i}`, i, 3);
    expect([...m.keys()]).toEqual(["k7", "k8", "k9"]);
  });

  it("treats a re-set key as the newest", () => {
    const m = new Map<string, number>();
    setCapped(m, "a", 1, 2);
    setCapped(m, "b", 2, 2);
    setCapped(m, "a", 3, 2);
    setCapped(m, "c", 4, 2);
    expect([...m.entries()]).toEqual([["a", 3], ["c", 4]]);
  });
});
