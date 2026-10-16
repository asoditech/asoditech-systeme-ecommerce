# Échanges de commandes au Maroc — droit, transporteurs, pratiques et spécification ASODITECH (2026-10-16)

**Statut : RECHERCHE + SPÉCIFICATION. Rien n'est implémenté.** Ce document
affine `docs/research/order-exchanges-proposal.md` (2026-10-12) et
`docs/research/carrier-exchange-capabilities.md` (2026-10-10). Le modèle
Prisma et la migration décrits au §6 ne sont **pas** créés.

Ce document ne remplace pas un avis juridique. Les articles de loi cités
viennent du texte officiel téléchargé (source S1). L'interprétation de leur
application à ASODITECH est marquée [RECO].

## 0. Légende des niveaux de preuve

Chaque affirmation porte l'une de ces étiquettes :

| Étiquette | Sens |
|---|---|
| **[OFFICIEL]** | Exigence documentée dans un texte officiel (loi, décret, Bulletin officiel) |
| **[TRANSPORTEUR]** | Pratique ou offre publiée par un transporteur sur son propre site ou dans sa documentation |
| **[MARCHÉ]** | Pratique rapportée : CGV publiées par des e-commerçants marocains, presse. Ce sont des cas, pas une norme |
| **[RECO]** | Recommandation déduite pour ASODITECH (notre analyse, pas un fait) |
| **[INCONNU]** | Recherché, aucune preuve trouvée. Inconnu ne veut pas dire impossible |

Les sources sont numérotées (S…, C…, M…) et listées au §9 avec URL, éditeur
et date. Les recherches web ont été faites pendant la session de rédaction
(2026-10-15/16).

---

## 1. Résumé

1. **[OFFICIEL]** La loi n° 31-08 ne prévoit **aucun droit à l'échange**. Elle prévoit :
   - un **droit de rétractation** pour la vente à distance : 7 jours, ou 30 jours si les informations n'ont pas été confirmées par écrit (art. 36) ;
   - un **remboursement** au plus tard 15 jours après la rétractation (art. 37) ;
   - la **garantie légale des vices** du Code des obligations et des contrats, avec une action en justice dans l'année qui suit la livraison pour un bien meuble (art. 65).

   L'échange est donc un **geste commercial** que le commerçant organise. Il ne peut pas remplacer un remboursement quand le client exerce sa rétractation (§2).
2. **[OFFICIEL]** En cas de rétractation, seuls les « frais de retour » peuvent rester à la charge du consommateur (art. 36). Ils sont à la charge du fournisseur si celui-ci a livré un produit de substitution prévu au contrat (art. 41).
3. **[OFFICIEL]** Aucune règle propre au paiement à la livraison (COD) n'a été trouvée dans la loi 31-08. L'art. 35 renvoie à « la législation en vigueur ». Un avant-projet de loi sur la livraison de colis (autorisation des opérateurs, amendes) est rapporté par la presse en mai 2026 comme **non adopté** (S3).
4. **[TRANSPORTEUR]** Un seul transporteur étudié **publie** une offre d'échange : **Cathedis** (« Échanges de marchandises », « Retour d'échange de colis Gratuit » dans le Pack Gold).
5. **[TRANSPORTEUR]** Sendit expose dans son export Swagger les champs `option_exchange` et `delivery_exchange_id`, **sans aucune description** de leur sens. Pour OzonExpress, Ameex, ForceLog, Onessta, Chrono Diali et Speedaf, aucune offre d'échange n'est publiée. Aramex Maroc et Amana n'ont pas pu être lus.
6. **[TRANSPORTEUR]** Plusieurs transporteurs publient un retour de fonds COD « sous 24h » : Ameex, Sendit, OzonExpress, ForceLog. Cathedis publie un retour de cash une à deux fois par semaine selon le pack. Onessta se contredit sur sa propre page. Pour les retours, les mentions « gratuit » coexistent parfois avec des frais dans les CGV : Ameex affiche « 0 MAD » sur sa page tarifs mais « 10 DH » en cas de refus dans ses conditions.
7. **[MARCHÉ]** Les CGV marocaines publiées sont très hétérogènes :
   - Marjane Mall : retour sous 7 jours, sans échange, remboursement COD par code WafaCash ;
   - Decathlon.ma : échange pendant 1 an avec un compte client, frais de retour en ligne à la charge du client sauf erreur ;
   - Kitea : 300 MAD de frais pour changer de produit après expédition.

   Nous n'avons trouvé **aucun guide marchand fiable** qui décrive l'échange en COD (différence de prix, échange au domicile). Les preuves sur les pratiques sont **minces**.
8. **[RECO]** Spécification au §6 :
   - une entité `OrderExchange` rattachée à la commande d'origine, avec deux « jambes » ;
   - la jambe retour réutilise `ReturnReception` → `OrderReturn` (RETOUR/ENDOMMAGE) ;
   - la jambe remplacement réutilise `Shipment`, plus un mouvement de stock dédié `ECHANGE_SORTIE` ;
   - la différence de prix est encaissée en COD sur le colis de remplacement, ou remboursée par le flux `Refund` existant ;
   - le statut de la commande d'origine et sa commission restent **inchangés**.

---

## 2. Cadre légal marocain (loi n° 31-08)

Texte : Dahir n° 1-11-03 du 14 rabii I 1432 (18 février 2011) portant
promulgation de la loi n° 31-08 édictant des mesures de protection du
consommateur, publié au **Bulletin officiel n° 5932 du 7 avril 2011, p. 347**.
Le texte a été lu dans la version publiée par le portail Adala du ministère de
la Justice (S1). Cette version intègre en notes des renvois au décret
n° 2-12-503.

### 2.1 Vente à distance (Titre IV, chapitre 2, art. 25 à 44) — [OFFICIEL]

