import { getCurrentUser } from "@/lib/auth/session";
import { userHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { parseExportPlatform, prepareProductExport } from "@/lib/catalog/export/service";

/**
 * Product CSV download (docs/adr/0054): POST `ids` (repeated form field) →
 * the platform-specific CSV. Server-side: authenticated, `products.edit`,
 * tenant-scoped load, the same validation as the screen (a file with
 * blocking errors is never produced), audited.
 */
export async function POST(request: Request, ctx: { params: Promise<{ platform: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Non authentifié." }, { status: 401 });
  if (!userHasPermission(user, "products.edit")) return Response.json({ error: "Permission « products.edit » requise." }, { status: 403 });
  const platform = parseExportPlatform((await ctx.params).platform);
  if (!platform) return Response.json({ error: "Plateforme inconnue." }, { status: 404 });

  let ids: string[] = [];
  try {
    ids = (await request.formData()).getAll("ids").filter((v): v is string => typeof v === "string");
  } catch {
    return Response.json({ error: "Requête invalide." }, { status: 400 });
  }
  const prepared = await prepareProductExport(platform, ids);
  if (!prepared.csv) return Response.json({ error: "Export refusé.", validation: prepared.validation }, { status: 422 });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.exported",
    entityType: "Product",
    entityId: platform,
    metadata: { platform, productCount: prepared.productCount, rowCount: prepared.rowCount, warnings: prepared.validation.warnings.length },
  });
  return new Response(prepared.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${prepared.filename}"`,
      "cache-control": "no-store",
    },
  });
}
