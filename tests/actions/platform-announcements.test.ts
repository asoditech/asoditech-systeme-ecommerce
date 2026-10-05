import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Platform announcement bar (docs/adr/0059).
 *
 * The `platform_announcements` table comes from a migration that is NOT
 * applied to the local test database (this change ships the migration file
 * only). So ONLY `prismaBase.platformAnnouncement` is replaced by an
 * in-memory store; sessions, users, permissions, the platform-admin guard
 * and audit events all run against the real test database as usual.
 */
type Row = {
  id: string;
  message: string;
  type: "INFO" | "MAINTENANCE" | "NEW_FEATURE";
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  actionLabel: string | null;
  actionUrl: string | null;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const store = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  let seq = 0;
  let clock = Date.UTC(2026, 9, 1, 8, 0, 0);
  const tick = () => new Date((clock += 1000));
  const calls: string[] = [];
  const delegate = {
    async create({ data }: { data: Partial<Row> }) {
      calls.push("create");
      const at = tick();
      const row = {
        id: `ann${++seq}`,
        type: "INFO",
        isPublished: false,
        startsAt: null,
        endsAt: null,
        actionLabel: null,
        actionUrl: null,
        createdById: null,
        updatedById: null,
        ...data,
        createdAt: data.createdAt ?? at,
        updatedAt: at,
      } as Row;
      rows.set(row.id, row);
      return { ...row };
    },
    async findUnique({ where }: { where: { id: string } }) {
      calls.push("findUnique");
      const r = rows.get(where.id);
      return r ? { ...r } : null;
    },
    async findMany() {
      calls.push("findMany");
      return [...rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((r) => ({ ...r }));
    },
    async update({ where, data }: { where: { id: string }; data: Partial<Row> }) {
      calls.push("update");
      const r = rows.get(where.id);
      if (!r) throw new Error("not found");
      const next = { ...r, ...data, updatedAt: tick() };
      rows.set(r.id, next);
      return { ...next };
    },
    async delete({ where }: { where: { id: string } }) {
      calls.push("delete");
      const r = rows.get(where.id);
      if (!r) throw new Error("not found");
      rows.delete(where.id);
      return { ...r };
    },
  };
  return {
    rows,
    calls,
    delegate,
    reset() {
      rows.clear();
      calls.length = 0;
    },
  };
});