| Art. | Contenu (citation ou résumé fidèle) | Effet pour un échange |
|---|---|---|
| 25-26 | Le chapitre s'applique à toute personne qui propose « par un moyen électronique » la fourniture d'un produit au consommateur. Le fournisseur est « responsable de plein droit » de la bonne exécution, même par d'autres prestataires (le transporteur compris), sauf faute du consommateur, fait d'un tiers imprévisible et insurmontable, ou force majeure. | Une erreur du transporteur sur le colis de remplacement reste, vis-à-vis du client, la responsabilité du commerçant. |
| 29 | L'offre doit mentionner notamment : les délais et frais de livraison, l'existence du droit de rétractation (art. 36), les modalités de paiement, de livraison ou d'exécution. | [RECO] Si le marchand propose l'échange, ses conditions (délai, frais) devraient figurer dans ses conditions publiées. ASODITECH ne publie pas les CGV du marchand : c'est sa responsabilité. |
| 32 | Au plus tard à la livraison, le consommateur doit recevoir par écrit la confirmation des informations, l'adresse de réclamation, et les conditions et modalités du droit de rétractation. Le consommateur doit pouvoir « exercer son droit de rétractation ou […] bénéficier de la garantie […] sans avoir à supporter des frais supplémentaires » de communication. | — |
| 34 | En cas de litige, « la charge de la preuve incombe au fournisseur ». | [RECO] Une piste d'audit complète de l'échange (qui, quand, quoi, montants) a une valeur probante. |
| 35 | « Les opérations de paiement relatives aux contrats conclus à distance sont soumises à la législation en vigueur. » | Seule mention du paiement. **Aucune règle spécifique au COD** dans ce chapitre. |
| **36** | « Le consommateur dispose d'un délai : de sept jours pour exercer son droit de rétractation ; de trente jours […] si le fournisseur n'honore pas son engagement de confirmer par écrit les informations prévues dans les articles 29 et 32. Et cela, sans avoir à se justifier, ni à payer des pénalités, à l'exception, le cas échéant, des frais de retour. » Le délai court « à compter de la date de réception du bien ». | Rétractation ≠ échange. Si le client se rétracte, il a droit au remboursement, pas à un échange imposé. Les frais de **retour** (pas ceux d'un nouvel envoi) peuvent lui être laissés. |
| **37** | Le fournisseur rembourse « sans délai […] le montant total payé et au plus tard dans les 15 jours suivant la date à laquelle ce droit a été exercé ». Au-delà, intérêts au taux légal. | [RECO] Une différence négative issue d'une **rétractation partielle** déguisée en échange devrait suivre ce délai. Le flux `Refund` doit pouvoir dater l'exercice du droit. |
| 38 | Exclusions, sauf accord contraire : biens confectionnés selon les spécifications du consommateur ou nettement personnalisés, biens qui « ne peuvent être réexpédiés ou sont susceptibles de se détériorer ou de se périmer rapidement », logiciels descellés, presse, etc. | [RECO] Le marchand doit pouvoir marquer des produits « non échangeables / non retournables » (périssables, personnalisés). C'est une décision de catalogue, voir §7. |
| 39 | Commande exécutée au plus tard 30 jours après la confirmation de réception de la commande, sauf accord contraire. | [RECO] Ce délai pourrait guider le délai d'envoi du remplacement. Aucun texte ne le rend explicitement applicable à un échange. |
| 40 | En cas d'indisponibilité du produit commandé : information du consommateur et remboursement au plus tard 15 jours après le paiement. | [RECO] Si la variante de remplacement est indisponible, l'échange ne peut pas être forcé vers un autre article : remboursement possible. |
| **41** | Si c'est prévu avant la conclusion du contrat ou dans le contrat, le fournisseur peut fournir un produit « d'une qualité et d'un prix équivalents ». « Les frais de retour consécutifs à l'exercice du droit de rétractation sont, dans ce cas, à la charge du fournisseur. » | Une substitution à l'initiative du marchand (rupture de stock) n'est pas un échange demandé par le client. Si le client refuse la substitution, c'est le marchand qui paie le retour. |
| 44 | « Les dispositions du présent chapitre sont d'ordre public. » | Les CGV ne peuvent pas y déroger au détriment du consommateur. |

### 2.2 Délai de livraison (art. 12 à 14) — [OFFICIEL]
- Au-delà d'un seuil fixé par voie réglementaire, le fournisseur doit préciser par écrit la date limite de livraison (art. 12). Le seuil est de **3 000 DH**, selon la note de S1 qui cite l'art. 28 du décret n° 2-12-503.
- Si cette date est dépassée de 7 jours hors force majeure, le consommateur peut résoudre le contrat dans les 5 jours qui suivent (art. 13). Le remboursement est alors dû sous 7 jours (art. 14).
- [RECO] Pertinent si le remplacement d'un article de plus de 3 000 DH tarde.

### 2.3 Produits défectueux — garanties (Titre V, art. 65 à 73) — [OFFICIEL]
- **Art. 65** : la garantie légale des défauts de la chose vendue du Code des obligations et des contrats (DOC, **art. 549 à 575**) s'applique aux ventes au consommateur. L'action doit être intentée, à peine de forclusion, dans « l'année suivant la livraison » pour les biens meubles. Ce délai « ne [peut] être réduit par accord entre les contractants ».
- **Art. 66-67** : une garantie conventionnelle est facultative. Elle doit rappeler la garantie légale, qui « s'applique dans tous les cas ».
- **Art. 68** : « Le fournisseur doit assumer les frais de transport ou d'expédition engagés à l'occasion de l'exécution de la garantie **conventionnelle** ».
- **[INCONNU]** Les textes lus ne fixent pas explicitement qui paie le transport quand l'échange d'un produit défectueux relève de la seule garantie **légale**. Les art. 549 à 575 du DOC n'ont pas été lus dans le cadre de cette recherche. **À faire confirmer par un juriste.** [RECO] Dans le doute, défaut, erreur de préparation et dommage de transport sont classés « faute boutique » et le marchand paie les deux jambes. C'est aussi la pratique publiée par Marjane Mall et Decathlon.ma (§4).

### 2.4 Réformes en cours (non adoptées à notre connaissance)
- **Proposition de loi (mars 2025)** du groupe socialiste à la Chambre des représentants (S2). Elle ajouterait à l'art. 36 un droit de rétractation de 15 jours en cas de vice non déclaré, et supprimerait le 2e alinéa de l'art. 38. Elle était **déposée, non adoptée**, à la date de l'article. Son statut actuel n'a pas été vérifié.
- **Avant-projet de loi sur la livraison de colis et la messagerie e-commerce** (S3, Le Matin, 13 mai 2026). Il prévoit :
  - une autorisation préalable des opérateurs ;
  - des amendes de 500 000 à 5 millions de DH ;
  - la fin du monopole postal sur les colis de moins de 1 kg ;
  - de « nouvelles garanties en matière de protection du consommateur » (remboursements, litiges, retours).

  L'article indique qu'il a été déposé au SGG et n'était pas adopté. Aucune règle COD précise n'y est décrite. Nous n'avons trouvé **aucune confirmation** d'adoption à ce jour.

### 2.5 Sources officielles non accessibles
- **[INCONNU]** Le portail consommateur (khidmat-almostahlik.ma) était injoignable pendant la session : échec de connexion et DNS. Aucune page de ministère consacrée à l'échange n'a été trouvée.

---

## 3. Transporteurs opérant au Maroc

« Non publié » = rien sur le site public ou la documentation lue. Cela ne
veut pas dire que le service n'existe pas : il faut le demander au gestionnaire
de compte (questions au §3.3).

### 3.1 Matrice

