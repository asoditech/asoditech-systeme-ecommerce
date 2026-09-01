"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./preloader.module.css";

/**
 * ASODITECH "orbit" preloader (option D) — light ground, black wordmark,
 * matching the /connexion page.
 *
 * The rocket glyph IS the "A" of the ASODITECH wordmark. It pops into its
 * resting slot, pauses a beat while the engine spins up, then flies a
 * single circular loop that arcs up and over the rest of the wordmark
 * (S‑O‑D‑I‑T‑E‑C‑H) and drops back into the exact spot it started from —
 * at which point it simply *is* the A. Because the dock sits at the
 * circle's leftmost point, the loop's start/end tangent is straight up,
 * matching the rocket art with no rotation fudge. The dock position is
 * measured once at mount (FLIP) so the loop is pixel‑accurate at any
 * viewport size. Motion is `requestAnimationFrame`‑driven (not CSS
 * keyframes) because position, rotation, scale and the exhaust trail all
 * derive from the same per‑frame circle parametrisation.
 *
 * Timing contract (same as the previous preloader): the overlay stays up
 * for the LONGER of (a) the intro's own minimum duration and (b) `ready`
 * becoming true. A fast login never gets held past the intro; a slow one
 * keeps the overlay on screen with a subtle "still working" pulse on the
 * progress bar, and only exits once `ready` flips.
 */

// Keep in sync with the CSS.
const APPEAR_MS = 260; // rocket pops into its slot
const PAUSE_MS = 180; // brief hold, engine spins up
const LOOP_MS = 1550; // one full revolution around the wordmark
const PEAK_SCALE = 2.0; // rocket size at the top of the loop
const TOTAL_MOTION_MS = APPEAR_MS + PAUSE_MS + LOOP_MS;

const LETTERS_START_MS = 100; // first letter, after the rocket lands
const LETTER_STAGGER_MS = 55;
const LETTER_DURATION_MS = 480;
const PARTICLE_LIFE_MS = 560;

/** Minimum time the overlay stays up — covers the loop plus every letter
 * settling, plus a short beat. Exit happens at max(this, whenReady). */
const MIN_DURATION_MS =
  TOTAL_MOTION_MS + LETTERS_START_MS + 7 * LETTER_STAGGER_MS + LETTER_DURATION_MS + 650;
const REDUCED_MIN_MS = 600;
const EXIT_DURATION_MS = 650;

// Adaptive "still working" cue, only relevant once a load runs past the
// intro. Subtle, capped steps — never a fake timer.
const WAIT_TIER_1_MS = 1800;
const WAIT_TIER_2_MS = 4500;

const HERO_RADIUS_VW = 0.56; // loop radius as a fraction of the wordmark width
const HERO_RADIUS_VH = 0.3; // …capped at this fraction of viewport height

const LETTERS = ["S", "O", "D", "I", "T", "E", "C", "H"] as const;

// left%/width% of each glyph relative to the full wordmark, from the source logo.
const POSITIONS: Record<string, { left: number; width: number }> = {
  rocket: { left: 0.0, width: 13.846 },
  S: { left: 13.706, width: 10.28 },
  O: { left: 24.336, width: 12.727 },
  D: { left: 38.182, width: 11.818 },
  I: { left: 51.189, width: 3.566 },
  T: { left: 55.455, width: 10.559 },
  E: { left: 66.643, width: 10.0 },
  C: { left: 77.133, width: 11.259 },
  H: { left: 88.951, width: 11.049 },
};

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

interface Particle {
  el: HTMLDivElement;
  born: number;
  x: number;
  y: number;
  driftX: number;
  driftY: number;
}

interface PreloaderProps {
  /** Set to false to hold the preloader open until the app is actually ready. */
  ready?: boolean;
  /** Called once the exit animation finishes and the preloader has unmounted. */
  onFinish?: () => void;
}

