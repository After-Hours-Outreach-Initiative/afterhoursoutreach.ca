const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export function nonce() {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function digest(value: string) {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export async function challenge(verifier: string) {
  return (await digest(verifier))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function key(secret: string) {
  return crypto.subtle.importKey("raw", bytes(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encryptToken(
  secret: string,
  token: string,
  owner: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(owner) },
    await key(secret),
    encoder.encode(token),
  );
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function decryptToken(
  secret: string,
  token: string,
  owner: string,
) {
  const [iv, ciphertext] = token.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv), additionalData: encoder.encode(owner) },
      await key(secret),
      bytes(ciphertext),
    ),
  );
}
