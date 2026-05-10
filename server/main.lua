-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : server entry
-- =========================================================
local QBCore = exports['qb-core']:GetCoreObject()

-- ---------------------- helpers ----------------------------------------

local lastTransfer = {} -- src -> ms (rate-limit)

-- Some QB-Core forks have removed Player.Functions.AddMoney (only RemoveMoney /
-- SetMoney / GetMoney remain). Use this safe helper everywhere — it works on
-- vanilla qb-core, on stripped forks, and even falls back to SetMoney if the
-- player object lacks AddMoney entirely.
local function safeAddMoney(Player, mtype, amount, reason)
    if not Player or not amount or amount <= 0 then return false end
    local fns = Player.Functions
    if fns.AddMoney then
        return fns.AddMoney(mtype, amount, reason or 'qb-banking')
    end
    if fns.SetMoney and fns.GetMoney then
        local cur = fns.GetMoney(mtype) or 0
        return fns.SetMoney(mtype, cur + amount, reason or 'qb-banking')
    end
    print(('^1[qb-banking]^7 No AddMoney/SetMoney function on Player — qb-core fork is broken.'))
    return false
end

local function safeRemoveMoney(Player, mtype, amount, reason)
    if not Player or not amount or amount <= 0 then return false end
    local fns = Player.Functions
    if fns.RemoveMoney then
        return fns.RemoveMoney(mtype, amount, reason or 'qb-banking')
    end
    if fns.SetMoney and fns.GetMoney then
        local cur = fns.GetMoney(mtype) or 0
        if cur < amount then return false end
        return fns.SetMoney(mtype, cur - amount, reason or 'qb-banking')
    end
    return false
end

-- Single notification path → uses the in-house notify script
-- (event: notifications:sendNotification, params: color, message, time).
-- color: 'success' | 'error' | 'primary' (= warning)
local function notify(src, msg, kind)
    local color = 'primary'
    if kind == 'success' then color = 'success'
    elseif kind == 'error' then color = 'error' end
    TriggerClientEvent('notifications:sendNotification', src, color, msg, 4500)
end

local function notifyByCid(cid, msg, kind)
    local Player = QBCore.Functions.GetPlayerByCitizenId(cid)
    if Player then notify(Player.PlayerData.source, msg, kind) end
end

-- Live refresh: tells a client's open UIs (NUI bank + LB phone app) to
-- re-fetch their snapshot. Called whenever something happens that changes
-- the player's data from OUTSIDE their own action (incoming transfer,
-- joint-account activity, invite received, member removed, etc.).
local function pushRefresh(src)
    if not src then return end
    TriggerClientEvent('qb-banking:liveRefresh', src)
end

local function pushRefreshByCid(cid)
    if not cid then return end
    local Player = QBCore.Functions.GetPlayerByCitizenId(cid)
    if Player then pushRefresh(Player.PlayerData.source) end
end

-- Refresh every joint-account member except the actor themselves.
local function pushRefreshJointMembers(accountId, exceptCid)
    if not accountId then return end
    for _, m in ipairs(DB.getMembers(accountId) or {}) do
        if m.citizenid ~= exceptCid then
            pushRefreshByCid(m.citizenid)
        end
    end
end

-- Register a callback that's reachable via BOTH QBCore.Functions.TriggerCallback
-- and ox_lib's lib.callback. Handler signature: function(source, payload) -> result
-- Errors are caught with full traceback so the actual cause shows in console.
local function registerCallback(name, handler)
    local function safeRun(source, payload)
        local result
        local function run() result = handler(source, payload) end
        local ok, err = xpcall(run, debug.traceback)
        if not ok then
            print(('^1[qb-banking]^7 callback %s threw:\n%s'):format(name, tostring(err)))
            return { ok = false, err = 'server_error', detail = tostring(err) }
        end
        return result
    end

    QBCore.Functions.CreateCallback(name, function(source, cb, payload)
        cb(safeRun(source, payload))
    end)

    if lib and lib.callback and lib.callback.register then
        lib.callback.register(name, function(source, payload)
            return safeRun(source, payload)
        end)
    end
end

local function getCid(src)
    local Player = QBCore.Functions.GetPlayer(src)
    return Player and Player.PlayerData.citizenid
end


local function getPlayerLabel(cid)
    if not cid then return 'unknown' end
    local Player = QBCore.Functions.GetPlayerByCitizenId(cid)
    if Player and Player.PlayerData and Player.PlayerData.charinfo then
        local ci = Player.PlayerData.charinfo
        return ('%s %s'):format(ci.firstname or '', ci.lastname or '')
    end
    -- offline: best-effort
    local ok, row = pcall(MySQL.single.await,
        'SELECT charinfo FROM players WHERE citizenid = ? LIMIT 1', { cid }
    )
    if ok and row and row.charinfo then
        local ok2, info = pcall(json.decode, row.charinfo)
        if ok2 and info then
            return ('%s %s'):format(info.firstname or '', info.lastname or '')
        end
    end
    return cid
end

local function validatePin(pin)
    if type(pin) ~= 'string' then return false end
    if #pin ~= Config.Security.pinLength then return false end
    return pin:match('^%d+$') ~= nil
end

-- Convert oxmysql DATETIME field (which can be string OR numeric timestamp,
-- depending on driver version / config) into a Unix timestamp in seconds.
local function parseDbTime(v)
    if not v then return 0 end
    local t = type(v)
    if t == 'number' then
        -- Some drivers return ms timestamps (>10^12); normalize to seconds.
        return v > 1e12 and math.floor(v / 1000) or v
    end
    if t == 'string' then
        local y, mo, d, h, mi, s = v:match('(%d+)-(%d+)-(%d+)[ Tt](%d+):(%d+):(%d+)')
        if not y then return 0 end
        return os.time({
            year=tonumber(y), month=tonumber(mo), day=tonumber(d),
            hour=tonumber(h), min=tonumber(mi), sec=tonumber(s),
        })
    end
    return 0
end

local function isLocked(account, cid)
    local lk = DB.getLockout(account.id, cid)
    if type(lk) ~= 'table' or not lk.locked_until then return false end
    local until_ts = parseDbTime(lk.locked_until)
    if until_ts > os.time() then
        return math.ceil((until_ts - os.time()) / 60)
    end
    return false
