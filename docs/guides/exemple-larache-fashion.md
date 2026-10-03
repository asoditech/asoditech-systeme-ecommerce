# مثال تدريبي — محل ملابس بالعرائش + Ecommerce Online

> **مثال عملي — Larache Fashion**
> «Larache Fashion» شركة خيالية. السلع، الأرقام والأسماء كلها أمثلة.
> بدّلهم بالسلع ديالك الحقيقية وتبّع نفس الخطوات.
>
> أسماء الصفحات والأزرار مكتوبة **بالفرنسية بحال ما كتبان فالتطبيق** (مثلاً **Réceptions**، **Valider la vente**).

---

## 0. قبل ما تبدا (مرة وحدة)

| شنو خاص يكون | فين تشوفو | ملاحظة |
|---|---|---|
| الحساب ديالك مفعّل بنمط **«En ligne + Magasin»** | فالقائمة كتلقى **Ventes magasin**، **Réceptions**، **Fournisseurs** | هاد النمط كيفعّلو فريق ASODITECH، ماشي انت. إلا ما لقيتيش هاد الصفحات، تواصل معانا. |
| الموقع ديالك (WooCommerce ولا Shopify) مربوط | **Intégrations** | باش تقدر تنشر السلعة فالموقع وباش الطلبات ديال الموقع يدخلو أوتوماتيكياً. |
| عندك جوج **Emplacements** | **Emplacements** | شوف القسم 2. |
| عندك قناة بيع ديال المحل | **Paramètres → Canaux de vente** | شوف القسم 2. |

---

## 1. كيفاش خدام المشروع ديالنا؟

فكرة وحدة خاصك تفهمها مزيان:

> **الستوك كاين فبلاصة حقيقية (Emplacement). القناة (En ligne / Magasin) غير كتقول فين مسموح نبيعو السلعة.**

- **Produit** = السلعة. كتتسجل **مرة وحدة** فالكتالوغ، واخا كتبيعها Online و Offline.
- **Emplacement** = بلاصة حقيقية فيها السلعة: المخزن، المحل ديال العرائش… كل بلاصة عندها الكمية ديالها.
- **Canal de vente** = طريقة البيع: **En ligne** (الموقع + الطلبات بالتيليفون/واتساب) ولا **Magasin** (البيع فالمحل).

ما كاينش «ستوك Online» و «ستوك Offline» مخبيين فالسيستام. كاين غير **شحال فكل Emplacement**.
- **Online** كيبيع من الستوك اللي فالـ Emplacements ديال النوع **Entrepôt**.
- **المحل** كيبيع من الستوك اللي فالـ **Magasin Larache**.

---

## 2. الهيكلة

```
المورّد (Fournisseur)
   ↓  Réception  ← كتسجل السلعة اللي وصلات وكتختار فين دخلات
Emplacement : Entrepôt principal  (المخزن — منو كيبيع الموقع)
   ↓  Transfert  ← كتصيفط جزء للمحل
Emplacement : Magasin Larache      (المحل — منو كيبيع Offline)
   ↓
البيع
   • Online  : Commande  → Confirmée (كتتحجز) → Expédiée (كتنقص)
   • Offline : Vente magasin → Valider la vente (كتنقص فالحين)
   ↓
الستوك كينقص أوتوماتيكياً — ما كتنقصو حتى حاجة بيدك
```

### الإعداد ديال Larache Fashion (مرة وحدة)

**أ) Emplacements** (القائمة **Emplacements**)

| Nom | Type | علاش |
|---|---|---|
| **Entrepôt principal** | Entrepôt | كاين من الأول، عليه علامة **Par défaut**. الستوك ديالو هو اللي كيبان فالموقع. |
| **Magasin Larache** | Magasin | المحل ديال العرائش. الستوك ديالو **ما كيمشيش للموقع أبداً**. |

