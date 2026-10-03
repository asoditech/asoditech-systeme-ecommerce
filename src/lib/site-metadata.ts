import type { Metadata } from "next";

/**
 * App-wide sharing/branding metadata (link previews, home-screen shortcut).
 *
 * Images come from the Next.js file conventions in src/app — icon.png (tab),
 * apple-icon.png (iOS home screen), opengraph-image.png / twitter-image.png
 * (link previews, 1200×630, generated from public/logos/logo.png) — and the
 * PWA icons in public/icons (from public/logos/IconAwithbackground.png). No
 * new brand mark: every image is a resize of an existing approved logo.
 *
 * Link-preview crawlers (WhatsApp, Facebook, LinkedIn, X…) need ABSOLUTE
 * image URLs, so `metadataBase` is the deployment's own public origin:
 * APP_URL (already the canonical origin used for e-mail links and OAuth
 * callbacks). Only its origin is used — a path, query or credentials in the
 * value can never leak into the page.
 */

export const SITE_NAME = "ASODITECH";
export const SITE_TITLE = "ASODITECH — Gestion E-commerce";
export const SITE_DESCRIPTION =
  "Gérez vos commandes, votre stock, vos ventes en ligne et en magasin, la livraison et vos rapports au même endroit.";

/** The public origin for absolute metadata URLs; falls back to localhost when APP_URL is missing or not http(s). */
export function siteOrigin(appUrl: string | undefined): URL {
  try {
    const url = new URL(appUrl ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return new URL(url.origin);
  } catch {
    // fall through
  }
  return new URL("http://localhost:3000");
}

export function buildRootMetadata(appUrl: string | undefined): Metadata {
  return {
    metadataBase: siteOrigin(appUrl),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    appleWebApp: { title: SITE_NAME, capable: true, statusBarStyle: "default" },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      locale: "fr_MA",
      url: "/",
    },
    twitter: {
      card: "summary_large_image",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    },
  };
}