vi.mock("@/lib/prisma", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/prisma")>();
  const prismaBase = new Proxy(mod.prismaBase, {
    get(target, prop) {
      if (prop === "platformAnnouncement") return store.delegate;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...mod, prismaBase };
});

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import {
  createAnnouncementAction,
  deleteAnnouncementAction,
  setAnnouncementPublishedAction,
  updateAnnouncementAction,
} from "@/actions/announcements";
import { getActiveAnnouncement } from "@/lib/queries/announcements";
import { AppShell } from "@/components/layout/app-shell";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import PlatformAnnouncementsPage from "@/app/platform/annonces/page";
import {
  ANNOUNCEMENT_DISMISS_COOKIE,
  addDismissedKey,
  announcementDismissKey,
  announcementStatus,
  isAnnouncementLive,
  localInputToIso,
  isoToLocalInput,
  parseDismissedCookie,
  pickAnnouncement,
  safeAnnouncementUrl,
} from "@/lib/announcements";
import { OPEN_SUPPORT_EVENT, openSupportWidget } from "@/lib/support/open-support";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  store.reset();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const VALID = { message: "Maintenance prévue dimanche 2h–4h.", type: "MAINTENANCE", isPublished: "true" };

async function seedAnnouncement(over: Partial<Row> = {}) {
  return store.delegate.create({ data: { message: "Bienvenue", type: "INFO", isPublished: true, ...over } });
}

describe("authorization — only platform admins mutate announcements", () => {
  const tenantRoles = ["OWNER", "ADMIN", "MANAGER"] as const;

  it.each(tenantRoles)("a tenant %s (not platform admin) cannot create, edit, publish, disable or delete — and nothing is touched", async (role) => {
    const existing = await seedAnnouncement({ isPublished: true });
    store.calls.length = 0;
    await loginAsTestUser({ role, isPlatformAdmin: false });

    await expect(createAnnouncementAction(form(VALID))).rejects.toThrow(/Non autorisé/);
    await expect(updateAnnouncementAction(form({ ...VALID, id: existing.id }))).rejects.toThrow(/Non autorisé/);
    await expect(setAnnouncementPublishedAction({ id: existing.id, isPublished: false })).rejects.toThrow(/Non autorisé/);
    await expect(setAnnouncementPublishedAction({ id: existing.id, isPublished: true })).rejects.toThrow(/Non autorisé/);
    await expect(deleteAnnouncementAction({ id: existing.id })).rejects.toThrow(/Non autorisé/);

    expect(store.calls).toEqual([]); // rejected before any read or write
    expect(store.rows.get(existing.id)?.isPublished).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it("an OWNER of ANOTHER tenant gets the same refusal (no tenant id in any payload to tamper with)", async () => {
    await prisma.tenant.create({ data: { id: "tenant-b-ann", name: "B", slug: "tenant-b-ann" } });
    const existing = await seedAnnouncement();
    store.calls.length = 0;
    await loginAsTestUser({ role: "OWNER", tenantId: "tenant-b-ann", isPlatformAdmin: false });
    const tampered = form({ ...VALID, id: existing.id, tenantId: "default", isPlatformAdmin: "true" });
    await expect(updateAnnouncementAction(tampered)).rejects.toThrow(/Non autorisé/);
    await expect(deleteAnnouncementAction({ id: existing.id })).rejects.toThrow(/Non autorisé/);
    expect(store.calls).toEqual([]);
  });

  it("no session → refused", async () => {
    await expect(createAnnouncementAction(form(VALID))).rejects.toThrow();
    expect(store.calls).toEqual([]);
  });

  it("the /platform/annonces page itself refuses tenant users (redirect), even if reached directly", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });
    await expect(PlatformAnnouncementsPage()).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("a platform admin can create, edit, publish/disable and delete — each audited", async () => {
    const admin = await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

    const created = await createAnnouncementAction(form({ ...VALID, actionLabel: "Détails", actionUrl: "/rapports" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = store.rows.get(created.data.id)!;
    expect(row).toMatchObject({ message: VALID.message, type: "MAINTENANCE", isPublished: true, actionUrl: "/rapports", createdById: admin.id });

    const edited = await updateAnnouncementAction(form({ ...VALID, id: row.id, message: "Nouveau texte", type: "INFO", isPublished: "false" }));
    expect(edited.ok).toBe(true);
    expect(store.rows.get(row.id)).toMatchObject({ message: "Nouveau texte", type: "INFO", isPublished: false, actionUrl: null });

    expect((await setAnnouncementPublishedAction({ id: row.id, isPublished: true })).ok).toBe(true);
    expect(store.rows.get(row.id)?.isPublished).toBe(true);
    expect((await setAnnouncementPublishedAction({ id: row.id, isPublished: false })).ok).toBe(true);
    expect(store.rows.get(row.id)?.isPublished).toBe(false);

    expect((await deleteAnnouncementAction({ id: row.id })).ok).toBe(true);
    expect(store.rows.has(row.id)).toBe(false);

    const actions = (await prisma.auditEvent.findMany({ where: { entityType: "PlatformAnnouncement" }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
    expect(actions).toEqual(["announcement.created", "announcement.updated", "announcement.published", "announcement.unpublished", "announcement.deleted"]);
  });

  it("unknown ids are reported, not created", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    expect((await updateAnnouncementAction(form({ ...VALID, id: "nope" }))).ok).toBe(false);
    expect((await setAnnouncementPublishedAction({ id: "nope", isPublished: true })).ok).toBe(false);
    expect((await deleteAnnouncementAction({ id: "nope" })).ok).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});

describe("validation and URL safety", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com",
    "//evil.example.com",
    "/\\evil.example.com",
    "https://user:pass@example.com",
    "ftp://example.com",
    "rapports",
    "https://exa mple.com",
    "/rapports\nSet-Cookie: x",
  ])("rejects the unsafe action URL %j", async (url) => {
    expect(safeAnnouncementUrl(url)).toBeNull();
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const r = await createAnnouncementAction(form({ ...VALID, actionLabel: "Voir", actionUrl: url }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors?.actionUrl?.[0]).toMatch(/Lien invalide/);
    expect(store.rows.size).toBe(0);
  });

  it("accepts in-app paths and https URLs", () => {
    expect(safeAnnouncementUrl("/rapports?periode=mois")).toBe("/rapports?periode=mois");
    expect(safeAnnouncementUrl("https://asoditech.com/nouveautes")).toBe("https://asoditech.com/nouveautes");
  });

  it("requires a message, bounds its length, pairs label+URL, and orders the dates", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const bad = async (values: Record<string, string>) => {
      const r = await createAnnouncementAction(form({ ...VALID, ...values }));
      expect(r.ok).toBe(false);
      return r.ok ? {} : (r.fieldErrors ?? {});
    };
    expect(Object.keys(await bad({ message: "   " }))).toContain("message");
    expect(Object.keys(await bad({ message: "x".repeat(281) }))).toContain("message");
    expect(Object.keys(await bad({ type: "PROMO" }))).toContain("type");
    expect(Object.keys(await bad({ actionLabel: "Voir" }))).toContain("actionUrl");
    expect(Object.keys(await bad({ actionUrl: "/rapports" }))).toContain("actionLabel");
    expect(Object.keys(await bad({ startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T09:00:00.000Z" }))).toContain("endsAt");
    expect(Object.keys(await bad({ startsAt: "10/10/2026 10:00" }))).toContain("startsAt"); // no ambiguous, zone-less dates
    expect(store.rows.size).toBe(0);
  });

  it("a stored unsafe URL (e.g. written before validation) is never rendered", async () => {
    await seedAnnouncement({ actionLabel: "Cliquer", actionUrl: "javascript:alert(1)" });
    const a = await getActiveAnnouncement(new Set());
    expect(a).not.toBeNull();
    expect(a!.actionUrl).toBeNull();
    expect(a!.actionLabel).toBeNull();
    const html = renderToStaticMarkup(createElement(AnnouncementBar, { announcement: { ...a!, actionLabel: "Cliquer", actionUrl: "javascript:alert(1)" } }));
    expect(html).not.toContain("javascript:");
  });

  it("datetime-local values become unambiguous instants and back", () => {
    const iso = localInputToIso("2026-10-12T09:30");
    expect(iso).toMatch(/^2026-10-1\dT\d{2}:30:00\.000Z$/);
    expect(isoToLocalInput(iso)).toBe("2026-10-12T09:30");
    expect(localInputToIso("")).toBe("");
    expect(localInputToIso("not a date")).toBe("");
  });
});

describe("scheduling and selection", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");
  const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
  const base = { id: "a1", type: "INFO" as const, isPublished: true, startsAt: null, endsAt: null, createdAt: at(-48), updatedAt: at(-48) };

  it("live only when published and inside [startsAt, endsAt)", () => {
    expect(isAnnouncementLive(base, NOW)).toBe(true);
    expect(isAnnouncementLive({ ...base, isPublished: false }, NOW)).toBe(false);
    expect(isAnnouncementLive({ ...base, startsAt: at(1) }, NOW)).toBe(false);
    expect(isAnnouncementLive({ ...base, startsAt: NOW }, NOW)).toBe(true);
    expect(isAnnouncementLive({ ...base, endsAt: NOW }, NOW)).toBe(false);
    expect(isAnnouncementLive({ ...base, startsAt: at(-1), endsAt: at(1) }, NOW)).toBe(true);
    expect(announcementStatus({ ...base, isPublished: false }, NOW)).toBe("DRAFT");
    expect(announcementStatus({ ...base, startsAt: at(2) }, NOW)).toBe("SCHEDULED");
    expect(announcementStatus({ ...base, endsAt: at(-2) }, NOW)).toBe("EXPIRED");
    expect(announcementStatus(base, NOW)).toBe("LIVE");
  });

  it("deterministic choice: maintenance first, then most recent, then id — no carousel", () => {
    const rows = [
      { ...base, id: "info-new", createdAt: at(-1) },
      { ...base, id: "maint-old", type: "MAINTENANCE" as const, createdAt: at(-30) },
      { ...base, id: "feat", type: "NEW_FEATURE" as const, createdAt: at(-2) },
      { ...base, id: "maint-future", type: "MAINTENANCE" as const, startsAt: at(5) },
    ];
    expect(pickAnnouncement(rows, NOW)?.id).toBe("maint-old");
    expect(pickAnnouncement(rows.reverse(), NOW)?.id).toBe("maint-old"); // order-independent
    expect(pickAnnouncement(rows.filter((r) => r.type !== "MAINTENANCE"), NOW)?.id).toBe("feat");
    expect(pickAnnouncement([{ ...base, id: "b" }, { ...base, id: "a" }], NOW)?.id).toBe("a");
  });

  it("no live announcement → null (inactive, future, expired)", async () => {
    await seedAnnouncement({ isPublished: false });
    await seedAnnouncement({ startsAt: new Date(Date.now() + 3600_000) });
    await seedAnnouncement({ endsAt: new Date(Date.now() - 1000) });
    expect(await getActiveAnnouncement(new Set())).toBeNull();
  });

  it("the bar receives display fields only (no author ids)", async () => {
    const admin = await prisma.user.findFirst();
    await seedAnnouncement({ createdById: admin?.id ?? "u1", updatedById: "u2", message: "Hello" });
    const a = await getActiveAnnouncement(new Set());
    expect(Object.keys(a!).sort()).toEqual(["actionLabel", "actionUrl", "id", "key", "message", "type"]);
  });
});

describe("dismissal — per browser, never global", () => {
  it("a dismissed announcement is hidden for THIS browser only and stays published", async () => {
    const row = await seedAnnouncement({ message: "Nouveau module" });
    const key = announcementDismissKey(row);
    const cookie = addDismissedKey(null, key);

    expect(await getActiveAnnouncement(parseDismissedCookie(cookie))).toBeNull(); // this browser
    expect((await getActiveAnnouncement(new Set()))?.id).toBe(row.id); // any other browser / tenant
    expect(store.rows.get(row.id)?.isPublished).toBe(true);
    expect(store.calls).not.toContain("update");
  });

  it("dismissing the top announcement reveals the next one; editing a dismissed one shows it again", async () => {
    const maint = await seedAnnouncement({ type: "MAINTENANCE", message: "Maintenance" });
    const info = await seedAnnouncement({ type: "INFO", message: "Info" });
    const dismissed = parseDismissedCookie(addDismissedKey(null, announcementDismissKey(maint)));
    expect((await getActiveAnnouncement(dismissed))?.id).toBe(info.id);

    await store.delegate.update({ where: { id: maint.id }, data: { message: "Maintenance — horaire modifié" } });
    expect((await getActiveAnnouncement(dismissed))?.id).toBe(maint.id);
  });

  it("the cookie value is bounded and ignores garbage", () => {
    let v = "";
    for (let i = 0; i < 30; i++) v = addDismissedKey(v, `ann${i}.${1000 + i}`);
    const keys = parseDismissedCookie(v);
    expect(keys.size).toBe(20);
    expect(keys.has("ann29.1029")).toBe(true);
    expect(keys.has("ann0.1000")).toBe(false);
    expect(parseDismissedCookie("x;y~<script>~ann1.5")).toEqual(new Set(["ann1.5"]));
    expect(addDismissedKey("ann1.5", "bad key")).toBe("ann1.5");
  });

  it("the bar's dismiss control is an accessible button that only writes the browser cookie", () => {
    const src = read("src/components/layout/announcement-bar.tsx");
    expect(src).toContain('aria-label="Masquer cette annonce"');
    expect(src).toContain("document.cookie = `${ANNOUNCEMENT_DISMISS_COOKIE}=");
    expect(src).not.toMatch(/@\/actions\//); // no server mutation from the bar
  });
});

describe("app shell integration", () => {
  /** Every element in a rendered server tree, in document order. */
  function flatten(node: unknown, out: { type: unknown; props: Record<string, unknown> }[] = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const c of node) flatten(c, out);
      return out;
    }
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (!el.props) return out;
    out.push({ type: el.type, props: el.props });
    flatten(el.props.children, out);
    return out;
  }

  async function renderShell() {
    const user = await getCurrentUser();
    const tree = await AppShell({ user: user!, children: createElement("p", null, "page") });
    return flatten(tree);
  }

  it("no live announcement → no bar element at all (no empty bar, no spacing)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seedAnnouncement({ isPublished: false });
    const els = await renderShell();
    expect(els.some((e) => e.type === AnnouncementBar)).toBe(false);
  });

  it("a live announcement renders ONE bar at the very top of the content column, ABOVE the header, before the page content", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seedAnnouncement({ message: "Bonjour" });
    const els = await renderShell();
    const types = els.map((e) => (typeof e.type === "string" ? e.type : e.type === AnnouncementBar ? "BAR" : "C"));
    expect(types.filter((t) => t === "BAR")).toHaveLength(1);
    const header = types.indexOf("header");
    const bar = types.indexOf("BAR");
    const main = types.indexOf("main");
    expect(bar).toBeGreaterThanOrEqual(0);
    expect(header).toBeGreaterThan(bar); // bar first, then the sticky header
    expect(main).toBeGreaterThan(header);
  });

  it("looks like a system top bar: solid, high-contrast colours per type (light and dark)", () => {
    const render = (type: "INFO" | "MAINTENANCE" | "NEW_FEATURE") =>
      renderToStaticMarkup(createElement(AnnouncementBar, { announcement: { id: "a", key: "a.1", message: "m", type, actionLabel: null, actionUrl: null } }));
    expect(render("INFO")).toContain("bg-sky-600 text-white");
    expect(render("MAINTENANCE")).toContain("bg-amber-400 text-amber-950");
    expect(render("NEW_FEATURE")).toContain("bg-primary text-primary-foreground");
    for (const t of ["INFO", "MAINTENANCE", "NEW_FEATURE"] as const) expect(render(t)).not.toMatch(/bg-(sky|amber)-50\b|bg-primary\/5/);
  });

  it("a dismissed announcement (cookie) is not rendered server-side for that browser", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const row = await seedAnnouncement();
    mockCookieStore.set(ANNOUNCEMENT_DISMISS_COOKIE, addDismissedKey(null, announcementDismissKey(row)));
    const els = await renderShell();
    expect(els.some((e) => e.type === AnnouncementBar)).toBe(false);
  });

  it("a read failure renders no bar instead of breaking the shell", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const spy = vi.spyOn(store.delegate, "findMany").mockRejectedValueOnce(new Error('relation "platform_announcements" does not exist'));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const els = await renderShell();
    expect(els.some((e) => e.type === AnnouncementBar)).toBe(false);
    spy.mockRestore();
    err.mockRestore();
  });

  it("only the authenticated app shell mounts the bar (not /platform, not public pages)", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && fs.readFileSync(full, "utf8").includes("@/components/layout/announcement-bar")) importers.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, "src"));
    expect(importers).toEqual(["src/components/layout/app-shell.tsx"]);
    expect(read("src/app/(protected)/layout.tsx")).toContain("<AppShell");
    expect(read("src/app/platform/layout.tsx")).not.toContain("AppShell");
    expect(read("src/app/layout.tsx")).not.toMatch(/AnnouncementBar|AppShell/);
  });

  it("the global orange progress bar is untouched: still mounted by the root layout, fixed at the very top, separate from the bar", () => {
    const root = read("src/app/layout.tsx");
    expect(root).toContain("<TopProgressBar />");
    const progress = read("src/components/top-progress-bar.tsx");
    expect(progress).toContain('className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5"');
    // The bar sits in the normal flow below the header: never fixed/sticky, never the progress bar.
    const html = renderToStaticMarkup(
      createElement(AnnouncementBar, { announcement: { id: "a", key: "a.1", message: "m", type: "INFO", actionLabel: null, actionUrl: null } })
    );
    expect(html).not.toMatch(/\bfixed\b|\bsticky\b|z-\[60\]/);
    expect(read("src/components/layout/announcement-bar.tsx")).not.toMatch(/^import .*(top-progress-bar|TopProgressBar)/m);
  });
});

