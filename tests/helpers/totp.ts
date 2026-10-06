import { createHmac } from "node:crypto";

/** Generate an authenticator code in tests without an app or live account. */
export function totpFromSetupKey(key: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const letter of key.replace(/=+$/, ""))
    bits += alphabet.indexOf(letter).toString(2).padStart(5, "0");
  const bytes = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const view = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength,
  );
  return String((view.getUint32(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
