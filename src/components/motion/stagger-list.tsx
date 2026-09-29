"use client";

import { motion } from "framer-motion";

/**
 * The ONE motion primitive this app uses for entrance — Phase 2 UI
 * refinement ("subtle motion for card/list entrance... not everywhere").
 * A short (150ms), small (6px), staggered fade — never a bounce, spin, or
 * parallax. Dialogs/sheets already animate via the existing Tailwind
 * `data-open:animate-in` classes (base-ui's own transition model) and are
 * deliberately left alone here, so there's only one motion system per
 * surface, not two competing ones.
 *
 * `StaggerList`/`StaggerUl` wrap a grid or list of Server-Component
 * children (KPI cards, ranked rows) — the children stay server-rendered;
 * only this thin client wrapper adds the stagger. `StaggerItem` marks each
 * direct child that should animate in.
 */
const containerVariants = { hidden: {}, show: { transition: { staggerChildren: 0.035 } } };
const itemVariants = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.15 } } };

export function StaggerList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial="hidden" animate="show" variants={containerVariants}>
      {children}
    </motion.div>
  );
}

export function StaggerUl({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.ul className={className} initial="hidden" animate="show" variants={containerVariants}>
      {children}
    </motion.ul>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  const Comp = as === "li" ? motion.li : motion.div;
  return (
    <Comp className={className} variants={itemVariants}>
      {children}
    </Comp>
  );
}

/**
 * A single fading-in block — for a whole section settling into place on
 * load (e.g. a dashboard `SummarySection`) where the caller doesn't control
 * each individual child's markup (so `StaggerList`/`StaggerItem` — which
 * need every direct child to be a `motion.*` element — don't apply
 * cleanly). Same 150ms/6px motion language, just not staggered.
 */
export function FadeIn({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay }}
    >
      {children}
    </motion.div>
  );
}