باش تزيد **Magasin Larache**: **Emplacements** ← **Nouvel emplacement de stock** ← Nom: `Magasin Larache` ← Type: **Magasin** ← **Ajouter**.

**ب) Canaux de vente** (**Paramètres → Canaux de vente**)

| Canal | Type | Emplacements de vente |
|---|---|---|
| **En ligne** | En ligne | كاينة من الأول، مربوطة بـ **Entrepôt principal** |
| **Magasin Larache** | Magasin | **Magasin Larache** |

باش تزيد القناة ديال المحل: **Nouveau canal de vente** ← Nom: `Magasin Larache` ← Type: **Magasin (vente en point de vente)** ← علّم **Magasin Larache** تحت **Emplacements de vente** ← **Créer le canal**.

---

## 3. مثال المنتجات

الكمية المكتوبة هي **فاش السلعة كتوصل من المورد**. الستوك كيتحسب **لكل variante بوحدها** (مثلاً Polo Bleu / M).

| Produit | Variantes | الكمية | Online؟ | Offline؟ | Emplacement | ملاحظات |
|---|---|---|---|---|---|---|
| T-shirt Basic | Taille S/M/L/XL × Couleur Noir/Blanc | 100 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 70 فالمخزن، 30 فالمحل |
| **Polo Classic** | Couleur Bleu × Taille S/M/L/XL | 100 | ✅ | ✅ | Entrepôt principal + Magasin Larache | **المثال 1** (القسم 4) |
| Jean Slim | Taille 30/32/34/36 | 60 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 40 / 20 |
| Chemise Homme | Taille S/M/L/XL × Couleur Blanc/Bleu ciel | 48 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 32 / 16 |
| Robe Femme | Taille S/M/L | 30 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 20 / 10 |
| Pantalon Femme | Taille 36/38/40 | 30 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 20 / 10 |
| Pull Laine | Taille M/L/XL | 24 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 12 / 12 |
| Veste Hiver | Taille M/L/XL | 18 | ✅ | ✅ | Entrepôt principal + Magasin Larache | 12 / 6 |
| **Jabador Boutique Exclusive** | Taille M/L/XL | 15 | ❌ | ✅ | **Magasin Larache فقط** | **المثال 2** — Offline only |
| **Sweat Online Exclusive** | Taille M/L/XL | 40 | ✅ | ❌ | **Entrepôt principal فقط** | **المثال 3** — Online only |
| Casquette | — (بلا variantes) | 40 | ✅ | ✅ | Entrepôt principal + Magasin Larache | accessoire، 25 / 15 |

> **مهم:** «Online؟ / Offline؟» = الخانات ديال **Canaux de vente** فصفحة المنتج.
> و «Emplacement» = فين كاين الستوك فعلاً. **بجوج خاصهم يكونو متوافقين.**

---

## 4. مثال 1 — Polo Classic : Online + Offline

### أ) إنشاء المنتج
1. **Produits** ← **Nouveau produit**.
2. عمّر الاسم `Polo Classic`، الثمن، والـ SKU.
3. فقسم **Stock**: خلي **Suivre le stock** معلّمة.
4. فقسم **Canaux de vente**: علّم **En ligne** و **Magasin Larache**.
5. فقسم **Variantes**: علّم **Ce produit possède des variantes (couleurs, tailles…)**.
6. سجّل. غادي توصل لصفحة المنتج.
7. فصفحة المنتج ← **Générer des combinaisons**:
   - Option `Couleur`، Valeurs `Bleu`
   - Option `Taille`، Valeurs `S, M, L, XL`
   - كيتخلقو 4 variantes: Bleu/S، Bleu/M، Bleu/L، Bleu/XL.

> ⚠️ ما كاينش «stock initial» فاش كتخلق المنتج. **الستوك كيدخل غير بـ Réception** (القسم 7).

### ب) دخول السلعة: 100 وحدة كلها لـ Entrepôt principal (Réception)

