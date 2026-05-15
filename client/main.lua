-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : client entry (NUI bridge + open helpers)
-- Uses QBCore native callbacks (with ox_lib as fallback) for max
-- compatibility across QBCore forks.
-- =========================================================
local QBCore = exports['qb-core']:GetCoreObject()

local uiOpen = false
local opening = false

-- ----------------------- callback await wrapper ------------------------
-- Tries QBCore.Functions.TriggerCallback first (always present in QBCore),
-- and falls back to lib.callback.await if QBCore-style fails. The result
-- is awaited via a promise so callers can write `local r = serverCall(...)`.

local function serverCall(name, payload)
    local p = promise.new()
    local resolved = false
    local function done(result)
        if resolved then return end
        resolved = true
        p:resolve(result)
    end

    -- Primary: ox_lib callback (uses unique IDs per call → safe for
    -- concurrent requests for the same event name). QBCore's native
    -- TriggerCallback uses a single shared key, which causes races when
    -- two refreshes overlap (one wins, the other gets stale/empty data).
    if lib and lib.callback and lib.callback.await then
        CreateThread(function()
            local res = lib.callback.await(name, false, payload)
            done(res)
        end)
    else
        local ok = pcall(QBCore.Functions.TriggerCallback, name, function(result)
            done(result)
        end, payload)
        if not ok then done(nil) end
    end

    -- Safety timeout — never let the UI hang forever
    SetTimeout(8000, function() done(nil) end)
    return Citizen.Await(p)
end

-- ----------------------- NUI helpers -----------------------------------

local function setNui(open)
    if uiOpen == open then return end
    uiOpen = open
    SetNuiFocus(open, open)
    SendNUIMessage({ action = 'visible', visible = open })
end

-- read current cash from QBCore PlayerData (best-effort)
local function getCash()
    local pd = QBCore.Functions.GetPlayerData()
    return (pd and pd.money and pd.money.cash) or 0
end

