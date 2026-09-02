import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createMarketingChannelAction, createMarketingCampaignAction } from "@/actions/marketing";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("createMarketingChannelAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without marketing.manage permission (Phase 26 audit fix)", async () => {
    await loginAsTestUser({ role: "SALES" });
    await expect(createMarketingChannelAction(formData({ name: "Meta", type: "META" }))).rejects.toThrow(
      /non autorisé/i
    );
  });

  it("audits channel creation as marketing_channel.created, not marketing_campaign.created (Phase 26 audit fix)", async () => {
    const user = await loginAsTestUser({ role: "MANAGER" });
    const result = await createMarketingChannelAction(formData({ name: "TikTok Ads", type: "TIKTOK" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: result.data.id, entityType: "MarketingChannel" } });
    expect(audit.action).toBe("marketing_channel.created");
    expect(audit.actorUserId).toBe(user.id);
  });
});

describe("createMarketingCampaignAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a campaign referencing a non-existent channel instead of throwing (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createMarketingCampaignAction(
      formData({ channelId: "does-not-exist", name: "Campagne Ramadan", startDate: "2026-03-01" })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an end date before the start date (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const channel = await createMarketingChannelAction(formData({ name: "Meta", type: "META" }));
    if (!channel.ok) throw new Error("setup failed");

    const result = await createMarketingCampaignAction(
      formData({
        channelId: channel.data.id,
        name: "Campagne Ramadan",
        startDate: "2026-03-10",
        endDate: "2026-03-01",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("creates a campaign with a valid channel and date range", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const channel = await createMarketingChannelAction(formData({ name: "Meta", type: "META" }));
    if (!channel.ok) throw new Error("setup failed");

    const result = await createMarketingCampaignAction(
      formData({
        channelId: channel.data.id,
        name: "Campagne Ramadan",
        startDate: "2026-03-01",
        endDate: "2026-03-30",
      })
    );
    expect(result.ok).toBe(true);

    const campaign = await prisma.marketingCampaign.findFirstOrThrow({ where: { name: "Campagne Ramadan" } });
    expect(campaign.channelId).toBe(channel.data.id);
  });
});
