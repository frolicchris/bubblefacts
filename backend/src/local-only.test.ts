import { allowedHost, allowedOrigin } from "./local-only";

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

describe("allowedOrigin", () => {
  it("lets OBS and this server's own page connect", () => {
    expect(allowedOrigin("http://absolute", "127.0.0.1:3000")).toBe(true);
    expect(allowedOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(allowedOrigin(undefined, "127.0.0.1:3000")).toBe(true);
  });

  it("turns away any other web page", () => {
    expect(allowedOrigin("https://evil.example", "127.0.0.1:3000")).toBe(false);
    expect(allowedOrigin("http://127.0.0.1:8080", "127.0.0.1:3000")).toBe(false);
    expect(allowedOrigin("null", "127.0.0.1:3000")).toBe(false);
    expect(allowedOrigin("http://localhost:3000", undefined)).toBe(false);
  });
});
