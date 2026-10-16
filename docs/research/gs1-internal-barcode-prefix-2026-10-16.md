# Codes-barres internes : préfixe GS1 et symbologie (2026-10-16)

**Statut : RECHERCHE et RECOMMANDATION. Aucun code n'a été modifié.** Ce
document évalue le choix de l'ADR 0061 :

- `src/lib/catalog/generated-barcode.ts` : `"20"` + séquence du tenant sur 10 chiffres + clé GS1 modulo 10, soit un nombre de forme EAN-13 ;
- `src/lib/catalog/label-barcode.ts` et `printable-label.tsx` : le code est imprimé en **Code 128** sous la légende « CODE INTERNE — PAS UN EAN/GTIN ».

Étiquettes utilisées dans ce document :

| Étiquette | Sens |
|---|---|
| **[OFFICIEL]** | Texte normatif GS1 |
| **[GS1 MA]** | Ce que GS1 publie pour le Maroc |
| **[ÉQUIPEMENT]** | Documentation d'un fabricant de scanner |
| **[RECO]** | Notre analyse |
| **[INCONNU]** | Recherché, aucune preuve trouvée |

---

## 1. Ce que dit GS1

Source principale : **GS1 General Specifications Standard, Release 26.0, Ratified, Jan 2026** (G1).

### 1.1 Définition et règle de symbologie — [OFFICIEL]
- **§1.2.2.2.1** : les Restricted Circulation Numbers (RCN) « SHALL NOT be used globally or in open environments ». Ils sont « allocated by GS1 either for internal use by companies or to GS1 Member Organisations for assignment based on business needs in their country (e.g., variable measure trade item identification, coupons) ».
- **Même section, règle de symbologie** : « Restricted Circulation Numbers (RCNs) **SHALL only be encoded in EAN-8, EAN-13, UPC-A, or UPC-E barcodes**. RCNs SHALL NOT be encoded using any GS1 Application Identifiers. » La règle est reprise au §2.1.11, déjà présente dans le GSCN 23-006 (G3, ratifié en mars 2023).
- La note du même paragraphe ajoute :
  - les RCN ne peuvent pas aller dans les codes 2D, puisqu'ils ne s'écrivent pas avec un AI ;
  - pour les produits frais, GS1 « strongly recommend[s] » le GTIN.

### 1.2 Tableau des préfixes (Table 1-4) — [OFFICIEL]
| Préfixe GS1 | Signification (citation) |
|---|---|
| `02` | « Used to issue Restricted Circulation Numbers within a geographic region (**MO defined**) » |
| `04` | « Used to issue Restricted Circulation Numbers within a company (**GS1 user company defined**) » |
| `20 – 29` | « Used to issue Restricted Circulation Numbers within a geographic region (**MO defined**) » |

MO = GS1 Member Organisation, c'est-à-dire l'organisation nationale : GS1 Maroc pour le Maroc.

### 1.3 Sections applicatives — [OFFICIEL]
- **§2.1.11** (« Fixed measure trade items – restricted distribution applications ») : « The regulations established by GS1 Member Organisations for their country or assigned area should be observed for the allocation of these Restricted Circulation Numbers ». Pour un usage interne à une entreprise, « the structure and management of the numbers […] are the responsibility of the user ».
- **§2.1.11.1** : RCN-8 avec préfixe 0 ou 2, numérotation interne d'entreprise. C'est un format à 8 chiffres, qui ne correspond pas au nôtre.
- **§2.1.11.2** : « Company internal numbering – RCN-13 GS1 Prefix **04** ». Citations :
  - « **Any company in the world may use this element string for company internal trade item numbering.** »
  - « The GS1 Prefix 04 is a system identifier showing that the identification number is under the sole control of the assigning company ».
  - Structure : `0 4 N3…N12 N13`, positions N3 à N12 libres, clé §7.9.
  - Support : « EAN-13 (carrying RCN-13) » ou UPC-A (RCN-12, préfixe U.P.C. 4).
- **§2.1.11.4** : « GS1 Prefixes **02, 20 to 29** – Restricted distribution ». Citations :
  - « reserved for identification purposes within a restricted geographic area. **Each GS1 Member Organisation is entitled to assign the prefixes to be used** for these element strings in its country » ;
  - usages possibles : identification de produits à poids variable ou fixe, ou « internal numbering […] by a particular company » ;
  - « A particular prefix may be assigned either for use on fixed measure trade items for restricted distribution or for variable measure trade items » ;
  - support : EAN-13.
