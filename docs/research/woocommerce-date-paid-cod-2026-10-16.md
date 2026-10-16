# WooCommerce : `date_paid` sur une commande « Paiement à la livraison » (2026-10-16)

**Question** : quand WooCommerce renseigne-t-il `date_paid` sur une commande
payée à la livraison (passerelle `cod`) ? Une commande COD importée avec un
`date_paid` a-t-elle vraiment été payée ?

**Réponse courte : non, pas nécessairement.** Pour une commande COD,
`date_paid` indique au mieux que la commande a atteint le statut *completed*
(« Terminée »), ou que WooCommerce l'a traitée comme « paiement complet » par
un autre chemin. Ce n'est **jamais** une preuve d'encaissement. Le
comportement actuel d'ASODITECH (`wooReportsPaid` ignore `date_paid` quand
`payment_method === "cod"`, `src/lib/orders/store-payment.ts`) est donc
**correct**. Son commentaire est en partie inexact (§4).

Étiquettes :

| Étiquette | Sens |
|---|---|
| **[SOURCE]** | Lu dans le code source officiel WooCommerce (dépôt `woocommerce/woocommerce`, branche `trunk`) |
| **[DOC]** | Documentation officielle WooCommerce |
| **[DÉDUIT]** | Notre lecture de l'enchaînement des appels, non testée sur un site réel |

---

## 1. Ce que fait le code WooCommerce

### 1.1 Passerelle COD — `plugins/woocommerce/includes/gateways/cod/class-wc-gateway-cod.php` (W1)
Dernier commit sur ce fichier : `a3f5a2f`, 2026-09-17.

- **Constructeur (l. 64)** : il ajoute le filtre `woocommerce_payment_complete_order_status` → `change_payment_complete_order_status`.
- **`change_payment_complete_order_status()` (l. 174, depuis 3.1.0)** : pour une commande dont `get_payment_method()` vaut `cod`, le statut « paiement complet » devient **`completed`** au lieu de `processing`. [SOURCE]
- **`process_payment()` (l. 126-141)** :
  - si le total est supérieur à 0 : `update_status( apply_filters('woocommerce_cod_process_payment_order_status', has_downloadable_item ? 'on-hold' : 'processing'), 'Payment to be made upon delivery.' )`. Le commentaire du code dit « payment won't be taken until delivery ». **`payment_complete()` n'est pas appelé.** [SOURCE]
  - si le total vaut 0 : `$order->payment_complete()`. `date_paid` est alors renseigné immédiatement. [SOURCE]

### 1.2 Commande — `plugins/woocommerce/includes/class-wc-order.php` (W2)
Dernier commit sur ce fichier : `8688957`, 2026-08-17.

- **`payment_complete()` (l. 138)** : si le statut actuel fait partie des statuts valides (`OrderStatus::PAYMENT_COMPLETE_STATUSES` = on-hold, pending, failed, cancelled, W4), alors `if ( ! $this->get_date_paid('edit') ) $this->set_date_paid( time() );`, puis passage au statut filtré. [SOURCE]
- **`set_status()` (l. 319)** : à chaque changement réel de statut, appelle `maybe_set_date_paid()` puis `maybe_set_date_completed()`. [SOURCE]
- **`maybe_set_date_paid()` (l. 355-377)**. Le docblock dit : « Sets the date paid variable when transitioning to the payment complete order status. This is either processing or completed. […] This ensures the data exists even if a gateway does not use the `payment_complete` method. » [SOURCE] Logique, seulement si `date_paid` est vide :
  - `$payment_completed_status = apply_filters('woocommerce_payment_complete_order_status', needs_processing() ? 'processing' : 'completed', …)` ;
  - si la commande **a** ce statut → `set_date_paid(time())` ;
  - sinon, si ce statut vaut `processing` et que la commande est `completed` → `set_date_paid(time())`.
- **`get_date_paid('view')` (l. 958)** : pour une commande créée **avant WooCommerce 3.0** sans date de paiement, la lecture en contexte « view » renvoie `date_created` si la commande est au statut « paiement complet ». [SOURCE]

### 1.3 API REST — `includes/rest-api/Controllers/Version2/class-wc-rest-orders-v2-controller.php` (W3)
Dernier commit : `ffb46bf`, 2026-09-30.

- `date_paid` / `date_paid_gmt` sont en **lecture seule** : « The date the order was paid ». [SOURCE]
- `set_paid` (booléen, écriture) : « Define if the order is paid. It will set the status to processing and reduce stock items ». À la création, ou si `needs_payment()`, il appelle `payment_complete()` (l. 844-846), ce qui renseigne `date_paid`. [SOURCE]

### 1.4 Chargement des passerelles — `includes/class-wc-payment-gateways.php` (W5)
- `WC()->payment_gateways()` renvoie `WC_Payment_Gateways::instance()`.
- Les passerelles, dont `WC_Gateway_COD`, ne sont instanciées que lorsque cette instance est créée (`init()`).
- **Le filtre COD du §1.1 n'existe donc que dans une requête où les passerelles ont été chargées.** [SOURCE pour le chargement paresseux, DÉDUIT pour la conséquence]

### 1.5 Documentation — [DOC] (W6)
« WooCommerce sets orders using Cash on Delivery (COD) to "Processing" until payment is collected. » Le marchand « should confirm that payments for Cash on Delivery orders have been collected before setting orders to "Complete" ». La page n'est pas datée (© 2026).

---

## 2. Quand une commande COD reçoit-elle `date_paid` ?

