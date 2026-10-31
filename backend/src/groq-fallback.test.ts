jest.mock("./config", () => ({
  config: {
    aiProvider: "openai",
    openaiApiKey: "test-key",
    openaiBaseUrl: "https://api.groq.com/openai/v1",
    openaiModel: "retired/test-model-70b",
    openaiTimeoutMs: 1000,
    temperature: 0,
    originals: false,
    instrument: "",
    topic: "general",
    streamerDisplayName: "Test Streamer",
    sslStreamerName: "teststreamer",
    factVerification: false,
  },
}));

import { config } from "./config";
import { askOpenAICompatible } from "./fact-generator";

const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const gone = reply(404, { error: { message: "The model `retired/test-model-70b` does not exist", code: "model_not_found" } });
const modelsSent = (fetchMock: jest.Mock) => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);

describe("Groq model fallback", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (config as { openaiModel: string }).openaiModel = "retired/test-model-70b";
    (config as { openaiBaseUrl: string }).openaiBaseUrl = "https://api.groq.com/openai/v1";
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("retries once with the default model when a hand-set model is gone", async () => {
    fetchMock.mockResolvedValueOnce(gone).mockResolvedValueOnce(reply(200, { choices: [{ message: { content: "ok" } }] }));
    await expect(askOpenAICompatible("Tell me.")).resolves.toBe("ok");
    expect(modelsSent(fetchMock)).toEqual(["retired/test-model-70b", "openai/gpt-oss-20b"]);
  });

  it("falls back only once", async () => {
    fetchMock.mockResolvedValue(gone);
    await expect(askOpenAICompatible("Tell me.")).rejects.toThrow(/model_not_found/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry other errors, or other providers", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, { error: { message: "oops" } }));
    await expect(askOpenAICompatible("Tell me.")).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear().mockResolvedValue(gone);
    (config as { openaiBaseUrl: string }).openaiBaseUrl = "http://localhost:1234/v1";
    await expect(askOpenAICompatible("Tell me.")).rejects.toThrow(/model_not_found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
