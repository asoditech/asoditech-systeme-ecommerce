import { bi, type ExplanationDoc, type SECTION_TITLES } from "@/lib/metrics/analytics-explanations";

/**
 * Explanations of every setting, switch, figure and information block shown
 * under /parametres (Configuration, Abonnement & Utilisation, Canaux de
 * vente, Notifications, Sauvegarde) — the « ⓘ » popovers of
 * src/components/settings/setting-info.tsx, in French and Arabic.
 *
 * Explanation text only: nothing here is read by a server action, a query or
 * a permission check. Each entry describes what the code ACTUALLY does
 * (`source` names where), audited against src/actions/settings.ts,
 * src/lib/validation/settings.ts and the code that reads each setting. The
 * shared `bi()` makes the Arabic text carry exactly the French sections.
 * For settings, « Calcul » reads « Effet », see SETTINGS_SECTION_TITLES.
 */

export type SettingsScreen = "configuration" | "abonnement" | "canaux" | "notifications" | "sauvegarde";

export interface SettingDoc extends ExplanationDoc {
  /** Screens that display it. */
  screens: readonly SettingsScreen[];
}

/** Section headings for settings: an effect, not a calculation. */
export const SETTINGS_SECTION_TITLES: Partial<typeof SECTION_TITLES> = {
  calculation: { fr: "Effet", ar: "التأثير" },
  scope: { fr: "S'applique à", ar: "ينطبق على" },
  period: { fr: "Quand", ar: "متى" },
  filters: { fr: "Valeurs possibles", ar: "القيم الممكنة" },
  interpretation: { fr: "Bon à savoir", ar: "معلومة مفيدة" },
};

const MANAGE = "settings.manage (OWNER / ADMIN)";
const VIEW = "settings.view";
const CHANNELS = "channels.manage (OWNER / ADMIN)";
const SELF = "Tout utilisateur connecté (ses propres réglages)";
const ACTION = "src/actions/settings.ts — updateBusinessSettingsAction";
const IDENTITY_USE = {
  fr: "Imprimé dans l'en-tête des rapports (/rapports), des factures de livraison et des relevés de commissions.",
  ar: "يُطبع في رأس التقارير (/rapports) وفواتير التوصيل وكشوف العمولات.",
};
const SUPPORT_USE = {
  fr: "Affiché à vos équipes dans le centre d'aide (icône en bas à droite). Vide = ce moyen de contact est masqué.",
  ar: "يظهر لفرقك في مركز المساعدة (الأيقونة أسفل يمين الشاشة). إذا كان فارغًا يُخفى وسيلة الاتصال هذه.",
};