-- Push fresh data into the UI. mode: 'atm' or 'bank'.
local function openUI(mode)
    if uiOpen or opening then return end
    opening = true
    CreateThread(function()
        local accounts = serverCall('qb-banking:getAccounts', {}) or {}
        local invites  = serverCall('qb-banking:getInvites',  {}) or {}
        local frozen   = serverCall('qb-banking:getFrozen',   {}) or 0
        local tier     = serverCall('qb-banking:getVipTier',  {}) or nil

        print(('[qb-banking] open %s mode — %d account(s), %d invite(s), frozen=%s, tier=%s')
            :format(mode, #accounts, #invites, tostring(frozen), tier and tier.name or '?'))

        SendNUIMessage({
            action   = 'open',
            mode     = mode,
            accounts = accounts,
            invites  = invites,
            cash     = getCash(),
            frozen   = tonumber(frozen) or 0,
            tier     = tier,
            config   = {
                currency       = Config.Currency,
                pinLength      = Config.Security.pinLength,
                lockoutMinutes = Config.Security.lockoutMinutes,
                quickBalance   = Config.ATM.quickBalanceEnabled,
                jointMax       = Config.JointMaxMembers,
                maxAccounts    = Config.MaxAccountsPerPlayer,
                atmDailyLimit  = Config.ATM.dailyWithdrawLimit,
                newFee         = Config.NewAccountFee,
                splitExpense   = Config.JointFeatures and Config.JointFeatures.splitExpenseEnabled or false,
            },
            locale = Locale,
        })
        setNui(true)
        opening = false
    end)
end

exports('OpenBank', function() openUI('bank') end)
exports('OpenATM',  function() openUI('atm') end)

RegisterNetEvent('qb-banking:open', function(mode) openUI(mode or 'bank') end)

-- ---------------------- NUI -> server bridge ---------------------------
RegisterNUICallback('close', function(_, cb)
    setNui(false); cb('ok')
end)

local function bridgeCallback(name, eventName)
    RegisterNUICallback(name, function(payload, cb)
        CreateThread(function()
            local res = serverCall(eventName, payload)
            cb(res or {})
        end)
    end)
end

bridgeCallback('verifyPin',       'qb-banking:verifyPin')
bridgeCallback('createAccount',   'qb-banking:createAccount')
bridgeCallback('changePin',       'qb-banking:changePin')
bridgeCallback('resetPin',        'qb-banking:resetPin')
bridgeCallback('getFrozenList',   'qb-banking:getFrozenList')
bridgeCallback('claimFrozen',     'qb-banking:claimFrozen')
bridgeCallback('setPrimary',      'qb-banking:setPrimary')
bridgeCallback('customizeAccount','qb-banking:customizeAccount')
bridgeCallback('renameAccount',   'qb-banking:renameAccount')
bridgeCallback('getContacts',     'qb-banking:getContacts')
bridgeCallback('renameContact',   'qb-banking:renameContact')
bridgeCallback('removeContact',   'qb-banking:removeContact')
bridgeCallback('splitExpense',    'qb-banking:splitExpense')

-- Live refresh — when cash changes via QBCore (jobs, sales, salaries...)
-- the bank UI re-fetches accounts/tier so VIP, sidebar cash, etc. stay in sync.
RegisterNetEvent('QBCore:Client:OnMoneyChange', function(moneytype, amount, operation, reason)
    if not uiOpen then return end
    if moneytype ~= 'cash' and moneytype ~= 'bank' then return end
    SendNUIMessage({ action = 'liveRefresh' })
end)

-- Server-pushed live refresh: fired whenever something happens that
-- changes our data from OUTSIDE our own action — incoming transfer,
-- joint-account activity by another member, invite received, removed
-- from an account, etc. If our UI is open we re-pull a fresh snapshot;
-- if it's closed we ignore (next open will fetch fresh anyway).
RegisterNetEvent('qb-banking:liveRefresh', function()
    if not uiOpen then return end
    SendNUIMessage({ action = 'liveRefresh' })
end)

-- Bridge: NUI → client-side notify via the in-house notify script.
-- Client-side errors (form validation etc.) fire through the same channel
-- as server-side notifications — single visual source of truth.
RegisterNUICallback('notify', function(payload, cb)
    local color = (payload and payload.color) or 'primary'
    local msg   = (payload and payload.message) or ''
    local time  = (payload and tonumber(payload.time)) or 4500
    TriggerEvent('notifications:sendNotification', color, msg, time)
    cb('ok')
end)


bridgeCallback('deposit',         'qb-banking:deposit')
bridgeCallback('withdraw',        'qb-banking:withdraw')
bridgeCallback('transfer',        'qb-banking:transfer')
bridgeCallback('invite',          'qb-banking:invite')
bridgeCallback('respondInvite',   'qb-banking:respondInvite')
bridgeCallback('leaveAccount',    'qb-banking:leaveAccount')
bridgeCallback('removeMember',    'qb-banking:removeMember')
bridgeCallback('closeAccount',    'qb-banking:closeAccount')

RegisterNUICallback('refresh', function(_, cb)
    CreateThread(function()
        local accounts = serverCall('qb-banking:getAccounts', {}) or {}
        local invites  = serverCall('qb-banking:getInvites',  {}) or {}
        local frozen   = serverCall('qb-banking:getFrozen',   {}) or 0
        local tier     = serverCall('qb-banking:getVipTier',  {}) or nil
        cb({
            accounts = accounts,
            invites  = invites,
            cash     = getCash(),
            frozen   = tonumber(frozen) or 0,
            tier     = tier,
        })
    end)
end)

RegisterNUICallback('transactions', function(payload, cb)
    CreateThread(function()
        local rows = serverCall('qb-banking:getTransactions', { accountId = tonumber(payload.accountId) }) or {}
        cb(rows)
    end)
end)

RegisterNUICallback('quickBalance', function(payload, cb)
    CreateThread(function()
        local res = serverCall('qb-banking:quickBalance', { accountNumber = tostring(payload.accountNumber or '') })
        cb(res or {})
    end)
end)

-- ---------------------- map blips --------------------------------------
CreateThread(function()
    if not Config.BankBlip.enabled then return end
    for _, b in ipairs(Config.BankLocations) do
        local blip = AddBlipForCoord(b.coords.x, b.coords.y, b.coords.z)
        SetBlipSprite(blip, Config.BankBlip.sprite)
        SetBlipColour(blip, Config.BankBlip.color)
        SetBlipScale(blip, Config.BankBlip.scale)
        SetBlipAsShortRange(blip, true)
        BeginTextCommandSetBlipName('STRING')
        AddTextComponentSubstringPlayerName(b.label or 'Bank')
        EndTextCommandSetBlipName(blip)
    end
end)

-- close UI on resource stop / player drop
AddEventHandler('onResourceStop', function(res)
    if res == GetCurrentResourceName() and uiOpen then setNui(false) end
end)

-- /qbbanking — debug command: opens the full bank UI without going to a teller
RegisterCommand('qbbanking', function() openUI('bank') end, false)
RegisterCommand('qbatm',  function() openUI('atm')  end, false)