- **§2.1.12.2** (poids variable en caisse avec RCN) : les MO « SHOULD assign one or several of the GS1 Prefixes 02, 20 through 29 for the identification of variable measure trade items ». Les caisses peuvent être programmées « to use the prefix as an instruction to decode the ensuing data fields » : poids, prix.
- **§5 (GS1-128)** : « The GS1-128 barcode is a subset of the Code 128 barcode symbology. Its use is exclusively licenced to GS1. » Un Code 128 **sans FNC1** en tête n'est pas un GS1-128 : ce n'est pas un support de données GS1.
- **§5.2 (UPC-A)** : « A UPC-A barcode may be decoded as a 13-digit number by adding an implied leading zero. » Réciproquement, un EAN-13 qui commence par `0` est un symbole UPC-A.

### 1.4 GS1 Maroc — [GS1 MA]
- Le document GS1 « **Summary of GS1 Prefixes 20 - 29 by GS1 Member Organisation** », Release 5.1.5, **Draft, mars 2026** (G2), contient une section **§2.50 GS1 Morocco**, page 60 :
  - `02` → note « **Internal use** » ;
  - `20` à `29` → « **GS1 Prefixes 20 to 29 are released for in-store use** » ;
  - une clé « C » en fin de code pour 20, 21, 22 et 26 à 29 ;
  - pour **23, 24 et 25**, une clé « C » placée en **position intermédiaire**. [RECO] Dans ce document, une clé intermédiaire signale en général une structure à prix ou poids intégré (clé de prix). **La légende de la section Maroc ne décrit pas cette structure** : interprétation non confirmée.
  - « A national solution for coupons does not exist. »
- L'introduction de G2 précise :
  - « Individual GS1 Member Organisations remain the definitive source of any local solutions » ;
  - les préfixes 02 et 20-29 « were often used for the identification of Variable Measure Retail Items » ;
  - « 13-digit numbers created using the GS1 prefix 02 and 20 through 29 are NOT GTINs ».
- **[INCONNU]** Le site gs1ma.org (G4) n'a **aucune page** sur les RCN, les codes internes ou le poids variable dans les pages lues : GTIN, EAN/UPC, GS1-128, liste des standards. Sa page GS1-128 dit seulement que ce code « est destiné à être scanné dans un environnement logistique, mais pas à la caisse d'un magasin de détail ». **Aucune règle marocaine publiée ne précise qui peut utiliser 20-29** : un détaillant seul, ou toute entreprise pour son usage interne. G2 est un **brouillon**.

---

## 2. Compatibilité des scanners et caisses

- **[ÉQUIPEMENT]** Zebra DS2208, Product Reference Guide MN-002874-14EN Rev. A, octobre 2025 (G5), table 12-1 « Standard default parameters » : **EAN-13/JAN 13 = Enable**, **Code 128 = Enable**, **GS1-128 = Enable** par défaut. C'est un seul modèle. Le scanner HENEX du propriétaire n'est pas documenté publiquement ici [INCONNU]. `docs/SCANNER-VERIFICATION.md` note déjà « Code 128 enabled (default on most models) » : à vérifier sur l'appareil.
- **[ÉQUIPEMENT]** Le même guide expose les réglages « UPC-A Preamble » et « Transmit UPC-A Check Digit ». La chaîne transmise pour un symbole UPC-A (un EAN-13 commençant par 0) dépend donc de la configuration du scanner. Un Code 128 transmet exactement les caractères encodés.
- **[OFFICIEL] et [RECO]** Une caisse d'enseigne qui reçoit un EAN-13 commençant par 2x peut appliquer sa règle « poids ou prix variable » (§2.1.12.2). C'est le **conflit principal** du préfixe 20 **hors** de l'environnement du tenant. Dans ASODITECH, la recherche est exacte (`resolveExactCode`) et aucune interprétation poids/prix n'existe : **aucun conflit interne**.
- **Bibliothèque** : JsBarcode 3.12.3 (dans `package.json`) gère `EAN13` et `CODE128` (README de JsBarcode, G6). L'impression en EAN-13 est donc techniquement possible sans nouvelle dépendance.
- **Caméra** : `RELEVANT_BARCODE_FORMATS` contient `ean_13` et `code_128`. Une étiquette **imprimée en Code 128** est lue comme `code_128`, pas comme `ean_13`. [RECO] La phrase du commentaire de `generated-barcode.ts` « the camera decoder reads it as ean_13 » n'est vraie que si le code est imprimé en EAN-13, par exemple par un tiers. À corriger dans un commentaire, sans incidence fonctionnelle.

---