describe("« Contacter le support » opens the EXISTING SupportWidget", () => {
  const announcement = { id: "ann1", key: "ann1.1", message: "Maintenance ce soir", type: "MAINTENANCE" as const, actionLabel: null, actionUrl: null };

  it("renders a support button and an accessible landmark — no form, no second support flow", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBar, { announcement }));
    expect(html).toContain("Contacter le support");
    expect(html).toContain('aria-label="Annonce : Maintenance"');
    expect(html).toContain('aria-label="Masquer cette annonce"');
    expect(html).not.toMatch(/<form|<textarea|<input/);
    const src = read("src/components/layout/announcement-bar.tsx");
    expect(src).toContain("openSupportWidget()");
    const imports = src.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.join("\n")).not.toMatch(/support-widget|report-problem|@\/actions\//);
  });

  it("openSupportWidget dispatches the event the SupportWidget listens to", () => {
    const target = new EventTarget();
    const seen: string[] = [];
    target.addEventListener(OPEN_SUPPORT_EVENT, (e) => seen.push(e.type));
    openSupportWidget(target);
    expect(seen).toEqual([OPEN_SUPPORT_EVENT]);
    const widget = read("src/components/support/support-widget.tsx");
    expect(widget).toContain("window.addEventListener(OPEN_SUPPORT_EVENT, onOpen)");
    expect(widget).toContain("const onOpen = () => setOpen(true);");
  });

  it("an in-app action renders a link, an external one opens safely in a new tab", () => {
    const internal = renderToStaticMarkup(createElement(AnnouncementBar, { announcement: { ...announcement, actionLabel: "Voir", actionUrl: "/rapports" } }));
    expect(internal).toContain('href="/rapports"');
    expect(internal).not.toContain("target=");
    const external = renderToStaticMarkup(
      createElement(AnnouncementBar, { announcement: { ...announcement, actionLabel: "Blog", actionUrl: "https://asoditech.com/blog" } })
    );
    expect(external).toContain('href="https://asoditech.com/blog"');
    expect(external).toContain('rel="noopener noreferrer"');
  });

  it("long messages wrap instead of overflowing", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBar, { announcement: { ...announcement, message: "x".repeat(280) } }));
    expect(html).toContain("break-words");
    expect(html).toContain("flex-wrap");
  });
});
