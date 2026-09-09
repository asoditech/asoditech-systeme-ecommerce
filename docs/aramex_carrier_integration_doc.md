# دليل تكامل Aramex — Carrier Integration Reference

> هذا المستند خاص **بشركة Aramex فقط** كأحد مزودي الشحن (Carriers) داخل منصة إدارة التجارة الإلكترونية.
> الهدف: تعريف الـ API، القدرات، القيود، وخريطة الحقول اللازمة لبناء `AramexCarrierAdapter`.

---

## 1. نظرة عامة

| العنصر | القيمة |
|---|---|
| اسم الشركة | Aramex |
| نوع API | SOAP (أساسي) + REST/JSON + REST/XML (متوفرين أيضاً) |
| البروتوكول | HTTPS (مشفّر) |
| المصادقة | Username/Password + Account Number/PIN/Entity/CountryCode (يُرسلوا مع كل Request، بدون OAuth أو Token) |
| Webhooks | **غير متوفرة** في هذا الإصدار — لا يوجد push notification، أي تحديث حالة لازم يكون عبر polling أو endpoint منفصل غير موثّق هنا |
| نظام التتبع (Tracking) | **غير مشمول** في Shipping Services API — Aramex عندها Tracking API منفصلة، خاص توثيقها بشكل مستقل إذا لزم |

---

## 2. البيئات (Environments)

```
Sandbox (Testing):
  https://ws.dev.aramex.net/shippingapi.v2/shipping/service_1_0.svc/json

Production (Live):
  https://ws.aramex.net/shippingapi.v2/shipping/service_1_0.svc/json
```

Testing credentials (لا تُستخدم في production):
```
AccountCountryCode: GB
AccountEntity: LON
AccountNumber: 102331
AccountPin: 321321
Username: testingapi@aramex.com
Password: R123456789$r
Version: v1
```

> ⚠️ للإنتاج الحقيقي بالمغرب: لازم تطلب من ممثل Aramex المغرب Account Number + PIN + Entity Code الخاص بالمغرب (مثال احتمالي: `CAS` للدار البيضاء — يجب التأكيد معهم).

---

## 3. العمليات المتاحة (Capabilities) وربطها بمفاهيم المنصة

| مفهوم المنصة | العملية عند Aramex | ملاحظات |
|---|---|---|
| **إنشاء طلبية شحن** (Order → Shipment) | `CreateShipments` | يُرجع AWB Number (رقم الشحنة) عند النجاح |
| **توليد الفاتورة/بوليصة الشحن** (Shipping Label) | `PrintLabel` (أو داخل نفس طلب `CreateShipments` عبر `LabelInfo`) | يُرجع إما URL لملف PDF أو Base64 stream حسب `ReportType` |
| **جدولة استلام من المخزن** (Pickup Request) | `CreatePickup` | اختياري — يُستخدم لو المنصة كتدير "اطلب استلام" بدل ما التاجر يوصل الطرد بنفسه |
| **إلغاء الاستلام** | `CancelPickup` | فقط إذا لم يُسند بعد لعامل توصيل |
| **جدولة توصيل بموقع دقيق** | `ScheduleDelivery` | حسب Longitude/Latitude، غير أساسي لمعظم المنصات |
| **حجز أرقام شحنات مسبقاً** | `ReserveShipmentNumberRange` | يُستخدم فقط لو التاجر يريد ترقيم يدوي مخصص |
| **الإحصائيات (Statistics/Dashboard)** | ⚠️ **لا يوجد endpoint مباشر** | يجب بناء الإحصائيات من داخل قاعدة بيانات المنصة نفسها (تخزين كل response من `CreateShipments`، الحالة، التكلفة...) — Aramex لا توفر تقارير جاهزة عبر هذه الـ API |
| **تتبع حالة الشحنة (Tracking)** | ⚠️ **غير مشمول في هذا الدليل** | يتطلب Tracking API منفصلة عند Aramex |

---

## 4. خريطة الحقول (Order → Aramex Shipment Mapping)

هذا الجدول أساسي لبناء دالة `mapOrderToAramexShipment()`:

| حقل عند المنصة (Order) | حقل Aramex | إلزامي؟ |
|---|---|---|
| `order.id` أو `order.reference` | `Shipment.Reference1` / `ForeignHAWB` | اختياري لكن **مستحسن جداً** للربط بين الطلبية والشحنة |
| `store.name`, `store.address`, `store.phone` | `Shipper.Contact`, `Shipper.PartyAddress` | ✅ إلزامي |
| `customer.name`, `customer.address`, `customer.phone`, `customer.email` | `Consignee.Contact`, `Consignee.PartyAddress` | ✅ إلزامي (PersonName, CompanyName, PhoneNumber1, CellPhone, EmailAddress) |
| `order.items.length` أو `package.count` | `Details.NumberOfPieces` | ✅ إلزامي |
| `order.totalWeightKg` | `Details.ActualWeight` | ✅ إلزامي |
| نوع الشحن (محلي/دولي) | `Details.ProductGroup` (`DOM`/`EXP`) | ✅ إلزامي |
| نوع الخدمة | `Details.ProductType` (راجع Appendix A بالدليل الأصلي) | ✅ إلزامي |
| من يدفع الشحن | `Details.PaymentType` (`P`/`C`/`3`) | ✅ إلزامي |
| وصف المنتجات | `Details.DescriptionOfGoods` | ✅ إلزامي |
| بلد المنشأ | `Details.GoodsOriginCountry` (`MA`) | ✅ إلزامي |
| قيمة الطلبية (لو دولي/جمركي) | `Details.CustomsValueAmount` | شرطي (Conditional) |
| مبلغ الدفع عند الاستلام (COD) | `Details.CashOnDeliveryAmount` + `Services: "CODS"` | شرطي |

---

## 5. الاستجابة (Response) وما يجب تخزينه في قاعدة البيانات

عند نجاح `CreateShipments`، الحقول المهمة لحفظها في `shipments` table:

```
- carrier: "aramex"
- carrier_shipment_id (AWB Number) -> ProcessedShipment.ID
- foreign_reference -> ProcessedShipment.Reference1
- has_errors -> boolean
- notifications -> array (للـ debugging والعرض للتاجر عند الخطأ)
- label_url -> ProcessedShipment.ShipmentLabel.LabelURL (إذا طُلب)
- raw_response -> JSON كامل (احتياطي لأي استخدام مستقبلي بما فيه الإحصائيات)
- created_at
```

بهذا الشكل، الإحصائيات (عدد الشحنات لكل شركة، معدل الأخطاء، إلخ) تُبنى من قاعدة بياناتك أنت، وليس من Aramex مباشرة.

---

## 6. رموز الأخطاء الأكثر شيوعاً (مرجع سريع)

| الكود | المعنى | الحل المقترح فالنظام |
|---|---|---|
| `REQ*` (REQ01-REQ44) | حقل إلزامي فارغ | validation قبل الإرسال — أرجع رسالة واضحة للتاجر |
| `ERR01` | Username/Password خاطئين | تحقق من الـ credentials فـ env vars |
| `ERR02`/`ERR03` | Account غير صالح/محظور | تواصل مع Aramex |
| `ERR30` | ForeignHAWB مكرر | تأكد أن `order.id` المُرسل فريد لكل شحنة |
| `ERR52` | خطأ فحل العنوان (Address) | تحقق من City/PostCode/CountryCode |
| `ERR38`/`ERR39` | التوقيت خارج ساعات العمل | فقط يخص Pickup requests |

(القائمة الكاملة موجودة فـ Appendix F من الدليل الأصلي، 61 كود مختلف)

---

## 7. قيود مهمة يجب مراعاتها فالتصميم

1. **لا يوجد Webhook** → إذا احتجت تحديث حالة الشحنة تلقائياً، لازم تبني polling job أو تستخدم Tracking API منفصلة (غير موثقة هنا).
2. **الحد الأقصى للمرفقات**: 2MB لكل ملف (Attachment).
3. **PaymentType = "3" (Third Party)** يتطلب حساب Aramex صالح للطرف الثالث بالكامل.
4. **Entity Code** يجب طلبه من Aramex مباشرة (ليس عاماً)، ويختلف حسب المدينة/الفرع.
5. **العملة**: الدليل لا يذكر MAD بشكل صريح فـ Appendix E — يجب التأكيد مع Aramex المغرب على العملة المدعومة للـ COD والـ Customs Value.

---

## 8. الخلاصة العملية

عند بناء `AramexCarrierAdapter` داخل النظام:
- Method `createShipment(order)` → تستخدم القسم 4 (Mapping) + تستدعي `CreateShipments`
- Method `getLabel(shipmentId)` → تستخدم `PrintLabel` أو تعتمد على الـ label المُرجع مباشرة عند الإنشاء
- Method `cancelShipment()` → **غير مدعومة مباشرة** لإلغاء شحنة مُنشأة (فقط `CancelPickup` لإلغاء طلب استلام قبل تعيين عامل)
- Method `trackShipment()` → **يجب تركها كـ "Not Implemented" أو ربطها بـ Tracking API منفصلة**
- كل الإحصائيات تُبنى من جدول `shipments` الداخلي، وليس من استدعاء مباشر لـ Aramex
