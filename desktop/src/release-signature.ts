import { createPublicKey, verify } from "crypto";

/**
 * Checking a release's minisign signature (the update-trust design): a
 * release's SHA256SUMS.txt is signed on the maintainer's computer, never on a
 * runner, and the app accepts an update only when that signature checks out
 * against a key built into the app. The existing SHA-256 check then covers
 * each installer.
 *
 * Nothing calls this yet: the real keys come first. It checks minisign's
 * legacy mode (`minisign -S -l`), a plain Ed25519 signature over the file,
 * because Electron's crypto has no BLAKE2b-512 for the default mode. Node's
 * own Ed25519 does the work; no new dependency.
 *
 * File formats (minisign's own):
 * - public key, second line in base64: "Ed", 8-byte key ID, 32-byte key;
 * - signature: an untrusted comment line, then base64 of "Ed" (or "ED" for
 *   the hashed mode), the 8-byte key ID and the 64-byte signature, then
 *   "trusted comment: ...", then base64 of a 64-byte signature over the
 *   signature followed by the trusted comment's text.
 */

export interface ReleaseKey {
  /** The 8-byte key ID as minisign stores it, in hex. */
  id: string;
  /** The 32-byte Ed25519 public key, base64. */
  publicKey: string;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "malformed" | "unsupported" | "unknown key" | "bad signature" | "wrong version" };

const TRUSTED = "trusted comment: ";

/** A minisign public key file (or just its base64 line) as a ReleaseKey. Throws on anything else. */
export function parsePublicKey(text: string): ReleaseKey {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("untrusted comment:"))[0] ?? "";
  const raw = Buffer.from(line, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("Not a minisign public key");
  return { id: raw.subarray(2, 10).toString("hex"), publicKey: raw.subarray(10).toString("base64") };
}

const keyObject = (key: ReleaseKey) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key.publicKey, "base64").toString("base64url") }, format: "jwk" });

/** The trusted comment a release's signature must carry: it ties the signature to one version. */
export const trustedCommentFor = (version: string) => `bubblefacts ${version.replace(/^v/, "")}`;

/**
 * Whether `minisig` is a good signature of `sums` (the exact bytes of
 * SHA256SUMS.txt) by one of `keys`, made for `version`. The reason is for the
 * log only; the streamer sees one plain message whatever it is.
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
    // The file's signature, then the one over signature + trusted comment, which keeps the comment from being swapped.
    if (!verify(null, sums, pub, signature) || !verify(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), pub, global)) {
      return { ok: false, reason: "bad signature" };
    }
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return comment === trustedCommentFor(version) ? { ok: true } : { ok: false, reason: "wrong version" };
}
