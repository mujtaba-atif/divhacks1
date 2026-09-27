"use client";

import { useEffect } from "react";
import type { AuthUser } from "@/lib/types";

const AUTH_CHANGE_EVENT = "rentescrow-auth-change";

/** A notification only: no credentials, tokens, or identity are stored here. */
export function announceSessionChange() {
  try { localStorage.setItem(AUTH_CHANGE_EVENT, crypto.randomUUID()); } catch { /* Periodic checks cover unavailable browser storage. */ }
}

export function redirectIfSignedOut(response: Response) {
  if (response.status === 401) window.location.replace("/login");
}

/** Revalidate background tabs so logout, expiry, and account switches clear stale views. */
export function useSessionGuard(user: AuthUser) {
  useEffect(() => {
    let disposed = false;
    let checking = false;
    async function check() {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (disposed) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) return;
        const data = await response.json() as { user?: AuthUser };
        if (!disposed && (data.user?.id !== user.id || data.user.role !== user.role)) window.location.replace("/");
      } catch { /* A transient outage should not discard an unsent draft. */ }
      finally { checking = false; }
    }
    const changed = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGE_EVENT) window.location.replace("/");
    };
    const revalidate = () => { void check(); };
    const interval = window.setInterval(revalidate, 15_000);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    void check();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [user.id, user.role]);
}
