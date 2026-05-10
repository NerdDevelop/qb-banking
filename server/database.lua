-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : database helpers
-- All persistence logic lives here. Server/main.lua imports DB.
-- =========================================================

DB = {}

-- ----------------------------- helpers ---------------------------------
local function genAccountNumber()
    local n = ('%04d-%04d-%04d'):format(math.random(0, 9999), math.random(0, 9999), math.random(0, 9999))
    return Config.AccountPrefix .. n
end

local function randomSalt(len)
    len = len or 16
    local chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    local out = {}
    for i = 1, len do
        local r = math.random(1, #chars)
        out[i] = chars:sub(r, r)
    end
    return table.concat(out)
end

-- Pure-Lua salted PIN hash. No ox_lib / external crypto dependency — always
-- works regardless of ox_lib version or Lua VM build.
--
-- For a 4-digit PIN with per-account salt and 3-attempt lockout, the strength
-- is more than sufficient: an attacker would need to crack the hash AND survive
-- the lockouts, which is infeasible online.
--
-- Internal: four parallel mixers (djb2 variant + FNV-style + position-keyed)
-- run for 24 rounds, producing a 128-bit (32-hex-char) digest. Uses only
-- arithmetic — no bitwise ops — so it works on every Lua VM.
local function hashPin(pin, salt)
    local input = tostring(salt) .. '|' .. tostring(pin) .. '|qb-banking'
    local h1, h2, h3, h4 = 5381, 52711, 2166136261, 16777619
    local len = #input
    local M = 0x100000000  -- 2^32
    for round = 1, 24 do
        for i = 1, len do
            local b = input:byte(i)
            h1 = ((h1 * 33)  + b + round)   % M
            h2 = ((h2 * 31)  + b * round)   % M
            h3 = ((h3 + b) * 16777619)      % M
            h4 = ((h4 * 2654435761) + b * i + round) % M
        end
        -- mix the lanes between rounds so a change anywhere affects everything
        h1 = (h1 + h3) % M
        h2 = (h2 + h4) % M
        h3 = (h3 + h2) % M
        h4 = (h4 + h1) % M
    end
    return ('%08x%08x%08x%08x'):format(h1, h2, h3, h4)
end

DB.hashPin = hashPin
DB.randomSalt = randomSalt

-- ----------------------------- accounts --------------------------------

function DB.createAccount(opts)
    -- opts: { name, type ('individual'|'joint'), ownerCid, pin, ownerName }
    local salt = randomSalt(16)
    local pinHash = hashPin(opts.pin, salt)

    -- find a unique account number (try 6 times)
    local accNum
    for _ = 1, 6 do
        accNum = genAccountNumber()
        local row = MySQL.scalar.await('SELECT id FROM qb_banking_accounts WHERE account_number = ?', { accNum })
        if not row then break else accNum = nil end
    end
    if not accNum then
        print('^1[qb-banking]^7 createAccount failed: could not generate unique account number')
        return nil
    end

    local insertId = MySQL.insert.await(
        'INSERT INTO qb_banking_accounts (account_number, name, type, owner_cid, pin_hash, pin_salt, balance) VALUES (?, ?, ?, ?, ?, ?, 0)',
        { accNum, opts.name or 'Account', opts.type or 'individual', opts.ownerCid, pinHash, salt }
    )
    if not insertId or insertId == 0 then
        print(('^1[qb-banking]^7 createAccount INSERT failed for cid=%s'):format(tostring(opts.ownerCid)))
        return nil
    end

    local memberId = MySQL.insert.await(
        'INSERT INTO qb_banking_members (account_id, citizenid, role) VALUES (?, ?, ?)',
        { insertId, opts.ownerCid, 'owner' }
    )
    if not memberId or memberId == 0 then
        print(('^1[qb-banking]^7 createAccount: account row inserted (id=%s) but member row FAILED for cid=%s'):format(tostring(insertId), tostring(opts.ownerCid)))
    end

    print(('^2[qb-banking]^7 Account created: %s (#%d) owner=%s type=%s'):format(accNum, insertId, opts.ownerCid, opts.type or 'individual'))

    return {
        id            = insertId,
        accountNumber = accNum,
        name          = opts.name or 'Account',
        type          = opts.type or 'individual',
        ownerCid      = opts.ownerCid,
        balance       = 0,
        frozen        = false,
    }
end

function DB.getAccountById(id)
    return MySQL.single.await('SELECT * FROM qb_banking_accounts WHERE id = ?', { id })
end

function DB.getAccountByNumber(num)
    return MySQL.single.await('SELECT * FROM qb_banking_accounts WHERE account_number = ?', { num })
end

function DB.countAccountsForOwner(cid)
    return MySQL.scalar.await(
        'SELECT COUNT(*) FROM qb_banking_accounts WHERE owner_cid = ?', { cid }
    ) or 0
end

-- list accounts the citizen can access (own + joint membership)
function DB.listAccountsForCitizen(cid)
    return MySQL.query.await([[
        SELECT a.*, m.role AS my_role
        FROM qb_banking_accounts a
        INNER JOIN qb_banking_members m ON m.account_id = a.id
        WHERE m.citizenid = ?
        ORDER BY a.id ASC
    ]], { cid }) or {}
end

function DB.getMembers(accountId)
    return MySQL.query.await(
        'SELECT citizenid, role, joined_at FROM qb_banking_members WHERE account_id = ?',
        { accountId }
    ) or {}
end

function DB.isMember(accountId, cid)
    local row = MySQL.scalar.await(
        'SELECT id FROM qb_banking_members WHERE account_id = ? AND citizenid = ?',
        { accountId, cid }
    )
    return row ~= nil
end

function DB.addMember(accountId, cid, role)
    return MySQL.insert.await(
        'INSERT IGNORE INTO qb_banking_members (account_id, citizenid, role) VALUES (?, ?, ?)',
        { accountId, cid, role or 'member' }
    )
end

function DB.removeMember(accountId, cid)
    return MySQL.update.await(
        'DELETE FROM qb_banking_members WHERE account_id = ? AND citizenid = ? AND role <> "owner"',
        { accountId, cid }
    )
end

function DB.deleteAccount(accountId)
    return MySQL.update.await('DELETE FROM qb_banking_accounts WHERE id = ?', { accountId })
end

-- ----------------------------- balance ---------------------------------

function DB.adjustBalance(accountId, delta)
    -- atomic-ish update; returns new balance or nil if it would go negative
    local row = MySQL.single.await('SELECT balance, frozen FROM qb_banking_accounts WHERE id = ?', { accountId })
    if not row then return nil, 'no_account' end
    if row.frozen == 1 then return nil, 'frozen' end
    local newBal = row.balance + delta
    if newBal < 0 then return nil, 'no_balance' end
    MySQL.update.await('UPDATE qb_banking_accounts SET balance = ? WHERE id = ?', { newBal, accountId })
    return newBal
end

function DB.setBalance(accountId, value)
    return MySQL.update.await('UPDATE qb_banking_accounts SET balance = ? WHERE id = ?', { value, accountId })
end

function DB.setFrozen(accountId, frozen)
    return MySQL.update.await('UPDATE qb_banking_accounts SET frozen = ? WHERE id = ?', { frozen and 1 or 0, accountId })
end

-- ----------------------------- pin -------------------------------------

function DB.verifyPin(account, pin)
    if not account then return false end
    return DB.hashPin(pin, account.pin_salt) == account.pin_hash
end

function DB.changePin(accountId, newPin)
    local salt = DB.randomSalt(16)
    local hash = DB.hashPin(newPin, salt)
    return MySQL.update.await(
        'UPDATE qb_banking_accounts SET pin_hash = ?, pin_salt = ? WHERE id = ?',
        { hash, salt, accountId }
    )
end

-- ----------------------------- lockouts --------------------------------

function DB.getLockout(accountId, cid)
    return MySQL.single.await(
        'SELECT * FROM qb_banking_lockouts WHERE account_id = ? AND citizenid = ?',
        { accountId, cid }
    )
end

function DB.recordFailedAttempt(accountId, cid)
    local lk = DB.getLockout(accountId, cid)
    local attempts = (lk and lk.attempts or 0) + 1
    local lockedUntil = nil
    if attempts >= Config.Security.maxAttempts then
        lockedUntil = os.date('%Y-%m-%d %H:%M:%S', os.time() + (Config.Security.lockoutMinutes * 60))
    end
    if lk then
        MySQL.update.await(
            'UPDATE qb_banking_lockouts SET attempts = ?, locked_until = ? WHERE id = ?',
            { attempts, lockedUntil, lk.id }
        )
    else
        MySQL.insert.await(
            'INSERT INTO qb_banking_lockouts (account_id, citizenid, attempts, locked_until) VALUES (?, ?, ?, ?)',
            { accountId, cid, attempts, lockedUntil }
        )
    end
    return attempts, lockedUntil
end

function DB.clearLockout(accountId, cid)
    MySQL.update.await(
        'DELETE FROM qb_banking_lockouts WHERE account_id = ? AND citizenid = ?',
        { accountId, cid }
    )
end

-- ----------------------------- transactions -----------------------------

function DB.logTransaction(accountId, kind, amount, balanceAfter, actorCid, targetLabel, note)
    return MySQL.insert.await([[
        INSERT INTO qb_banking_transactions
            (account_id, kind, amount, balance_after, actor_cid, target_label, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ]], { accountId, kind, amount, balanceAfter, actorCid or '', targetLabel or '', note or '' })
end

function DB.getTransactions(accountId, limit)
    return MySQL.query.await([[
        SELECT id, kind, amount, balance_after, actor_cid, target_label, note, created_at
        FROM qb_banking_transactions
        WHERE account_id = ?
        ORDER BY id DESC
        LIMIT ?
    ]], { accountId, limit or Config.TransactionsHistory }) or {}
end

-- ----------------------------- atm usage -------------------------------

function DB.getDailyWithdrawn(accountId)
    local today = os.date('%Y-%m-%d')
    local row = MySQL.single.await(
        'SELECT withdrawn_today FROM qb_banking_atm_usage WHERE account_id = ? AND day = ?',
        { accountId, today }
    )
    return row and row.withdrawn_today or 0
end

function DB.addDailyWithdrawn(accountId, amount)
    local today = os.date('%Y-%m-%d')
    MySQL.insert.await([[
        INSERT INTO qb_banking_atm_usage (account_id, day, withdrawn_today)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE withdrawn_today = withdrawn_today + VALUES(withdrawn_today)
    ]], { accountId, today, amount })
end

-- ----------------------------- invites ---------------------------------

function DB.createInvite(accountId, inviterCid, targetCid)
    return MySQL.insert.await([[
        INSERT IGNORE INTO qb_banking_invites (account_id, inviter_cid, target_cid)
        VALUES (?, ?, ?)
    ]], { accountId, inviterCid, targetCid })
end

function DB.getInvitesForCid(cid)
    return MySQL.query.await([[
        SELECT i.id, i.account_id, i.inviter_cid, i.created_at,
               a.account_number, a.name, a.type
        FROM qb_banking_invites i
        INNER JOIN qb_banking_accounts a ON a.id = i.account_id
        WHERE i.target_cid = ?
        ORDER BY i.id DESC
    ]], { cid }) or {}
end

function DB.deleteInvite(inviteId)
    return MySQL.update.await('DELETE FROM qb_banking_invites WHERE id = ?', { inviteId })
end

function DB.getInviteById(inviteId)
    return MySQL.single.await('SELECT * FROM qb_banking_invites WHERE id = ?', { inviteId })
end

-- ----------------------------- frozen balance --------------------------
-- When an account is closed, the remaining balance is parked here under
-- the owner's citizenid until they claim it (which converts to cash).

function DB.addFrozen(cid, amount, sourceAccount, sourceName, sourceType)
    if not amount or amount <= 0 then return nil end
    return MySQL.insert.await([[
        INSERT INTO qb_banking_frozen (citizenid, amount, source_account, source_name, source_type)
        VALUES (?, ?, ?, ?, ?)
    ]], { cid, amount, sourceAccount or '', sourceName or '', sourceType or 'individual' })
end

function DB.getFrozenTotal(cid)
    if not cid then return 0 end
    -- oxmysql can return SUM() as DECIMAL/string depending on the driver
    -- version, so coerce to number defensively.
    local v = MySQL.scalar.await(
        'SELECT COALESCE(SUM(amount), 0) FROM qb_banking_frozen WHERE citizenid = ?',
        { cid }
    )
    return tonumber(v) or 0
end

function DB.getFrozenList(cid)
    if not cid then return {} end
    return MySQL.query.await([[
        SELECT id, amount, source_account, source_name, source_type, created_at
        FROM qb_banking_frozen
        WHERE citizenid = ?
        ORDER BY id ASC
    ]], { cid }) or {}
end

function DB.clearFrozen(cid)
    return MySQL.update.await(
        'DELETE FROM qb_banking_frozen WHERE citizenid = ?', { cid }
    )
end

-- ----------------------------- user prefs ------------------------------
function DB.getUserPrefs(cid)
    if not cid then return nil end
    return MySQL.single.await(
        'SELECT * FROM qb_banking_user_prefs WHERE citizenid = ?', { cid }
    )
end

function DB.setPrimaryAccount(cid, accountId)
    -- accountId can be nil to clear
    MySQL.update.await([[
        INSERT INTO qb_banking_user_prefs (citizenid, primary_account_id)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE primary_account_id = VALUES(primary_account_id)
    ]], { cid, accountId })
end

-- ----------------------------- account customization -------------------
function DB.updateAccountStyle(accountId, icon, color)
    MySQL.update.await(
        'UPDATE qb_banking_accounts SET icon = ?, color = ? WHERE id = ?',
        { icon, color, accountId }
    )
end

-- ----------------------------- account name ----------------------------
function DB.updateAccountName(accountId, name)
    MySQL.update.await(
        'UPDATE qb_banking_accounts SET name = ? WHERE id = ?',
        { name, accountId }
    )
end

-- ----------------------------- contacts --------------------------------
-- Auto-saved when a player transfers to another player. The `last_used` and
-- `transfer_count` fields drive the "most-frequent" sort order.

function DB.upsertContact(ownerCid, targetCid)
    if not ownerCid or not targetCid or ownerCid == targetCid then return end
    MySQL.update.await([[
        INSERT INTO qb_banking_contacts (owner_cid, target_cid, transfer_count, last_used)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
            transfer_count = transfer_count + 1,
            last_used      = CURRENT_TIMESTAMP
    ]], { ownerCid, targetCid })
end

function DB.listContacts(ownerCid)
    return MySQL.query.await([[
        SELECT id, target_cid, custom_label, transfer_count, last_used
        FROM qb_banking_contacts
        WHERE owner_cid = ?
        ORDER BY last_used DESC, transfer_count DESC
    ]], { ownerCid }) or {}
end

function DB.renameContact(ownerCid, contactId, label)
    MySQL.update.await([[
        UPDATE qb_banking_contacts SET custom_label = ?
        WHERE id = ? AND owner_cid = ?
    ]], { label, contactId, ownerCid })
end

function DB.removeContact(ownerCid, contactId)
    MySQL.update.await([[
        DELETE FROM qb_banking_contacts WHERE id = ? AND owner_cid = ?
    ]], { contactId, ownerCid })
end

return DB
