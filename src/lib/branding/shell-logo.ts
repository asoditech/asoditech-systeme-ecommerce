/**
 * In-app company logo (docs/decisions/platform-order-sync-and-branding.md,
 * option A — owner decision 2026-10-16): the platform admin grants it per
 * company (Tenant.brandLogoGranted); the company sets the image itself in
 * Paramètres (BusinessSettings.logoUrl — the same logo as its documents,
 * validated there: https URL, or a picked file resized to a small PNG data
 * URI). Pure — client-safe.
 */

// Raster images only: an <img> never runs SVG scripts, but an SVG data URI
// is still excluded from the shell to keep the accepted surface minimal.
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_LENGTH = 1_500_000;

/**
 * The logo the app shell may show, or null → the ASODITECH mark.
 * Null unless the platform granted it AND the stored value is a usable
 * https URL or raster data URI.
 */
export function shellLogoSrc(granted: boolean, logoUrl: string | null | undefined): string | null {
  if (!granted || !logoUrl) return null;
  const value = logoUrl.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return null;
  if (value.startsWith("https://")) {
    try {
      return new URL(value).protocol === "https:" ? value : null;
    } catch {
      return null;
    }
  }
  return DATA_IMAGE.test(value) ? value : null;
}
