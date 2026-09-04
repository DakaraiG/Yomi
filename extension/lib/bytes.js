// Base64 <-> bytes, for everything crossing between the service worker and the
// offscreen document: messages are serialised, and an ArrayBuffer arrives as an
// empty object with no error raised.

const CHUNK = 0x8000;   // apply() on a huge array overflows the argument list

export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
