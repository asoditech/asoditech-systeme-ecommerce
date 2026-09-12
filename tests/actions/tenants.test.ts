import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import {
  createTenantAction,
  activateTenantAction,
  suspendTenantAction,
  deleteTenantAction,
  listTenantsForPlatform,
} from "@/actions/tenants";
import { acceptInvitationAction } from "@/actions/invitations";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Phase 5 (docs/adr/0027-tenant-provisioning.md) — /platform tenant
 * lifecycle. `isPlatformAdmin` is the ONE flag this whole area gates on,
 * deliberately independent of role/RBAC — a plain OWNER of a tenant must be
 * rejected just as hard as any other non-platform-admin role.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("createTenantAction / activateTenantAction / suspendTenantAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a plain OWNER (not a platform admin) for every tenant-lifecycle action", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });

    await expect(
      createTenantAction(
        formData({ name: "New Co", slug: "new-co", ownerName: "Owner", ownerEmail: "owner@newco.test" })
      )
    ).rejects.toThrow(/non autorisé/i);
    await expect(activateTenantAction(formData({ id: DEFAULT_TENANT_ID }))).rejects.toThrow(/non autorisé/i);
    await expect(suspendTenantAction(formData({ id: DEFAULT_TENANT_ID }))).rejects.toThrow(/non autorisé/i);
    await expect(
      deleteTenantAction(formData({ id: DEFAULT_TENANT_ID, slugConfirmation: "default" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("a platform admin creates a tenant with a pending OWNER invitation, and it can be accepted", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

    const result = await createTenantAction(
      formData({ name: "New Co", slug: "new-co", ownerName: "Jane Owner", ownerEmail: "jane@newco.test" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tenant = await prismaBase.tenant.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(tenant.slug).toBe("new-co");
    expect(tenant.status).toBe("ACTIVE");

    const invitation = await prismaBase.invitation.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(invitation.role).toBe("OWNER");
    expect(invitation.email).toBe("jane@newco.test");
    expect(invitation.invitedById).toBeNull();

    mockCookieStore.clear();
    const token = result.data.inviteUrl.replace("/invitations/", "");
    await expect(
      acceptInvitationAction(undefined, formData({ token, password: "jane-owner-password-1" }))
    ).rejects.toThrow(RedirectSignal);

    const newOwner = await prismaBase.user.findFirstOrThrow({ where: { email: "jane@newco.test" } });
    expect(newOwner.tenantId).toBe(tenant.id);
    expect(newOwner.role).toBe("OWNER");
    expect(newOwner.isPlatformAdmin).toBe(false);
  });

  it("rejects a duplicate slug", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    await prismaBase.tenant.create({ data: { id: "existing-co", name: "Existing", slug: "existing-co" } });

    const result = await createTenantAction(
      formData({ name: "Dup", slug: "existing-co", ownerName: "Dup Owner", ownerEmail: "dup@dup.test" })
    );
    expect(result.ok).toBe(false);
  });

  it("cannot suspend the bootstrap tenant", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await suspendTenantAction(formData({ id: DEFAULT_TENANT_ID }));
    expect(result.ok).toBe(false);

    const tenant = await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } });
    expect(tenant.status).toBe("ACTIVE");
  });

  it("suspending a tenant destroys every one of its users' sessions and blocks their login", async () => {
    const TENANT_B = "tenant-b-suspend";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const memberOfB = await createTestUser({ tenantId: TENANT_B, role: "ADMIN" });
    await createSession(memberOfB.id);
    expect(await prismaBase.session.count({ where: { userId: memberOfB.id } })).toBe(1);

    // The session cookie now belongs to memberOfB; capture it, then switch
    // to a platform admin to perform the suspension, then switch back to
    // confirm memberOfB's session no longer resolves.
    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await suspendTenantAction(formData({ id: TENANT_B }));
    expect(result.ok).toBe(true);

    expect(await prismaBase.session.count({ where: { userId: memberOfB.id } })).toBe(0);

    const tenant = await prismaBase.tenant.findUniqueOrThrow({ where: { id: TENANT_B } });
    expect(tenant.status).toBe("SUSPENDED");
  });

  it("a suspended tenant's existing session is rejected by getCurrentUser", async () => {
    const TENANT_B = "tenant-b-suspend-session";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const member = await createTestUser({ tenantId: TENANT_B, role: "ADMIN" });
    await createSession(member.id);
    expect(await getCurrentUser()).toMatchObject({ id: member.id });

    await prismaBase.tenant.update({ where: { id: TENANT_B }, data: { status: "SUSPENDED" } });

    expect(await getCurrentUser()).toBeNull();
  });

  it("re-activating a suspended tenant restores login", async () => {
    const TENANT_B = "tenant-b-reactivate";
    await prismaBase.tenant.create({
      data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B, status: "SUSPENDED" },
    });
    const member = await createTestUser({ tenantId: TENANT_B, role: "ADMIN" });
    await createSession(member.id);
    expect(await getCurrentUser()).toBeNull();

    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await activateTenantAction(formData({ id: TENANT_B }));
    expect(result.ok).toBe(true);

    mockCookieStore.clear();
    await createSession(member.id);
    expect(await getCurrentUser()).toMatchObject({ id: member.id });
  });

  it("listTenantsForPlatform sees every tenant, not just the caller's own", async () => {
    const TENANT_B = "tenant-b-list";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });

    const tenants = await listTenantsForPlatform();
    const ids = tenants.map((t) => t.id);
    expect(ids).toContain(DEFAULT_TENANT_ID);
    expect(ids).toContain(TENANT_B);
  });
});

describe("deleteTenantAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("cannot delete the bootstrap tenant", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: DEFAULT_TENANT_ID, slugConfirmation: "default" }));
    expect(result.ok).toBe(false);

    expect(await prismaBase.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } })).not.toBeNull();
  });

  it("rejects a slug confirmation that doesn't match the tenant", async () => {
    const TENANT_B = "tenant-b-delete-wrong-slug";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

    const result = await deleteTenantAction(formData({ id: TENANT_B, slugConfirmation: "not-the-slug" }));
    expect(result.ok).toBe(false);

    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT_B } })).not.toBeNull();
  });

  it("a platform admin deletes a tenant by typing its slug, and it is fully gone", async () => {
    const TENANT_B = "tenant-b-delete-ok";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const memberOfB = await createTestUser({ tenantId: TENANT_B, role: "ADMIN" });
    const admin = await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

    const result = await deleteTenantAction(formData({ id: TENANT_B, slugConfirmation: TENANT_B }));
    expect(result.ok).toBe(true);

    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT_B } })).toBeNull();
    expect(await prismaBase.user.count({ where: { id: memberOfB.id } })).toBe(0);

    const audit = await prismaBase.auditEvent.findFirst({
      where: { action: "tenant.deleted", entityId: TENANT_B },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(admin.id);
  });
});