## 3. Évaluation du choix actuel

| Critère | Préfixe `20` + Code 128 (actuel) | Préfixe `04` + Code 128 | Préfixe `04` + EAN-13 | Préfixe `20` + EAN-13 | Préfixe `02` |
|---|---|---|---|---|---|
| Sens GS1 mondial du préfixe | RCN régional, défini par la MO | **RCN interne d'entreprise, « any company in the world »** (§2.1.11.2) | idem | RCN régional, défini par la MO | RCN régional, défini par la MO |
| Sens au Maroc (G2, brouillon) | « released for in-store use » | — (04 n'est pas défini par la MO) | — | « in-store use » | « Internal use » |
| Risque d'interprétation poids/prix par une caisse tierce | **Oui** dans beaucoup de pays (§2.1.12.2, G2 §1.2) ; au Maroc, 23-25 semblent structurés, 20 ne l'est pas d'après G2 | **Non** (04 n'est jamais un poids variable) | Non | Oui | Variable selon les pays (G2) ; « Internal use » au Maroc |
| Conformité de symbologie (§1.2.2.2.1 « SHALL only be encoded in EAN/UPC ») | **Non conforme** : RCN dans du Code 128 | Non conforme | **Conforme** | Conforme | dépend |
| Lecture par scanner | Exacte (13 caractères transmis) | Exacte | Le symbole est un **UPC-A** : la chaîne transmise peut faire 12 chiffres selon le réglage (G5) ; la recherche gère déjà l'équivalence UPC-A↔EAN-13 | Exacte | — |
| Collision avec un GTIN réel déjà stocké | Impossible (commence par 2) | Impossible comme GTIN ; **équivalence possible** avec un UPC-A interne `4…` (RCN-12 U.P.C. préfixe 4) d'un fournisseur. Le générateur saute déjà les numéros déjà utilisés (exacts ou équivalents GTIN, ADR 0061) | idem | Impossible | — |
| Coût du changement | — | Faible : **ADR 0061 n'est ni commité ni déployé** (statut du 2026-10-15), donc aucun code `20…` n'existe en production | Moyen : rendu d'étiquette EAN-13 et tests de lecture à refaire | Moyen | Faible |

Le choix actuel :

**Ce qui est solide :**
- 13 chiffres avec une clé valide ;
- jamais un GTIN ;
- exclu de l'export GTIN ;
- légende explicite ;
- lecture exacte en Code 128 ;
- conforme à l'idée générale d'un « RCN pour usage interne ».

**Ce qui est fragile :**
- **(a)** au Maroc, `20-29` sont publiés comme « in-store use » par la MO et, ailleurs, souvent comme poids variable. Ce n'est pas le préfixe que GS1 réserve explicitement à **toute entreprise** pour sa numérotation interne : c'est `04`.
- **(b)** imprimer un RCN en Code 128 contredit la règle « SHALL only be encoded in EAN-8, EAN-13, UPC-A, or UPC-E ». En pratique, cela n'a aucun effet dans ASODITECH. Mais un tiers qui lit le code ne reconnaît pas un RCN, ce qui est peut-être souhaitable pour éviter une interprétation poids/prix, mais ce n'est pas conforme.

---

## 4. Recommandation (ne pas modifier le code sans décision)

**[RECO] Option privilégiée : passer au préfixe `04` pour les nouveaux codes, en gardant l'impression Code 128 et la légende.**

**Pourquoi `04` :**
- c'est le seul préfixe que la norme GS1 mondiale attribue explicitement à « any company in the world » pour une numérotation interne (§2.1.11.2, Table 1-4), sans dépendre d'une règle nationale ;
- il n'est jamais lu comme un poids ou un prix variable ;
- il évite tout chevauchement avec l'usage « in-store » des détaillants marocains (G2) ;
- l'ADR 0061 n'étant pas déployé, le changement ne coûte presque rien : aucune donnée de production à migrer.

**Points à traiter si `04` est retenu :**
- `GENERATED_PATTERN` devient `/^04\d{11}$/` ;
- la sauvegarde/restauration doit faire avancer le compteur au-delà du plus haut code `04…` ;
- la phrase « Starting with "2", it can never be a GTIN-equivalent spelling » n'est plus vraie : un `04…` à 13 chiffres équivaut à un UPC-A `4…` à 12 chiffres. Le saut des numéros déjà pris couvre la génération. La recherche reste exacte, plus l'équivalence déjà prévue ;
- tests à adapter : `isGeneratedProductBarcode` et l'export (`exportableBarcode`).