| Variante | Entrepôt principal |
|---|---|
| Bleu / S | 20 |
| Bleu / M | 30 |
| Bleu / L | 30 |
| Bleu / XL | 20 |
| **المجموع** | **100** |

### ج) صيفط 30 للمحل (Transfert)
**Transferts** ← **Nouveau transfert**:
- Source: **Entrepôt principal**
- Destination: **Magasin Larache**
- الكميات: S 5، M 10، L 10، XL 5

بعدها: **Créer le transfert** ← **Expédier** (الحالة: *En transit*) ← فاش السلعة كتوصل للمحل: **Confirmer la réception** (الحالة: *Reçu*).

| Emplacement | S | M | L | XL | المجموع |
|---|---|---|---|---|---|
| Entrepôt principal | 15 | 20 | 20 | 15 | **70** ← هادي اللي كتبان فالموقع |
| Magasin Larache | 5 | 10 | 10 | 5 | **30** ← هادي اللي كيتباع فالمحل |

### د) النشر فالموقع
صفحة المنتج ← قسم **Publication externe** ← **Publier** ← **Confirmer la publication**.
الحالة كتولي **Publié** وكيبان رابط **Voir sur WooCommerce** (ولا Shopify).

### هـ) بيع Online: 5 × Bleu/M من الموقع

| المرحلة | Entrepôt principal — Bleu/M |
|---|---|
| قبل | Physique 20 · Réservé 0 · Disponible 20 |
| الطلب دخل: **Nouvelle** | ما كيتبدل والو فـ ASODITECH |
| تأكد مع الكليان: **Confirmée** | Physique 20 · **Réservé 5** · **Disponible 15** |
| **Expédiée** | **Physique 15** · Réservé 0 · Disponible 15 |

### و) بيع Offline فالعرائش: 3 × Bleu/L

| المرحلة | Magasin Larache — Bleu/L |
|---|---|
| قبل | Physique 10 · Disponible 10 |
| **Valider la vente** | **Physique 7** · Disponible 7 (فالحين) |

### ز) النتيجة

| Emplacement | قبل البيع | بعد البيع |
|---|---|---|
| Entrepôt principal | 70 | **65** |
| Magasin Larache | 30 | **27** |
| **المجموع** | **100** | **92** |

✅ **100 − 5 − 3 = 92**. هاد الحساب صحيح، **ولكن** الستوك ديال Online نقص فاش الطلب ولا **Expédiée**، ماشي فاش دخل.

---

## 5. مثال 2 — Jabador Boutique Exclusive : Offline only

1. **Produits** ← منتج جديد `Jabador Boutique Exclusive` + variantes M/L/XL.
2. **Canaux de vente**: علّم **Magasin Larache** فقط. **ما تعلّمش En ligne**.
3. **Réception** مباشرة لـ **Magasin Larache**: 5 M، 5 L، 5 XL. (فـ **Provenance & destination** اختار Magasin Larache)
4. **ما تديرش Publier** فـ **Publication externe**.
5. كليان شرا 1 × L فالمحل ← **Ventes magasin** ← **Nouvelle vente** ← … ← **Valider la vente** ← Magasin Larache L: 5 → **4**.

**علاش ما خاصوش يكون Online؟**
- الستوك ديالو كاين **غير فالمحل** (Magasin). الموقع كيقرا **غير** الستوك ديال **Entrepôt**، يعني بالنسبة للموقع الكمية = 0.
- إلا نشرتيه، الكليان يقدر يشوفو ولكن ما يلقاش ستوك، ولا يطلبو وما تلقاش منين تصيفطو.

> ⚠️ **انتبه:** فاش كتسجل **commande يدوية** (Nouvelle opération → Commande en ligne)، السيستام **ما كيمنعكش** تزيد منتج Offline only. خاصك **انت** ما تزيدوش. (شوف «الحدود» C.)

---

## 6. مثال 3 — Sweat Online Exclusive : Online only