export const SETTINGS_EXPLANATIONS = {
  // ------------------------------------------------------------ Configuration — vue d'ensemble
  identityCompletion: {
    labels: ["Identité complète"],
    screens: ["configuration"],
    source: "src/lib/settings/configuration-model.ts — identityCompletion",
    access: MANAGE,
    text: bi(
      {
        definition: "La part des informations d'identité de l'entreprise déjà renseignées.",
        calculation: "Éléments remplis ÷ 6 × 100, arrondi : nom de l'entreprise, logo, e-mail, téléphone, adresse, ville. Le pays et la devise ne comptent pas.",
        example: "Nom, logo, e-mail et ville remplis, téléphone et adresse vides → 4 ÷ 6 = 67 %.",
        interpretation: "Ces éléments apparaissent sur vos documents imprimés ; 100 % n'est pas obligatoire.",
      },
      {
        definition: "نسبة معلومات هوية المقاولة التي تمّ ملؤها.",
        calculation: "العناصر المملوءة ÷ 6 × 100، مع التقريب: اسم المقاولة، الشعار، البريد الإلكتروني، الهاتف، العنوان، المدينة. البلد والعملة لا يُحتسبان.",
        example: "الاسم والشعار والبريد والمدينة مملوءة، والهاتف والعنوان فارغان ← 4 ÷ 6 = 67 %.",
        interpretation: "تظهر هذه العناصر في وثائقك المطبوعة، وبلوغ 100 % ليس إلزاميًا.",
      }
    ),
  },
  sectionsInOrder: {
    labels: ["sections en ordre"],
    screens: ["configuration"],
    source: "src/lib/settings/configuration-model.ts — configHealth",
    access: MANAGE,
    text: bi(
      {
        definition: "Le nombre de sections de la configuration sans aucun point à vérifier.",
        calculation: "Sections (Entreprise, Commandes, Expédition, Magasin, Stock, Support = 6) moins celles qui ont au moins un point « À corriger ».",
        example: "Aucun contact support renseigné → Support a 1 point à vérifier → 5/6 sections en ordre.",
      },
      {
        definition: "عدد أقسام الإعدادات التي لا تتضمّن أي نقطة تحتاج إلى مراجعة.",
        calculation: "الأقسام (Entreprise وCommandes وExpédition وMagasin وStock وSupport = 6) ناقص الأقسام التي فيها نقطة واحدة على الأقل « À corriger ».",
        example: "لا توجد أي وسيلة اتصال للدعم ← قسم Support فيه نقطة 1 للمراجعة ← 5/6 أقسام سليمة.",
      }
    ),
  },
  pointsToCheck: {
    labels: ["points à vérifier", "À corriger"],
    screens: ["configuration"],
    source: "src/lib/settings/configuration-model.ts — configAttention",
    access: MANAGE,
    text: bi(
      {
        definition: "Les réglages manquants qui changent ce que voient vos équipes ou vos clients.",
        calculation: "Quatre contrôles seulement : nom de l'entreprise vide ; ni e-mail ni téléphone de l'entreprise ; transporteur par défaut devenu inactif, ou plusieurs transporteurs actifs sans transporteur par défaut ; aucun contact support.",
        example: "2 transporteurs actifs et aucun choisi par défaut → 1 point : « Transporteur par défaut ».",
        caveats: "Un champ facultatif laissé vide (adresse, horaires…) n'est jamais compté comme un problème.",
      },
      {
        definition: "الإعدادات الناقصة التي تغيّر ما يراه فريقك أو زبناؤك.",
        calculation: "أربع عمليات تحقّق فقط: اسم المقاولة فارغ؛ لا بريد إلكتروني ولا هاتف للمقاولة؛ شركة التوصيل الافتراضية أصبحت غير نشطة، أو عدة شركات نشطة دون شركة افتراضية؛ لا توجد أي وسيلة اتصال للدعم.",
        example: "شركتا توصيل نشطتان (2) دون اختيار افتراضي ← نقطة 1: « Transporteur par défaut ».",
        caveats: "الحقل الاختياري الفارغ (العنوان، الأوقات…) لا يُعدّ مشكلة أبدًا.",
      }
    ),
  },
  featuresOn: {
    labels: ["fonctions activées"],
    screens: ["configuration"],
    source: "src/lib/settings/configuration-model.ts — sectionSwitches / configHealth",
    access: MANAGE,
    text: bi(
      {
        definition: "Combien des interrupteurs de la configuration sont activés.",
        calculation: "Interrupteurs activés ÷ interrupteurs qui existent pour vous : import en « Nouvelle » (une par boutique connectée), vérification de l'emballage, prix modifiable par les vendeurs (mode magasin), coût d'achat lors des transferts (accès Finance).",
        example: "WooCommerce connecté (activé), emballage désactivé, mode en ligne seulement, sans accès Finance → 1/2.",
        caveats: "Le total varie selon vos boutiques connectées, votre mode d'activité et vos droits.",
      },
      {
        definition: "عدد المفاتيح المفعّلة من بين مفاتيح الإعدادات.",
        calculation: "المفاتيح المفعّلة ÷ المفاتيح المتاحة لك: الاستيراد بحالة « Nouvelle » (واحد لكل متجر مربوط)، التحقق من التغليف، تعديل السعر من طرف البائعين (وضع المتجر)، كلفة الشراء عند التحويلات (صلاحية المالية).",
        example: "WooCommerce مربوط (مفعّل)، التغليف غير مفعّل، وضع إلكتروني فقط، دون صلاحية المالية ← 1/2.",
        caveats: "يتغيّر المجموع حسب المتاجر المربوطة ووضع النشاط وصلاحياتك.",
      }
    ),
  },
  settingsTiles: {
    labels: ["Vos réglages"],
    screens: ["configuration"],
    source: "src/lib/settings/configuration-model.ts — sectionSummary, settingsIndex",
    access: MANAGE,
    text: bi(
      {
        definition: "Une carte par section, avec la valeur qui la résume le mieux.",
        calculation: "Entreprise : nom et identité complète ; Commandes : prochain numéro ; Expédition : transporteur par défaut ; Magasin : prix libre ou catalogue ; Stock : méthode de coût et seuil ; Support : contacts affichés sur 3. « N réglages » = nombre de réglages de la section que vous pouvez voir.",
        example: "Carte Support « 2 / 3 » : WhatsApp et téléphone renseignés, e-mail vide.",
      },
      {
        definition: "بطاقة لكل قسم مع القيمة التي تلخّصه أكثر.",
        calculation: "Entreprise: الاسم ونسبة اكتمال الهوية؛ Commandes: رقم الطلب التالي؛ Expédition: شركة التوصيل الافتراضية؛ Magasin: سعر حرّ أو سعر الكتالوج؛ Stock: طريقة الكلفة والعتبة؛ Support: وسائل الاتصال المعروضة من أصل 3. « N réglages » = عدد إعدادات القسم التي يمكنك رؤيتها.",
        example: "بطاقة Support « 2 / 3 »: واتساب والهاتف مملوءان، والبريد الإلكتروني فارغ.",
      }
    ),
  },

  // ------------------------------------------------------------ Entreprise
  companyName: {
    labels: ["Nom de l'entreprise"],
    screens: ["configuration"],
    source: ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "Le nom de votre entreprise.",
        calculation: IDENTITY_USE.fr,
        filters: "Texte libre, 200 caractères au maximum.",
        example: "« Boutique Exemple » apparaît en haut de chaque rapport imprimé.",
        caveats: "Vide : signalé dans « À corriger ».",
      },
      {
        definition: "اسم مقاولتك.",
        calculation: IDENTITY_USE.ar,
        filters: "نص حرّ، 200 حرف كحدّ أقصى.",
        example: "يظهر « Boutique Exemple » أعلى كل تقرير مطبوع.",
        caveats: "إذا كان فارغًا يظهر ضمن « À corriger ».",
      }
    ),
  },
  logo: {
    labels: ["Logo"],
    screens: ["configuration"],
    source: "src/components/settings/logo-field.tsx ; " + ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "Le logo affiché sur vos documents.",
        calculation: `${IDENTITY_USE.fr} Une image choisie est réduite dans le navigateur (320 px au plus, PNG) puis enregistrée avec les réglages.`,
        filters: "Une image importée, ou une adresse https ; 1,5 Mo au maximum.",
        example: "Un logo de 2000 × 1000 px est enregistré en 320 × 160 px.",
      },
      {
        definition: "الشعار المعروض على وثائقك.",
        calculation: `${IDENTITY_USE.ar} تُصغَّر الصورة المختارة داخل المتصفح (320 px كحدّ أقصى، بصيغة PNG) ثم تُحفظ مع الإعدادات.`,
        filters: "صورة مستوردة أو عنوان https؛ بحجم 1,5 Mo كحدّ أقصى.",
        example: "شعار بقياس 2000 × 1000 px يُحفظ بقياس 320 × 160 px.",
      }
    ),
  },
  companyEmail: {
    labels: ["E-mail de contact"],
    screens: ["configuration"],
    source: ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "L'adresse e-mail de l'entreprise imprimée sur vos documents.",
        calculation: `${IDENTITY_USE.fr} Ce n'est pas l'adresse qui reçoit les alertes (chaque utilisateur reçoit les siennes à l'adresse de son compte).`,
        filters: "Une adresse e-mail valide, ou vide.",
        example: "contact@boutique-exemple.ma sous le nom de l'entreprise.",
        caveats: "Ni e-mail ni téléphone : signalé dans « À corriger ».",
      },
      {
        definition: "عنوان البريد الإلكتروني للمقاولة المطبوع على وثائقك.",
        calculation: `${IDENTITY_USE.ar} ليس هو العنوان الذي يستقبل التنبيهات (كل مستخدم يتلقى تنبيهاته على بريد حسابه).`,
        filters: "عنوان بريد إلكتروني صحيح، أو فارغ.",
        example: "contact@boutique-exemple.ma تحت اسم المقاولة.",
        caveats: "إذا غاب البريد والهاتف معًا يظهر ذلك ضمن « À corriger ».",
      }
    ),
  },
  companyPhone: {
    labels: ["Téléphone"],
    screens: ["configuration"],
    source: ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "Le téléphone de l'entreprise imprimé sur vos documents (« Tél. … »).",
        calculation: IDENTITY_USE.fr,
        filters: "30 caractères au maximum, ou vide.",
        example: "Tél. +212 600 000 000 dans l'en-tête des rapports.",
      },
      {
        definition: "هاتف المقاولة المطبوع على وثائقك (« Tél. … »).",
        calculation: IDENTITY_USE.ar,
        filters: "30 حرفًا كحدّ أقصى، أو فارغ.",
        example: "Tél. +212 600 000 000 في رأس التقارير.",
      }
    ),
  },
  companyAddress: {
    labels: ["Adresse", "Ville", "Pays"],
    screens: ["configuration"],
    source: ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "L'adresse postale de l'entreprise.",
        calculation: `${IDENTITY_USE.fr} L'adresse et la ville comptent dans « Identité complète » ; le pays (Maroc par défaut) non.`,
        filters: "Adresse 500 caractères, ville et pays 120 caractères au maximum.",
        example: "12 rue Exemple, Casablanca, Maroc.",
        caveats: "Sans effet sur les adresses de livraison des commandes.",
      },
      {
        definition: "العنوان البريدي للمقاولة.",
        calculation: `${IDENTITY_USE.ar} يدخل العنوان والمدينة في « Identité complète »، أما البلد (المغرب افتراضيًا) فلا.`,
        filters: "العنوان 500 حرف، والمدينة والبلد 120 حرفًا كحدّ أقصى.",
        example: "12 rue Exemple، الدار البيضاء، المغرب.",
        caveats: "لا يؤثّر في عناوين توصيل الطلبات.",
      }
    ),
  },
  currency: {
    labels: ["Devise"],
    screens: ["configuration"],
    source: "src/lib/validation/settings.ts — currency (MAD par défaut)",
    access: MANAGE,
    text: bi(
      {
        definition: "La devise de cette installation.",
        calculation: "Affichée en lecture seule : elle n'est pas modifiable ici.",
        example: "MAD : les montants s'affichent en dirhams (ex. 1 470,00 MAD).",
      },
      {
        definition: "عملة هذا التثبيت.",
        calculation: "تُعرض للقراءة فقط ولا يمكن تعديلها هنا.",
        example: "MAD: تُعرض المبالغ بالدرهم (مثلًا 1 470,00 MAD).",
      }
    ),
  },
  documentPreview: {
    labels: ["Aperçu sur vos documents"],
    screens: ["configuration"],
    source: "src/components/settings/business-settings-form.tsx — CompanySettingsForm",
    access: MANAGE,
    text: bi(
      {
        definition: "Un aperçu de l'en-tête de vos documents avec les valeurs enregistrées.",
        calculation: "Affiche le logo (ou les initiales), le nom, la ville et le pays, l'adresse, l'e-mail et le téléphone ENREGISTRÉS ; il se met à jour après « Enregistrer ».",
        example: "Sans logo, « Boutique Exemple » s'affiche avec les initiales « BE ».",
      },
      {
        definition: "معاينة لرأس وثائقك بالقيم المحفوظة.",
        calculation: "يعرض الشعار (أو الأحرف الأولى) والاسم والمدينة والبلد والعنوان والبريد والهاتف المحفوظة، ويتحدّث بعد الضغط على « Enregistrer ».",
        example: "دون شعار يظهر « Boutique Exemple » مع الحرفين الأولين « BE ».",
      }
    ),
  },

  // ------------------------------------------------------------ Commandes
  orderNumberPrefix: {
    labels: ["Numéro des commandes", "Préfixe des numéros de commande"],
    screens: ["configuration"],
    source: `${ACTION} ; src/lib/format.ts — displayOrderNumber`,
    access: MANAGE,
    text: bi(
      {
        definition: "Les lettres placées devant le numéro des commandes créées dans ASODITECH.",
        calculation: "Le numéro affiché = préfixe + « - » + numéro sur 6 chiffres. Le préfixe est appliqué à l'AFFICHAGE : le numéro de chaque commande ne change jamais, mais après un changement de préfixe, les commandes existantes s'affichent elles aussi avec le nouveau préfixe.",
        scope: "Commandes manuelles. Une commande importée de WooCommerce ou Shopify garde son propre numéro de boutique (« #1042 »).",
        filters: "1 à 10 caractères ; vide = « CMD ».",
        example: "Préfixe « BX », commande n° 124 → BX-000124.",
        caveats: "Quelques écrans (ex. bordereau de livraison) affichent encore « CMD- » quel que soit le préfixe.",
      },
      {
        definition: "الحروف التي توضع قبل رقم الطلبات المُنشأة في ASODITECH.",
        calculation: "الرقم المعروض = البادئة + « - » + الرقم على 6 أرقام. تُطبَّق البادئة عند العرض: رقم كل طلب لا يتغيّر أبدًا، لكن بعد تغيير البادئة تُعرض الطلبات الموجودة أيضًا بالبادئة الجديدة.",
        scope: "الطلبات اليدوية. الطلب المستورد من WooCommerce أو Shopify يحتفظ برقمه في المتجر (« #1042 »).",
        filters: "من 1 إلى 10 أحرف؛ إذا كانت فارغة تُستعمل « CMD ».",
        example: "البادئة « BX » والطلب رقم 124 ← BX-000124.",
        caveats: "بعض الشاشات (مثل بيان التسليم) ما زالت تعرض « CMD- » مهما كانت البادئة.",
      }
    ),
  },
  importAsNouvelle: {
    labels: ["WooCommerce : importer en « Nouvelle »", "Shopify : importer en « Nouvelle »"],
    screens: ["configuration"],
    source: "src/actions/woocommerce.ts / shopify.ts — set…ForceNouvelleOnImportAction ; src/lib/integrations/*/sync/orders.ts",
    access: "integrations.manage (modification) ; lecture : settings.manage",
    text: bi(
      {
        definition: "Empêche une commande importée d'arriver déjà « Confirmée ».",
        calculation: "Activé (par défaut) : une commande que la boutique considère payée / en traitement est créée « Nouvelle », et une synchronisation ultérieure ne la fait jamais passer seule de « Nouvelle » à « Confirmée » : l'équipe appelle toujours le client. Désactivé : le statut de la boutique est repris tel quel.",
        scope: "Une boutique à la fois (un interrupteur par boutique connectée).",
        example: "Commande WooCommerce « processing » → arrive « Nouvelle » (activé) ou « Confirmée » (désactivé).",
        caveats: "Les autres statuts de la boutique (livrée, annulée, remboursée…) sont repris normalement. Les commandes déjà importées ne sont pas modifiées.",
      },
      {
        definition: "يمنع الطلب المستورد من الوصول بحالة « Confirmée » مسبقًا.",
        calculation: "مفعّل (افتراضيًا): الطلب الذي يعتبره المتجر مؤدّى أو قيد المعالجة يُنشأ بحالة « Nouvelle »، ولا تنقله أي مزامنة لاحقة وحدها من « Nouvelle » إلى « Confirmée »: يتصل الفريق دائمًا بالزبون. غير مفعّل: تُعتمد حالة المتجر كما هي.",
        scope: "متجر واحد في كل مرة (مفتاح لكل متجر مربوط).",
        example: "طلب WooCommerce بحالة « processing » ← يصل « Nouvelle » (مفعّل) أو « Confirmée » (غير مفعّل).",
        caveats: "الحالات الأخرى للمتجر (مسلَّم، ملغى، مسترَدّ…) تُعتمد عاديًا. الطلبات المستوردة سابقًا لا تُعدَّل.",
      }
    ),
  },

  // ------------------------------------------------------------ Expédition
  packingVerification: {
    labels: ["Vérification avant expédition"],
    screens: ["configuration"],
    source: "src/actions/settings.ts — updatePackingVerificationAction ; src/lib/packing-settings.ts — isPackingRequired",
    access: MANAGE,
    text: bi(
      {
        definition: "Oblige à vérifier le contenu d'une commande avant de l'expédier.",
        calculation: "Activé : une commande ne peut passer « Expédiée » (ni recevoir une expédition) que si son emballage a été vérifié à l'étape « Emballage » (scan, ou vérification manuelle) ; elle n'apparaît dans « À expédier » qu'après. Désactivé (par défaut) : expédition sans vérification.",
        scope: "Commandes en ligne ; contrôlé sur le serveur, pas seulement à l'écran.",
        example: "Commande de 3 articles : les 3 doivent être scannés avant de créer le colis.",
        caveats: "Sans effet sur les commandes déjà expédiées.",
      },
      {
        definition: "يفرض التحقق من محتوى الطلب قبل شحنه.",
        calculation: "مفعّل: لا يمكن أن ينتقل الطلب إلى « Expédiée » (ولا أن تُنشأ له شحنة) إلا بعد التحقق من تغليفه في مرحلة « Emballage » (مسح أو تحقق يدوي)، ولا يظهر في « À expédier » إلا بعد ذلك. غير مفعّل (افتراضيًا): شحن دون تحقق.",
        scope: "الطلبات الإلكترونية؛ يُفرض على الخادم وليس على الشاشة فقط.",
        example: "طلب من 3 قطع: يجب مسح القطع الـ3 قبل إنشاء الطرد.",
        caveats: "لا يؤثّر في الطلبات المشحونة سابقًا.",
      }
    ),
  },
  defaultShippingProvider: {
    labels: ["Transporteur par défaut"],
    screens: ["configuration"],
    source: "src/actions/settings.ts — updateDefaultShippingProviderAction ; src/lib/delivery-cities.ts — pickCitySourceProvider",
    access: MANAGE,
    text: bi(
      {
        definition: "Le transporteur dont la liste de villes est proposée quand on saisit une commande ou un client en ligne.",
        calculation: "0 transporteur actif : ville saisie librement. 1 seul actif : sa liste est utilisée automatiquement (ce réglage ne change rien). Plusieurs actifs : la liste du transporteur choisi ici ; sans choix, saisie libre.",
        filters: "« Aucun » ou un transporteur ACTIF.",
        example: "2 transporteurs actifs, Ozon choisi → la ville se choisit dans la liste d'Ozon.",
        caveats: "Le transporteur réel du colis reste choisi à la création de l'expédition. Un transporteur sans liste de villes donne une saisie libre.",
      },
      {
        definition: "شركة التوصيل التي تُقترح لائحة مدنها عند إدخال طلب أو زبون إلكتروني.",
        calculation: "0 شركة نشطة: تُكتب المدينة بحرية. شركة 1 نشطة فقط: تُستعمل لائحتها تلقائيًا (ولا يغيّر هذا الإعداد شيئًا). عدة شركات نشطة: لائحة الشركة المختارة هنا؛ ودون اختيار تُكتب المدينة بحرية.",
        filters: "« Aucun » أو شركة توصيل نشطة.",
        example: "شركتان (2) نشطتان واختيار Ozon ← تُختار المدينة من لائحة Ozon.",
        caveats: "شركة التوصيل الفعلية للطرد تُختار عند إنشاء الشحنة. شركة دون لائحة مدن تعني الكتابة الحرة.",
      }
    ),
  },

  // ------------------------------------------------------------ Magasin
  sellerPriceOverride: {
    labels: ["Prix modifiable par les vendeurs"],
    screens: ["configuration"],
    source: "src/actions/settings.ts — updateSellerPriceOverrideAction ; src/lib/auth/effective-access.ts",
    access: MANAGE,
    text: bi(
      {
        definition: "Autorise les vendeurs en magasin à changer le prix ou accorder une remise à la caisse.",
        calculation: "Activé : tout utilisateur qui peut vendre en magasin reçoit aussi le droit « modifier le prix ». Désactivé (par défaut) : seuls les rôles qui ont déjà ce droit, ou un vendeur à qui il a été accordé individuellement, le peuvent.",
        scope: "Ventes en magasin uniquement (mode « En ligne + Magasin »).",
        example: "Activé : un vendeur passe un article de 200 MAD à 180 MAD à la caisse.",
        caveats: "Un retrait individuel dans Utilisateurs reste prioritaire.",
      },
      {
        definition: "يسمح لبائعي المتجر بتغيير السعر أو منح تخفيض عند الصندوق.",
        calculation: "مفعّل: كل مستخدم يمكنه البيع في المتجر يحصل أيضًا على صلاحية « تعديل السعر ». غير مفعّل (افتراضيًا): لا يستطيع ذلك إلا من يملك هذه الصلاحية أصلًا أو بائع مُنحت له فرديًا.",
        scope: "مبيعات المتجر فقط (وضع « En ligne + Magasin »).",
        example: "مفعّل: يغيّر البائع سعر قطعة من 200 MAD إلى 180 MAD عند الصندوق.",
        caveats: "السحب الفردي للصلاحية في Utilisateurs تبقى له الأولوية.",
      }
    ),
  },
  storeModeUnavailable: {
    labels: ["Ventes magasin non activées"],
    screens: ["configuration"],
    source: "src/lib/auth/capabilities.ts — offlineSales (mode d'activité)",
    access: VIEW,
    text: bi(
      {
        definition: "Votre entreprise est en mode « En ligne » uniquement.",
        calculation: "Les ventes en caisse, magasins et leurs réglages sont masqués. Ce mode est fixé par l'équipe ASODITECH, pas depuis cette page.",
        example: "Mode « En ligne » : aucun interrupteur « Prix modifiable par les vendeurs » (0 réglage magasin).",
      },
      {
        definition: "مقاولتك في وضع « En ligne » فقط.",
        calculation: "تُخفى مبيعات الصندوق والمتاجر وإعداداتها. يحدّد فريق ASODITECH هذا الوضع، وليس من هذه الصفحة.",
        example: "وضع « En ligne »: لا يظهر مفتاح « Prix modifiable par les vendeurs » (0 إعداد للمتجر).",
      }
    ),
  },

  // ------------------------------------------------------------ Stock & achats
  lowStockThreshold: {
    labels: ["Seuil de stock faible", "Seuil par défaut (unités)"],
    screens: ["configuration"],
    source: `${ACTION} ; src/components/products/product-form.tsx`,
    access: MANAGE,
    text: bi(
      {
        definition: "Le seuil d'alerte « stock faible » proposé pour un nouveau produit.",
        calculation: "Prérempli à la création d'un produit ; ensuite chaque produit garde SON seuil. Un article est en stock faible quand son stock disponible est inférieur ou égal au seuil du produit.",
        filters: "Nombre entier ≥ 0 ; vide = 5.",
        example: "Seuil 5 → un nouveau produit est créé avec 5 ; à 4 unités disponibles, il est en stock faible.",
        caveats: "Changer ce réglage ne modifie pas le seuil des produits existants.",
      },
      {
        definition: "عتبة تنبيه « المخزون المنخفض » المقترحة لمنتج جديد.",
        calculation: "تُملأ مسبقًا عند إنشاء منتج، ثم يحتفظ كل منتج بعتبته الخاصة. يكون المنتج في مخزون منخفض عندما يكون مخزونه المتاح أقل من عتبته أو مساويًا لها.",
        filters: "عدد صحيح ≥ 0؛ إذا كان فارغًا = 5.",
        example: "العتبة 5 ← يُنشأ المنتج الجديد بـ5؛ وعند 4 قطع متاحة يصبح في مخزون منخفض.",
        caveats: "تغيير هذا الإعداد لا يغيّر عتبة المنتجات الموجودة.",
      }
    ),
  },
  costingMethod: {
    labels: ["Méthode de calcul du coût"],
    screens: ["configuration"],
    source: "src/actions/settings.ts — updateCostingMethodAction ; src/lib/receptions.ts ; src/lib/catalog/costing.ts — computeUpdatedCost",
    access: MANAGE,
    text: bi(
      {
        definition: "Comment une réception fournisseur validée met à jour le coût actuel d'un produit.",
        calculation: "Manuel (par défaut) : rien n'est modifié. Dernier coût d'achat : le coût devient le prix d'achat de la réception. Coût moyen pondéré : (stock existant × coût actuel + quantité reçue × prix reçu) ÷ (stock existant + quantité reçue) ; sans stock existant ou sans coût, le prix reçu.",
        filters: "Manuel, Dernier coût d'achat, Coût moyen pondéré.",
        example: "10 unités à 50 MAD, réception de 10 à 60 MAD → dernier coût : 60 MAD ; moyenne pondérée : (10 × 50 + 10 × 60) ÷ 20 = 55 MAD.",
        caveats: "Le « stock existant » est celui de l'emplacement qui reçoit. Le coût déjà figé sur une commande ou une vente passée ne change jamais.",
      },
      {
        definition: "كيف يحدّث استلامُ مورّدٍ مؤكَّد الكلفةَ الحالية للمنتج.",
        calculation: "يدوي (افتراضيًا): لا يتغيّر شيء. آخر كلفة شراء: تصبح الكلفة هي سعر شراء الاستلام. الكلفة المتوسطة المرجّحة: (المخزون الحالي × الكلفة الحالية + الكمية المستلمة × السعر المستلم) ÷ (المخزون الحالي + الكمية المستلمة)؛ وإن لم يوجد مخزون أو كلفة فالسعر المستلم.",
        filters: "Manuel وDernier coût d'achat وCoût moyen pondéré.",
        example: "10 قطع بـ50 MAD، واستلام 10 بـ60 MAD ← آخر كلفة: 60 MAD؛ المتوسط المرجّح: (10 × 50 + 10 × 60) ÷ 20 = 55 MAD.",
        caveats: "« المخزون الحالي » هو مخزون الموقع المستلِم. الكلفة المثبّتة على طلب أو بيع سابق لا تتغيّر أبدًا.",
      }
    ),
  },
  transferCostOverride: {
    labels: ["Coût d'achat lors des transferts"],
    screens: ["configuration"],
    source: "src/actions/settings.ts — updateTransferCostOverrideAction ; src/lib/transfers.ts ; src/lib/receptions.ts",
    access: `${MANAGE} + finance.view`,
    text: bi(
      {
        definition: "Permet un coût d'achat propre à chaque emplacement.",
        calculation: "Activé : sur un transfert, un utilisateur avec accès Finance peut fixer le coût d'achat à l'emplacement de destination, et une réception validée devient le coût de l'emplacement qui reçoit (le dernier coût l'emporte). Désactivé (par défaut) : les transferts ne déplacent que des quantités ; les coûts déjà enregistrés sont conservés.",
        example: "Transfert de 5 unités vers Rabat avec un coût de 65 MAD → l'emplacement Rabat a un coût d'achat de 65 MAD.",
        caveats: "Le prix de vente n'est jamais modifié. Réservé aux utilisateurs ayant accès aux données financières.",
      },
      {
        definition: "يسمح بكلفة شراء خاصة بكل موقع.",
        calculation: "مفعّل: عند التحويل يمكن لمستخدم له صلاحية المالية تحديد كلفة الشراء في موقع الوصول، ويصبح الاستلام المؤكَّد كلفةً للموقع المستلِم (آخر كلفة هي المعتمدة). غير مفعّل (افتراضيًا): التحويلات تنقل الكميات فقط، وتُحفظ الكلف المسجّلة سابقًا.",
        example: "تحويل 5 قطع إلى الرباط بكلفة 65 MAD ← تصبح كلفة الشراء في موقع الرباط 65 MAD.",
        caveats: "لا يتغيّر سعر البيع أبدًا. مخصّص للمستخدمين الذين لهم صلاحية الاطلاع على المعطيات المالية.",
      }
    ),
  },

  // ------------------------------------------------------------ Support
  supportName: {
    labels: ["Nom du support"],
    screens: ["configuration"],
    source: `${ACTION} ; src/lib/queries/support.ts`,
    access: MANAGE,
    text: bi(
      {
        definition: "Le nom affiché en tête du centre d'aide.",
        calculation: `${SUPPORT_USE.fr} Vide : « Support ».`,
        filters: "120 caractères au maximum.",
        example: "« Équipe Boutique Exemple » en titre du centre d'aide.",
      },
      {
        definition: "الاسم المعروض في أعلى مركز المساعدة.",
        calculation: `${SUPPORT_USE.ar} إذا كان فارغًا: « Support ».`,
        filters: "120 حرفًا كحدّ أقصى.",
        example: "« Équipe Boutique Exemple » عنوانًا لمركز المساعدة.",
      }
    ),
  },
  supportHours: {
    labels: ["Horaires"],
    screens: ["configuration"],
    source: `${ACTION} ; src/lib/queries/support.ts`,
    access: MANAGE,
    text: bi(
      {
        definition: "Vos horaires de disponibilité, en texte libre.",
        calculation: `${SUPPORT_USE.fr} Purement informatif : rien n'est bloqué en dehors de ces horaires.`,
        filters: "200 caractères au maximum.",
        example: "« Lun–Sam, 9h–18h ».",
      },
      {
        definition: "أوقات توفّركم، بنص حرّ.",
        calculation: `${SUPPORT_USE.ar} للإعلام فقط: لا يُمنع أي شيء خارج هذه الأوقات.`,
        filters: "200 حرف كحدّ أقصى.",
        example: "مثال: « Lun–Sam, 9h–18h ».",
      }
    ),
  },
  supportWhatsapp: {
    labels: ["WhatsApp"],
    screens: ["configuration"],
    source: `${ACTION} ; src/lib/validation/settings.ts — contactNumberSchema`,
    access: MANAGE,
    text: bi(
      {
        definition: "Le numéro WhatsApp que vos équipes peuvent contacter.",
        calculation: SUPPORT_USE.fr,
        filters: "Chiffres, espaces, tirets, parenthèses et un « + » au début ; 6 à 30 caractères.",
        example: "+212 600 000 000 → bouton WhatsApp dans le centre d'aide.",
        caveats: "Indépendant du téléphone : un numéro de téléphone n'est pas forcément joignable sur WhatsApp.",
      },
      {
        definition: "رقم واتساب الذي يمكن لفرقك التواصل معه.",
        calculation: SUPPORT_USE.ar,
        filters: "أرقام ومسافات وشرطات وأقواس وعلامة « + » في البداية؛ من 6 إلى 30 حرفًا.",
        example: "+212 600 000 000 ← زر واتساب في مركز المساعدة.",
        caveats: "مستقلّ عن الهاتف: رقم الهاتف ليس بالضرورة متاحًا على واتساب.",
      }
    ),
  },
  supportPhone: {
    labels: ["Téléphone"],
    screens: ["configuration"],
    source: `${ACTION} ; src/lib/validation/settings.ts — contactNumberSchema`,
    access: MANAGE,
    text: bi(
      {
        definition: "Le numéro de téléphone du support.",
        calculation: SUPPORT_USE.fr,
        filters: "Même format que WhatsApp : 6 à 30 caractères.",
        example: "+212 522 000 000 → bouton d'appel dans le centre d'aide.",
      },
      {
        definition: "رقم هاتف الدعم.",
        calculation: SUPPORT_USE.ar,
        filters: "نفس صيغة واتساب: من 6 إلى 30 حرفًا.",
        example: "+212 522 000 000 ← زر الاتصال في مركز المساعدة.",
      }
    ),
  },
  supportEmail: {
    labels: ["E-mail du support"],
    screens: ["configuration"],
    source: ACTION,
    access: MANAGE,
    text: bi(
      {
        definition: "L'adresse e-mail du support.",
        calculation: SUPPORT_USE.fr,
        filters: "Une adresse e-mail valide, ou vide.",
        example: "support@boutique-exemple.ma.",
        caveats: "Aucun des 3 contacts (WhatsApp, téléphone, e-mail) : signalé dans « À corriger ».",
      },
      {
        definition: "عنوان البريد الإلكتروني للدعم.",
        calculation: SUPPORT_USE.ar,
        filters: "عنوان بريد إلكتروني صحيح، أو فارغ.",
        example: "مثال: support@boutique-exemple.ma.",
        caveats: "إذا غابت وسائل الاتصال الـ3 (واتساب، الهاتف، البريد) يظهر ذلك ضمن « À corriger ».",
      }
    ),
  },
  supportPreview: {
    labels: ["Ce que voient vos équipes"],
    screens: ["configuration"],
    source: "src/components/settings/business-settings-form.tsx — SupportSettingsForm",
    access: MANAGE,
    text: bi(
      {
        definition: "Un aperçu du centre d'aide avec les contacts enregistrés.",
        calculation: "Montre le nom, les horaires et les 3 moyens de contact ; un contact vide apparaît « Non affiché » et sera masqué pour vos équipes.",
        example: "E-mail vide → seuls WhatsApp et téléphone (2 sur 3) apparaissent dans le centre d'aide.",
      },
      {
        definition: "معاينة لمركز المساعدة بوسائل الاتصال المحفوظة.",
        calculation: "يعرض الاسم والأوقات ووسائل الاتصال الـ3؛ وتظهر الوسيلة الفارغة « Non affiché » وتُخفى عن فرقك.",
        example: "البريد فارغ ← يظهر واتساب والهاتف فقط (2 من 3) في مركز المساعدة.",
      }
    ),
  },

  // ------------------------------------------------------------ Abonnement & Utilisation
  currentPlan: {
    labels: ["Forfait actuel"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/plan.ts — getTenantPlan",
    access: VIEW,
    text: bi(
      {
        definition: "Votre forfait, son prix mensuel et l'état de l'abonnement.",
        calculation: "Lecture seule : le forfait et ses limites sont fixés par l'équipe ASODITECH. Badges possibles : « Essai », « Paiement en retard », « Résilié ».",
        example: "BUSINESS — 299 MAD / mois (montant fictif).",
      },
      {
        definition: "باقتك وثمنها الشهري وحالة الاشتراك.",
        calculation: "للقراءة فقط: يحدّد فريق ASODITECH الباقة وحدودها. الشارات الممكنة: « Essai » و« Paiement en retard » و« Résilié ».",
        example: "BUSINESS — 299 MAD في الشهر (مبلغ وهمي).",
      }
    ),
  },
  usagePeriod: {
    labels: ["Période en cours"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/usage.ts — currentPeriod",
    access: VIEW,
    text: bi(
      {
        definition: "Le mois pendant lequel les commandes sont comptées.",
        calculation: "Le mois calendaire en cours, découpé en temps universel (UTC).",
        example: "Octobre 2026 : du 1er octobre 00:00 UTC au 31 octobre 23:59 UTC.",
        caveats: "Le Maroc étant à UTC+1 la plupart de l'année, une commande passée le 1er entre 00:00 et 01:00 heure locale compte dans le mois précédent.",
      },
      {
        definition: "الشهر الذي تُحتسب خلاله الطلبات.",
        calculation: "الشهر الميلادي الجاري، محسوبًا بالتوقيت العالمي (UTC).",
        example: "أكتوبر 2026: من 1 أكتوبر 00:00 UTC إلى 31 أكتوبر 23:59 UTC.",
        caveats: "بما أن المغرب على توقيت UTC+1 أغلب السنة، فالطلب المسجَّل يوم 1 بين 00:00 و01:00 بالتوقيت المحلي يُحتسب في الشهر السابق.",
      }
    ),
  },
  usageStatus: {
    labels: ["Utilisation de votre abonnement"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/catalogue.ts — computeUsageStatus, USAGE_THRESHOLDS",
    access: VIEW,
    text: bi(
      {
        definition: "Où vous en êtes par rapport aux limites de votre forfait.",
        calculation: "Pour chaque compteur : utilisé ÷ limite × 100. 🟢 moins de 80 % ; 🟠 dès 80 % ; 🔴 dès 90 % ; ⚫ dès 100 %. Sans limite : « Illimité ».",
        example: "1 230 commandes sur 1 500 → 82 % → 🟠.",
        interpretation: "Les commandes ne sont JAMAIS bloquées par la limite (simple alerte) ; les utilisateurs et les emplacements, si : au-delà de la limite, on ne peut plus en ajouter.",
      },
      {
        definition: "موقعك بالنسبة لحدود باقتك.",
        calculation: "لكل عدّاد: المستعمَل ÷ الحدّ × 100. 🟢 أقل من 80 %؛ 🟠 ابتداءً من 80 %؛ 🔴 ابتداءً من 90 %؛ ⚫ ابتداءً من 100 %. دون حدّ: « Illimité ».",
        example: "1 230 طلبًا من 1 500 ← 82 % ← 🟠.",
        interpretation: "الطلبات لا تُمنع أبدًا بسبب الحدّ (مجرد تنبيه)؛ أما المستخدمون والمواقع فتُمنع إضافتهم بعد بلوغ الحدّ.",
      }
    ),
  },
  usageOrders: {
    labels: ["Commandes ce mois-ci"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/usage.ts — countOrdersInPeriod",
    access: VIEW,
    text: bi(
      {
        definition: "Le nombre de commandes passées ce mois-ci, comparé à la limite mensuelle du forfait.",
        calculation: "Toutes les commandes dont la date de commande est dans le mois en cours (UTC), quel que soit leur statut — annulées comprises. Une commande importée compte dans le mois de SA date d'origine, pas le jour de l'import.",
        example: "Import en octobre de 300 commandes de septembre → elles comptent en septembre, pas en octobre.",
        caveats: "Dépasser la limite ne bloque jamais une commande : seule une alerte est envoyée.",
      },
      {
        definition: "عدد الطلبات المسجَّلة هذا الشهر مقارنةً بالحدّ الشهري للباقة.",
        calculation: "كل الطلبات التي يقع تاريخها في الشهر الجاري (UTC) مهما كانت حالتها، بما فيها الملغاة. الطلب المستورد يُحتسب في شهر تاريخه الأصلي وليس يوم الاستيراد.",
        example: "استيراد 300 طلب من سبتمبر في أكتوبر ← تُحتسب في سبتمبر وليس في أكتوبر.",
        caveats: "تجاوز الحدّ لا يمنع أي طلب أبدًا: يُرسَل تنبيه فقط.",
      }
    ),
  },
  usageUsers: {
    labels: ["Utilisateurs"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/usage.ts — countActiveUsers ; src/lib/entitlements/checks.ts — withSeatLimit",
    access: VIEW,
    text: bi(
      {
        definition: "Le nombre d'utilisateurs actifs, comparé à la limite du forfait.",
        calculation: "Comptage à l'instant présent des comptes au statut actif (pas un total mensuel). Un compte désactivé libère aussitôt sa place.",
        example: "6 comptes dont 1 désactivé → 5 utilisateurs.",
        caveats: "Limite stricte : une fois atteinte, une nouvelle invitation ne peut pas être acceptée. La phrase « … ce mois-ci » sous le compteur est trompeuse : c'est un nombre actuel.",
      },
      {
        definition: "عدد المستخدمين النشطين مقارنةً بحدّ الباقة.",
        calculation: "عدّ في اللحظة الحالية للحسابات النشطة (وليس مجموعًا شهريًا). الحساب المعطَّل يحرّر مكانه فورًا.",
        example: "6 حسابات منها 1 معطَّل ← 5 مستخدمين.",
        caveats: "حدّ صارم: بعد بلوغه لا يمكن قبول دعوة جديدة. عبارة « … ce mois-ci » تحت العدّاد مضلِّلة: إنه عدد حالي.",
      }
    ),
  },
  usageWarehouses: {
    labels: ["Entrepôts"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/usage.ts — countActiveWarehouses ; src/actions/warehouses.ts",
    access: VIEW,
    text: bi(
      {
        definition: "Le nombre d'emplacements actifs, comparé à la limite du forfait.",
        calculation: "Comptage actuel de TOUS les emplacements actifs — entrepôts ET magasins. Un emplacement désactivé libère sa place (son historique de stock est conservé).",
        example: "2 entrepôts et 1 magasin actifs → 3.",
        caveats: "Limite stricte : une fois atteinte, on ne peut plus créer d'emplacement. C'est un nombre actuel, pas mensuel.",
      },
      {
        definition: "عدد المواقع النشطة مقارنةً بحدّ الباقة.",
        calculation: "عدّ حالي لكل المواقع النشطة، أي المستودعات والمتاجر معًا. الموقع المعطَّل يحرّر مكانه (ويُحفظ سجلّ مخزونه).",
        example: "مستودعان (2) ومتجر 1 نشطة ← 3.",
        caveats: "حدّ صارم: بعد بلوغه لا يمكن إنشاء موقع جديد. إنه عدد حالي وليس شهريًا.",
      }
    ),
  },
  planFeatures: {
    labels: ["Fonctionnalités incluses"],
    screens: ["abonnement"],
    source: "src/lib/entitlements/catalogue.ts — FEATURE_KEY_LABELS",
    access: VIEW,
    text: bi(
      {
        definition: "Les modules prévus par votre forfait.",
        calculation: "✓ = inclus (« (avancé) » pour le niveau avancé), ✗ = non inclus, d'après la fiche du forfait.",
        example: "8 modules listés : WooCommerce, Shopify, Rapports, Rentabilité, Sauvegarde, Assistant IA, Commissions, Finance & dépenses.",
        caveats: "Aujourd'hui, cette liste est informative : aucun de ces 8 modules n'est bloqué par l'application lorsqu'il est marqué ✗.",
      },
      {
        definition: "الوحدات التي تتضمّنها باقتك.",
        calculation: "✓ = مُدرجة (« (avancé) » للمستوى المتقدّم)، ✗ = غير مُدرجة، حسب بطاقة الباقة.",
        example: "8 وحدات مذكورة: WooCommerce وShopify وRapports وRentabilité وSauvegarde وAssistant IA وCommissions وFinance & dépenses.",
        caveats: "هذه اللائحة حاليًا للإعلام فقط: لا يمنع التطبيق أيًّا من هذه الوحدات الـ8 عندما تكون مُعلَّمة ✗.",
      }
    ),
  },
  upgradeRequest: {
    labels: ["Passer à PRO", "Voir le forfait PRO"],
    screens: ["abonnement"],
    source: "src/actions/plans.ts — requestPlanUpgradeAction",
    access: MANAGE,
    text: bi(
      {
        definition: "Demande de passage au forfait PRO.",
        calculation: "Envoie une demande à l'équipe ASODITECH, qui vous recontacte. Aucun paiement n'est fait et le forfait ne change pas tant que l'équipe ne l'a pas modifié.",
        example: "Clic sur « Passer à PRO » → message « Votre demande a été envoyée ».",
        caveats: "Les chiffres du forfait PRO cités dans le message (environ 7 000 commandes, 20 utilisateurs, 10 entrepôts) sont écrits dans la page, pas lus dans la fiche du forfait.",
      },
      {
        definition: "طلب الانتقال إلى باقة PRO.",
        calculation: "يُرسل طلبًا إلى فريق ASODITECH الذي يتواصل معك. لا يتمّ أي أداء ولا تتغيّر الباقة حتى يعدّلها الفريق.",
        example: "الضغط على « Passer à PRO » ← رسالة « Votre demande a été envoyée ».",
        caveats: "أرقام باقة PRO المذكورة في الرسالة (حوالي 7 000 طلب و20 مستخدمًا و10 مستودعات) مكتوبة في الصفحة وليست مقروءة من بطاقة الباقة.",
      }
    ),
  },

  // ------------------------------------------------------------ Canaux de vente
  channelCounts: {
    labels: ["produit(s) · utilisateur(s)"],
    screens: ["canaux"],
    source: "src/lib/queries/channels.ts — listChannelsWithLocations (_count)",
    access: CHANNELS,
    text: bi(
      {
        definition: "Combien de produits sont proposés sur ce canal et combien d'utilisateurs y ont accès.",
        calculation: "Produits : produits rattachés au canal. Utilisateurs : comptes à qui ce canal a été attribué (les propriétaires et administrateurs voient tous les canaux sans attribution).",
        example: "« 120 produit(s) · 3 utilisateur(s) ».",
      },
      {
        definition: "عدد المنتجات المعروضة في هذه القناة وعدد المستخدمين الذين لهم صلاحية الولوج إليها.",
        calculation: "المنتجات: المنتجات المرتبطة بالقناة. المستخدمون: الحسابات التي أُسندت إليها هذه القناة (المالكون والمديرون يرون كل القنوات دون إسناد).",
        example: "مثال: « 120 produit(s) · 3 utilisateur(s) »، أي 120 منتجًا و3 مستخدمين.",
      }
    ),
  },
  channelDefault: {
    labels: ["Par défaut"],
    screens: ["canaux"],
    source: "prisma/schema.prisma — SalesChannel.isDefault ; src/actions/channels.ts",
    access: CHANNELS,
    text: bi(
      {
        definition: "Le canal en ligne principal de l'entreprise.",
        calculation: "Toute commande en ligne créée sans canal précis (formulaire manuel, import WooCommerce / Shopify) lui est rattachée. Il peut être renommé mais jamais désactivé.",
        example: "« Boutique en ligne » (par défaut) reçoit les 10 commandes importées du jour.",
      },
      {
        definition: "القناة الإلكترونية الرئيسية للمقاولة.",
        calculation: "كل طلب إلكتروني يُنشأ دون قناة محدّدة (نموذج يدوي، استيراد WooCommerce / Shopify) يُنسب إليها. يمكن إعادة تسميتها لكن لا يمكن تعطيلها أبدًا.",
        example: "« Boutique en ligne » (افتراضية) تستقبل الطلبات الـ10 المستوردة اليوم.",
      }
    ),
  },
  channelActive: {
    labels: ["Actif"],
    screens: ["canaux"],
    source: "src/actions/channels.ts — updateSalesChannelAction ; src/lib/auth/channel-access.ts",
    access: CHANNELS,
    text: bi(
      {
        definition: "Active ou désactive le canal.",
        calculation: "Désactivé : plus aucune nouvelle opération ne peut être enregistrée sur ce canal (« Ce canal de vente est inactif »). Son historique (commandes, ventes) est conservé ; un canal n'est jamais supprimé.",
        example: "Magasin fermé en été → désactivé, ses 2 mois de ventes restent dans les rapports.",
        caveats: "Le canal par défaut ne peut pas être désactivé.",
      },
      {
        definition: "يفعّل القناة أو يعطّلها.",
        calculation: "معطَّلة: لا يمكن تسجيل أي عملية جديدة في هذه القناة (« Ce canal de vente est inactif »). يُحفظ تاريخها (الطلبات، المبيعات)، ولا تُحذف القناة أبدًا.",
        example: "متجر مغلق في الصيف ← يُعطَّل، وتبقى مبيعات شهرين (2) في التقارير.",
        caveats: "لا يمكن تعطيل القناة الافتراضية.",
      }
    ),
  },
  channelName: {
    labels: ["Nom"],
    screens: ["canaux"],
    source: "src/actions/channels.ts — create/updateSalesChannelAction",
    access: CHANNELS,
    text: bi(
      {
        definition: "Le nom du canal, affiché dans les filtres, rapports et accès.",
        filters: "2 à 100 caractères ; deux canaux ne peuvent pas porter le même nom.",
        calculation: "Renommer ne change que l'affichage : l'historique reste rattaché au même canal.",
        example: "« Magasin Casablanca ».",
      },
      {
        definition: "اسم القناة، يظهر في المرشّحات والتقارير والصلاحيات.",
        filters: "من 2 إلى 100 حرف؛ لا يمكن لقناتين أن تحملا الاسم نفسه.",
        calculation: "إعادة التسمية تغيّر العرض فقط: يبقى التاريخ مرتبطًا بالقناة نفسها.",
        example: "مثال: « Magasin Casablanca ».",
      }
    ),
  },
  channelType: {
    labels: ["Type"],
    screens: ["canaux"],
    source: "prisma/schema.prisma — SalesChannelKind",
    access: CHANNELS,
    text: bi(
      {
        definition: "En ligne (commandes à livrer) ou Magasin (ventes en caisse).",
        calculation: "Le type décide quelles opérations appartiennent au canal : commandes en ligne d'un côté, ventes en point de vente de l'autre. Il est choisi à la création.",
        filters: "« En ligne » ou « Magasin ».",
        example: "Un nouveau point de vente à Rabat → type « Magasin ».",
      },
      {
        definition: "إلكتروني (طلبات للتوصيل) أو متجر (مبيعات في الصندوق).",
        calculation: "يحدّد النوع العمليات التي تنتمي إلى القناة: الطلبات الإلكترونية من جهة، والمبيعات في نقطة البيع من جهة أخرى. يُختار عند الإنشاء.",
        filters: "« En ligne » أو « Magasin ».",
        example: "نقطة بيع جديدة في الرباط ← النوع « Magasin ».",
      }
    ),
  },
  channelLocations: {
    labels: ["Emplacements de vente"],
    screens: ["canaux"],
    source: "src/actions/channels.ts — setChannelLocationsAction",
    access: CHANNELS,
    text: bi(
      {
        definition: "Les emplacements physiques d'où ce canal vend ou expédie.",
        calculation: "Un rattachement, pas un stock : la quantité reste sur l'emplacement, jamais dupliquée par canal. Seuls les emplacements actifs peuvent être rattachés.",
        example: "Canal « Magasin Casablanca » rattaché à « Boutique Maarif » et « Réserve » : la caisse peut vendre le stock de ces 2 emplacements.",
      },
      {
        definition: "المواقع الفعلية التي تبيع منها هذه القناة أو تشحن.",
        calculation: "ربط وليس مخزونًا: تبقى الكمية في الموقع ولا تُكرَّر حسب القناة. لا يمكن ربط إلا المواقع النشطة.",
        example: "قناة « Magasin Casablanca » مربوطة بـ« Boutique Maarif » و« Réserve »: يمكن للصندوق بيع مخزون هذين الموقعين (2).",
      }
    ),
  },
  newChannel: {
    labels: ["Nouveau canal de vente"],
    screens: ["canaux"],
    source: "src/actions/channels.ts — createSalesChannelAction",
    access: CHANNELS,
    text: bi(
      {
        definition: "Crée un nouveau canal (une activité de vente).",
        calculation: "Enregistre le nom, le type et les emplacements choisis ; l'opération est inscrite au journal d'audit.",
        example: "Nom « Magasin Rabat », type Magasin, 1 emplacement → canal créé, 0 produit, 0 utilisateur.",
      },
      {
        definition: "ينشئ قناة جديدة (نشاط بيع).",
        calculation: "يحفظ الاسم والنوع والمواقع المختارة، وتُسجَّل العملية في سجل التدقيق.",
        example: "الاسم « Magasin Rabat »، النوع متجر، موقع 1 ← تُنشأ القناة بـ0 منتج و0 مستخدم.",
      }
    ),
  },

  // ------------------------------------------------------------ Notifications
  inAppAlerts: {
    labels: ["Dans l'application"],
    screens: ["notifications"],
    source: "src/components/settings/notification-channels.tsx — InAppChannelCard",
    access: SELF,
    text: bi(
      {
        definition: "Les alertes affichées dans la cloche et sur la page Notifications.",
        calculation: "Toujours actif : chaque alerte qui vous concerne y arrive. Le son se règle pour CE navigateur uniquement (enregistré dans le navigateur).",
        example: "Rupture de stock à 14 h → pastille sur la cloche, son si activé.",
      },
      {
        definition: "التنبيهات المعروضة في الجرس وفي صفحة Notifications.",
        calculation: "مفعّل دائمًا: يصل إليه كل تنبيه يخصّك. يُضبط الصوت لهذا المتصفح فقط (يُحفظ في المتصفح).",
        example: "نفاد المخزون على الساعة 14 ← علامة على الجرس، مع صوت إذا كان مفعّلًا.",
      }
    ),
  },
  emailAlerts: {
    labels: ["Alertes par email"],
    screens: ["notifications"],
    source: "src/lib/notification-settings.ts — getMyNotificationSettings",
    access: SELF,
    text: bi(
      {
        definition: "Les alertes critiques envoyées à l'adresse e-mail de votre compte.",
        calculation: "« Activé » quand l'envoi d'e-mails est configuré sur la plateforme ; sinon « Canal indisponible » et rien n'est envoyé par e-mail. Pas de désactivation alerte par alerte.",
        example: "Échec de livraison → e-mail à l'adresse de votre compte.",
        caveats: "Les e-mails de compte (invitation, mot de passe) ne sont pas des alertes.",
      },
      {
        definition: "التنبيهات الحرجة المرسلة إلى البريد الإلكتروني لحسابك.",
        calculation: "« Activé » عندما يكون إرسال البريد مُعدًّا في المنصة؛ وإلا « Canal indisponible » ولا يُرسل أي شيء بالبريد. لا يمكن تعطيل كل تنبيه على حدة.",
        example: "فشل التسليم ← رسالة إلى بريد حسابك.",
        caveats: "رسائل الحساب (الدعوة، كلمة المرور) ليست تنبيهات.",
      }
    ),
  },
  whatsappAlerts: {
    labels: ["Alertes WhatsApp"],
    screens: ["notifications"],
    source: "src/lib/notification-settings.ts — whatsAppStatus ; src/lib/whatsapp/dispatch.ts",
    access: SELF,
    text: bi(
      {
        definition: "Les alertes critiques sur votre WhatsApp : rupture de stock, échec de livraison, erreur d'intégration.",
        calculation: "Envoyées seulement si les 4 conditions sont réunies : canal WhatsApp disponible pour l'entreprise, numéro renseigné, numéro vérifié, notifications activées. Le badge montre la première condition manquante.",
        example: "Numéro vérifié mais notifications désactivées → badge « désactivé », rien n'est envoyé.",
        caveats: "Échecs de livraison : un résumé au plus par jour sur WhatsApp.",
      },
      {
        definition: "التنبيهات الحرجة على واتساب الخاص بك: نفاد المخزون، فشل التسليم، خطأ في الربط.",
        calculation: "لا تُرسَل إلا إذا اجتمعت الشروط الـ4: قناة واتساب متاحة للمقاولة، رقم مُدخل، رقم مُتحقَّق منه، إشعارات مفعّلة. تُظهر الشارة أول شرط ناقص.",
        example: "رقم مُتحقَّق منه لكن الإشعارات معطَّلة ← شارة « désactivé » ولا يُرسل شيء.",
        caveats: "فشل التسليم: ملخّص واحد في اليوم كحدّ أقصى على واتساب.",
      }
    ),
  },
  whatsappNumber: {
    labels: ["Numéro WhatsApp"],
    screens: ["notifications"],
    source: "src/actions/whatsapp.ts",
    access: SELF,
    text: bi(
      {
        definition: "Votre propre numéro WhatsApp pour recevoir les alertes.",
        calculation: "Changer de numéro oblige à le vérifier à nouveau. Le numéro n'est affiché que masqué.",
        example: "+212 6•• ••• •12 (numéro masqué).",
      },
      {
        definition: "رقم واتساب الخاص بك لتلقّي التنبيهات.",
        calculation: "تغيير الرقم يستلزم التحقق منه من جديد. لا يُعرض الرقم إلا مُخفى جزئيًا.",
        example: "+212 6•• ••• •12 (رقم مُخفى).",
      }
    ),
  },
  whatsappVerification: {
    labels: ["Vérification"],
    screens: ["notifications"],
    source: "src/lib/whatsapp/verification.ts — CODE_TTL_MS, MAX_ATTEMPTS",
    access: SELF,
    text: bi(
      {
        definition: "Prouve que le numéro vous appartient.",
        calculation: "Un code à 6 chiffres est envoyé dans WhatsApp ; il est valable 10 minutes et 5 essais au plus sont acceptés.",
        example: "Code reçu à 10 h 00 → à saisir avant 10 h 10 ; après 5 codes faux, il faut en redemander un.",
      },
      {
        definition: "يُثبت أن الرقم يعود إليك.",
        calculation: "يُرسَل رمز من 6 أرقام عبر واتساب؛ صالح لمدة 10 دقائق، ولا تُقبل إلا 5 محاولات كحدّ أقصى.",
        example: "رمز وصل على الساعة 10 h 00 ← يجب إدخاله قبل 10 h 10؛ وبعد 5 رموز خاطئة يجب طلب رمز جديد.",
      }
    ),
  },
  whatsappOptIn: {
    labels: ["Notifications activées", "Notifications désactivées"],
    screens: ["notifications"],
    source: "src/actions/whatsapp.ts",
    access: SELF,
    text: bi(
      {
        definition: "Votre accord pour recevoir les alertes sur WhatsApp.",
        calculation: "Activable seulement une fois le numéro vérifié ; désactivable à tout moment. Désactivé : aucune alerte WhatsApp, les autres canaux continuent.",
        example: "Désactivé pendant 1 semaine de congés → alertes uniquement dans l'application et par e-mail.",
      },
      {
        definition: "موافقتك على تلقّي التنبيهات عبر واتساب.",
        calculation: "لا يمكن تفعيله إلا بعد التحقق من الرقم، ويمكن تعطيله في أي وقت. معطَّل: لا تنبيهات عبر واتساب، وتستمرّ القنوات الأخرى.",
        example: "معطَّل خلال أسبوع 1 من العطلة ← التنبيهات في التطبيق والبريد فقط.",
      }
    ),
  },
  alertPreferences: {
    labels: ["Préférences d'alertes"],
    screens: ["notifications"],
    source: "src/lib/notification-settings.ts — ALERT_RULES, alertsForUser",
    access: SELF,
    text: bi(
      {
        definition: "Les alertes que vous recevez selon vos droits, et par quel canal.",
        calculation: "Une ligne par type d'alerte auquel vos droits donnent accès (9 types au total). ✓ = envoyé à vous par ce canal ; – = canal inactif ou non proposé pour cette alerte. Lecture seule : on ne choisit pas les alertes ici.",
        scope: "Rupture et stock faible : seulement vos emplacements, si vous n'avez pas accès à tous.",
        example: "Rôle Confirmation (droit commandes) → ligne « Commandes … » dans l'application uniquement.",
      },
      {
        definition: "التنبيهات التي تتلقّاها حسب صلاحياتك، وعبر أي قناة.",
        calculation: "سطر لكل نوع تنبيه تسمح به صلاحياتك (9 أنواع في المجموع). ✓ = يُرسَل إليك عبر هذه القناة؛ – = قناة غير نشطة أو غير متاحة لهذا التنبيه. للقراءة فقط: لا تُختار التنبيهات هنا.",
        scope: "نفاد المخزون والمخزون المنخفض: مواقعك فقط، إذا لم تكن لك صلاحية على جميعها.",
        example: "دور Confirmation (صلاحية الطلبات) ← سطر « Commandes … » داخل التطبيق فقط.",
      }
    ),
  },
  accountSecurity: {
    labels: ["Sécurité du compte"],
    screens: ["notifications"],
    source: "src/actions/auth.ts — logoutAllSessionsAction",
    access: SELF,
    text: bi(
      {
        definition: "Ferme toutes VOS sessions ouvertes, sur tous vos appareils, y compris celle-ci.",
        calculation: "Après confirmation, vos sessions sont fermées immédiatement : il faut se reconnecter partout. Les autres utilisateurs ne sont pas touchés.",
        example: "Téléphone perdu → « Se déconnecter de toutes les sessions » → le téléphone est déconnecté.",
        caveats: "Seul l'appareil courant oublie aussi l'appareil « connu » de la protection de connexion.",
      },
      {
        definition: "يغلق كل جلساتك المفتوحة على جميع أجهزتك، بما فيها هذه الجلسة.",
        calculation: "بعد التأكيد تُغلق جلساتك فورًا ويجب تسجيل الدخول من جديد في كل مكان. لا يتأثّر المستخدمون الآخرون.",
        example: "هاتف ضائع ← « Se déconnecter de toutes les sessions » ← يُفصل الهاتف.",
        caveats: "الجهاز الحالي وحده ينسى أيضًا صفة « الجهاز المعروف » في حماية تسجيل الدخول.",
      }
    ),
  },

  // ------------------------------------------------------------ Sauvegarde
  lastBackup: {
    labels: ["État de la dernière sauvegarde"],
    screens: ["sauvegarde"],
    source: "src/lib/queries/backup.ts — getBackupStatus ; src/lib/backup/service.ts",
    access: MANAGE,
    text: bi(
      {
        definition: "La dernière sauvegarde générée avec « Sauvegarder maintenant ».",
        calculation: "Date, auteur, taille du fichier chiffré, nombre d'enregistrements, versions du format de données et de l'application. Seule la DERNIÈRE sauvegarde reste téléchargeable : en générer une nouvelle remplace la précédente.",
        example: "10/10/2026 15:00, par Younes, 1,2 Mo, 4 350 enregistrements.",
        caveats: "Au-delà de 100 000 enregistrements, la génération est refusée.",
      },
      {
        definition: "آخر نسخة احتياطية أُنشئت بزر « Sauvegarder maintenant ».",
        calculation: "التاريخ والمُنشئ وحجم الملف المشفّر وعدد السجلات وإصدارا صيغة المعطيات والتطبيق. وحدها آخر نسخة تبقى قابلة للتنزيل: إنشاء نسخة جديدة يعوّض السابقة.",
        example: "10/10/2026 على 15:00، من طرف Younes، بحجم 1,2 Mo، و4 350 سجلًا.",
        caveats: "إذا تجاوزت المعطيات 100 000 سجل يُرفض الإنشاء.",
      }
    ),
  },
  backupRecords: {
    labels: ["Enregistrements"],
    screens: ["sauvegarde"],
    source: "src/lib/queries/backup.ts — totalOf(counts)",
    access: MANAGE,
    text: bi(
      {
        definition: "Le nombre total de lignes de données contenues dans la sauvegarde.",
        calculation: "Somme des lignes de chaque catégorie (commandes, produits, stock, clients…) ; le détail est dans « Détail par catégorie ».",
        example: "1 200 commandes + 3 000 lignes de commande + 150 produits = 4 350 enregistrements.",
        caveats: "Ni mots de passe, ni sessions, ni clés d'API, ni identifiants de connecteurs.",
      },
      {
        definition: "العدد الإجمالي لأسطر المعطيات داخل النسخة الاحتياطية.",
        calculation: "مجموع أسطر كل فئة (الطلبات، المنتجات، المخزون، الزبناء…)، والتفصيل في « Détail par catégorie ».",
        example: "1 200 طلب + 3 000 سطر طلب + 150 منتجًا = 4 350 سجلًا.",
        caveats: "لا كلمات مرور ولا جلسات ولا مفاتيح API ولا معرّفات الربط.",
      }
    ),
  },
  backupSize: {
    labels: ["Taille"],
    screens: ["sauvegarde"],
    source: "src/lib/backup/container.ts",
    access: MANAGE,
    text: bi(
      {
        definition: "La taille du fichier .asb.",
        calculation: "Données compressées (gzip) puis chiffrées (AES-256-GCM) ; 25 Mo au maximum.",
        example: "4 350 enregistrements → environ 1,2 Mo.",
      },
      {
        definition: "حجم الملف .asb.",
        calculation: "معطيات مضغوطة (gzip) ثم مشفّرة (AES-256-GCM)؛ 25 Mo كحدّ أقصى.",
        example: "4 350 سجلًا ← حوالي 1,2 Mo.",
      }
    ),
  },
  backupVersions: {
    labels: ["Version du schéma", "Version de l'app"],
    screens: ["sauvegarde"],
    source: "src/lib/backup/manifest.ts",
    access: MANAGE,
    text: bi(
      {
        definition: "Les versions de la structure des données et de l'application au moment de la sauvegarde.",
        calculation: "Version du schéma = nom de la dernière migration de la base ; version de l'app = version du logiciel. Informations de diagnostic : à la restauration, c'est le FORMAT du fichier (v1) et son intégrité qui sont vérifiés, pas ces deux versions.",
        example: "Schéma « 20261011120000_return_receptions », app « 0.1.0 » (valeurs d'exemple).",
      },
      {
        definition: "إصدارا بنية المعطيات والتطبيق لحظة إنشاء النسخة.",
        calculation: "إصدار البنية = اسم آخر ترحيل (migration) لقاعدة المعطيات؛ إصدار التطبيق = إصدار البرنامج. معلومات تشخيصية: عند الاسترجاع تُفحص صيغة الملف (v1) وسلامته، لا هذان الإصداران.",
        example: "البنية « 20261011120000_return_receptions »، التطبيق « 0.1.0 » (قيم للمثال).",
      }
    ),
  },
  restoreBackup: {
    labels: ["Restaurer une sauvegarde"],
    screens: ["sauvegarde"],
    source: "src/lib/backup/service.ts — restore",
    access: MANAGE,
    text: bi(
      {
        definition: "Remplace les données actuelles par celles d'un fichier .asb.",
        calculation: "1) le fichier est vérifié et un aperçu s'affiche ; 2) un instantané de sécurité des données actuelles est créé ; 3) commandes, produits, stock, livraison et finance sont remplacés en une seule opération (en cas d'erreur, rien n'est modifié). Les comptes utilisateurs sont fusionnés, jamais supprimés.",
        scope: "Uniquement une sauvegarde de CE compte : la restauration entre comptes n'est pas disponible.",
        period: "Un fichier importé attend votre confirmation 1 heure au plus.",
        example: "Restaurer la sauvegarde d'hier → les commandes saisies aujourd'hui disparaissent (elles restent dans l'instantané de sécurité).",
        caveats: "Les connecteurs (boutiques, transporteurs, Google Drive) devront être reconnectés.",
      },
      {
        definition: "يعوّض المعطيات الحالية بمعطيات ملف .asb.",
        calculation: "1) يُفحص الملف وتظهر معاينة؛ 2) تُنشأ لقطة أمان للمعطيات الحالية؛ 3) تُعوَّض الطلبات والمنتجات والمخزون والتوصيل والمالية في عملية واحدة (عند أي خطأ لا يتغيّر شيء). تُدمج حسابات المستخدمين ولا تُحذف أبدًا.",
        scope: "نسخة هذا الحساب فقط: الاسترجاع بين الحسابات غير متاح.",
        period: "ينتظر الملف المستورد تأكيدك لمدة ساعة 1 كحدّ أقصى.",
        example: "استرجاع نسخة الأمس ← تختفي الطلبات المُدخلة اليوم (وتبقى في لقطة الأمان).",
        caveats: "يجب إعادة ربط الموصّلات (المتاجر، شركات التوصيل، Google Drive).",
      }
    ),
  },
  safetySnapshots: {
    labels: ["Instantanés de sécurité (avant restauration)"],
    screens: ["sauvegarde"],
    source: "src/lib/backup/constants.ts — SAFETY_SNAPSHOT_TTL_MS",
    access: MANAGE,
    text: bi(
      {
        definition: "Les copies de vos données prises automatiquement juste avant chaque restauration.",
        calculation: "Les 5 plus récentes sont listées ; chacune reste téléchargeable 7 jours, puis « Expiré ».",
        example: "Restauration le 3 → instantané du 3 téléchargeable jusqu'au 10.",
      },
      {
        definition: "نسخ من معطياتك تُؤخذ تلقائيًا قبيل كل استرجاع.",
        calculation: "تُعرض أحدث 5 لقطات؛ وتبقى كل واحدة قابلة للتنزيل 7 أيام ثم تصبح « Expiré ».",
        example: "استرجاع يوم 3 ← لقطة يوم 3 قابلة للتنزيل حتى يوم 10.",
      }
    ),
  },
  googleDrive: {
    labels: ["Google Drive"],
    screens: ["sauvegarde"],
    source: "src/lib/backup/google-drive-service.ts",
    access: MANAGE,
    text: bi(
      {
        definition: "Une copie du même fichier chiffré .asb dans le Google Drive de votre entreprise.",
        calculation: "Après connexion, « Sauvegarder maintenant vers Google Drive » y envoie une sauvegarde ; la liste montre celles présentes, à télécharger, restaurer ou supprimer. Aucun envoi automatique planifié.",
        example: "3 sauvegardes sur Drive → 3 lignes avec date et taille.",
        caveats: "Connexion expirée ou révoquée : « Reconnecter » ; la base de données reste la source de vérité.",
      },
      {
        definition: "نسخة من ملف .asb المشفّر نفسه في Google Drive الخاص بمقاولتك.",
        calculation: "بعد الربط يرسل زر « Sauvegarder maintenant vers Google Drive » نسخة إليه؛ وتعرض اللائحة النسخ الموجودة للتنزيل أو الاسترجاع أو الحذف. لا يوجد إرسال تلقائي مُبرمج.",
        example: "3 نسخ في Drive ← 3 أسطر بالتاريخ والحجم.",
        caveats: "عند انتهاء الربط أو إلغائه: « Reconnecter »؛ وتبقى قاعدة المعطيات هي المصدر المرجعي.",
      }
    ),
  },
} satisfies Record<string, SettingDoc>;

export type SettingId = keyof typeof SETTINGS_EXPLANATIONS;

export const SETTING_IDS = Object.keys(SETTINGS_EXPLANATIONS) as SettingId[];