**Pourquoi garder Code 128 plutôt qu'EAN-13 :**
- transmission exacte, sans conversion UPC-A ↔ EAN-13 liée au réglage du scanner ;
- même rendu que tous les autres codes de l'étiquette ;
- vérifié par `tests/lib/label-scan-compat.test.ts`.

C'est un écart **assumé et documenté** à la règle de symbologie GS1. Il est acceptable tant que le code reste **dans l'environnement du tenant** : la légende le dit, et l'export GTIN l'exclut déjà.

**Alternatives acceptables, à décider par le propriétaire :**
1. **Garder `20`** si l'on considère, avec G2, que « in-store use » couvre l'usage interne d'un commerçant. Il faut alors documenter dans l'ADR 0061 le risque d'interprétation poids/prix par une caisse tierce, et **demander confirmation écrite à GS1 Maroc** (gs1ma.org, Casablanca), qui reste « the definitive source » (G2).
2. **Conformité stricte** : `04` imprimé en **EAN-13**. Il faut alors tester la lecture sur le scanner HENEX et la caméra, en vérifiant que la chaîne transmise fait 12 ou 13 chiffres. La recherche gère déjà les deux.
3. `02` : **non recommandé**. Défini par la MO, il est noté « Internal use » au Maroc, mais son usage varie selon les pays et il n'offre aucun avantage sur `04`.

Quelle que soit l'option :
- ne jamais présenter ces codes comme des EAN/GTIN (déjà fait) ;
- ne jamais les exporter vers une boutique ou une place de marché comme GTIN (déjà fait) ;
- pour des produits revendus à des enseignes, le marchand doit acheter de vrais GTIN auprès de GS1 Maroc (préfixe pays 611, G4).

Décision du propriétaire (une seule) : **préfixe `04`, recommandé, ou `20`, à conserver avec la confirmation de GS1 Maroc ?** Et, en option : Code 128, recommandé, ou EAN-13 strict ?

---

## 5. Sources

| # | URL | Éditeur | Date | Ce que la source étaye |
|---|---|---|---|---|
| G1 | https://ref.gs1.org/standards/genspecs/ (PDF « GS1 General Specifications Standard ») | GS1 AISBL | Release 26.0, Ratified, janvier 2026 | §1.2.2.2.1 (RCN, règle EAN/UPC seulement), Table 1-4 (02 / 04 / 20-29), §2.1.11 et §2.1.11.1-2.1.11.4 (pp. 113-117), §2.1.12.2, §5 GS1-128 sous-ensemble de Code 128 (p. 318), §5.2 UPC-A avec zéro implicite (p. 327) |
| G2 | https://www.gs1.org/docs/barcodes/SummaryOfGS1MOPrefixes20-29.pdf | GS1 AISBL | Release 5.1.5, **Draft**, mars 2026 | §2.50 GS1 Morocco (p. 60) : 02 « Internal use », 20-29 « released for in-store use » ; introduction : les MO sont la source de référence ; 02/20-29 souvent utilisés pour le poids variable |
| G3 | https://www.gs1.org/docs/barcodes/GSCN-23-006-RCN.pdf | GS1 AISBL | GSCN 23-006, ratifié en mars 2023 | Clarification des RCN ; texte du §2.1.11 et du §2.1.11.1 ; règle « SHALL only be encoded in EAN-8, EAN-13, UPC-A, or UPC-E » |
| G4 | https://gs1ma.org/ (pages GTIN, codes EAN/UPC, GS1-128) ; https://www.gs1.org/locations/morocco | GS1 Maroc / GS1 AISBL | date non indiquée | Aucune page RCN trouvée ; GS1-128 « pas à la caisse » ; coordonnées GS1 Maroc |
| G5 | https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/product/ds2208-prg-en.pdf | Zebra Technologies | MN-002874-14EN Rev. A, octobre 2025 | Valeurs par défaut : EAN-13, Code 128 et GS1-128 activés ; réglages UPC-A Preamble / Transmit Check Digit |
| G6 | https://github.com/lindell/JsBarcode (README) | Projet JsBarcode | branche master, consultée en session | Formats CODE128 et EAN-13 gérés |
| R1 | `docs/adr/0061-product-barcode-generation.md`, `src/lib/catalog/generated-barcode.ts`, `src/lib/catalog/label-barcode.ts`, `src/components/products/printable-label.tsx`, `src/lib/barcode-scanner/support.ts`, `docs/SCANNER-VERIFICATION.md` | Dépôt ASODITECH | 2026-10-15 | Choix actuel et état (local, non commité, non déployé) |