| Chemin | `date_paid` renseigné ? | Niveau |
|---|---|---|
| Paiement au checkout (`process_payment`, total > 0) → `processing` | **Non.** Passerelle chargée, filtre → `completed`, donc la commande en `processing` ne correspond pas | [SOURCE] + [DÉDUIT] |
| Total = 0 au checkout | **Oui, immédiatement** (`payment_complete()`) | [SOURCE] |
| Passage à **`completed`** (manuel, plugin, API) | **Oui**, si la date était vide : statut « paiement complet » = `completed` (filtre COD), ou branche « processing dépassé » sans filtre | [SOURCE] + [DÉDUIT] |
| Passage à `processing` dans une requête **où la passerelle COD n'a pas été chargée** (API REST, WP-CLI, cron, plugin d'import ou de statut) | **Probablement oui** : sans le filtre COD, le statut par défaut est `processing` pour un produit physique | [DÉDUIT], non testé |
| Création ou mise à jour REST avec `set_paid: true` | **Oui** (`payment_complete()`) | [SOURCE] |
| Commande antérieure à WooCommerce 3.0 | Valeur de repli = `date_created` en lecture « view » | [SOURCE] |
| Plugin tiers qui appelle `payment_complete()` (ex. « marquer payé à l'expédition ») | Oui | [DÉDUIT] |

**Conséquences :**
1. Le cas le plus courant donne `date_paid` = date du passage en **Terminée**. La documentation demande au marchand de ne le faire qu'après encaissement, mais c'est une **convention du marchand** : rien ne le vérifie.
2. Plusieurs chemins renseignent `date_paid` **avant toute livraison** : total 0, `set_paid`, plugins, changement de statut sans passerelle chargée.
3. WooCommerce n'a aucun champ « argent COD reçu ». Seul le marchand ou une extension de transporteur le sait.

**Preuves manquantes ou contradictoires :**
- Aucun ticket GitHub WooCommerce trouvé sur ce cas (recherche `date_paid cod`).
- La ligne « [DÉDUIT] » du passage à `processing` sans passerelle chargée n'a pas été testée. Un test sur un WooCommerce local le confirmerait, mais c'est hors du périmètre de cette tâche (aucun test exécuté).

---

## 3. Décision pour ASODITECH

- **Garder** la règle actuelle : `date_paid` d'une commande `payment_method = "cod"` n'est **pas** un paiement. Le paiement COD vient de la livraison (règle d'entreprise « payée à la livraison ») ou d'une personne.
- **[DÉDUIT] Écart restant** : `wooReportsPaid` compare uniquement `payment_method === "cod"`. Une passerelle COD **tierce**, avec un identifiant différent (plugin de COD avec frais par exemple), n'est pas reconnue : son `date_paid` serait pris pour un paiement. Options possibles, sans rien changer ici :
  - une liste configurable d'identifiants « paiement à la livraison » par connexion WooCommerce ;
  - ou le traitement de `payment_method_title` / d'une liste connue.

  À trancher par le propriétaire si ses boutiques utilisent un plugin COD.

## 4. Correction de commentaire suggérée (pas faite ici)
`src/lib/orders/store-payment.ts` dit : « WooCommerce stamps it as soon as the order enters « processing » / « completed » ». D'après le code source :
- le checkout COD **ne** renseigne **pas** `date_paid` en `processing` ;
- `date_paid` est renseigné au passage en `completed`, ou par `payment_complete()` / `set_paid`, ou en `processing` quand la passerelle COD n'est pas chargée.

La conclusion (« ce n'est pas un paiement ») reste juste. Seule la justification est à préciser.

---

## 5. Sources

| # | URL | Éditeur | Date | Ce que la source étaye |
|---|---|---|---|---|
| W1 | https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/gateways/cod/class-wc-gateway-cod.php | WooCommerce (Automattic), dépôt officiel | dernier commit `a3f5a2f`, 2026-09-17 | Filtre COD → `completed` (l. 64, 174) ; `process_payment` → `processing` sans `payment_complete` (l. 126-141) |
| W2 | https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-order.php | idem | dernier commit `8688957`, 2026-08-17 | `payment_complete` (l. 138) ; `set_status` → `maybe_set_date_paid` (l. 319-337) ; `maybe_set_date_paid` (l. 355-377) ; `get_date_paid` avec repli pré-3.0 (l. 958) |
| W3 | https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-orders-v2-controller.php | idem | dernier commit `ffb46bf`, 2026-09-30 | `date_paid` en lecture seule ; `set_paid` → `payment_complete()` |
| W4 | https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/src/Enums/OrderStatus.php | idem | dernier commit `3e79076`, 2026-08-20 | `PAYMENT_COMPLETE_STATUSES` = on-hold, pending, failed, cancelled |
| W5 | https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-payment-gateways.php | idem | dernier commit `8688957`, 2026-08-17 | Chargement paresseux des passerelles, dont `WC_Gateway_COD` |
| W6 | https://woocommerce.com/document/cash-on-delivery/ | WooCommerce | date non indiquée (© 2026) | COD en « Processing » jusqu'à l'encaissement ; ne passer en « Complete » qu'après encaissement |
| R1 | `src/lib/orders/store-payment.ts` (`wooReportsPaid`), `src/lib/integrations/woocommerce/sync/orders.ts`, `src/lib/integrations/shared/order-sync-rules.ts` (`importedPaymentStatus`) | Dépôt ASODITECH | 2026-10-14/16 | Règle actuelle d'import du paiement. Au moment de la rédaction, les trois appels de `sync/orders.ts` (import, évènement de paiement, détection de rafraîchissement) passent par `wooReportsPaid`. Ce changement est **non commité** dans l'arbre de travail : à vérifier avant publication |

Numéros de ligne relevés sur `trunk` au moment de la lecture (2026-10-15/16). Pour un permalien stable, remplacer `trunk` par le SHA du commit indiqué.
