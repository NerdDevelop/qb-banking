-- =========================================================
-- qb-banking schema
-- Run this once on your MySQL database before starting the resource.
-- =========================================================

CREATE TABLE IF NOT EXISTS `qb_banking_accounts` (
    `id`             INT(11) NOT NULL AUTO_INCREMENT,
    `account_number` VARCHAR(20) NOT NULL UNIQUE,
    `name`           VARCHAR(48) NOT NULL DEFAULT 'Account',
    `type`           ENUM('individual','joint') NOT NULL DEFAULT 'individual',
    `owner_cid`      VARCHAR(50) NOT NULL,
    `pin_hash`       VARCHAR(128) NOT NULL,
    `pin_salt`       VARCHAR(32) NOT NULL,
    `balance`        BIGINT(20) NOT NULL DEFAULT 0,
    `frozen`         TINYINT(1) NOT NULL DEFAULT 0,
    `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_owner_cid` (`owner_cid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_members` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_transactions` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_lockouts` (
    `id`             INT(11) NOT NULL AUTO_INCREMENT,
    `citizenid`      VARCHAR(50) NOT NULL,
    `account_id`     INT(11) NOT NULL,
    `attempts`       TINYINT(4) NOT NULL DEFAULT 0,
    `locked_until`   DATETIME DEFAULT NULL,
    `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_cid_acc` (`citizenid`, `account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_invites` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_frozen` (
    `id`             INT(11) NOT NULL AUTO_INCREMENT,
    `citizenid`      VARCHAR(50) NOT NULL,
    `amount`         BIGINT(20) NOT NULL,
    `source_account` VARCHAR(20) NOT NULL DEFAULT '',
    `source_name`    VARCHAR(48) NOT NULL DEFAULT '',
    `source_type`    ENUM('individual','joint') NOT NULL DEFAULT 'individual',
    `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_cid` (`citizenid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_user_prefs` (
    `citizenid`           VARCHAR(50)  NOT NULL,
    `primary_account_id`  INT(11)      DEFAULT NULL,
    `updated_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`citizenid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- New optional columns added to qb_banking_accounts (icon, color, savings goal).
-- The resource auto-migrates these via ensureColumn() on startup, but the
-- canonical DDL is kept here for fresh installs:
--   ALTER TABLE `qb_banking_accounts`
--     ADD COLUMN `icon`              VARCHAR(40)   DEFAULT NULL,
--     ADD COLUMN `color`             VARCHAR(20)   DEFAULT NULL,
--     ADD COLUMN `goal_amount`       BIGINT(20)    DEFAULT NULL,
--     ADD COLUMN `goal_reached`      TINYINT(1)    NOT NULL DEFAULT 0,
--     ADD COLUMN `goal_acknowledged` TINYINT(1)    NOT NULL DEFAULT 0,
--     ADD COLUMN `pending_close_at`  DATETIME      DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `qb_banking_contacts` (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `qb_banking_atm_usage` (
    `id`             INT(11) NOT NULL AUTO_INCREMENT,
    `account_id`     INT(11) NOT NULL,
    `withdrawn_today` BIGINT(20) NOT NULL DEFAULT 0,
    `day`            DATE NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uniq_acc_day` (`account_id`, `day`),
    CONSTRAINT `fk_atm_account` FOREIGN KEY (`account_id`)
        REFERENCES `qb_banking_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
