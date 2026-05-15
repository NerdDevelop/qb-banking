-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : admin commands
-- =========================================================
local QBCore = exports['qb-core']:GetCoreObject()

local function isAdmin(src)
    if src == 0 then return true end
    for _, group in ipairs(Config.AdminGroups) do
        if QBCore.Functions.HasPermission(src, group) then return true end
    end
    return false
end

local function adminMsg(src, msg)
    if src == 0 then print('[qb-banking] ' .. msg); return end
    TriggerClientEvent('notifications:sendNotification', src, 'primary', msg, 4500)
end

-- /bankfreeze <account_number>
RegisterCommand('bankfreeze', function(src, args)
    if not isAdmin(src) then return end
    local accNum = args[1]
    if not accNum then return adminMsg(src, 'Usage: /bankfreeze <account_number>') end
    local acc = DB.getAccountByNumber(accNum)
    if not acc then return adminMsg(src, 'Account not found') end
    DB.setFrozen(acc.id, true)
    DB.logTransaction(acc.id, 'admin', 0, acc.balance, 'admin', 'system', 'Frozen by admin')
    adminMsg(src, ('Account %s frozen'):format(accNum))
end, false)

-- /bankunfreeze <account_number>
RegisterCommand('bankunfreeze', function(src, args)
    if not isAdmin(src) then return end
    local accNum = args[1]
    if not accNum then return adminMsg(src, 'Usage: /bankunfreeze <account_number>') end
    local acc = DB.getAccountByNumber(accNum)
    if not acc then return adminMsg(src, 'Account not found') end
    DB.setFrozen(acc.id, false)
    DB.logTransaction(acc.id, 'admin', 0, acc.balance, 'admin', 'system', 'Unfrozen by admin')
    adminMsg(src, ('Account %s unfrozen'):format(accNum))
end, false)

-- /banksetbalance <account_number> <amount>
RegisterCommand('banksetbalance', function(src, args)
    if not isAdmin(src) then return end
    local accNum, amount = args[1], tonumber(args[2])
    if not accNum or not amount then return adminMsg(src, 'Usage: /banksetbalance <account_number> <amount>') end
    local acc = DB.getAccountByNumber(accNum)
    if not acc then return adminMsg(src, 'Account not found') end
    DB.setBalance(acc.id, amount)
    DB.logTransaction(acc.id, 'admin', amount - acc.balance, amount, 'admin', 'system', 'Admin set balance')
    adminMsg(src, ('Account %s balance set to %s'):format(accNum, amount))
end, false)

-- /bankunlock <citizenid> <account_number>
RegisterCommand('bankunlock', function(src, args)
    if not isAdmin(src) then return end
    local cid, accNum = args[1], args[2]
    if not cid or not accNum then return adminMsg(src, 'Usage: /bankunlock <citizenid> <account_number>') end
    local acc = DB.getAccountByNumber(accNum)
    if not acc then return adminMsg(src, 'Account not found') end
    DB.clearLockout(acc.id, cid)
    adminMsg(src, ('Cleared lockout for %s on %s'):format(cid, accNum))
end, false)

-- /bankresetpin <account_number> <new4digit>
RegisterCommand('bankresetpin', function(src, args)
    if not isAdmin(src) then return end
    local accNum, newPin = args[1], args[2]
    if not accNum or not newPin or #newPin ~= Config.Security.pinLength or not newPin:match('^%d+$') then
        return adminMsg(src, ('Usage: /bankresetpin <account_number> <%d-digit-pin>'):format(Config.Security.pinLength))
    end
    local acc = DB.getAccountByNumber(accNum)
    if not acc then return adminMsg(src, 'Account not found') end
    DB.changePin(acc.id, newPin)
    adminMsg(src, ('PIN reset for %s'):format(accNum))
end, false)

-- =========================================================
-- DIAGNOSTIC COMMANDS — anyone can run these to self-troubleshoot
-- =========================================================

