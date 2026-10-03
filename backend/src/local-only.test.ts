import { allowedHost } from "./local-only";

describe("allowedHost", () => {
  it("answers this computer on our port", () => {
    expect(allowedHost("127.0.0.1:3000", 3000, "127.0.0.1")).toBe(true);
    expect(allowedHost("localhost:3000", 3000, "127.0.0.1")).toBe(true);
    expect(allowedHost("[::1]:3000", 3000, "127.0.0.1")).toBe(true);
  });

  it("turns away a web page's own name, another port, or no Host at all", () => {
    expect(allowedHost("evil.example:3000", 3000, "127.0.0.1")).toBe(false);
    expect(allowedHost("127.0.0.1:3001", 3000, "127.0.0.1")).toBe(false);
    expect(allowedHost(undefined, 3000, "127.0.0.1")).toBe(false);
  });

  it("leaves a server set to listen beyond this computer alone", () => {
    expect(allowedHost("studio-pc:3000", 3000, "0.0.0.0")).toBe(true);
  });
});
