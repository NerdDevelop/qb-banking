-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : DB bootstrap + migration from qoda_bank_*
-- Author: Sultan
-- يسوي:
--   1) ينقل الجداول القديمة qoda_bank_* الى qb_banking_* (لو موجودة)
--   2) ينشئ جداول qb_banking_* لو ما هي موجودة (نفس schema.sql)
-- يشتغل تلقائياً عند تشغيل المورد. ما يحتاج تشغيل schema.sql يدوياً.
-- =========================================================

local function tableExists(name)
    local row = MySQL.scalar.await(
        [[SELECT COUNT(*) FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?]], { name })
    return tonumber(row or 0) > 0
end

local function safeRename(oldName, newName)
    if tableExists(oldName) and not tableExists(newName) then
        local ok, err = pcall(function()
            MySQL.query.await(('RENAME TABLE `%s` TO `%s`'):format(oldName, newName))
        end)
        if ok then
            print(('^2[qb-banking]^7 migrated table %s -> %s'):format(oldName, newName))
        else
            print(('^1[qb-banking]^7 migrate %s failed: %s'):format(oldName, tostring(err)))
        end
    end
end

local function ensureSchema()
    -- 1) Migrate any legacy qoda_bank_* tables (preserve data)
    local pairsMap = {
        { 'qoda_bank_accounts',     'qb_banking_accounts'     },
        { 'qoda_bank_members',      'qb_banking_members'      },
        { 'qoda_bank_transactions', 'qb_banking_transactions' },
        { 'qoda_bank_lockouts',     'qb_banking_lockouts'     },
        { 'qoda_bank_invites',      'qb_banking_invites'      },
        { 'qoda_bank_frozen',       'qb_banking_frozen'       },
        { 'qoda_bank_user_prefs',   'qb_banking_user_prefs'   },
        { 'qoda_bank_contacts',     'qb_banking_contacts'     },
        { 'qoda_bank_atm_usage',    'qb_banking_atm_usage'    },
    }
    for _, p in ipairs(pairsMap) do safeRename(p[1], p[2]) end

    -- 2) CREATE TABLE IF NOT EXISTS — safe to re-run
    local ddl = {
        [[CREATE TABLE IF NOT EXISTS `qb_banking_accounts` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `account_number` VARCHAR(20) NOT NULL UNIQUE,
            `name`           VARCHAR(48) NOT NULL DEFAULT 'Account',
            `type`           ENUM('individual','joint') NOT NULL DEFAULT 'individual',
            `owner_cid`      VARCHAR(50) NOT NULL,
            `pin_hash`       VARCHAR(128) NOT NULL,
            `pin_salt`       VARCHAR(32) NOT NULL,
            `balance`        BIGINT(20) NOT NULL DEFAULT 0,
            `frozen`         TINYINT(1) NOT NULL DEFAULT 0,
            `icon`               VARCHAR(40)   DEFAULT NULL,
            `color`              VARCHAR(20)   DEFAULT NULL,
            `goal_amount`        BIGINT(20)    DEFAULT NULL,
            `goal_reached`       TINYINT(1)    NOT NULL DEFAULT 0,
            `goal_acknowledged`  TINYINT(1)    NOT NULL DEFAULT 0,
            `pending_close_at`   DATETIME      DEFAULT NULL,
            `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            INDEX `idx_owner_cid` (`owner_cid`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_members` (
            `id`           INT(11) NOT NULL AUTO_INCREMENT,
            `account_id`   INT(11) NOT NULL,
            `citizenid`    VARCHAR(50) NOT NULL,
            `role`         ENUM('owner','member') NOT NULL DEFAULT 'member',
            `joined_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_acc_cid` (`account_id`, `citizenid`),
            INDEX `idx_cid` (`citizenid`),
            CONSTRAINT `fk_member_account` FOREIGN KEY (`account_id`)
                REFERENCES `qb_banking_accounts` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_transactions` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `account_id`     INT(11) NOT NULL,
            `kind`           ENUM('deposit','withdraw','transfer_out','transfer_in','internal_in','internal_out','admin') NOT NULL,
            `amount`         BIGINT(20) NOT NULL,
            `balance_after`  BIGINT(20) NOT NULL,
            `actor_cid`      VARCHAR(50) NOT NULL,
            `target_label`   VARCHAR(96) NOT NULL DEFAULT '',
            `note`           VARCHAR(160) NOT NULL DEFAULT '',
            `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            INDEX `idx_account_time` (`account_id`, `created_at`),
            CONSTRAINT `fk_tx_account` FOREIGN KEY (`account_id`)
                REFERENCES `qb_banking_accounts` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_lockouts` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `citizenid`      VARCHAR(50) NOT NULL,
            `account_id`     INT(11) NOT NULL,
            `attempts`       TINYINT(4) NOT NULL DEFAULT 0,
            `locked_until`   DATETIME DEFAULT NULL,
            `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_cid_acc` (`citizenid`, `account_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_invites` (
            `id`           INT(11) NOT NULL AUTO_INCREMENT,
            `account_id`   INT(11) NOT NULL,
            `inviter_cid`  VARCHAR(50) NOT NULL,
            `target_cid`   VARCHAR(50) NOT NULL,
            `created_at`   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_acc_target` (`account_id`, `target_cid`),
            INDEX `idx_target` (`target_cid`),
            CONSTRAINT `fk_inv_account` FOREIGN KEY (`account_id`)
                REFERENCES `qb_banking_accounts` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_frozen` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `citizenid`      VARCHAR(50) NOT NULL,
            `amount`         BIGINT(20) NOT NULL,
            `source_account` VARCHAR(20) NOT NULL DEFAULT '',
            `source_name`    VARCHAR(48) NOT NULL DEFAULT '',
            `source_type`    ENUM('individual','joint') NOT NULL DEFAULT 'individual',
            `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            INDEX `idx_cid` (`citizenid`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_user_prefs` (
            `citizenid`           VARCHAR(50)  NOT NULL,
            `primary_account_id`  INT(11)      DEFAULT NULL,
            `updated_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`citizenid`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_contacts` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `owner_cid`      VARCHAR(50) NOT NULL,
            `target_cid`     VARCHAR(50) NOT NULL,
            `custom_label`   VARCHAR(48) DEFAULT NULL,
            `transfer_count` INT(11) NOT NULL DEFAULT 0,
            `last_used`      TIMESTAMP NULL DEFAULT NULL,
            `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_owner_target` (`owner_cid`, `target_cid`),
            INDEX `idx_owner` (`owner_cid`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],

        [[CREATE TABLE IF NOT EXISTS `qb_banking_atm_usage` (
            `id`             INT(11) NOT NULL AUTO_INCREMENT,
            `account_id`     INT(11) NOT NULL,
            `withdrawn_today` BIGINT(20) NOT NULL DEFAULT 0,
            `day`            DATE NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_acc_day` (`account_id`, `day`),
            CONSTRAINT `fk_atm_account` FOREIGN KEY (`account_id`)
                REFERENCES `qb_banking_accounts` (`id`) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]],
    }

    for _, sql in ipairs(ddl) do
        local ok, err = pcall(function() MySQL.query.await(sql) end)
        if not ok then
            print(('^1[qb-banking]^7 DDL error: %s'):format(tostring(err)))
        end
    end

    -- 3) ensure newly added optional columns on qb_banking_accounts exist
    --    (for old DBs that already had qb_banking_accounts but without these)
    local function ensureColumn(table_, col, def)
        local has = MySQL.scalar.await(
            [[SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?]],
            { table_, col })
        if (tonumber(has or 0) or 0) == 0 then
            local ok, err = pcall(function()
                MySQL.query.await(('ALTER TABLE `%s` ADD COLUMN `%s` %s'):format(table_, col, def))
            end)
            if ok then
                print(('^2[qb-banking]^7 added column %s.%s'):format(table_, col))
            end
        end
    end
    ensureColumn('qb_banking_accounts', 'icon',              'VARCHAR(40) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'color',             'VARCHAR(20) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'goal_amount',       'BIGINT(20) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'goal_reached',      'TINYINT(1) NOT NULL DEFAULT 0')
    ensureColumn('qb_banking_accounts', 'goal_acknowledged', 'TINYINT(1) NOT NULL DEFAULT 0')
    ensureColumn('qb_banking_accounts', 'pending_close_at',  'DATETIME DEFAULT NULL')

    print('^2[qb-banking]^7 schema bootstrap done')
end

-- =========================================================
-- Bootstrap launcher: يشتغل عند تحميل الملف مباشرة (مو من onResourceStart)
-- علشان يضمن إن الجداول موجودة قبل أي callback يحاول يكتب فيها.
-- =========================================================
local bootstrapped = false

local function runBootstrap()
    if bootstrapped then return end
    bootstrapped = true
    print('^3[qb-banking]^7 starting DB bootstrap…')
    local ok, err = pcall(ensureSchema)
    if not ok then
        print(('^1[qb-banking]^7 bootstrap FAILED: %s'):format(tostring(err)))
    end
end

-- 1) جرب إذا MySQL.ready موجود (oxmysql الحديث)
if MySQL and MySQL.ready then
    MySQL.ready(function()
        runBootstrap()
    end)
else
    -- 2) fallback — انتظر حتى يصير MySQL متاح
    CreateThread(function()
        local tries = 0
        while not (MySQL and MySQL.query and MySQL.query.await) do
            tries = tries + 1
            if tries > 100 then
                print('^1[qb-banking]^7 bootstrap timeout — MySQL not ready after 10s')
                return
            end
            Wait(100)
        end
        runBootstrap()
    end)
end

-- 3) تأمين إضافي: لو شي فشل في الحالتين فوق، احتياطياً حاول مرة ثانية بعد 3 ثوان
CreateThread(function()
    Wait(3000)
    runBootstrap()
end)