end

local function authorize(src, accountId, pin)
    local cid = getCid(src)
    if not cid then return false, 'no_player' end

    local account = DB.getAccountById(accountId)
    if not account then return false, 'invalid_account' end
    if account.frozen == 1 then return false, 'frozen' end

    if not DB.isMember(account.id, cid) then return false, 'invalid_account' end

    local mins = isLocked(account, cid)
    if mins then return false, 'locked', mins end

    if not validatePin(pin) then return false, 'pin_format' end

    if not DB.verifyPin(account, pin) then
        local attempts, lockedUntil = DB.recordFailedAttempt(account.id, cid)
        return false, lockedUntil and 'locked_now' or 'invalid_pin', attempts
    end

    -- success: clear lockouts
    DB.clearLockout(account.id, cid)
    return true, nil, account
end

local function safeAccountForUI(acc, members, myRole)
    return {
        id            = acc.id,
        accountNumber = acc.account_number,
        name          = acc.name,
        type          = acc.type,
        balance       = acc.balance,
        frozen        = acc.frozen == 1,
        ownerCid      = acc.owner_cid,
        myRole        = myRole or 'owner',
        members       = members,
    }
end

-- Compute tier for a citizen. Counts ONLY money inside bank accounts —
-- cash on hand is intentionally excluded so the tier rewards keeping money
-- in the bank, not just being a wallet carrier.
local function computeTier(cid)
    local bankTotal = tonumber(MySQL.scalar.await([[
        SELECT COALESCE(SUM(a.balance), 0)
        FROM qb_banking_accounts a
        INNER JOIN qb_banking_members m ON m.account_id = a.id
        WHERE m.citizenid = ?
    ]], { cid })) or 0

    local total = bankTotal

    -- Find current tier (first match wins; tiers are sorted highest-first)
    local current, currentIdx
    for i, t in ipairs(Config.VipTiers) do
        if total >= t.minTotal then current = t; currentIdx = i; break end
    end
    if not current then
        current = { id = 'standard', name = 'Standard', icon = 'fa-user', atmBoost = 1.0, minTotal = 0 }
        currentIdx = #Config.VipTiers
    end

    -- Next tier is the one ABOVE this in the list (lower index = higher tier)
    local nextTier = currentIdx and Config.VipTiers[currentIdx - 1] or nil

    return {
        id        = current.id,
        name      = current.name,
        icon      = current.icon,
        atmBoost  = current.atmBoost,
        minTotal  = current.minTotal,
        total     = total,
        bank      = bankTotal,
        nextId    = nextTier and nextTier.id    or nil,
        nextName  = nextTier and nextTier.name  or nil,
        nextMin   = nextTier and nextTier.minTotal or nil,
    }
end

local function getVipBoostedDailyLimit(cid)
    local base = Config.ATM.dailyWithdrawLimit or 0
    if base <= 0 then return 0 end
    local tier = computeTier(cid)
    return math.floor(base * (tier.atmBoost or 1))
end