| Transporteur | Échange publié ? | Ramassage retour chez le client ? | Frais de retour publiés | Délai de reversement COD publié | Intégration ASODITECH |
|---|---|---|---|---|---|
| **OzonExpress** (C6) | **Non publié** sur le site. L'API reçue du propriétaire contient un champ `parcel-replace` (ADR 0013), **sens non documenté**. | Non publié. La page liste « Bons de retour » parmi les fonctions de l'espace client. | Prix `RETURNED-PRICE` / `REFUSED-PRICE` par ville, renvoyés par l'API. Observé en compte réel : `RETURNED-PRICE: 0`, `REFUSED-PRICE: 10` (ADR 0013, 2026-09-01) | « Virement bancaire toutes les 24h », « Remboursement bancaire garanti sous 24h » | Adapter actif (tracking vérifié en réel) |
| **Sendit** (C1, C2, C3) | Champs API `option_exchange` (0/1) et `delivery_exchange_id` présents dans l'export Swagger, **sans description**. Absents du site public et du plugin WooCommerce officiel v2.2.5. | Non publié | « Le retour est gratuit si le client est injoignable ou annule sa commande » ; « L'annulation et le refus sont GRATUITS » | « paiement rapide sous 24h » | Modules purs, client bloqué (`docs/carriers/sendit.md`). Le mapper envoie déjà ces deux champs si un code d'échange est fourni. |
| **Ameex** (C4, C5) | **Non publié**. Les CGV prévoient un retour sur « demande de retour du client final (selon la politique de retour adoptée) » (§10.1). | Non publié | **Conflit** : page tarifs « Retour 0 MAD / colis » et « Les colis retournés ne sont pas facturés » ; CGV §10.2 « 10 DH pour chaque colis retourné en raison du refus du destinataire » | Tarifs : « versé par virement sous 24h après la livraison ». CGV §9.3 : quotidien, hebdomadaire ou mensuel, hors week-ends et fériés, avec des frais de 5 DH par virement (§9.4) | Échafaudage non enregistré (`docs/carriers/ameex.md`) |
| **Cathedis** (C7) | **Oui, publié** : « Échanges de marchandises — Nous gérons vos échanges de colis » ; Pack Gold : « Retour d'échange de colis Gratuit ». Modalités (API, deux colis ou un) **non publiées**. | Non publié | Pack Silver : retour gratuit jusqu'à 10 % ; Gold : jusqu'à 20 % | Silver : « Retour de Cash une fois par semaine » ; Gold : « 2 fois par semaine » | Aucune |
| **ForceLog** (C8) | Non publié | Non publié ; propose un « Retour express » | « Retour MAD 0 /colis », retour en 5-7 jours | « Retour de fond 24h » ; tableau comparatif « Chaque 12h - 24h » | Aucune |
| **Onessta** (C9) | Non publié. « Retour des colis non livré, avec une possibilité de changement destinataire. » | Non publié | Non publié | **Conflit sur la même page** : « retour de vos fonds deux fois par semaine » et « Paiement chaque 24h » | Aucune |
| **Chrono Diali** (C10) | Non publié | « Demandez le retour de vos colis jusqu'à votre adresse » (retour vers le marchand) | Non publié | « Pilotez vos retours de fond en ligne » (délai non publié) | Aucune |
| **Speedaf (Maroc)** (C11) | Non publié (page générique) | Non publié | Non publié | Non publié | Aucune |
| **Aramex Maroc** | **[INCONNU]** Le site renvoie HTTP 403 aux requêtes automatisées. Le manuel API (PDF) était déjà inaccessible en 2026-10-10. | `CreatePickup` existe ; usage chez le destinataire non documenté | — | — | Adapter existant, retiré pour les nouvelles connexions (ADR 0060) |
| **Amana (Barid Al-Maghrib)** | **[INCONNU]** Le site n'a pas pu être résolu pendant la session. Seule preuve indirecte : Marjane Mall fait déposer les retours en bureau de poste avec un « bon de retour (BDR) » envoyé par e-mail (M1). | Indirect : dépôt en bureau de poste par le client | — | — | Aucune |

### 3.2 Lecture

- **[TRANSPORTEUR]** L'échange existe comme **service commercial** chez au moins un transporteur (Cathedis). Aucun transporteur étudié ne publie de **contrat d'API** décrivant un échange : quel colis, quel suivi, quel encaissement.
- **[TRANSPORTEUR]** Pour Sendit, la présence des champs `option_exchange` / `delivery_exchange_id` laisse supposer un « colis d'échange » lié à un colis existant (`delivery_exchange_id` = code du colis d'origine ?). **C'est une hypothèse** : aucune phrase de la documentation ne le dit. L'exemple de détail montre `option_exchange: 1` avec `status_return: "RETOUR_PENDING"`, ce qui n'est pas une preuve de sémantique.
- **[TRANSPORTEUR]** Le reversement COD « sous 24h » est un argument marketing très répandu. Les CGV d'Ameex le conditionnent au calendrier choisi et excluent week-ends et fériés. [RECO] ASODITECH ne doit **jamais** déduire « payé » de ces promesses. La règle existante reste valable : un encaissement COD n'est constaté que par la livraison, si l'entreprise a activé « payée à la livraison », ou par une personne.

### 3.3 Questions à poser (complètent celles de `carrier-exchange-capabilities.md`)
À Sendit, Cathedis, OzonExpress et Ameex :
1. Le service d'échange (livrer le nouvel article et reprendre l'ancien lors du même passage) existe-t-il ? Via l'API ? Avec quels champs ?
   - Sendit : que signifient précisément `option_exchange` et `delivery_exchange_id` ?
   - OzonExpress : que fait `parcel-replace` ?
2. Un échange produit-il un ou deux numéros de suivi ? Quels statuts pour la jambe retour ?
3. Le livreur peut-il encaisser une différence (COD) sur un colis d'échange ? Peut-il **rembourser** une différence au client ? On suppose que non, mais c'est à confirmer.
4. Quels sont les frais d'un échange : livraison plus retour, ou forfait ? Comment apparaissent-ils sur la facture et sur le relevé de fonds ?
5. Que se passe-t-il si le client refuse l'échange ou ne remet pas l'ancien article ?

---

## 4. Pratiques de marché rapportées — [MARCHÉ]

Ce sont des **cas observés**, pas une norme ni une moyenne.

| Source | Échange ? | Délai | Qui paie le transport | Remboursement / COD |
|---|---|---|---|---|
| **Marjane Mall** — « Politique de retour » (M1) | Non mentionné : retour et remboursement seulement | « 7 jours suivant la date de livraison » ; casse ou dommage à signaler sous 48 h avec photos | Rétractation : frais à la charge du client. Non conforme, abîmé ou défectueux : retour gratuit | Contrôle qualité « jusqu'à 8 jours pour Casablanca ». Payé en COD : remboursé par un code **WafaCash** à retirer en agence. Ramassage par livreur, 3 tentatives. Zones non desservies : dépôt Amana avec BDR |
| **Decathlon Maroc** — « Retour et échange » (M2) | **Oui** | Avec compte client : **échange 1 an** sans justificatif, remboursement 30 jours. Sans compte : 30 jours avec ticket | En ligne : « Les frais de retour sont à votre charge — sauf problème lié à votre commande ou à la livraison » | Non détaillé |
| **Kitea** — CGV en ligne (M3) | Changement de produit après expédition : « frais de service d'un montant de trois cent (300) dirhams payable à l'avance » (§2.3) | Rétractation 7 jours calendaires, produits non déballés | Frais de retour à la charge du client, minimum 360 MAD TTC | « minimum trente (30) jours ouvrables » pour le remboursement. **Note** : cela semble plus long que les 15 jours de l'art. 37. Nous signalons l'écart sans le qualifier juridiquement. Kitea n'accepte pas le COD (carte, virement, espèces via WafaCash avant livraison). |