1. **Produits** ← منتج جديد `Sweat Online Exclusive` + variantes M/L/XL.
2. **Canaux de vente**: علّم **En ligne** فقط. **ما تعلّمش Magasin Larache**.
3. **Réception** لـ **Entrepôt principal**: 15 M، 15 L، 10 XL (= 40).
4. **Publication externe** ← **Publier** ← **Confirmer la publication**.
5. طلب من الموقع: 2 × L ← **Confirmée**: Réservé 2، Disponible 13 ← **Expédiée**: Physique 13.
6. **ما تصيفطوش للمحل بـ Transfert.**

**فالمحل:** إلا البائع قلّب عليه فـ **Nouvelle vente**، كيطلع لو **«Aucun article trouvé sur ce canal.»**.
وإلا حاول يبيعو، السيستام كيرفض: **« … n'est pas vendu sur ce canal. »**. هاد المنع مضمون من السيستام.

---

## 7. مثال دخول بضاعة من المورد (Réception)

1. **Fournisseurs** ← تأكد أن المورد مسجل (ولا زيدو).
2. **Réceptions** ← **Nouvelle réception**.
3. فقسم **Provenance & destination**: اختار **المورد** و الـ **Emplacement** ديال الوصول:
   - السلعة اللي غادي تتباع Online ← **Entrepôt principal**
   - السلعة اللي غادي تتباع غير فالمحل ← **Magasin Larache**
4. قلّب على كل variante (scanner ولا الاسم/الـ référence) ← عمّر **الكمية** و **ثمن الشراء**.
5. **Enregistrer le brouillon** ← راجع مزيان ← **Valider et ajouter au stock**.
6. كتطلع: **«Réception validée — stock ajouté.»**.

| مزيان تعرف | |
|---|---|
| Brouillon | **ما كيزيدش** الستوك. تقدر تبدلو ولا تلغيه (**Annuler**). |
| Validée | الستوك تزاد. **ما تقدرش تبدلها ولا تمسحها.** |
| ضغطتي جوج مرات؟ | السيستام كيزيد الستوك **مرة وحدة**. |
| الخلاص ديال المورد | حاجة أخرى منفصلة: الخلاص **ما كيزيدش** الستوك. |
| الموقع | ملي كتـ valider، ASODITECH كيبعث الكمية الجديدة للموقع أوتوماتيكياً (للمنتجات المربوطة بالموقع). |

---

## 8. مثال بيع Online

**فين كيبان؟** فـ **Commandes**. الطلبات ديال الموقع كيدخلو بوحدهم. الطلبات بالتيليفون/واتساب كتسجلهم انت: **Nouvelle opération** ← **Commande en ligne**.

| الحالة | شنو كيوقع للستوك (Emplacement ديال الطلب) |
|---|---|
| **Nouvelle** | والو. طلب ما تأكدش ما كيحجز والو. |
| **Confirmée** | **Réservé** كيزيد، **Disponible** كينقص. Physique ما كيتبدلش. |
| **En préparation** | باقي محجوز. |
| **Expédiée** | **Physique** كينقص و Réservé كيرجع 0. **هادي هي اللحظة اللي السلعة كتخرج.** |
| **Livrée** | ما كيتبدل والو فالستوك. |
| **Annulée** قبل Expédiée | الحجز كيتلغى، Disponible كيرجع. |
| **Retour** | الستوك **ما كيرجعش بوحدو**. خاصك تأكد **Retour physique** فصفحة الطلب ملي السلعة توصلك فعلاً: الصالحة كترجع لـ Physique، والمخسورة كتمشي لـ **Endommagé**. |

**Emplacement ديال الطلب:**
- طلب جا من **الموقع** ← كيتحجز ويخرج من **Entrepôt principal** (Par défaut).
- طلب **يدوي** ← كتختار **Entrepôt de préparation** فالفورميلير (إلا عندك أكثر من Emplacement). الطلب كيبقى «En ligne» كيفما كان الـ Emplacement.

