# qb-banking

[![image.png](https://i.postimg.cc/PJPgsmB0/image.png)](https://postimg.cc/ctG9f81c)

سكربت بنك شامل لـ **QBCore** — يدمج البنك والـ ATM والحسابات المشتركة والتحويلات وتطبيق الجوال (lb-phone) كله في مورد واحد.

## ✨ المميزات

- **واجهة بنك** عصرية للـ NUI مع دعم الوضع الليلي
- **ATM** على جميع موديلات الصرافات في GTA V
- **حسابات مشتركة** (joint accounts) مع دعوات وإدارة أعضاء
- **تحويلات** بين اللاعبين بالـ ID أو citizen ID أو رقم الحساب
- **PIN** مُشفّر مع نظام lockout بعد عدة محاولات خاطئة
- **VIP Tiers** على أساس الرصيد الإجمالي
- **سجل المعاملات** مع فلترة وإحصاءات
- **Frozen balances** عند إغلاق الحساب
- **تطبيق جوال** متكامل مع lb-phone (مدمج بنفس المورد، لا يحتاج resource منفصل)
- **Auto-migration** من السكربتات القديمة (qoda_bank_*) بدون فقد بيانات

## 📦 المتطلبات

- `qb-core`
- `oxmysql`
- `ox_lib`
- `qb-target`
- `lb-phone` (اختياري، فقط إذا تبي تطبيق الجوال)

## 🚀 التثبيت

1. ضع المجلد `qb-banking` في مجلد resources الخاص بك.
2. أضف الترتيب التالي في `server.cfg`:

   ```
   ensure oxmysql
   ensure ox_lib
   ensure qb-core
   ensure qb-target
   ensure lb-phone
   ensure qb-banking
   ```

3. شغّل السيرفر — السكربت يُنشئ الجداول تلقائياً (لا تحتاج تنفيذ `sql/schema.sql` يدوياً).
4. لو عندك جداول قديمة باسم `qoda_bank_*` راح تنتقل تلقائياً مع الحفاظ على البيانات.

## ⚙️ الإعدادات

كل الإعدادات في ملف `config.lua` — مثل العملة، حدود الـ ATM، صلاحيات تطبيق الجوال، VIP tiers، إلخ.

## 📱 تطبيق الجوال

تطبيق Bank يظهر تلقائياً في lb-phone بعد التشغيل. لتجربته يدوياً اكتب في الشات:

```
/bankphone
```

## 🛠️ الأوامر

| الأمر         | الوصف                          |
| ------------- | ------------------------------ |
| `/qbbanking`  | فتح واجهة البنك (debug)        |
| `/qbatm`      | فتح واجهة الـ ATM (debug)      |
| `/bankphone`  | اختبار تطبيق الجوال            |
| `/phonebank`  | فتح البنك في وضع الجوال        |

## 📂 هيكل المشروع

```
qb-banking/
├── client/           # واجهة العميل (NUI bridge, ATM, target)
├── server/           # المنطق والقاعدة (database, callbacks, bootstrap)
├── shared/           # ملفات مشتركة (locale)
├── html/             # واجهة البنك الرئيسية
├── phone/            # تطبيق الجوال (lb-phone)
│   ├── client.lua
│   ├── server.lua
│   └── ui/
├── sql/              # schema (يُنفذ تلقائياً)
├── config.lua        # الإعدادات
└── fxmanifest.lua
```

## 📜 الحقوق

```
qb-banking — by Nerd
Developed & maintained by Nerd Studio
© Nerd 2026
```