Ce que ces cas montrent, et ce qu'ils ne montrent pas :
- **Faute client / faute boutique** : les trois sources séparent « rétractation ou choix du client » (frais au client) et « non conforme, défectueux, problème de commande » (frais au marchand). C'est aligné avec l'art. 36 (frais de retour au consommateur) et l'art. 68 (transport de la garantie conventionnelle au fournisseur).
- **Remboursement d'une commande COD** : il faut un canal de paiement séparé (Marjane : mandat WafaCash). [RECO] Un `Refund` ASODITECH doit pouvoir porter le **mode de versement** (espèces, virement, mandat), aujourd'hui absent du modèle `Refund`. Voir §6.7.
- **[INCONNU]** Aucune source fiable trouvée sur :
  - l'échange au domicile en COD (le livreur reprend l'ancien article) ;
  - l'encaissement d'une différence de prix par le livreur ;
  - le traitement d'un remplacement moins cher en COD.

  Les blogs d'éditeurs (eGrow, YouCan) parlent de COD et de retours (RTO) en termes promotionnels, sans procédure d'échange. Ils ne sont pas utilisés ici comme preuve.

---

## 5. Ce que fait ASODITECH aujourd'hui (rappel, vérifié dans le code le 2026-10-16)

- **Aucun échange.** Le seul chemin aujourd'hui :
  1. retour physique (`recordPhysicalReturn`, `src/lib/returns/physical-return.ts`), ou réception puis inspection dans `/livraison/retours` (`receiveReturnParcel` / `inspectReturnReception`, `src/lib/returns/reception.ts`) ;
  2. puis une **nouvelle commande** pour le remplacement.
- `createShipment` (`src/lib/integrations/delivery/service.ts`) prend un verrou par commande (`shipmentSlotLockKey`). Il refuse un 2e colis actif, et refuse tout nouveau colis si des marchandises de la commande sont revenues (`orderGoodsCameBack`, `RESHIP_AFTER_RETURN_MESSAGE`). **Un colis de remplacement sur la commande d'origine est donc bloqué aujourd'hui.** C'est voulu : la spécification doit le contourner explicitement (§6.4).
- `applyShipmentStatusTransition` (`src/lib/delivery.ts`) fait passer la commande en EXPEDIEE/LIVREE/RETOUR et exécute `fulfillStockForOrder` (VENTE) une seule fois.
- Commission (ADR 0022) : `EARNED` quand la commande atteint `LIVREE`, `REVERSED` si elle quitte `LIVREE`. Au plus un `EARNED` et un `REVERSED` par commande (`@@unique([orderId, type])`).
- `Refund` : montant, motif, statut (EN_ATTENTE → APPROUVE/REJETE → COMPLETE), permission `orders.refund`. **Pas de mode de versement.**
- `Shipment` n'a **pas** de colonne de montant COD : le COD est calculé à la création depuis la commande.

---

## 6. Spécification proposée — `OrderExchange` (NON implémentée)

Principes, inchangés par rapport à la proposition du 2026-10-12 :
- jamais de deuxième commande de vente ;
- jamais de recette comptée deux fois ;
- chaque unité ne bouge qu'une fois dans chaque sens ;
- la commande d'origine garde son statut (`LIVREE`) et sa commission ;
- tout se voit dans l'historique de la commande d'origine.

### 6.1 Activation
`BusinessSettings.exchangesEnabled Boolean @default(false)`. Quand le réglage
est désactivé, aucun écran, aucune action et aucune requête ne change.

### 6.2 Éligibilité (vérifiée côté serveur, sous verrou de la commande)
- Commande du tenant courant, au statut **`LIVREE`**.
  - [RECO] Pas d'échange sur `EXPEDIEE`, `ECHEC`, `RETOUR`, `REMBOURSEE` ou `ANNULEE` : un colis refusé à la porte relève du flux retour existant, puis d'une nouvelle commande.
- `exchangesEnabled` actif, et canal ONLINE pour la permission, comme `orders.return`.
- Par ligne : quantité échangeable = quantité livrée − quantité déjà retournée (`OrderReturnLine`) − quantité engagée dans un échange **ouvert**.
- Délai depuis `deliveredAt` ≤ `BusinessSettings.exchangeWindowDays` (décision D4). La loi n'impose aucun délai d'échange. Le délai de 7 jours de l'art. 36 concerne la rétractation.
- Produit marqué non échangeable (art. 38 : périssable, personnalisé) → refus. Ce marquage dépend d'une décision de catalogue (D4).

### 6.3 Motifs et imputation
`OrderExchangeReason` :

| Code | Libellé FR | Faute par défaut | Base légale ou pratique |
|---|---|---|---|
| `TAILLE_COULEUR` | Mauvaise taille ou couleur choisie | CLIENT | [MARCHÉ] frais au client (M2, M3) |
| `CHANGEMENT_AVIS` | Le client préfère un autre article | CLIENT | [OFFICIEL] Proche de la rétractation (art. 36) : le client garde le droit de demander un **remboursement** à la place |
| `DEFECTUEUX` | Article défectueux | BOUTIQUE | [OFFICIEL] Garantie légale (art. 65) ; transport de la garantie conventionnelle au fournisseur (art. 68) |
| `ERREUR_PREPARATION` | Mauvais article ou mauvaise variante envoyé | BOUTIQUE | [MARCHÉ] retour gratuit si non conforme (M1, M2) |
| `ENDOMMAGE_TRANSPORT` | Abîmé à la livraison | BOUTIQUE (recours éventuel contre le transporteur) | [OFFICIEL] art. 26, responsabilité de plein droit du fournisseur |
| `AUTRE` | Autre (note obligatoire) | choisie par l'utilisateur | — |

Le **payeur de chaque jambe** (`returnShippingPaidBy`, `replacementShippingPaidBy` : `CLIENT | BOUTIQUE`) vient d'une **politique du tenant par motif**. C'est la décision D1, non inventée ici. L'utilisateur peut la surcharger avec une note obligatoire, et la surcharge est auditée.

### 6.4 Lignes, stock et disponibilité
`OrderExchangeLine` :
- `orderItemId` : la ligne d'origine ;
- `returnQuantity` ;
- article de remplacement : `replacementProductId` / `replacementVariationId`, `replacementQuantity`, avec les instantanés `nameSnapshot`, `skuSnapshot`, `unitPriceSnapshot`, `costSnapshot`, comme `OrderItem` ;
- `warehouseId` : l'entrepôt source du remplacement, contrôlé par la même logique que `hasLocationAccess`. Cette fonction est aujourd'hui privée dans `src/lib/returns/reception.ts` : il faudra l'extraire pour la partager.

