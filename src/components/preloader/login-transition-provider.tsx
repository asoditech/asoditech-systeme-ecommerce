"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Preloader from "./preloader";

interface LoginTransitionContextValue {
  /** Call once a login is confirmed to still be in flight toward a successful navigation. */
  beginLoginTransition: () => void;
  /** Call once the login attempt has settled without a page navigation (error, thrown exception, etc.). */
  resolveLoginTransition: () => void;
  /** Tear the transition down at once, no exit animation — used when a login comes back a failure. */
  cancelLoginTransition: () => void;
}

const LoginTransitionContext = createContext<LoginTransitionContextValue | null>(null);

/**
 * Mounted once in the root layout so it survives the /connexion →
 * /tableau-de-bord navigation itself (the page content underneath does
 * not). Readiness is driven by real signals only:
 *  - success: `usePathname()` changing away from the page that started the
 *    transition IS the app telling us the destination route has actually
 *    committed — no timer involved.
 *  - failure: `cancelLoginTransition()`, called by the login form the
 *    moment the server action returns an error result. The form only calls
 *    `beginLoginTransition()` once an attempt has stayed in flight long
 *    enough that a rejected credential would already have come back, so a
 *    failed login normally never starts the transition at all.
 */
export function LoginTransitionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);
  const startPathRef = useRef<string | null>(null);

  const beginLoginTransition = useCallback(() => {
    startPathRef.current = pathname;
    setReady(false);
    setActive(true);
    // Force a fresh Preloader instance even if one is still mid-exit from a
    // previous (failed) attempt, so a quick retry gets its own clean intro
    // instead of inheriting an already-exiting instance.
    setInstanceKey((key) => key + 1);
  }, [pathname]);

  const resolveLoginTransition = useCallback(() => {
    setReady(true);
  }, []);

  const cancelLoginTransition = useCallback(() => {
    setActive(false);
    setReady(false);
    startPathRef.current = null;
  }, []);

  // The authoritative "navigation actually landed" signal — fires once the
  // committed route differs from the one the transition started on.
  useEffect(() => {
    if (active && startPathRef.current !== null && pathname !== startPathRef.current) {
      setReady(true);
    }
  }, [active, pathname]);

  const handleFinish = useCallback(() => {
    setActive(false);
    setReady(false);
    startPathRef.current = null;
  }, []);

  return (
    <LoginTransitionContext.Provider
      value={{ beginLoginTransition, resolveLoginTransition, cancelLoginTransition }}
    >
      {children}
      {active && <Preloader key={instanceKey} ready={ready} onFinish={handleFinish} />}
    </LoginTransitionContext.Provider>
  );
}

export function useLoginTransition() {
  const ctx = useContext(LoginTransitionContext);
  if (!ctx) {
    throw new Error("useLoginTransition must be used within a LoginTransitionProvider");
  }
  return ctx;
}
