// Service worker registration, install prompt and push subscription.

const SW_URL = "/sw.js";

export type PushState = "unsupported" | "unconfigured" | "default" | "denied" | "subscribed";

let installPrompt: (Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }) | null = null;

export function watchInstallPrompt(onChange: () => void) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as typeof installPrompt;
    onChange();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    onChange();
  });
}

export const canInstall = () => installPrompt !== null;

export const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export async function promptInstall(): Promise<boolean> {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === "accepted";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    // A new worker takes over as soon as it is ready, so a deploy is never half-applied.
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker.controller) next.postMessage({ type: "skip-waiting" });
      });
    });
    return reg;
  } catch (error) {
    console.warn("service worker registration failed", error);
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const b64 = (buf: ArrayBuffer | null) =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";

export interface PushConfig {
  publicKey: string | null;
  configured: boolean;
  devices: number;
}

export async function pushState(config: PushConfig): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (!config.configured || !config.publicKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "subscribed" : "default";
}

/** Asks for permission (must be called from a click) and registers the subscription with the Worker. */
export async function subscribe(config: PushConfig): Promise<PushState> {
  if (!config.publicKey) throw new Error("Push is not configured on the server.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!reg) throw new Error("No service worker.");
  await navigator.serviceWorker.ready;

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource,
    }));

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: { p256dh: b64(sub.getKey("p256dh")), auth: b64(sub.getKey("auth")) },
      label: `${navigator.platform || "device"}${isInstalled() ? " (app)" : ""}`,
    }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not register device");
  return "subscribed";
}

export async function unsubscribe(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return "default";
}
