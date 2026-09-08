# Connecting a WooCommerce store (operator guide)

Steps to perform **on the WooCommerce store** before connecting it in
ASODITECH → Intégrations. This is store-side configuration the app cannot
do for you.

## 1. Use the store's real canonical URL

Enter the exact origin WordPress is configured with — the value shown in
**WooCommerce → Statut → Adresse du site (URL)**. If that says
`https://example.com`, enter `https://example.com` (not `www.`, not a
different TLD, not a staging/preview domain). A mismatch, or a redirect to
a different host, makes the store reject the API keys.

## 2. Generate REST API keys on THAT store

WooCommerce → **Réglages → Avancé → API REST → Ajouter une clé** :

- **Utilisateur** : an Administrator (or Shop manager) account.
- **Permissions** : **Lecture/Écriture**.
- Copy the **Consumer key** (`ck_…`) and **Consumer secret** (`cs_…`)
  immediately — the secret is shown only once.

Keys generated on a different store (e.g. a Hostinger preview clone) will
not work here.

## 3. Let the server pass the `Authorization` header to WooCommerce

Many hosts — **LiteSpeed / Hostinger, Apache in CGI/FastCGI mode** — strip
the HTTP `Authorization` header before WordPress sees it. WooCommerce then
treats every API call as anonymous and answers `401`
(`woocommerce_rest_cannot_view`). Symptom in this app: *« La boutique
WooCommerce n'a pas reçu les identifiants API »*.

**Confirm it:** WooCommerce → Statut → section **API** — it reports whether
the server responds to the Authorization header.

**Fix:** add this to the very top of the store's `.htaccess` (root of the
WordPress install), **above** `# BEGIN WordPress` :

```apache
# Pass the Authorization header through to PHP (LiteSpeed / Apache CGI)
CGIPassAuth On

<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{HTTP:Authorization} .
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
</IfModule>
```

If the host does not allow `.htaccess` overrides, ask their support to
*"allow the HTTP Authorization header to reach PHP for the WooCommerce
REST API"* — they know this request.

**Verify from any terminal:**

```bash
curl -u ck_xxx:cs_xxx "https://VOTRE-BOUTIQUE/wp-json/wc/v3/orders?per_page=1"
```

Expected: a JSON array (`[]` or orders). If you still get
`{"code":"woocommerce_rest_cannot_view",...}`, the header is still being
stripped.

## 4. Connect in ASODITECH

Intégrations → WooCommerce → enter the store URL + the two keys → **Tester**.
On success, run the syncs in order: **Catégories → Produits → Commandes**.

## 5. Register webhooks (real-time updates)

WooCommerce → Réglages → Avancé → **Webhooks** — one per topic, all
pointing at `https://<app>/api/webhooks/woocommerce`, secret =
the webhook secret shown in the ASODITECH integration panel:

| Nom | Sujet |
| --- | --- |
| Order created  | `order.created` |
| Order updated  | `order.updated` |
| Order deleted  | `order.deleted` |
| Product created | `product.created` |
| Product updated | `product.updated` |
| Product deleted | `product.deleted` |

## Notes

- **Variable products**: WooCommerce keeps no price or stock on the
  variable *parent* — both live on the variations. ASODITECH shows the
  parent with a price range and the summed variation stock; this is
  expected, not missing data.
- **Historical orders** import with their real order date. The Commandes
  page defaults to the current month — use **« Toutes les commandes »** to
  see older imported history.
- If the Stock page is empty after a product sync, the tenant is missing
  its default warehouse — run `scripts/backfill-tenant-baseline.ts`
  (see that file's header).
