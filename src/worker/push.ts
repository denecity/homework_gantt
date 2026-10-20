// Web Push from a Worker: VAPID (RFC 8292) auth + aes128gcm payload encryption (RFC 8291),
// built on WebCrypto so it needs no Node polyfills.

const enc = new TextEncoder();

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** Single-block HKDF, which is all RFC 8291 needs (outputs are ≤ 32 bytes). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point
  privateKey: string; // base64url, PKCS#8
  subject: string; // mailto: or https: contact
}

/** Generates a VAPID keypair in the format the env vars expect. */
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: bytesToB64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    privateKey: bytesToB64url((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
    subject,
  };
}

async function vapidHeader(endpoint: string, keys: VapidKeys): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = enc.encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    b64urlToBytes(keys.privateKey) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput);
  return `vapid t=${header}.${payload}.${bytesToB64url(sig)}, k=${keys.publicKey}`;
}

/** Encrypts `payload` for a subscription, returning an aes128gcm body (RFC 8188 framing). */
async function encryptPayload(payload: string, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);

  const asPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asPair.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPair.privateKey, 256),
  );

  // RFC 8291 §3.3
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), Uint8Array.of(2)); // 0x02 = last record
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, key, plaintext as BufferSource),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** The subscription is gone and the device row should be deleted. */
  gone: boolean;
  error?: string;
}

export async function sendPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
  keys: VapidKeys,
  ttlSeconds = 12 * 3600,
): Promise<PushResult> {
  try {
    const body = await encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(subscription.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "normal",
      },
      body: body as BodyInit,
    });
    if (res.ok) return { ok: true, status: res.status, gone: false };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: text };
  } catch (error) {
    return { ok: false, status: 0, gone: false, error: String(error) };
  }
}
