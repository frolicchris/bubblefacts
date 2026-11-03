import { generateKeyPairSync, randomBytes, sign, KeyObject } from "crypto";
import { checkReleaseSignature, parsePublicKey, ReleaseKey, trustedCommentFor } from "./release-signature";

// A throwaway key made for these tests only, written in minisign's own file formats.
function testKey(): { key: ReleaseKey; file: string; secret: KeyObject; id: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const file = `untrusted comment: minisign public key ${id.toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
  return { key: parsePublicKey(file), file, secret: privateKey, id };
}

function minisig(data: Buffer, k: { secret: KeyObject; id: Buffer }, comment: string, algorithm = "Ed"): string {
  const signature = sign(null, data, k.secret);
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), k.secret);
  return [
    "untrusted comment: signature from minisign secret key",
    Buffer.concat([Buffer.from(algorithm), k.id, signature]).toString("base64"),
    `trusted comment: ${comment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

const SUMS = Buffer.from("0123abcd  BubbleFacts-9.9.9-mac-arm64.dmg\n4567ef01  BubbleFacts-9.9.9-windows-x64.exe\n");

describe("checking a release's signature (update trust)", () => {
  const primary = testKey();
  const spare = testKey();

  it("reads a minisign public key file", () => {
    expect(primary.key.id).toBe(primary.id.toString("hex"));
    expect(Buffer.from(primary.key.publicKey, "base64")).toHaveLength(32);
    expect(() => parsePublicKey("untrusted comment: x\nbm90IGEga2V5")).toThrow();
  });

  it("accepts the release's checksums signed for its version, by either built-in key", () => {
    expect(checkReleaseSignature(SUMS, minisig(SUMS, primary, "bubblefacts 9.9.9"), "9.9.9", [primary.key, spare.key])).toEqual({ ok: true });
    expect(checkReleaseSignature(SUMS, minisig(SUMS, spare, "bubblefacts 9.9.9"), "v9.9.9", [primary.key, spare.key])).toEqual({ ok: true });
    expect(trustedCommentFor("v2.2.0")).toBe("bubblefacts 2.2.0");
  });

  it("refuses checksums changed after signing", () => {
    const changed = Buffer.from(SUMS.toString().replace("0123abcd", "0123abce"));
    expect(checkReleaseSignature(changed, minisig(SUMS, primary, "bubblefacts 9.9.9"), "9.9.9", [primary.key])).toEqual({ ok: false, reason: "bad signature" });
  });

  it("refuses an old release's good signature reused for another version", () => {
    expect(checkReleaseSignature(SUMS, minisig(SUMS, primary, "bubblefacts 9.9.8"), "9.9.9", [primary.key])).toEqual({ ok: false, reason: "wrong version" });
  });

  it("refuses a trusted comment edited after signing", () => {
    const edited = minisig(SUMS, primary, "bubblefacts 9.9.8").replace("trusted comment: bubblefacts 9.9.8", "trusted comment: bubblefacts 9.9.9");
    expect(checkReleaseSignature(SUMS, edited, "9.9.9", [primary.key])).toEqual({ ok: false, reason: "bad signature" });
  });

  it("refuses a key the app doesn't carry", () => {
    const stranger = testKey();
    expect(checkReleaseSignature(SUMS, minisig(SUMS, stranger, "bubblefacts 9.9.9"), "9.9.9", [primary.key])).toEqual({ ok: false, reason: "unknown key" });
  });

  it("says the hashed mode isn't supported, and anything else is malformed", () => {
    expect(checkReleaseSignature(SUMS, minisig(SUMS, primary, "bubblefacts 9.9.9", "ED"), "9.9.9", [primary.key])).toEqual({ ok: false, reason: "unsupported" });
    expect(checkReleaseSignature(SUMS, "", "9.9.9", [primary.key])).toEqual({ ok: false, reason: "malformed" });
    expect(checkReleaseSignature(SUMS, "<html>Not Found</html>", "9.9.9", [primary.key])).toEqual({ ok: false, reason: "malformed" });
    const short = minisig(SUMS, primary, "bubblefacts 9.9.9").split("\n");
    short[3] = "AAAA";
    expect(checkReleaseSignature(SUMS, short.join("\n"), "9.9.9", [primary.key])).toEqual({ ok: false, reason: "malformed" });
  });
});