---

## 9. مثال بيع Offline فالعرائش

1. **Ventes magasin** ← **Nouvelle vente** (ولا **Nouvelle opération** ← **Vente magasin**).
2. اختار القناة **Magasin Larache** و الـ Emplacement **Magasin Larache**.
3. **scanner** الكود (ولا **Caméra**)، ولا كتب الاسم/الـ référence ← **Chercher**.
4. بدّل الكمية إلا بغيتي. الكليان كيبان **Passage** إلا ما عمرتيهش.
5. الخلاص: **Tout en espèces** (ولا زيد **Paiement**). **مجموع الخلاص خاصو يساوي المجموع.**
6. **Valider la vente** ← **«Vente enregistrée.»** ← رقم **VTE-…**.

**شنو كيوقع؟**
- الستوك ديال **Magasin Larache** كينقص **فالحين**، وكيتسجل mouvement «Vente» فـ **Traçabilité**.
- البيع كيتسجل كامل ولا ما كيتسجل والو: إلا سلعة ما كفاتش، البيع كامل كيترفض.
- ضغطتي جوج مرات؟ كتتسجل **vente وحدة** وكينقص الستوك **مرة وحدة**.
- **الثمن** كيجي من الكتالوغ. باش تبدل الثمن ولا تدير remise، خاص صلاحية خاصة (Modifier le prix).
- ما كتقدرش تبيع وحدات **محجوزة** لطلب Online مأكد (فنفس الـ Emplacement).
- إلا رجع ليك كليان سلعة: من صفحة البيع ← **Retour de vente**.

---

## 10. كيفاش نعرف الستوك ديالي؟

**Stock** ← لكل منتج/variante ولكل Emplacement:

| العمود | المعنى |
|---|---|
| **Produit** | السلعة (أو الـ variante) |
| **Emplacement** | فين كاينة |
| **Physique** | شحال كاين فعلاً فالبلاصة |
| **Réservé** | محجوز لطلبات Online **Confirmée** ما تشحناتش باقي |
| **Disponible** | **Physique − Réservé**: هادا اللي تقدر تبيع |
| **Endommagé** | سلعة مخسورة (رجعات). كتتحسب بوحدها |
| **État** | **Stock faible** (قرب يسالي) ولا **Rupture de stock** (سالا) |

- **شحال كيبان فالموقع؟** = مجموع **Disponible** فالـ Emplacements ديال النوع **Entrepôt** النشيطين.
- **شحال نقدر نبيع فالمحل؟** = **Disponible** فـ **Magasin Larache**.
- **التاريخ ديال سلعة** (شكون دخلها، شكون باعها، فين كاينة دابا): **Traçabilité**.
- **الجرد** (تعاود تحسب السلعة بيدك): **Inventaires**.
- **السلعة بين المخزن والمحل**: **Transferts**.

---

## 11. الأخطاء اللي خاص نتفاداها

