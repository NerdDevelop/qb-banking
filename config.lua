-- =====================================================
-- qb-banking  (شامل qb-banking-phone — All-in-one)
-- Author: Sultan
-- Banking script: ATM + Bank UI + Phone App في مورد واحد
-- =====================================================

Config = {}

-- =====================================================
-- PHONE INTEGRATION (qb-banking-phone — مدمج بنفس المورد)
-- =====================================================
Config.Phone = {
    enabled       = true,                    -- تفعيل تطبيق البنك في الجوال
    appName       = 'Bank',                  -- اسم التطبيق داخل الجوال
    appIcon       = 'nui://qb-banking/html/phone-icon.png',
    -- اختر نظام الجوال المستخدم في السيرفر — أو 'auto' للاكتشاف التلقائي
    -- 'auto' | 'qb-phone' | 'lb-phone' | 'gksphone' | 'roadphone' | 'yseries' | 'custom'
    framework     = 'auto',
    -- الحدث اللي يفتح واجهة الجوال (يستخدم نفس الـ UI ولكن بمود phone)
    openEvent     = 'qb-banking:phone:open',
    -- صلاحيات التطبيق داخل الجوال
    allowTransfer = true,
    allowDeposit  = false,                   -- ايداع من الجوال (مغلق افتراضياً)
    allowWithdraw = false,                   -- سحب من الجوال (مغلق افتراضياً)
    showHistory   = true,
    showInvites   = true,
    showJoint     = true,
}

-- =====================================================
-- GENERAL
-- =====================================================
Config.Locale          = 'en'                  -- 'en' only for now (locale file in shared/locale.lua)
Config.Currency        = '$'                   -- prefix shown in UI
Config.AccountPrefix   = ''                    -- e.g. 'QB-' to prepend account numbers (leave empty for plain digits)
Config.NewAccountFee   = 0                     -- cost (cash) to open a new account, set 0 to disable
Config.MaxAccountsPerPlayer = 5                -- limit individual+joint accounts owned by a single player
Config.JointMaxMembers      = 4                -- max members in a joint account (incl. owner)
Config.TransactionsHistory  = 50               -- how many transactions to return to UI

-- =====================================================
-- ATM (qb-target on the ATM model itself — all 4 GTA V ATM props)
-- =====================================================
Config.ATM = {
    models = {
        'prop_atm_01',     -- Fleeca interior ATM
        'prop_atm_02',     -- small standalone ATM
        'prop_atm_03',     -- large standalone ATM
        'prop_fleeca_atm', -- Fleeca exterior ATM
    },
    dailyWithdrawLimit  = 5000,  -- per account, set 0 for no limit
    quickBalanceEnabled = true,  -- show masked balance without password
    targetDistance      = 2.0,   -- qb-target focus distance
    icon                = 'fas fa-credit-card',
}

-- =====================================================
-- BANK BUILDINGS (full bank UI).
-- Coordinates copied 1:1 from the official qb-banking config:
--   https://github.com/qbcore-framework/qb-banking/blob/main/config.lua
-- (Config.LocationCoords) — these are the canonical teller positions
-- used by every standard QBCore server.
-- =====================================================
Config.BankLocations = {
    -- pacific  → Pacific Standard Bank (the famous heist bank)
    { id = 'pacific', coords = vec4(241.4,    226.59,  106.29, 158.0),
      length = 1.0, width = 1.0, label = 'Pacific Standard Bank' },

    -- fleeca1  → Fleeca Bank (Vinewood Blvd / Legion Square)
    { id = 'fleeca1', coords = vec4(314.18,  -278.62,   54.17, 339.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca2  → Fleeca Bank (Burton / Rockford Hills)
    { id = 'fleeca2', coords = vec4(-351.53,  -49.52,   49.04, 339.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca3  → Fleeca counter inside Pacific Standard
    { id = 'fleeca3', coords = vec4(241.71,   220.70,  106.28, 245.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca4  → Fleeca Bank (Hawick — Del Perro Blvd)
    { id = 'fleeca4', coords = vec4(-1212.98, -330.84,  37.78,  27.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca5  → Fleeca Bank (Banham Canyon / Great Ocean Hwy)
    { id = 'fleeca5', coords = vec4(-2962.58,  482.62,  15.70,  87.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca6  → Fleeca Bank (Paleto Bay)
    { id = 'fleeca6', coords = vec4(-112.20,  6469.29,  31.62, 135.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca7  → Fleeca Bank (Grapeseed)
    { id = 'fleeca7', coords = vec4(1175.06,  2706.67,  38.09,   0.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },

    -- fleeca8  → Fleeca Bank (Vespucci)
    { id = 'fleeca8', coords = vec4(149.446, -1041.370, 29.555, 340.0),
      length = 1.0, width = 1.0, label = 'Fleeca Bank' },
}
Config.BankBlip = {
    enabled = true,
    sprite  = 108,
    color   = 2,
    scale   = 0.7,
}

-- =====================================================
-- SECURITY
-- =====================================================
Config.Security = {
    pinLength       = 4,         -- 4-digit password
    maxAttempts     = 3,         -- attempts before lockout
    lockoutMinutes  = 5,         -- lockout duration
    transferCooldownMs = 1500,   -- per-player transfer rate-limit (anti spam)
}

-- =====================================================
-- JOINT ACCOUNT FEATURES (optional)
-- =====================================================
Config.JointFeatures = {
    splitExpenseEnabled = true,   -- enable the "Split Expense" feature on joint accounts
}

-- =====================================================
-- VIP TIERS — based on TOTAL balance across all accounts
-- =====================================================
Config.VipTiers = {
    -- Order matters: highest threshold first. The first match wins.
    { id = 'platinum', name = 'Platinum', minTotal = 10000000, atmBoost = 5.0, icon = 'fa-crown' },
    { id = 'gold',     name = 'Gold',     minTotal = 1000000,  atmBoost = 3.0, icon = 'fa-medal' },
    { id = 'silver',   name = 'Silver',   minTotal = 100000,   atmBoost = 2.0, icon = 'fa-award' },
    { id = 'bronze',   name = 'Bronze',   minTotal = 10000,    atmBoost = 1.5, icon = 'fa-shield-halved' },
    { id = 'standard', name = 'Standard', minTotal = 0,        atmBoost = 1.0, icon = 'fa-user' },
}

-- =====================================================
-- ADMIN
-- =====================================================
Config.AdminGroups = { 'admin', 'god' }   -- ace permissions / qb-core admin perms