Ces lignes se chiffrent ainsi :
- Prix du remplacement : décision D3 (prix catalogue actuel ou prix payé d'origine).
- Prix net payé d'origine par unité = `OrderItem.total / OrderItem.quantity`. Ce prix inclut la remise de ligne. La répartition d'une remise de commande éventuelle fait partie de D3.

Stock (le registre existant n'est pas modifié) :
1. **Création** : `RESERVATION` par ligne de remplacement, avec `orderExchangeId`. La création est refusée si la quantité disponible (en main − réservé) dans l'entrepôt est insuffisante. Le message dit quelle variante manque.
2. **Départ du colis de remplacement** (premier passage EN_TRANSIT ou LIVRE, ou « Expédier » manuel) : nouveau type **`ECHANGE_SORTIE`**, écrit **une seule fois** par ligne d'échange. Un index unique partiel garantit cette unicité. La réservation est convertie.
3. **Annulation avant départ** : `LIBERATION` par ligne.
4. **Retour de l'article d'origine** : `ReturnReception` (nouvelle colonne `orderExchangeId`) → inspection → `recordPhysicalReturn` → `RETOUR` (vendable) ou `ENDOMMAGE`. Le plafond existant, livré − déjà retourné par `orderItemId`, empêche tout double réassort.
5. **Remplacement refusé ou retourné par le transporteur** : réception liée à la **ligne d'échange**. Il faut un nouveau `OrderReturnLine.orderExchangeLineId`, avec un plafond = `replacementQuantity` − déjà revenu. Il ne compte **jamais** contre le plafond de la ligne d'origine.

### 6.5 Transport : deux jambes, trois modes
`OrderExchange.flow` (les modes autorisés sont la décision D2) :

| Mode | Déroulé | Risque principal |
|---|---|---|
| `RETOUR_PUIS_ENVOI` | Le client rend l'article (dépôt, ramassage ou colis retour) ; après **inspection**, le remplacement part | Plus lent ; aucun risque de stock « dans la nature » |
| `ENVOI_PUIS_RETOUR` | Le remplacement part tout de suite ; l'ancien article revient ensuite | L'ancien article ne revient jamais (D6) |
| `ECHANGE_A_LA_LIVRAISON` | Le livreur remet le nouvel article et reprend l'ancien lors du même passage | Dépend du transporteur : seul Cathedis le publie, et sans API (§3). En v1 : instruction en note sur le colis, retour constaté à la réception |

Implémentation de la jambe remplacement :
- C'est un `Shipment` ordinaire sur la **commande d'origine**, avec `exchangeId` non nul. Son montant COD est figé dans `OrderExchange.replacementCodAmount`.
- Garde-fous à ajouter dans les deux écrivains existants :
  - `createShipment` : pour un colis d'échange, verrou `exchange:<id>` au lieu de `shipmentSlotLockKey(orderId)`, et **pas** de contrôle `orderGoodsCameBack`. Un seul colis actif par **échange**.
  - `applyShipmentStatusTransition` : si `exchangeId` est renseigné, **ne jamais** toucher `Order.status`, `shippedAt` ou `deliveredAt`, ne jamais appeler `fulfillStockForOrder`, ne jamais déclencher l'alerte « Commande retournée » ni le rapprochement de commission. Seuls `OrderExchange` et `ECHANGE_SORTIE` sont mis à jour.
- Adapters :
  - OzonExpress : `parcel-price` = `replacementCodAmount`, `parcel-note` = « ÉCHANGE CMD-xxxx — reprendre : <article, taille> ».
  - Aramex : même note, plus `Reference2` = id de l'échange.
  - Sendit : `deliveryExchangeId` existe déjà dans le mapper, mais **ne doit pas être utilisé** tant que sa sémantique n'est pas confirmée par écrit par Sendit (§3.3).
  - Toute automatisation passe par une capacité explicite (`CREATE_EXCHANGE`), ajoutée en même temps que la méthode, l'action et l'écran, selon la règle de `types.ts`.

Jambe retour :
- dépôt du client : réception manuelle ;
- colis retour créé par le marchand : c'est un `Shipment` avec `exchangeId` et une nature « retour » ; [INCONNU] aucun transporteur ne documente une API de ramassage chez le client ;
- reprise lors d'un échange à la livraison.

Dans tous les cas, la réception se fait dans `/livraison/retours`. L'éligibilité devient « colis RETOURNE **ou** échange ouvert avec une jambe retour attendue ».

### 6.6 Argent
- `priceDifference` (Decimal signé) = Σ(prix remplacement × qté) − Σ(prix net payé d'origine × qté retournée), figé à la création.
- Frais facturés au client : `customerShippingFee` (≥ 0) = frais des jambes dont `paidBy = CLIENT`, selon le tarif du tenant (D1). [RECO] ASODITECH n'invente jamais un tarif transporteur : le montant est saisi ou vient de la règle configurée.
- **Montant à encaisser** = max(priceDifference, 0) + `customerShippingFee`.
  - En COD : `replacementCodAmount` sur le colis de remplacement.
  - Si le client a prépayé : enregistrement manuel, et `replacementCodAmount` = 0.
- **Différence négative** : création d'un `Refund` (EN_ATTENTE) par le flux `orders.refund` existant, avec approbation. Créé **après l'inspection** de l'article d'origine, sauf décision contraire (D5). Le délai de 15 jours de l'art. 37 ne vaut que pour la rétractation. [RECO] Afficher l'échéance quand le motif est `CHANGEMENT_AVIS`.
- La recette de la commande d'origine reste intacte. Ce qui est constaté :
  - la différence encaissée, via `OrderExchange.collectedAmount` / `collectedAt`. Elle est fixée à la livraison du remplacement **seulement** si la règle « payée à la livraison » de l'entreprise est active, sinon par une personne ;
  - le `Refund` en cas de différence négative.
- `Order.paymentStatus` n'est **pas** modifié par l'échange.

### 6.7 Commissions et rentabilité
- **Commission** : aucune nouvelle écriture. La commande reste `LIVREE` (garde-fou §6.5), donc ni `REVERSED` ni nouvel `EARNED`. Les règles existantes (ADR 0022, contrainte unique `orderId, type`) tranchent : **ce n'est pas une décision ouverte**.
- **Rentabilité de la commande d'origine** :
  - coûts d'échange = `Shipment.cost` de chaque jambe (figé selon ADR 0032) ;
  - plus le coût des unités `ENDOMMAGE` ;
  - plus l'écart de coût : `costSnapshot` du remplacement − `costSnapshot` d'origine ;
  - moins la différence encaissée, plus le remboursement.

  Ces montants sont affichés dans une ligne « Échanges » du détail de rentabilité.
- **KPI** : les colis avec `exchangeId` sont **exclus** du taux de livraison, du nombre de commandes, de Suivi et des factures transporteur « par commande », mais **inclus** dans les coûts (D7). Il faut un filtre `exchangeId IS NULL` partout où l'on compte des colis par commande.
- `ERREUR_PREPARATION` alimente un indicateur « erreurs de préparation ».

### 6.8 Statuts et audit
`OrderExchange.status` (statut global) : `OUVERT → CLOTURE | ANNULE`, plus deux états de jambe :
- `returnLeg` : `NON_REQUIS | ATTENDU | RECU_A_INSPECTER | INSPECTE | NON_RECU` ;
- `replacementLeg` : `A_PREPARER | RESERVE | EXPEDIE | LIVRE | ECHEC | RETOURNE | A_VERIFIER`.

Règles :
- `CLOTURE` quand (`returnLeg ∈ {INSPECTE, NON_REQUIS}` **ou** clôture manuelle « non reçu » décidée selon D6) **et** `replacementLeg = LIVRE`, et que l'argent est soldé (encaissé ou `Refund` créé).
- `ANNULE` seulement tant que `replacementLeg ∈ {A_PREPARER, RESERVE}` et `returnLeg ∈ {ATTENDU, NON_REQUIS}`. L'annulation libère les réservations.
- `A_VERIFIER` reprend le mécanisme « issue incertaine » d'OzonExpress (commit 720fe90) : pas de nouvelle tentative automatique de création.

Audit (`recordAuditEvent`, `entityType: "OrderExchange"`, `metadata.orderId`) :
- `exchange.created`, `exchange.policy_overridden` ;
- `exchange.replacement_shipment_created`, `exchange.replacement_shipped`, `exchange.replacement_delivered`, `exchange.replacement_failed` ;
- `exchange.return_received`, `exchange.return_inspected`, `exchange.return_not_received` ;
- `exchange.difference_collected`, `exchange.refund_requested` ;
- `exchange.closed`, `exchange.cancelled`.

Libellés FR à ajouter dans `src/lib/audit-labels.ts`.

### 6.9 Permissions et isolation des tenants
- Nouvelle permission `orders.exchange` : créer, annuler, clôturer, surcharger la politique. Domaine ONLINE. Accordée par défaut là où `orders.return` l'est.
- Les autres permissions restent celles des flux réutilisés :
  - créer ou expédier le colis : `delivery.manage` ;
  - réception et inspection : `orders.return` ;
  - remboursement : `orders.refund`.
- Tenant :
  - chaque table porte `tenantId` ;
  - chaque action relit la commande, les produits, les variations et l'entrepôt **par `tenantId` de session** ;
  - l'accès à l'entrepôt est vérifié avec la logique de `hasLocationAccess` ;
  - les identifiants envoyés par le client ne sont jamais crus sans relecture.
- Sauvegarde et restauration (ADR 0034) : ajouter les nouvelles tables à l'export et à la restauration transactionnelle.

### 6.10 Idempotence, reprises, pannes
| Risque | Parade |
|---|---|
| Double clic ou rejeu à la création | `@@unique([orderId, idempotencyKey])`, comme `OrderReturn` |
| Deux échanges concurrents sur la même ligne | Verrou de ligne sur la commande, puis recalcul de la quantité échangeable sous verrou |
| Double `ECHANGE_SORTIE` | Index unique partiel `(orderExchangeLineId) WHERE type = 'ECHANGE_SORTIE'`, plus mise à jour conditionnelle (`updateMany` avec contrôle du nombre de lignes) |
| Création de colis à l'issue incertaine (timeout) | `A_VERIFIER`, pas de nouvelle tentative automatique (ADR OzonExpress) |
| Évènement transporteur rejoué | Mise à jour conditionnelle existante de `Shipment.status`, plus transition conditionnelle de la jambe |
| Remboursement créé deux fois | `OrderExchange.refundId @unique` |
| Remplacement refusé | `replacementLeg = RETOURNE` → réception liée à la ligne d'échange → stock réintégré une fois. L'échange reste ouvert pour une décision : renvoyer ou rembourser |
| Ancien article jamais rendu | Rappel après N jours, puis clôture « non reçu » selon D6, auditée. Aucun mouvement de stock (l'unité n'est jamais revenue) |

### 6.11 Interface
- Page commande : bouton **« Échanger »**, visible si le réglage est actif, la commande `LIVREE` et une ligne échangeable. Assistant en 4 étapes :
  1. articles à rendre ;
  2. remplacement (recherche produit avec le résolveur exact `resolveExactCode`, disponibilité par entrepôt) ;
  3. motif, mode et payeurs (préremplis par la politique) ;
  4. récapitulatif financier : différence, frais client, montant COD à encaisser ou montant à rembourser.
- Panneau « Échanges » sur la commande : les deux jambes, les liens vers le colis et la réception, et la chronologie d'audit.
- `/livraison/retours` : onglet ou filtre « Échanges attendus ».
- Liste des commandes : badge « Échange en cours ».
- Rapports : colonne « coûts d'échange » dans la rentabilité, indicateur « erreurs de préparation ».
- Textes en français. Explications ⓘ dans `settings-explanations.ts` pour les réglages.

---

## 6bis. Esquisse Prisma et migration (NON implémentée)

```prisma
// --- migration A (seule) : ALTER TYPE ne peut pas être utilisé dans la même transaction
enum InventoryMovementType {
  // … valeurs existantes …
  ECHANGE_SORTIE
}

// --- migration B
enum OrderExchangeStatus  { OUVERT CLOTURE ANNULE }
enum OrderExchangeReason  { TAILLE_COULEUR CHANGEMENT_AVIS DEFECTUEUX ERREUR_PREPARATION ENDOMMAGE_TRANSPORT AUTRE }
enum OrderExchangeFlow    { RETOUR_PUIS_ENVOI ENVOI_PUIS_RETOUR ECHANGE_A_LA_LIVRAISON }
enum ExchangeParty        { CLIENT BOUTIQUE }
enum ExchangeReturnLeg    { NON_REQUIS ATTENDU RECU_A_INSPECTER INSPECTE NON_RECU }
enum ExchangeReplacementLeg { A_PREPARER RESERVE EXPEDIE LIVRE ECHEC RETOURNE A_VERIFIER }

model OrderExchange {
  id                       String   @id @default(cuid())
  tenantId                 String
  orderId                  String
  idempotencyKey           String
  status                   OrderExchangeStatus   @default(OUVERT)
  reason                   OrderExchangeReason
  flow                     OrderExchangeFlow
  returnLeg                ExchangeReturnLeg
  replacementLeg           ExchangeReplacementLeg @default(A_PREPARER)
  returnShippingPaidBy     ExchangeParty
  replacementShippingPaidBy ExchangeParty
  policyOverridden         Boolean  @default(false)
  priceDifference          Decimal  @db.Decimal(12, 2)   // signé
  customerShippingFee      Decimal  @default(0) @db.Decimal(12, 2)
  replacementCodAmount     Decimal  @default(0) @db.Decimal(12, 2)
  collectedAmount          Decimal? @db.Decimal(12, 2)
  collectedAt              DateTime?
  refundId                 String?  @unique
  note                     String?
  createdById              String?
  closedAt                 DateTime?
  cancelledAt              DateTime?
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt

  order     Order    @relation(fields: [orderId], references: [id], onDelete: Restrict)
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  refund    Refund?  @relation(fields: [refundId], references: [id], onDelete: Restrict)
  lines     OrderExchangeLine[]
  shipments Shipment[]
  receptions ReturnReception[]
  movements InventoryMovement[]

  @@unique([orderId, idempotencyKey])
  @@index([orderId])
  @@index([tenantId, status])
  @@map("order_exchanges")
}

model OrderExchangeLine {
  id                     String  @id @default(cuid())
  tenantId               String
  orderExchangeId        String
  orderItemId            String?          // SetNull, comme OrderReturnLine
  returnQuantity         Int
  originalUnitNetPrice   Decimal @db.Decimal(12, 2)
  replacementProductId   String?
  replacementVariationId String?
  replacementQuantity    Int
  nameSnapshot           String
  skuSnapshot            String
  unitPriceSnapshot      Decimal @db.Decimal(12, 2)
  costSnapshot           Decimal? @db.Decimal(12, 2)
  warehouseId            String
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  // relations : exchange (Cascade), tenant, orderItem (SetNull), product/variation (SetNull), warehouse (Restrict)
  @@index([orderExchangeId])
  @@index([tenantId])
  @@map("order_exchange_lines")
}

// Colonnes additives, toutes nullables :
// Shipment.exchangeId            String?  (index)
// InventoryMovement.orderExchangeId / orderExchangeLineId String? (SetNull)
// ReturnReception.orderExchangeId String? (index)
// OrderReturnLine.orderExchangeLineId String? (retour d'un remplacement)
// BusinessSettings.exchangesEnabled Boolean @default(false)
// BusinessSettings.exchangeWindowDays Int?   (D4)
// BusinessSettings.exchangePolicy Json?      (D1 : payeur par motif)
// Refund.payoutMethod String?  (espèces / virement / mandat — §4)
```

Partie SQL brute de la migration B :
- CHECK `returnQuantity >= 0`, `replacementQuantity > 0`, au moins une ligne avec `returnQuantity > 0`.
- CHECK `replacementCodAmount >= 0`, `customerShippingFee >= 0`.
- Index unique partiel `inventory_movements (orderExchangeLineId) WHERE type = 'ECHANGE_SORTIE'`.
- Index unique partiel « au plus une réception A_INSPECTER par échange », sur le modèle de celui par colis.
- Index unique partiel `shipments (exchangeId) WHERE status IN ('EN_ATTENTE','EN_TRANSIT')`.
- **Droits du rôle d'exécution** sur les nouvelles tables, vérifiés par `scripts/prod-check-runtime-role.sql`. Le même point était ouvert pour P3.
- Avant tout `migrate deploy`, vérifier vers quelle base pointe chaque environnement (Preview ≠ Prod depuis le 2026-10-02, à revérifier).

---

## 7. Décisions du propriétaire (seulement ce que la recherche et les règles existantes ne tranchent pas)

1. **D1 — Payeur du transport par motif et par jambe**. Pour TAILLE_COULEUR, CHANGEMENT_AVIS et AUTRE : client ou boutique, pour la jambe retour et pour la jambe remplacement ? Pour DEFECTUEUX, ERREUR_PREPARATION et ENDOMMAGE_TRANSPORT, la spécification propose « boutique » (§2.3, §4). Confirmez, et donnez le montant facturé au client, fixe ou saisi.
2. **D2 — Modes autorisés** : `RETOUR_PUIS_ENVOI` seulement, ou aussi `ENVOI_PUIS_RETOUR` (le remplacement part avant le retour de l'ancien article) et `ECHANGE_A_LA_LIVRAISON` ? Par motif ?
3. **D3 — Prix du remplacement et remises** : prix catalogue actuel ou prix payé d'origine (même produit, autre variante) ? Et comment répartir une remise de commande sur l'article rendu ?
4. **D4 — Délai et exclusions** : nombre de jours après livraison pendant lesquels un échange est accepté. Faut-il un marquage produit « non échangeable » (périssables, personnalisés, hygiène, cf. art. 38) ?
5. **D5 — Différence négative** : remboursement en argent (`Refund`), avoir, ou au choix ? Créé après inspection seulement, ou dès la création ? Par quel canal pour une commande COD (espèces, virement, mandat type WafaCash) ?
6. **D6 — Article d'origine jamais rendu** (mode `ENVOI_PUIS_RETOUR`) : après combien de jours ? Rappel, facturation de l'article au client, ou clôture en perte ?
7. **D7 — KPI** : confirmez que les colis d'échange sont exclus du taux de livraison et du nombre de commandes, mais comptés dans les coûts. C'est la proposition du 2026-10-12, toujours ouverte.
8. **D8 — Transporteurs** : à qui envoyer d'abord les questions du §3.3 ? (Cathedis, seul à publier l'échange ; Sendit, seul à avoir des champs API d'échange ; OzonExpress, adapter actif.) Faut-il rester en v1 manuelle (note sur le colis) tant qu'aucune réponse écrite n'est reçue ?

Décisions **tranchées** par la loi ou les règles existantes (ne pas re-demander) :
- **commission** : jamais touchée, ADR 0022 ;
- la **rétractation** reste un remboursement, pas un échange imposé (art. 36, 37, 41) ;
- **pas de seconde commande** et pas de changement de `Order.status` (ADR 0036, règles de colis) ;
- **pas de « payé »** déduit des promesses de reversement des transporteurs.

---

## 8. Plan d'implémentation et de tests

**Pré-requis** : réponses D1 à D8, et un ADR (numéro suivant : 0062) qui fige ces réponses.

| Phase | Contenu | Tests (Vitest, base de test jetable uniquement) |
|---|---|---|
| P0 | ADR 0062 ; libellés ; `exchangesEnabled` et politique dans Paramètres (désactivé par défaut) | Réglage refusé sans `settings.manage` ; audit `settings.updated` |
| P1 | Migration A (enum seul), puis migration B ; droits du rôle ; sauvegarde et restauration | Migration sur une base de test vierge ; restauration aller-retour avec échanges ; `prod-check-runtime-role.sql` |
| P2 | Domaine pur `src/lib/exchanges/` : éligibilité, quantité échangeable, calcul de la différence et du COD, table de transitions des jambes | Tests unitaires : ligne partiellement retournée, deux échanges concurrents, différence +, − et 0, frais client, transitions interdites |
| P3 | Action `createExchangeAction` (verrou de commande, idempotence, réservation) et `cancelExchangeAction` (libération) | Rejeu de la même clé = pas d'effet ; stock insuffisant ; autre tenant refusé ; entrepôt sans accès refusé |
| P4 | Jambe remplacement : `createShipment` avec `exchangeId` (verrou par échange, sans `orderGoodsCameBack`) ; garde-fou dans `applyShipmentStatusTransition` ; `ECHANGE_SORTIE` unique | **Test critique** : un colis d'échange LIVRE, RETOURNE ou ECHEC ne change jamais `Order.status`, n'écrit jamais VENTE, ne touche jamais la commission. ECHANGE_SORTIE écrit une seule fois malgré 3 évènements rejoués |
| P5 | Jambe retour : `ReturnReception.orderExchangeId`, inspection via `recordPhysicalReturn` ; retour d'un remplacement via `orderExchangeLineId` | Plafond par ligne d'origine respecté ; plafond du remplacement séparé ; une seule réception en attente par échange |
| P6 | Argent : `replacementCodAmount` transmis aux adapters (OzonExpress `parcel-price`, Aramex COD) ; `Refund` lié ; `collectedAmount` selon la règle « payée à la livraison » | COD = max(diff, 0) + frais ; différence négative → un seul Refund ; `paymentStatus` de la commande inchangé |
| P7 | Rapports : filtres `exchangeId IS NULL` (taux de livraison, Suivi, factures, nombre de commandes) ; ligne « Échanges » de la rentabilité | Régression : un tenant sans échanges a des rapports identiques au centime près |
| P8 | Interface : assistant, panneau, filtre retours, badge | Tests de composants ; vérification navigateur sur la base de dev |
| P9 | Mise en service : un tenant pilote, transporteur MANUEL d'abord, puis OzonExpress avec note ; automatisation seulement après réponses écrites | Liste de contrôle dans `docs/RELEASE-VERIFICATION-CHECKLIST.md` |

---

## 9. Sources

| # | URL | Éditeur | Date | Ce que la source étaye |
|---|---|---|---|---|
| S1 | https://adala.justice.gov.ma/api/uploads/2024/03/01/protection%20de%20consommateur-1709283839988.pdf | Ministère de la Justice, portail Adala (texte de la loi 31-08 avec notes) | Loi : dahir du 18/02/2011, BO n° 5932 du 07/04/2011 p. 347 ; fichier mis en ligne le 2024-03-01 (date du chemin d'URL) | Art. 12-14, 25-44 (vente à distance, rétractation 7/30 jours, remboursement 15 jours, exclusions, substitution), 65-73 (garanties), seuil de 3 000 DH (décret 2-12-503, art. 28) |
| S2 | https://fr.hespress.com/413805-droits-des-consommateurs-nouvelle-proposition-de-loi-pour-elargir-le-droit-de-retractation.html | Hespress FR | 2025-03-16 | Proposition de modification des art. 36 et 38 ; déposée, non adoptée à cette date |
| S3 | https://lematin.ma/economie/livraison-de-colisle-maroc-prepare-un-cadre-legal-pour-assainir-le-secteur/345448 | Le Matin | 2026-05-13 | Avant-projet de loi sur la livraison de colis : autorisation, amendes, monopole < 1 kg, garanties consommateur ; non adopté |
| C1 | https://www.sendit.ma/nos-services/ | Sendit | date non indiquée | Retour gratuit (injoignable, annulation), refus gratuit, paiement sous 24h, stockage des colis retournés |
| C2 | Export Swagger Sendit fourni par le propriétaire (local, hors dépôt : `lvr societes APIs/sendit.rtf`) | Sendit | date non indiquée | Champs `option_exchange`, `delivery_exchange_id` dans `POST /deliveries` et le détail, sans description |
| C3 | https://wordpress.org/plugins/sendit-ma-integration/ (archive v2.2.5) | Sendit / WordPress.org | v2.2.5, téléchargée en session | Le plugin officiel n'utilise aucun champ d'échange ; URL d'API `app.sendit.ma/api/v1` |
| C4 | https://ameex.ma/fr/tarifs | Ameex | date non indiquée (© 2026) | « Retour 0 MAD », « Les colis retournés ne sont pas facturés », reversement « sous 24h après la livraison » |
| C5 | https://ameex.ma/fr/conditions | Ameex | date non indiquée (© 2026) | §9.3 calendrier de virement ; §9.4 5 DH par virement ; §10.1 motifs de retour, dont la demande du client final ; §10.2 10 DH par refus ; §10.3 liquidation sous 15 jours ; 3 tentatives de livraison |
| C6 | https://www.ozonexpress.ma (textes FR de l'application, bundle `/assets/index-DloLF5V3.js`) ; ADR 0013 du dépôt | OzonExpress | date non indiquée | « Virement bancaire toutes les 24h », « Remboursement bancaire garanti sous 24h », « Bons de retour » ; aucun texte d'échange ; prix de retour et de refus observés via l'API (ADR 0013, 2026-09-01) |
| C7 | https://cathedis.ma/ et https://cathedis.ma/nos-tarifs/ | Cathedis | date non indiquée | « Échanges de marchandises » ; Pack Gold « Retour d'échange de colis Gratuit » ; retour de cash 1×/sem (Silver) ou 2×/sem (Gold) ; retours gratuits jusqu'à 10 % / 20 % |
| C8 | https://forcelog.ma/ et https://forcelog.ma/tarifs-colis/ | ForceLog | date non indiquée | Retour 0 MAD, retour en 5-7 jours, « Retour de fond 24h » / « Chaque 12h - 24h » |
| C9 | https://onessta.com/ | Onessta | date non indiquée | Fonds « deux fois par semaine » et « Paiement chaque 24h » (contradiction) ; changement de destinataire au retour |
| C10 | https://www.chronodiali.ma/ | Chrono Diali | date non indiquée | Retour des colis à l'adresse du marchand, « retours de fond » pilotés en ligne |
| C11 | https://www.speedaf.com/ma-fr | Speedaf | date non indiquée | Aucune information sur l'échange, le retour ou le COD |
| M1 | https://www.marjanemall.ma/retour-et-remboursement | Marjane Mall | date non indiquée (© 2026) | 7 jours ; frais de rétractation au client ; non conforme gratuit ; remboursement COD par code WafaCash ; ramassage en 3 tentatives ; dépôt Amana avec BDR |
| M2 | https://www.decathlon.ma/content/12-retour-echange | Decathlon Maroc | date non indiquée | Échange 1 an avec compte client ; remboursement 30 jours ; frais de retour en ligne au client sauf problème de commande ou de livraison |
| M3 | https://www.kitea.com/conditions-generales-enligne | Kitea | date non indiquée | 300 MAD de frais pour changer de produit après expédition ; rétractation 7 jours ; frais de retour d'au moins 360 MAD ; remboursement en 30 jours minimum ; moyens de paiement |
| R1 | `docs/research/order-exchanges-proposal.md`, `docs/research/carrier-exchange-capabilities.md`, ADR 0006, 0013, 0022, 0032, 0036 ; `prisma/schema.prisma` | Dépôt ASODITECH | 2026-08 à 2026-10 | État du code et des règles existantes (§5) |

Recherché sans résultat exploitable :
- portail consommateur khidmat-almostahlik.ma (injoignable) ;
- site Amana / Barid Al-Maghrib (non résolu) ;
- aramex.ma (HTTP 403) ;
- politique de retour de Jumia Maroc (contenu chargé en JavaScript, non lisible) ;
- guides marchands sur l'échange en COD (rien de fiable trouvé).
