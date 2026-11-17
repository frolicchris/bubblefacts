import { createPublicKey, verify } from "crypto";

// A release's minisign signature on SHA256SUMS.txt, signed on the maintainer's computer (never a runner)
// and checked against keys built into the app; the SHA-256 check then covers each installer. Unused until real keys
// Legacy mode only (`minisign -S -l`, plain Ed25519): Electron's crypto has no BLAKE2b-512 for the default mode
// Public key (second line, base64): "Ed", 8-byte key ID, 32-byte key
// Signature: untrusted comment; base64 "Ed" ("ED" hashed), key ID, 64-byte signature; "trusted comment: ...";
// base64 of a 64-byte signature over that signature plus the trusted comment's text

export interface ReleaseKey {
  /** 8-byte key ID as minisign stores it, hex */
  id: string;
  /** 32-byte Ed25519 public key, base64 */
  publicKey: string;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "malformed" | "unsupported" | "unknown key" | "bad signature" | "wrong version" };

const TRUSTED = "trusted comment: ";

/** A minisign public key file (or its base64 line) as a ReleaseKey; throws on anything else */
export function parsePublicKey(text: string): ReleaseKey {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("untrusted comment:"))[0] ?? "";
  const raw = Buffer.from(line, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("Not a minisign public key");
  return { id: raw.subarray(2, 10).toString("hex"), publicKey: raw.subarray(10).toString("base64") };
}

const keyObject = (key: ReleaseKey) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key.publicKey, "base64").toString("base64url") }, format: "jwk" });

/** The trusted comment a release's signature must carry, tying it to one version */
export const trustedCommentFor = (version: string) => `bubblefacts ${version.replace(/^v/, "")}`;

/**
 * Whether `minisig` signs `sums` (SHA256SUMS.txt's exact bytes) by one of `keys`, for `version`
 * The reason is for the log only; the streamer sees one plain message
 */
export function checkReleaseSignature(sums: Buffer, minisig: string, version: string, keys: ReleaseKey[]): SignatureCheck {
  const lines = minisig.split(/\r?\n/);
  if (lines.length < 4 || !lines[2].startsWith(TRUSTED)) return { ok: false, reason: "malformed" };
  const sig = Buffer.from(lines[1].trim(), "base64");
  const global = Buffer.from(lines[3].trim(), "base64");
  if (sig.length !== 74 || global.length !== 64) return { ok: false, reason: "malformed" };
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm === "ED") return { ok: false, reason: "unsupported" };
  if (algorithm !== "Ed") return { ok: false, reason: "malformed" };
  const key = keys.find((k) => k.id === sig.subarray(2, 10).toString("hex"));
  if (!key) return { ok: false, reason: "unknown key" };
  const signature = sig.subarray(10);
  const comment = lines[2].slice(TRUSTED.length);
  try {
    const pub = keyObject(key);
    // The file's signature, then the one over signature + trusted comment, so the comment can't be swapped
    if (!verify(null, sums, pub, signature) || !verify(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), pub, global)) {
      return { ok: false, reason: "bad signature" };
    }
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return comment === trustedCommentFor(version) ? { ok: true } : { ok: false, reason: "wrong version" };
}