export default function Preloader({ ready = true, onFinish }: PreloaderProps) {
  const [exiting, setExiting] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [waitTier, setWaitTier] = useState<0 | 1 | 2>(0);

  const rocketRef = useRef<HTMLDivElement>(null);
  const thrustRef = useRef<HTMLDivElement>(null);
  const dockGlowRef = useRef<HTMLDivElement>(null);
  const shockRef = useRef<HTMLDivElement>(null);
  const trailLayerRef = useRef<HTMLDivElement>(null);
  const pfillRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const letterRefs = useRef<(HTMLImageElement | null)[]>([]);

  // The single time reference every timer below measures against. Captured
  // in the layout effect (which runs before the passive effects) so
  // "wait for the longer of intro vs ready" stays correct.
  const mountTimeRef = useRef<number>(0);
  const reducedRef = useRef(false);

  // ---- the flight animation ----
  useLayoutEffect(() => {
    mountTimeRef.current = performance.now();

    const rocket = rocketRef.current;
    const thrust = thrustRef.current;
    const dockGlow = dockGlowRef.current;
    const shock = shockRef.current;
    const trailLayer = trailLayerRef.current;
    const pfill = pfillRef.current;
    const pctEl = pctRef.current;
    const logoWrap = rocket?.parentElement;
    if (!rocket || !thrust || !dockGlow || !shock || !trailLayer || !pfill || !pctEl || !logoWrap) {
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedRef.current = reduced;

    const finalRect = rocket.getBoundingClientRect();
    const dock = { x: finalRect.left + finalRect.width / 2, y: finalRect.top + finalRect.height / 2 };
    const wordmarkRect = logoWrap.getBoundingClientRect();

    // dock sits at the circle's leftmost point → the loop arcs up and over
    // the rest of the wordmark before dropping back onto it.
    const R = Math.min(wordmarkRect.width * HERO_RADIUS_VW, window.innerHeight * HERO_RADIUS_VH);
    const cx = dock.x + R;
    const cy = dock.y;

    const settleLetters = () => {
      letterRefs.current.forEach((l, i) => {
        if (!l) return;
        l.style.animationDelay = `${LETTERS_START_MS + i * LETTER_STAGGER_MS}ms`;
        l.style.animationDuration = `${LETTER_DURATION_MS}ms`;
        l.classList.add(styles.settled);
      });
    };

    if (reduced) {
      rocket.style.opacity = "1";
      rocket.style.transform = "translate(0, 0) scale(1) rotate(0deg)";
      dockGlow.classList.add(styles.pulse);
      settleLetters();
      pfill.style.width = "100%";
      pctEl.textContent = "100";
      return;
    }

    let raf = 0;
    let lastParticleAt = -Infinity;
    let landed = false;
    const particles: Particle[] = [];
    const t0 = mountTimeRef.current;

    const frame = (now: number) => {
      const elapsed = now - t0;

      if (elapsed < APPEAR_MS) {
        const p = easeOutCubic(Math.min(1, elapsed / APPEAR_MS));
        rocket.style.opacity = String(p);
        rocket.style.transform = `translate(0px, 0px) scale(${0.7 + 0.3 * p}) rotate(0deg)`;
        thrust.style.opacity = "0";
      } else if (elapsed < APPEAR_MS + PAUSE_MS) {
        rocket.style.opacity = "1";
        rocket.style.transform = "translate(0px, 0px) scale(1) rotate(0deg)";
        const pp = (elapsed - APPEAR_MS) / PAUSE_MS;
        thrust.style.opacity = String(0.25 * pp);
        thrust.style.height = `${6 * pp}px`;
      } else if (elapsed < TOTAL_MOTION_MS) {
        const raw = (elapsed - APPEAR_MS - PAUSE_MS) / LOOP_MS;
        const eased = easeInOutCubic(raw);
        const theta = Math.PI + eased * Math.PI * 2;

        const x = cx + R * Math.cos(theta);
        const y = cy + R * Math.sin(theta);
        const dxdt = -Math.sin(theta);
        const dydt = Math.cos(theta);
        const angle = (Math.atan2(dydt, dxdt) * 180) / Math.PI + 90;
        const scale = 1 + (PEAK_SCALE - 1) * Math.sin(raw * Math.PI);

        rocket.style.opacity = "1";
        rocket.style.transform = `translate(${x - dock.x}px, ${y - dock.y}px) scale(${scale}) rotate(${angle}deg)`;
        thrust.style.opacity = String(0.6 + 0.4 * Math.sin(elapsed * 0.025));
        thrust.style.height = `${12 + scale * 8}px`;

        if (raw < 0.96 && elapsed - lastParticleAt > 24) {
          lastParticleAt = elapsed;
          const el = document.createElement("div");
          el.className = styles.particle;
          const size = 4 + Math.random() * 5;
          el.style.width = `${size}px`;
          el.style.height = `${size}px`;
          trailLayer.appendChild(el);
          particles.push({
            el,
            born: now,
            x: x + (Math.random() - 0.5) * 8,
            y: y + (Math.random() - 0.5) * 8,
            driftX: -dxdt * 26 + (Math.random() - 0.5) * 10,
            driftY: -dydt * 26 + (Math.random() - 0.5) * 10,
          });
        }
      } else if (!landed) {
        landed = true;
        rocket.style.opacity = "1";
        rocket.style.transform = "translate(0px, 0px) scale(1) rotate(0deg)";
        thrust.style.opacity = "0";
        dockGlow.classList.add(styles.pulse);
        shock.classList.add(styles.go);
        pfill.style.width = "100%";
        pctEl.textContent = "100";
        settleLetters();
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const pt = particles[i];
        const age = now - pt.born;
        if (age >= PARTICLE_LIFE_MS) {
          pt.el.remove();
          particles.splice(i, 1);
          continue;
        }
        const p = age / PARTICLE_LIFE_MS;
        const ease = 1 - Math.pow(1 - p, 2);
        pt.el.style.transform = `translate(-50%, -50%) translate(${pt.x + pt.driftX * ease}px, ${pt.y + pt.driftY * ease}px) scale(${1 - 0.8 * ease})`;
        pt.el.style.opacity = String(1 - p);
      }

      if (!landed) {
        const pct = Math.round(Math.min(1, elapsed / TOTAL_MOTION_MS) * 100);
        pfill.style.width = `${pct}%`;
        pctEl.textContent = String(pct);
      }

      if (elapsed < TOTAL_MOTION_MS || particles.length > 0) {
        raf = requestAnimationFrame(frame);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- exit: the longer of the intro minimum and `ready` ----
  useEffect(() => {
    if (!ready) return;
    const min = reducedRef.current ? REDUCED_MIN_MS : MIN_DURATION_MS;
    const remaining = Math.max(0, min - (performance.now() - mountTimeRef.current));
    const t = setTimeout(() => setExiting(true), remaining);
    return () => clearTimeout(t);
  }, [ready]);

  // ---- "still working" cue while a slow load runs past the intro ----
  useEffect(() => {
    if (ready) return;
    const elapsed = performance.now() - mountTimeRef.current;
    const toSettle = Math.max(0, MIN_DURATION_MS - elapsed);
    const toTier1 = Math.max(0, MIN_DURATION_MS + WAIT_TIER_1_MS - elapsed);
    const toTier2 = Math.max(0, MIN_DURATION_MS + WAIT_TIER_1_MS + WAIT_TIER_2_MS - elapsed);
    const settle = setTimeout(() => setWaiting(true), toSettle);
    const tier1 = setTimeout(() => setWaitTier((t) => (t < 1 ? 1 : t)), toTier1);
    const tier2 = setTimeout(() => setWaitTier((t) => (t < 2 ? 2 : t)), toTier2);
    return () => {
      clearTimeout(settle);
      clearTimeout(tier1);
      clearTimeout(tier2);
    };
  }, [ready]);

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(() => {
      setMounted(false);
      onFinish?.();
    }, EXIT_DURATION_MS);
    return () => clearTimeout(t);
  }, [exiting, onFinish]);

  if (!mounted) return null;

  return (
    <div
      className={`${styles.preloader} ${exiting ? styles.exiting : ""}`}
      data-waiting={waiting ? "true" : undefined}
      data-tier={waitTier}
      role="status"
      aria-label="Chargement d'ASODITECH"
    >
      <div className={styles.trailLayer} ref={trailLayerRef} aria-hidden="true" />

      <div className={styles.center}>
        <div className={styles.logoWrap}>
          <div
            ref={rocketRef}
            className={styles.rocket}
            style={{ left: `${POSITIONS.rocket.left}%`, width: `${POSITIONS.rocket.width}%` }}
          >
            <div ref={thrustRef} className={styles.thrust} aria-hidden="true" />
            <img src="/preloader-light/rocket.png" alt="" aria-hidden="true" className={styles.rocketImg} />
            <div ref={dockGlowRef} className={styles.dockGlow} aria-hidden="true" />
            <div ref={shockRef} className={styles.shock} aria-hidden="true" />
          </div>

          {LETTERS.map((letter, i) => (
            <img
              key={letter}
              ref={(el) => {
                letterRefs.current[i] = el;
              }}
              src={`/preloader-light/${letter}.png`}
              alt=""
              aria-hidden="true"
              className={`${styles.glyph} ${styles.letter}`}
              style={{ left: `${POSITIONS[letter].left}%`, width: `${POSITIONS[letter].width}%` }}
            />
          ))}
        </div>
      </div>

      <div className={styles.status}>
        <div className={styles.progressTrack}>
          <div ref={pfillRef} className={styles.progressFill} />
          <div className={styles.progressPulse} aria-hidden="true" />
        </div>
        <div className={styles.pct}>
          <span ref={pctRef}>0</span>%
        </div>
      </div>
    </div>
  );
}