local function listAccountsPayload(cid)
    local rows = DB.listAccountsForCitizen(cid)
    local prefs = DB.getUserPrefs(cid)
    local primaryId = prefs and prefs.primary_account_id or nil
    local out = {}
    for i = 1, #rows do
        local r = rows[i]
        local members
        if r.type == 'joint' then
            local m = DB.getMembers(r.id)
            members = {}
            for _, mm in ipairs(m) do
                members[#members + 1] = {
                    citizenid = mm.citizenid,
                    role      = mm.role,
                    label     = getPlayerLabel(mm.citizenid),
                }
            end
        end
        local payload = safeAccountForUI(r, members, r.my_role)
        payload.icon            = r.icon
        payload.color           = r.color
        payload.isPrimary       = (primaryId == r.id)
        payload.goalAmount      = r.goal_amount
        payload.goalReached     = (r.goal_reached or 0) == 1
        payload.goalAcknowledged= (r.goal_acknowledged or 0) == 1
        out[#out + 1] = payload
    end
    -- sort: primary first, then by id ASC
    table.sort(out, function(a, b)
        if a.isPrimary ~= b.isPrimary then return a.isPrimary end
        return a.id < b.id
    end)
    return out
end

-- ---------------------- bootstrap ---------------------------------------

-- ----------------------- schema migration helpers ----------------------
local function ensureColumn(tbl, column, ddl)
    local ok, exists = pcall(function()
        return tonumber(MySQL.scalar.await([[
            SELECT COUNT(*) FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
        ]], { tbl, column })) or 0
    end)
    if not ok then return end
    if (exists or 0) == 0 then
        local q = ('ALTER TABLE `%s` ADD COLUMN %s'):format(tbl, ddl)
        MySQL.update.await(q)
        print(('^2[qb-banking]^7 migration: added %s.%s'):format(tbl, column))
    end
end

local function ensureTable(tbl, ddl)
    local ok, exists = pcall(function()
        return tonumber(MySQL.scalar.await([[
            SELECT COUNT(*) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ]], { tbl })) or 0
    end)
    if not ok then return end
    if (exists or 0) == 0 then
        MySQL.update.await(ddl)
        print(('^2[qb-banking]^7 migration: created table %s'):format(tbl))
    end
end

CreateThread(function()
    Wait(500)
    -- run migrations first (idempotent)
    -- Core tables (originally created via schema.sql; migrations make sure
    -- they exist even on installs where the SQL was never run manually)
    ensureTable('qb_banking_accounts', [[
        CREATE TABLE qb_banking_accounts (
            id             INT(11) NOT NULL AUTO_INCREMENT,
            account_number VARCHAR(20) NOT NULL UNIQUE,
            name           VARCHAR(48) NOT NULL DEFAULT 'Account',
            type           ENUM('individual','joint') NOT NULL DEFAULT 'individual',
            owner_cid      VARCHAR(50) NOT NULL,
            pin_hash       VARCHAR(128) NOT NULL,
            pin_salt       VARCHAR(32) NOT NULL,
            balance        BIGINT(20) NOT NULL DEFAULT 0,
            frozen         TINYINT(1) NOT NULL DEFAULT 0,
            created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id), INDEX idx_owner_cid (owner_cid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_members', [[
        CREATE TABLE qb_banking_members (
            id         INT(11) NOT NULL AUTO_INCREMENT,
            account_id INT(11) NOT NULL,
            citizenid  VARCHAR(50) NOT NULL,
            role       ENUM('owner','member') NOT NULL DEFAULT 'member',
            joined_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_acc_cid (account_id, citizenid),
            INDEX idx_cid (citizenid),
            CONSTRAINT fk_member_account FOREIGN KEY (account_id) REFERENCES qb_banking_accounts (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_transactions', [[
        CREATE TABLE qb_banking_transactions (
            id            INT(11) NOT NULL AUTO_INCREMENT,
            account_id    INT(11) NOT NULL,
            kind          ENUM('deposit','withdraw','transfer_out','transfer_in','internal_in','internal_out','admin') NOT NULL,
            amount        BIGINT(20) NOT NULL,
            balance_after BIGINT(20) NOT NULL,
            actor_cid     VARCHAR(50) NOT NULL,
            target_label  VARCHAR(96) NOT NULL DEFAULT '',
            note          VARCHAR(160) NOT NULL DEFAULT '',
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            INDEX idx_account_time (account_id, created_at),
            CONSTRAINT fk_tx_account FOREIGN KEY (account_id) REFERENCES qb_banking_accounts (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_lockouts', [[
        CREATE TABLE qb_banking_lockouts (
            id           INT(11) NOT NULL AUTO_INCREMENT,
            citizenid    VARCHAR(50) NOT NULL,
            account_id   INT(11) NOT NULL,
            attempts     TINYINT(4) NOT NULL DEFAULT 0,
            locked_until DATETIME DEFAULT NULL,
            updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id), UNIQUE KEY uniq_cid_acc (citizenid, account_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_invites', [[
        CREATE TABLE qb_banking_invites (
            id           INT(11) NOT NULL AUTO_INCREMENT,
            account_id   INT(11) NOT NULL,
            inviter_cid  VARCHAR(50) NOT NULL,
            target_cid   VARCHAR(50) NOT NULL,
            created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_acc_target (account_id, target_cid),
            INDEX idx_target (target_cid),
            CONSTRAINT fk_inv_account FOREIGN KEY (account_id) REFERENCES qb_banking_accounts (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_atm_usage', [[
        CREATE TABLE qb_banking_atm_usage (
            id              INT(11) NOT NULL AUTO_INCREMENT,
            account_id      INT(11) NOT NULL,
            withdrawn_today BIGINT(20) NOT NULL DEFAULT 0,
            day             DATE NOT NULL,
            PRIMARY KEY (id), UNIQUE KEY uniq_acc_day (account_id, day),
            CONSTRAINT fk_atm_account FOREIGN KEY (account_id) REFERENCES qb_banking_accounts (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_frozen', [[
        CREATE TABLE qb_banking_frozen (
            id             INT(11) NOT NULL AUTO_INCREMENT,
            citizenid      VARCHAR(50) NOT NULL,
            amount         BIGINT(20) NOT NULL,
            source_account VARCHAR(20) NOT NULL DEFAULT '',
            source_name    VARCHAR(48) NOT NULL DEFAULT '',
            source_type    ENUM('individual','joint') NOT NULL DEFAULT 'individual',
            created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id), INDEX idx_cid (citizenid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_user_prefs', [[
        CREATE TABLE qb_banking_user_prefs (
            citizenid          VARCHAR(50) NOT NULL,
            primary_account_id INT(11) DEFAULT NULL,
            updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (citizenid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureTable('qb_banking_contacts', [[
        CREATE TABLE qb_banking_contacts (
            id             INT(11) NOT NULL AUTO_INCREMENT,
            owner_cid      VARCHAR(50) NOT NULL,
            target_cid     VARCHAR(50) NOT NULL,
            custom_label   VARCHAR(48) DEFAULT NULL,
            transfer_count INT(11) NOT NULL DEFAULT 0,
            last_used      TIMESTAMP NULL DEFAULT NULL,
            created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_owner_target (owner_cid, target_cid),
            INDEX idx_owner (owner_cid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ]])
    ensureColumn('qb_banking_accounts', 'icon',              '`icon` VARCHAR(40) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'color',             '`color` VARCHAR(20) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'goal_amount',       '`goal_amount` BIGINT(20) DEFAULT NULL')
    ensureColumn('qb_banking_accounts', 'goal_reached',      '`goal_reached` TINYINT(1) NOT NULL DEFAULT 0')
    ensureColumn('qb_banking_accounts', 'goal_acknowledged', '`goal_acknowledged` TINYINT(1) NOT NULL DEFAULT 0')
    ensureColumn('qb_banking_accounts', 'pending_close_at',  '`pending_close_at` DATETIME DEFAULT NULL')

    local required = {
        'qb_banking_accounts',
        'qb_banking_members',
        'qb_banking_transactions',
        'qb_banking_lockouts',
        'qb_banking_invites',
        'qb_banking_atm_usage',
        'qb_banking_frozen',
        'qb_banking_user_prefs',
    }
    local missing = {}
    for _, t in ipairs(required) do
        local ok = pcall(function()
            MySQL.scalar.await('SELECT 1 FROM ' .. t .. ' LIMIT 1')
        end)
        if not ok then missing[#missing + 1] = t end
    end
    if #missing > 0 then
        print(('^1[qb-banking]^7 Missing tables: %s'):format(table.concat(missing, ', ')))
        print('^1[qb-banking]^7 Please run sql/schema.sql on your database before using this resource.')
    else
        local accCount = MySQL.scalar.await('SELECT COUNT(*) FROM qb_banking_accounts') or 0
        print(('^2[qb-banking]^7 ready — %d account(s) in database.'):format(accCount))
    end
end)

-- ---------------------- callbacks ---------------------------------------
-- Reachable via BOTH QBCore native and ox_lib callbacks.

registerCallback('qb-banking:getAccounts', function(source)
    local cid = getCid(source); if not cid then return {} end
    return listAccountsPayload(cid)
end)

registerCallback('qb-banking:getVipTier', function(source)
    local cid = getCid(source); if not cid then return nil end
    return computeTier(cid)
end)


-- ===================== CONTACTS =====================

registerCallback('qb-banking:getContacts', function(source)
    local cid = getCid(source); if not cid then return {} end
    local rows = DB.listContacts(cid)
    -- Enrich with player names so the UI can show readable labels
    for i = 1, #rows do
        rows[i].label = rows[i].custom_label and rows[i].custom_label ~= ''
            and rows[i].custom_label
            or getPlayerLabel(rows[i].target_cid)
    end
    return rows
end)

registerCallback('qb-banking:renameContact', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local id    = tonumber(payload and payload.contactId)
    local label = (payload and payload.label or ''):sub(1, 48)
    if not id then return { ok = false, err = 'invalid' } end
    DB.renameContact(cid, id, label ~= '' and label or nil)
    return { ok = true }
end)

registerCallback('qb-banking:removeContact', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local id = tonumber(payload and payload.contactId)
    if not id then return { ok = false, err = 'invalid' } end
    DB.removeContact(cid, id)
    return { ok = true }
end)

-- ===================== JOINT EXPENSE SPLITTER =====================
-- Owner of a joint account triggers a split: each member's PRIMARY account
-- is charged an equal share of the total amount, and the joint account is
-- credited with the full amount. If any member's primary lacks funds, the
-- whole operation is rolled back atomically.
registerCallback('qb-banking:splitExpense', function(source, payload)
    if not (Config.JointFeatures and Config.JointFeatures.splitExpenseEnabled) then
        return { ok = false, err = 'unauthorized' }
    end
    local cid = getCid(source); if not cid then return { ok = false, err = 'no_player' } end
    local accId  = tonumber(payload and payload.accountId)
    local amount = math.floor(tonumber(payload and payload.amount) or 0)
    local desc   = (payload and payload.description or 'Split expense'):sub(1, 80)
    if not accId or amount <= 0 then return { ok = false, err = 'invalid_amount' } end

    local acc = DB.getAccountById(accId)
    if not acc or acc.type ~= 'joint' then return { ok = false, err = 'invalid_account' } end
    if acc.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end

    local members = DB.getMembers(acc.id)
    if not members or #members == 0 then return { ok = false, err = 'invalid' } end

    -- equal split (with remainder going to the owner so totals always match)
    local share = math.floor(amount / #members)
    local remainder = amount - (share * #members)

    -- Pre-flight check: each member's primary has enough balance
    local plan = {}     -- list of { cid, accountId, name, amount }
    for _, m in ipairs(members) do
        local prefs = DB.getUserPrefs(m.citizenid)
        local primaryId = prefs and prefs.primary_account_id
        local primary = primaryId and DB.getAccountById(primaryId) or nil
        if not primary or primary.frozen == 1 then
            -- fall back to their first owned individual account
            local rows = DB.listAccountsForCitizen(m.citizenid)
            for _, r in ipairs(rows) do
                if r.type == 'individual' and r.owner_cid == m.citizenid and r.frozen ~= 1 then
                    primary = r; break
                end
            end
        end
        if not primary then
            return { ok = false, err = 'invalid_target',
                     detail = ('Member %s has no usable primary account'):format(getPlayerLabel(m.citizenid)) }
        end
        local memberShare = share + (m.role == 'owner' and remainder or 0)
        if (primary.balance or 0) < memberShare then
            return { ok = false, err = 'no_balance',
                     detail = ('Member %s has $%s but needs $%s'):format(
                                  getPlayerLabel(m.citizenid), primary.balance or 0, memberShare) }
        end
        plan[#plan + 1] = {
            cid = m.citizenid, accountId = primary.id,
            accountName = primary.name, amount = memberShare,
        }
    end

    -- Execute: debit each member's primary, then credit joint with the total
    local debited = {}
    local rollback = function()
        for _, d in ipairs(debited) do DB.adjustBalance(d.accountId, d.amount) end
    end
    for _, p in ipairs(plan) do
        local newBal, derr = DB.adjustBalance(p.accountId, -p.amount)
        if not newBal then rollback(); return { ok = false, err = derr or 'no_balance' } end
        debited[#debited + 1] = p
        DB.logTransaction(p.accountId, 'transfer_out', p.amount, newBal,
            cid, ('Split: %s → %s'):format(desc, acc.account_number), '')
    end
    local newJointBal = DB.adjustBalance(acc.id, amount)
    if not newJointBal then rollback(); return { ok = false, err = 'frozen' } end
    DB.logTransaction(acc.id, 'transfer_in', amount, newJointBal,
        cid, ('Split: %s'):format(desc), ('Equal split among %d members'):format(#members))

    -- notify everyone involved
    for _, p in ipairs(plan) do
        local label = (p.cid == cid) and 'You' or getPlayerLabel(p.cid)
        notifyByCid(p.cid, ('%s contributed %s%s for "%s" to %s'):format(
            label, Config.Currency, p.amount, desc, acc.name), 'inform')
    end

    return { ok = true, perMember = share, remainder = remainder, total = amount, members = #members }
end)

registerCallback('qb-banking:getInvites', function(source)
    local cid = getCid(source); if not cid then return {} end
    return DB.getInvitesForCid(cid)
end)

registerCallback('qb-banking:getTransactions', function(source, payload)
    local cid = getCid(source); if not cid then return {} end
    local accountId = type(payload) == 'table' and tonumber(payload.accountId) or tonumber(payload)
    if not accountId or not DB.isMember(accountId, cid) then return {} end
    return DB.getTransactions(accountId, Config.TransactionsHistory)
end)

-- ATM step-2: explicit pin verification so we can show error before
-- moving to the operations screen. Counts toward lockout like any other auth.
registerCallback('qb-banking:verifyPin', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false, err = 'no_player' } end
    local ok, err, accOrAttempts = authorize(source, payload.accountId, payload.pin)
    if not ok then return { ok = false, err = err, attempts = accOrAttempts } end
    local account = accOrAttempts
    return { ok = true, balance = account.balance, name = account.name, accountNumber = account.account_number }
end)

registerCallback('qb-banking:quickBalance', function(source, payload)
    if not Config.ATM.quickBalanceEnabled then return nil end
    local accountNumber = type(payload) == 'table' and tostring(payload.accountNumber or '') or tostring(payload or '')
    local acc = DB.getAccountByNumber(accountNumber)
    if not acc then return nil end
    -- only return masked balance and last 4 digits — no auth required
    local lastFour = (acc.account_number:gsub('[^%d]', '')):sub(-4)
    return {
        accountNumber = '••••-••••-' .. lastFour,
        name          = acc.name,
        balance       = acc.balance,
    }
end)

-- create new account: cost = Config.NewAccountFee from cash
registerCallback('qb-banking:createAccount', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then
        print(('^1[qb-banking]^7 createAccount: no player for source %s'):format(source))
        return { ok = false, err = 'no_player' }
    end
    local cid = Player.PlayerData.citizenid
    payload = payload or {}

    print(('^3[qb-banking]^7 createAccount request: cid=%s name=%s type=%s pinLen=%s'):format(
        cid,
        tostring(payload.name),
        tostring(payload.type),
        payload.pin and #payload.pin or 0
    ))

    if not validatePin(payload.pin) then
        print('^1[qb-banking]^7 createAccount rejected: pin_format')
        return { ok = false, err = 'pin_format' }
    end
    local accountType = payload.type == 'joint' and 'joint' or 'individual'
    local name = (payload.name and #payload.name > 0) and payload.name:sub(1, 48) or 'Account'

    local owned = DB.countAccountsForOwner(cid)
    if owned >= Config.MaxAccountsPerPlayer then
        print(('^1[qb-banking]^7 createAccount rejected: max_accounts (%d/%d)'):format(owned, Config.MaxAccountsPerPlayer))
        return { ok = false, err = 'max_accounts' }
    end

    if Config.NewAccountFee > 0 then
        local cash = (Player.PlayerData.money and Player.PlayerData.money.cash) or 0
        if cash < Config.NewAccountFee then
            print(('^1[qb-banking]^7 createAccount rejected: no_money (have %d, need %d)'):format(cash, Config.NewAccountFee))
            return { ok = false, err = 'no_money' }
        end
        if not safeRemoveMoney(Player, 'cash', Config.NewAccountFee, 'qb-banking: new account') then
            print('^1[qb-banking]^7 createAccount rejected: safeRemoveMoney failed')
            return { ok = false, err = 'no_money' }
        end
    end

    local acc = DB.createAccount({
        name     = name,
        type     = accountType,
        ownerCid = cid,
        pin      = payload.pin,
    })
    if not acc then
        print('^1[qb-banking]^7 createAccount: DB.createAccount returned nil — see prior DB error')
        -- refund the fee if we charged it
        if Config.NewAccountFee > 0 then
            safeAddMoney(Player, 'cash', Config.NewAccountFee, 'qb-banking: new account refund')
        end
        return { ok = false, err = 'unknown' }
    end

    DB.logTransaction(acc.id, 'admin', 0, 0, cid, 'system', 'Account opened')
    notify(source, Locale.ok_account_created, 'success')
    return { ok = true, accountId = acc.id }
end)

-- change pin
registerCallback('qb-banking:changePin', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local ok, err, accOrAttempts = authorize(source, payload.accountId, payload.oldPin)
    if not ok then return { ok = false, err = err, attempts = accOrAttempts } end
    if not validatePin(payload.newPin) then return { ok = false, err = 'pin_format' } end
    DB.changePin(payload.accountId, payload.newPin)
    notify(source, Locale.ok_pin_changed, 'success')
    return { ok = true }
end)

-- deposit (cash -> account)
registerCallback('qb-banking:deposit', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then return { ok = false, err = 'no_player' } end
    local cid = Player.PlayerData.citizenid

    local amount = tonumber(payload.amount)
    if not amount or amount <= 0 then return { ok = false, err = 'invalid_amount' } end
    amount = math.floor(amount)

    -- ATM mode requires PIN auth; bank mode: only members may deposit
    if payload.mode == 'atm' then
        local ok, err = authorize(source, payload.accountId, payload.pin)
        if not ok then return { ok = false, err = err } end
    else
        if not DB.isMember(payload.accountId, cid) then return { ok = false, err = 'invalid_account' } end
    end

    if (Player.PlayerData.money.cash or 0) < amount then
        return { ok = false, err = 'no_money' }
    end
    if not safeRemoveMoney(Player, 'cash', amount, 'qb-banking: deposit') then
        return { ok = false, err = 'no_money' }
    end

    local newBal = DB.adjustBalance(payload.accountId, amount)
    if not newBal then
        safeAddMoney(Player, 'cash', amount, 'qb-banking: deposit refund')
        return { ok = false, err = 'frozen' }
    end

    DB.logTransaction(payload.accountId, 'deposit', amount, newBal, cid, 'self', payload.note or '')
    notify(source, Locale.ok_deposit:format(amount, Config.Currency), 'success')

    -- notify other joint members + push live refresh so their open UIs update
    local acc = DB.getAccountById(payload.accountId)
    if acc and acc.type == 'joint' then
        for _, m in ipairs(DB.getMembers(payload.accountId)) do
            if m.citizenid ~= cid then
                notifyByCid(m.citizenid, ('Joint %s: %s deposited %s%s')
                    :format(acc.name, getPlayerLabel(cid), Config.Currency, amount), 'inform')
            end
        end
        pushRefreshJointMembers(payload.accountId, cid)
    end

    return { ok = true, balance = newBal }
end)

-- withdraw (account -> cash)
registerCallback('qb-banking:withdraw', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then return { ok = false, err = 'no_player' } end
    local cid = Player.PlayerData.citizenid

    local amount = tonumber(payload.amount)
    if not amount or amount <= 0 then return { ok = false, err = 'invalid_amount' } end
    amount = math.floor(amount)

    -- always require PIN auth for withdraws
    local ok, err, accOrAttempts = authorize(source, payload.accountId, payload.pin)
    if not ok then return { ok = false, err = err, attempts = accOrAttempts } end
    local account = accOrAttempts -- on success, third return is account row

    -- ATM daily cap (boosted by VIP tier)
    if payload.mode == 'atm' and Config.ATM.dailyWithdrawLimit > 0 then
        local boostedLimit = getVipBoostedDailyLimit(cid)
        local taken = DB.getDailyWithdrawn(payload.accountId)
        if taken + amount > boostedLimit then
            return { ok = false, err = 'daily_limit', remaining = math.max(0, boostedLimit - taken) }
        end
    end

    local newBal, derr = DB.adjustBalance(payload.accountId, -amount)
    if not newBal then return { ok = false, err = derr or 'no_balance' } end

    if not safeAddMoney(Player, 'cash', amount, 'qb-banking: withdraw') then
        -- couldn't credit cash, undo the bank debit so we never lose money
        DB.adjustBalance(payload.accountId, amount)
        return { ok = false, err = 'unknown' }
    end

    if payload.mode == 'atm' then DB.addDailyWithdrawn(payload.accountId, amount) end

    DB.logTransaction(payload.accountId, 'withdraw', amount, newBal, cid, payload.mode or 'bank', payload.note or '')
    notify(source, Locale.ok_withdraw:format(amount, Config.Currency), 'success')

    if account.type == 'joint' then
        for _, m in ipairs(DB.getMembers(payload.accountId)) do
            if m.citizenid ~= cid then
                notifyByCid(m.citizenid, ('Joint %s: %s withdrew %s%s')
                    :format(account.name, getPlayerLabel(cid), Config.Currency, amount), 'inform')
            end
        end
        pushRefreshJointMembers(payload.accountId, cid)
    end

    return { ok = true, balance = newBal }
end)

-- transfer
-- modes: 'player_id' (server id), 'citizen_id', 'own_account' (between own accounts)
registerCallback('qb-banking:transfer', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then return { ok = false, err = 'no_player' } end
    local cid = Player.PlayerData.citizenid

    -- rate limit
    local now = GetGameTimer()
    if lastTransfer[source] and (now - lastTransfer[source]) < Config.Security.transferCooldownMs then
        return { ok = false, err = 'rate_limit' }
    end
    lastTransfer[source] = now

    local amount = tonumber(payload.amount)
    if not amount or amount <= 0 then return { ok = false, err = 'invalid_amount' } end
    amount = math.floor(amount)

    -- require PIN on the source account
    local ok, err, srcAccOrAttempts = authorize(source, payload.fromAccountId, payload.pin)
    if not ok then return { ok = false, err = err, attempts = srcAccOrAttempts } end
    local srcAcc = srcAccOrAttempts

    -- resolve destination account
    local destAcc
    local destLabel = ''
    if payload.targetType == 'own_account' then
        local row = DB.getAccountByNumber(tostring(payload.targetValue or ''))
        if not row or not DB.isMember(row.id, cid) then return { ok = false, err = 'invalid_target' } end
        if row.id == srcAcc.id then return { ok = false, err = 'self_transfer' } end
        destAcc = row
        destLabel = ('Own • %s'):format(row.name)

    elseif payload.targetType == 'player_id' then
        local target = QBCore.Functions.GetPlayer(tonumber(payload.targetValue))
        if not target then return { ok = false, err = 'invalid_target' } end
        if target.PlayerData.citizenid == cid then return { ok = false, err = 'self_transfer' } end
        -- pick the recipient's primary individual account, else create one — but we'll require they have one
        local rows = DB.listAccountsForCitizen(target.PlayerData.citizenid)
        if #rows == 0 then return { ok = false, err = 'invalid_target' } end
        -- prefer their first individual account they own
        for _, r in ipairs(rows) do
            if r.type == 'individual' and r.owner_cid == target.PlayerData.citizenid then destAcc = r; break end
        end
        if not destAcc then destAcc = rows[1] end
        destLabel = ('Player %s'):format(getPlayerLabel(target.PlayerData.citizenid))

    elseif payload.targetType == 'citizen_id' then
        local targetCid = tostring(payload.targetValue or '')
        if targetCid == '' or targetCid == cid then return { ok = false, err = 'self_transfer' } end
        local rows = DB.listAccountsForCitizen(targetCid)
        if #rows == 0 then return { ok = false, err = 'invalid_target' } end
        for _, r in ipairs(rows) do
            if r.type == 'individual' and r.owner_cid == targetCid then destAcc = r; break end
        end
        if not destAcc then destAcc = rows[1] end
        destLabel = ('CID %s'):format(getPlayerLabel(targetCid))

    else
        return { ok = false, err = 'invalid_target' }
    end

    -- source debit
    local newSrcBal, dErr = DB.adjustBalance(srcAcc.id, -amount)
    if not newSrcBal then return { ok = false, err = dErr or 'no_balance' } end

    -- destination credit
    local newDstBal, dErr2 = DB.adjustBalance(destAcc.id, amount)
    if not newDstBal then
        -- roll back
        DB.adjustBalance(srcAcc.id, amount)
        return { ok = false, err = dErr2 or 'frozen' }
    end

    -- log
    if payload.targetType == 'own_account' then
        DB.logTransaction(srcAcc.id,  'internal_out', amount, newSrcBal, cid, destLabel, payload.note or '')
        DB.logTransaction(destAcc.id, 'internal_in',  amount, newDstBal, cid, ('From %s'):format(srcAcc.name), payload.note or '')
    else
        DB.logTransaction(srcAcc.id,  'transfer_out', amount, newSrcBal, cid, destLabel, payload.note or '')
        DB.logTransaction(destAcc.id, 'transfer_in',  amount, newDstBal, cid, ('From %s'):format(getPlayerLabel(cid)), payload.note or '')
        -- Auto-save contact for player/citizen-id transfers (skip own_account)
        if destAcc.owner_cid and destAcc.owner_cid ~= cid then
            DB.upsertContact(cid, destAcc.owner_cid)
        end
    end

    -- notify
    notify(source, Locale.ok_transfer_out:format(amount, Config.Currency, destLabel), 'success')
    if payload.targetType ~= 'own_account' then
        notifyByCid(destAcc.owner_cid, Locale.ok_transfer_in:format(amount, Config.Currency, getPlayerLabel(cid)), 'success')
        -- Push refresh to recipient + all joint members on the destination account
        pushRefreshJointMembers(destAcc.id, cid)
        pushRefreshByCid(destAcc.owner_cid)
    end
    -- If the SOURCE account is a joint, refresh its other members so they
    -- see the balance go down even though they didn't initiate the transfer.
    if srcAcc.type == 'joint' then
        pushRefreshJointMembers(srcAcc.id, cid)
    end

    return { ok = true, balance = newSrcBal }
end)

-- invite: only owner of joint account can invite, target must be online to be added — invite is offline-friendly
registerCallback('qb-banking:invite', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local acc = DB.getAccountById(payload.accountId)
    if not acc or acc.type ~= 'joint' or acc.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end
    if #DB.getMembers(acc.id) >= Config.JointMaxMembers then return { ok = false, err = 'max_members' } end

    -- resolve target citizen id either by player id or citizen id
    local targetCid
    if payload.targetType == 'player_id' then
        local target = QBCore.Functions.GetPlayer(tonumber(payload.targetValue))
        if not target then return { ok = false, err = 'invalid_target' } end
        targetCid = target.PlayerData.citizenid
    else
        targetCid = tostring(payload.targetValue or '')
        if targetCid == '' then return { ok = false, err = 'invalid_target' } end
    end

    if targetCid == cid then return { ok = false, err = 'self_transfer' } end
    if DB.isMember(acc.id, targetCid) then return { ok = false, err = 'already_member' } end

    local insertId = DB.createInvite(acc.id, cid, targetCid)
    if not insertId or insertId == 0 then return { ok = false, err = 'invite_pending' } end

    notifyByCid(targetCid, Locale.inv_body:format(getPlayerLabel(cid), acc.account_number), 'inform')
    notify(source, Locale.ok_invite_sent, 'success')
    -- Push refresh so the target's open UI shows the new invite immediately
    pushRefreshByCid(targetCid)
    return { ok = true }
end)

registerCallback('qb-banking:respondInvite', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local invite = DB.getInviteById(payload.inviteId)
    if not invite or invite.target_cid ~= cid then return { ok = false, err = 'invalid' } end

    if payload.accept then
        local acc = DB.getAccountById(invite.account_id)
        if not acc then DB.deleteInvite(invite.id); return { ok = false, err = 'invalid' } end
        if #DB.getMembers(acc.id) >= Config.JointMaxMembers then
            DB.deleteInvite(invite.id)
            return { ok = false, err = 'max_members' }
        end
        DB.addMember(acc.id, cid, 'member')
        DB.deleteInvite(invite.id)
        notify(source, Locale.ok_invite_accepted, 'success')
        notifyByCid(invite.inviter_cid, ('%s joined %s'):format(getPlayerLabel(cid), acc.account_number), 'success')
        -- Push refresh: inviter sees new member; all existing members see the
        -- new joiner too (in case their settings panel is open).
        pushRefreshByCid(invite.inviter_cid)
        pushRefreshJointMembers(acc.id, cid)
    else
        DB.deleteInvite(invite.id)
        notify(source, Locale.ok_invite_declined, 'inform')
        notifyByCid(invite.inviter_cid, ('%s declined %s'):format(getPlayerLabel(cid), invite.account_id), 'inform')
        pushRefreshByCid(invite.inviter_cid)
    end
    return { ok = true }
end)

-- leave joint account (members only; owner cannot leave — must close)
registerCallback('qb-banking:leaveAccount', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local acc = DB.getAccountById(payload.accountId)
    if not acc or acc.type ~= 'joint' then return { ok = false, err = 'invalid' } end
    if acc.owner_cid == cid then return { ok = false, err = 'unauthorized' } end
    DB.removeMember(acc.id, cid)
    notify(source, Locale.ok_left_account, 'inform')
    -- Tell remaining members (including the owner) the member list shrank
    pushRefreshJointMembers(acc.id, cid)
    pushRefreshByCid(acc.owner_cid)
    return { ok = true }
end)

-- owner removes a member
registerCallback('qb-banking:removeMember', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false } end
    local acc = DB.getAccountById(payload.accountId)
    if not acc or acc.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end
    if payload.targetCid == cid then return { ok = false, err = 'unauthorized' } end
    DB.removeMember(acc.id, payload.targetCid)
    notifyByCid(payload.targetCid, ('Removed from %s'):format(acc.account_number), 'inform')
    -- Removed member needs to see the account disappear from their list,
    -- and remaining members should see the member list update.
    pushRefreshByCid(payload.targetCid)
    pushRefreshJointMembers(acc.id, cid)
    return { ok = true }
end)

-- close account (owner only). The remaining balance becomes a "frozen
-- balance" entry on the OWNER's citizenid (since only the owner can close
-- both individual and joint accounts). The player can claim it later via
-- the Claim Frozen flow, which converts to cash.
registerCallback('qb-banking:closeAccount', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then return { ok = false } end
    local cid = Player.PlayerData.citizenid
    local ok, err, account = authorize(source, payload.accountId, payload.pin)
    if not ok then return { ok = false, err = err } end
    if account.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end

    -- Capture the member list BEFORE delete so we can refresh them after.
    -- DB.deleteAccount cascades to the membership table, so we must fetch first.
    local memberCids = {}
    if account.type == 'joint' then
        for _, m in ipairs(DB.getMembers(account.id) or {}) do
            if m.citizenid ~= cid then table.insert(memberCids, m.citizenid) end
        end
    end

    local refund = account.balance or 0
    if refund > 0 then
        DB.addFrozen(cid, refund, account.account_number, account.name, account.type)
    end
    DB.deleteAccount(account.id)

    if refund > 0 then
        notify(source, ('Account %s closed — %s%s held as frozen balance'):format(
            account.account_number, Config.Currency, refund), 'success')
    else
        notify(source, ('Account %s closed'):format(account.account_number), 'success')
    end
    print(('^2[qb-banking]^7 Account #%d closed by %s — frozen=%s'):format(account.id, cid, refund))
    -- Refresh ex-members so the closed account drops out of their UI
    for _, mcid in ipairs(memberCids) do pushRefreshByCid(mcid) end
    return { ok = true, frozen = refund }
end)

-- Set this account as the user's "primary" — appears first, default for
-- direct deposits. Per-user, not per-account, so joint members each have
-- their own primary independently. Can be ANY account they have access to.
registerCallback('qb-banking:setPrimary', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false, err = 'no_player' } end
    local accountId = payload and tonumber(payload.accountId)
    if accountId then
        if not DB.isMember(accountId, cid) then return { ok = false, err = 'invalid_account' } end
    end
    DB.setPrimaryAccount(cid, accountId)
    return { ok = true }
end)

-- Owner-only: customize icon and color of an account
registerCallback('qb-banking:customizeAccount', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false, err = 'no_player' } end
    local acc = DB.getAccountById(payload and tonumber(payload.accountId))
    if not acc then return { ok = false, err = 'invalid_account' } end
    if acc.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end

    -- validate icon / color from a small whitelist
    local allowedIcons = {
        ['fa-user']=1, ['fa-users']=1, ['fa-house']=1, ['fa-car']=1,
        ['fa-briefcase']=1, ['fa-piggy-bank']=1, ['fa-vault']=1,
        ['fa-gem']=1, ['fa-plane']=1, ['fa-shop']=1, ['fa-graduation-cap']=1,
        ['fa-heart']=1, ['fa-star']=1, ['fa-gun']=1, ['fa-cake-candles']=1,
        ['fa-coins']=1, ['fa-snowflake']=1, ['fa-crown']=1,
    }
    local allowedColors = {
        green=1, blue=1, purple=1, orange=1, cyan=1, red=1, gold=1,
    }
    local icon  = payload.icon  and allowedIcons[payload.icon]  and payload.icon  or nil
    local color = payload.color and allowedColors[payload.color] and payload.color or nil

    DB.updateAccountStyle(acc.id, icon, color)
    return { ok = true }
end)

-- Owner-only: rename an account
registerCallback('qb-banking:renameAccount', function(source, payload)
    local cid = getCid(source); if not cid then return { ok = false, err = 'no_player' } end
    local acc = DB.getAccountById(payload and tonumber(payload.accountId))
    if not acc then return { ok = false, err = 'invalid_account' } end
    if acc.owner_cid ~= cid then return { ok = false, err = 'unauthorized' } end
    local name = (payload.name or ''):sub(1, 48)
    if #name < 1 then return { ok = false, err = 'invalid_amount' } end
    DB.updateAccountName(acc.id, name)
    return { ok = true }
end)

-- Frozen balance: read total
registerCallback('qb-banking:getFrozen', function(source)
    local cid = getCid(source); if not cid then return 0 end
    return DB.getFrozenTotal(cid)
end)

-- Frozen balance: list (per-source breakdown for the UI)
registerCallback('qb-banking:getFrozenList', function(source)
    local cid = getCid(source); if not cid then return {} end
    return DB.getFrozenList(cid)
end)

-- Frozen balance: claim → user picks cash OR a specific bank account.
-- payload: { destType = 'cash' | 'bank', accountId = N (when bank) }
registerCallback('qb-banking:claimFrozen', function(source, payload)
    local Player = QBCore.Functions.GetPlayer(source)
    if not Player then return { ok = false, err = 'no_player' } end
    local cid = Player.PlayerData.citizenid

    local total = DB.getFrozenTotal(cid)
    if not total or total <= 0 then return { ok = false, err = 'no_balance' } end

    local destType = (payload and payload.destType) == 'bank' and 'bank' or 'cash'

    if destType == 'bank' then
        local accountId = tonumber(payload and payload.accountId)
        if not accountId then return { ok = false, err = 'invalid_account' } end
        if not DB.isMember(accountId, cid) then return { ok = false, err = 'invalid_account' } end

        local account = DB.getAccountById(accountId)
        if not account then return { ok = false, err = 'invalid_account' } end
        if account.frozen == 1 then return { ok = false, err = 'frozen' } end

        local newBal, derr = DB.adjustBalance(accountId, total)
        if not newBal then return { ok = false, err = derr or 'unknown' } end

        DB.logTransaction(accountId, 'deposit', total, newBal, cid,
            'Frozen claim', 'Reclaimed frozen balance')
        DB.clearFrozen(cid)

        notify(source, ('Claimed %s%s into %s'):format(
            Config.Currency, total, account.name), 'success')
        print(('^2[qb-banking]^7 Frozen claimed by %s → %s%s into bank acc#%d (%s)')
            :format(cid, Config.Currency, total, accountId, account.account_number))
        return {
            ok = true, amount = total, destType = 'bank',
            accountName = account.name, accountNumber = account.account_number,
            balance = newBal,
        }
    end

    -- destType == 'cash'
    if not safeAddMoney(Player, 'cash', total, 'qb-banking: claim frozen') then
        return { ok = false, err = 'unknown' }
    end
    DB.clearFrozen(cid)
    notify(source, ('Claimed %s%s as cash'):format(Config.Currency, total), 'success')
    print(('^2[qb-banking]^7 Frozen claimed by %s → %s%s as cash')
        :format(cid, Config.Currency, total))
    return { ok = true, amount = total, destType = 'cash' }
end)

-- Forgot PIN — owner-only. Resets the PIN without requiring the old one.
-- Joint account members CANNOT use this; only the original creator (owner_cid).
-- Also clears any active lockouts and notifies the other joint members.
registerCallback('qb-banking:resetPin', function(source, payload)
    local cid = getCid(source)
    if not cid then return { ok = false, err = 'no_player' } end

    local accountId = payload and tonumber(payload.accountId)
    local newPin    = payload and payload.newPin
    if not accountId then return { ok = false, err = 'invalid_account' } end

    local acc = DB.getAccountById(accountId)
    if not acc then return { ok = false, err = 'invalid_account' } end

    -- ONLY the account creator can reset the PIN
    if acc.owner_cid ~= cid then
        print(('^1[qb-banking]^7 resetPin denied: cid=%s is not owner of acc#%d (owner=%s)')
            :format(cid, acc.id, acc.owner_cid))
        return { ok = false, err = 'unauthorized' }
    end

    if not validatePin(newPin) then return { ok = false, err = 'pin_format' } end

    DB.changePin(acc.id, newPin)
    DB.clearLockout(acc.id, cid)
    DB.logTransaction(acc.id, 'admin', 0, acc.balance, cid, 'system', 'PIN reset (Forgot PIN)')

    notify(source, 'PIN reset successfully', 'success')

    -- notify joint members (security signal — they should know the PIN changed)
    if acc.type == 'joint' then
        for _, m in ipairs(DB.getMembers(acc.id)) do
            if m.citizenid ~= cid then
                notifyByCid(m.citizenid,
                    ('PIN reset on joint account %s'):format(acc.account_number), 'inform')
            end
        end
    end

    print(('^2[qb-banking]^7 PIN reset for acc#%d by owner %s'):format(acc.id, cid))
    return { ok = true }
end)

-- cleanup on player drop
AddEventHandler('playerDropped', function()
    local src = source
    lastTransfer[src] = nil
end)