- [ ] **ما تخلقش نفس المنتج جوج مرات** (واحد Online وواحد Offline). منتج واحد + **Canaux de vente**.
- [ ] **ما تنقصش الستوك بيدك من بعد كل بيعة.** **Valider la vente** و **Expédiée** كينقصو بوحدهم.
- [ ] **ما تخلطش بين Canaux de vente و الستوك.** علامة **En ligne** ما كتزيدش ولا وحدة. الستوك كيدخل غير بـ **Réception**/**Transfert**.
- [ ] **ما تنشرش (Publier) منتج Offline only** فالموقع.
- [ ] **ما تزيدش منتج Offline only فـ commande يدوية.** السيستام ما كيمنعكش، خاصك انت تنتابه.
- [ ] **ما تصيفطش منتج Online only للمحل بـ Transfert** وما تعلّمش ليه **Magasin Larache**، إلا إلا قررتي تبدل القرار.
- [ ] **ما تبدلش الستوك بيدك بلا سبب.** إلا كاين فرق ← **Inventaires** باش يبقى كلشي مسجل.
- [ ] **ما تزيدش Emplacements بلا حاجة.** وأي Emplacement جديد من نوع **Entrepôt** كيتحسب أوتوماتيكياً فالموقع.
- [ ] **ما تحطش «Retour» وتتسنى الستوك يرجع بوحدو.** أكد **Retour physique** ملي السلعة توصلك.
- [ ] **ما تتسنى من الموقع يبدل الستوك ديال ASODITECH.** ASODITECH هو المرجع، والموقع كيتبعو.
- [ ] **ما كتحتاجش تخلق شركة/حساب آخر** لنفس النشاط. Online و المحل فنفس الحساب.
- [ ] الإعدادات ديال **المنصة** (النمط En ligne + Magasin، الاشتراك) كيديرها فريق ASODITECH. ماشي خدمتك.

---

## 12. الخلاصة — الخدمة ديال كل نهار

**الصباح**
1. **Commandes / Confirmation** ← أكّد الطلبات الجداد (**Confirmée**).
2. وجّد وصيفط ← **Expédiée**.

**ملي كتوصل سلعة**
3. **Réceptions** ← **Nouvelle réception** ← **Valider et ajouter au stock** (فالـ Emplacement الصحيح).
4. المحل محتاج سلعة؟ ← **Transferts** (Entrepôt principal → Magasin Larache).

**فالمحل**
5. كل بيعة ← **Ventes magasin** ← **Valider la vente**.

**فالليل**
6. **Stock** ← شوف **Disponible** والسلع اللي قربو يساليو.
7. رجعات وصلات؟ ← **Retour physique** فصفحة الطلب.

---

## الحدود — شنو ما كيديروش السيستام دابا (غير مدعوم حالياً / Not currently supported)

| # | الطلب | الواقع فالتطبيق | البديل اللي خدام |
|---|---|---|---|
| A | «40 Online + 30 Offline + 30 مخبيين» كحصص فنفس البلاصة | **غير مدعوم حالياً.** ما كاينش كمية لكل قناة. | قسّم **فعلياً** بـ **Transfert** بين Emplacements. كلشي فـ Entrepôt كيتحسب Online. |
| B | تخلي جزء مخبي (réserve) لا يتباع Online لا Offline | **غير مدعوم كخاصية.** | ممكن تديرو فـ Emplacement من نوع **Magasin** **ما مربوط بحتى قناة**. ولكن غير إلا كان ضروري. |
| C | المنع الأوتوماتيكي ديال منتج Offline only فـ commande يدوية ولا فـ **Publier** | **غير مضمون من السيستام.** خانة **En ligne** ما كتتحققش فـ commande يدوية ولا فالنشر. | الانضباط: ما تزيدوش وما تنشروش. (فالمحل العكس مضمون: منتج ما معلّمش Magasin ما كيتباعش.) |
| D | تختار Emplacement لطلب جا من الموقع | **غير مدعوم.** | الطلبات ديال الموقع كيخرجو من **Entrepôt principal** (Par défaut). |
| E | stock initial فاش كتخلق المنتج | **غير مدعوم.** | **Réception** (ولا **Inventaires** للجرد). |
| F | تبدل/تمسح Réception validée، ولا رجوع سلعة للمورد | **غير مدعوم حالياً.** | تصحيح بـ **Inventaires**، وكيبقى مسجل. |
| G | نشر منتج فيه أكثر من variante وحدة على **Shopify** | **مرفوض فـ Shopify.** | WooCommerce كيقبل variantes. |
| H | تفعيل **Ventes magasin / Réceptions / Fournisseurs** | ماشي من الحساب ديالك. | فريق ASODITECH كيفعّل النمط **En ligne + Magasin**. |