-- /qbbanking_diag — full self-test, prints to server console
RegisterCommand('qbbanking_diag', function(src)
    local function p(line) print('[qb-banking][diag] ' .. line) end

    p('--------------------------------------------------------')
    p('qb-banking diagnostic')
    p('--------------------------------------------------------')

    -- 1. Resources
    p(('ox_lib:    %s'):format(GetResourceState('ox_lib')))
    p(('oxmysql:   %s'):format(GetResourceState('oxmysql')))
    p(('qb-core:   %s'):format(GetResourceState('qb-core')))
    p(('qb-target: %s'):format(GetResourceState('qb-target')))

    -- 2. DB tables
    local tables = {
        'qb_banking_accounts', 'qb_banking_members', 'qb_banking_transactions',
        'qb_banking_lockouts', 'qb_banking_invites', 'qb_banking_atm_usage',
    }
    for _, t in ipairs(tables) do
        local ok, count = pcall(function()
            return MySQL.scalar.await('SELECT COUNT(*) FROM ' .. t)
        end)
        if ok then p(('table %s: OK (%s rows)'):format(t, tostring(count))) end
        if not ok then p(('table %s: ^1MISSING^7'):format(t)) end
    end

    -- 3. Player object check
    if src and src > 0 then
        local Player = QBCore.Functions.GetPlayer(src)
        if Player then
            local fns = Player.Functions
            p(('Player [%d] %s — cid=%s'):format(src, GetPlayerName(src), Player.PlayerData.citizenid))
            p(('  AddMoney:    %s'):format(fns.AddMoney    and 'present' or '^1MISSING^7'))
            p(('  RemoveMoney: %s'):format(fns.RemoveMoney and 'present' or '^1MISSING^7'))
            p(('  SetMoney:    %s'):format(fns.SetMoney    and 'present' or '^1MISSING^7'))
            p(('  GetMoney:    %s'):format(fns.GetMoney    and 'present' or '^1MISSING^7'))
            p(('  cash:        %s'):format(tostring(Player.PlayerData.money and Player.PlayerData.money.cash)))
            p(('  bank:        %s'):format(tostring(Player.PlayerData.money and Player.PlayerData.money.bank)))
        else
            p('No QBCore player for source ' .. src)
        end
    end

    -- 4. Schema convention check
    local total = MySQL.scalar.await('SELECT COUNT(*) FROM qb_banking_accounts') or 0
    p(('Total accounts in DB: %d'):format(total))

    p('--------------------------------------------------------')
    if src and src > 0 then
        TriggerClientEvent('notifications:sendNotification', src, 'primary', 'Diagnostic printed to server console', 5000)
    end
end, false)

-- /qbbanking_makeaccount <pin> [name] — bypasses the UI completely so we can
-- verify the DB persistence layer in isolation.
RegisterCommand('qbbanking_makeaccount', function(src, args)
    if src == 0 then return print('[qb-banking] this command must run from in-game') end
    local Player = QBCore.Functions.GetPlayer(src)
    if not Player then return end
    local pin = args[1]
    if not pin or #pin ~= Config.Security.pinLength or not pin:match('^%d+$') then
        return adminMsg(src, ('Usage: /qbbanking_makeaccount <%d-digit-pin> [name]'):format(Config.Security.pinLength))
    end
    local name = args[2] or 'Direct'
    print(('[qb-banking] /qbbanking_makeaccount: cid=%s pin=%s name=%s'):format(Player.PlayerData.citizenid, pin, name))
    local acc = DB.createAccount({
        name     = name,
        type     = 'individual',
        ownerCid = Player.PlayerData.citizenid,
        pin      = pin,
    })
    if acc then
        adminMsg(src, ('OK — account %s (id=%d) created'):format(acc.accountNumber, acc.id))
    else
        adminMsg(src, 'Failed — see server console for the reason')
    end
end, false)

