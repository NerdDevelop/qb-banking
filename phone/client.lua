-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : LB Phone integration
-- Registers a "Bank" app with lb-phone that re-uses the existing
-- qb-banking server callbacks. Theme/locale follow the phone.
-- =========================================================

local QBCore     = exports['qb-core']:GetCoreObject()
local APP_ID     = 'qb-banking'
local RESOURCE   = GetCurrentResourceName()

local function safeNotify(color, msg, time)
    -- Funnel through the in-house notify script (same as qb-banking).
    TriggerEvent('notifications:sendNotification', color or 'primary', msg or '', time or 4500)
end

-- ------------------------- server callbacks -----------------------------
-- Lightweight wrapper that prefers ox_lib (unique IDs, race-safe) and
-- falls back to QBCore native if ox_lib isn't available.
local function srv(event, payload)
    if lib and lib.callback and lib.callback.await then
        return lib.callback.await(event, false, payload)
    end
    local p = promise.new()
    local resolved = false
    QBCore.Functions.TriggerCallback(event, function(r)
        if resolved then return end
        resolved = true
        p:resolve(r)
    end, payload)
    SetTimeout(8000, function()
        if not resolved then resolved = true; p:resolve(nil) end
    end)
    return Citizen.Await(p)
end

-- ------------------------- helpers --------------------------------------
local function getCash()
    local pd = QBCore.Functions.GetPlayerData()
    return (pd and pd.money and pd.money.cash) or 0
end

-- Probes lb-phone for the active language; identical logic to the
-- getPhoneLang NUI callback below, but callable from Lua so we can ship
-- the language inside every snapshot.
local function detectPhoneLang()
    local lang
    pcall(function()
        local settings = exports['lb-phone']:GetSettings()
        if type(settings) == 'table' then
            lang = settings.language or settings.locale or settings.lang
                or settings.currentLanguage or settings.currentLocale
        end
    end)
    if not lang then
        for _, fn in ipairs({ 'GetLanguage', 'GetCurrentLanguage', 'GetLocale', 'GetCurrentLocale' }) do
            pcall(function()
                local v = exports['lb-phone'][fn](exports['lb-phone'])
                if v then lang = v end
            end)
            if lang then break end
        end
    end
    if not lang then
        local cv = GetConvar('lb_phone_language', '')
        if cv ~= '' then lang = cv end
    end
    return lang
end

local function fetchSnapshot()
    local accounts = srv('qb-banking:getAccounts', {}) or {}
    local frozen   = srv('qb-banking:getFrozen',   {}) or 0
    local tier     = srv('qb-banking:getVipTier',  {}) or nil
    local contacts = srv('qb-banking:getContacts', {}) or {}
    local invites  = srv('qb-banking:getInvites',  {}) or {}
    return {
        accounts = accounts,
        frozen   = tonumber(frozen) or 0,
        cash     = getCash(),
        tier     = tier,
        contacts = contacts,
        invites  = invites,
        lang     = detectPhoneLang(),
    }
end

-- Push fresh state into the app UI.
local function pushSnapshot()
    local data = fetchSnapshot()
    data.action = 'snapshot'
    exports['lb-phone']:SendCustomAppMessage(APP_ID, data)
end

-- Server-pushed live refresh — fired by qb-banking when something
-- happens to us from outside our own action (incoming transfer, joint
-- account activity by another member, invite received, etc.). Push a
-- fresh snapshot to the phone app so the user sees it without re-opening.
RegisterNetEvent('qb-banking:liveRefresh', function()
    CreateThread(function() pushSnapshot() end)
end)

-- ------------------------- NUI callbacks (UI → client) ------------------
-- The UI sends fetch('https://qb-banking/<event>', ...) which routes
-- here. We forward to qb-banking's existing callbacks.

RegisterNUICallback('phone_refresh', function(_, cb)
    CreateThread(function() cb(fetchSnapshot()) end)
end)

-- Reads the phone-wide language setting (lb-phone). The UI uses this to
-- match the user's chosen language without an in-app toggle. We probe
-- every plausible field/export the various lb-phone versions expose.
RegisterNUICallback('getPhoneLang', function(_, cb)
    local lang, source

    -- 1) GetSettings → settings.language / .locale / .lang
    pcall(function()
        local settings = exports['lb-phone']:GetSettings()
        if type(settings) == 'table' then
            lang = settings.language or settings.locale or settings.lang
                or settings.currentLanguage or settings.currentLocale
            if lang then source = 'GetSettings' end
        end
    end)

    -- 2) Dedicated exports some builds ship with
    if not lang then
        for _, fn in ipairs({ 'GetLanguage', 'GetCurrentLanguage', 'GetLocale', 'GetCurrentLocale' }) do
            pcall(function()
                local v = exports['lb-phone'][fn](exports['lb-phone'])
                if v then lang = v; source = fn end
            end)
            if lang then break end
        end
    end

    -- 3) Convars (occasionally used for global default)
    if not lang then
        local cv = GetConvar('lb_phone_language', '')
        if cv ~= '' then lang = cv; source = 'convar' end
    end

    print(('[qb-banking] getPhoneLang → %s (via %s)'):format(
        tostring(lang), tostring(source or 'none')))
    cb({ lang = lang })
end)

RegisterNUICallback('phone_transactions', function(payload, cb)
    CreateThread(function()
        local rows = srv('qb-banking:getTransactions', { accountId = tonumber(payload.accountId) }) or {}
        cb(rows)
    end)
end)

RegisterNUICallback('phone_deposit', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:deposit', {
            mode = 'bank',
            accountId = tonumber(payload.accountId),
            amount    = tonumber(payload.amount),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

RegisterNUICallback('phone_withdraw', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:withdraw', {
            mode      = 'bank',
            accountId = tonumber(payload.accountId),
            amount    = tonumber(payload.amount),
            pin       = tostring(payload.pin or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

RegisterNUICallback('phone_transfer', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:transfer', {
            fromAccountId = tonumber(payload.fromAccountId),
            targetType    = payload.targetType,
            targetValue   = payload.targetValue,
            amount        = tonumber(payload.amount),
            note          = payload.note or '',
            pin           = tostring(payload.pin or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

RegisterNUICallback('phone_claimFrozen', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:claimFrozen', {
            destType  = payload.destType or 'cash',
            accountId = tonumber(payload.accountId),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- ------------------- new (phone-only) callbacks --------------------------

-- Returns the lb-phone contacts saved on the player's phone. The lookup
-- happens server-side because lb-phone's GetContacts is server-only.
RegisterNUICallback('getPhoneContacts', function(_, cb)
    CreateThread(function()
        local rows
        if lib and lib.callback and lib.callback.await then
            rows = lib.callback.await('qb-banking:getMyContacts', false)
        else
            local p = promise.new()
            local resolved = false
            QBCore.Functions.TriggerCallback('qb-banking:getMyContacts', function(r)
                if resolved then return end
                resolved = true; p:resolve(r)
            end)
            SetTimeout(8000, function() if not resolved then resolved = true; p:resolve({}) end end)
            rows = Citizen.Await(p)
        end
        cb(rows or {})
    end)
end)

-- Phone number → citizen ID. Used by the Send page when the recipient is
-- chosen from the contacts picker. Returns { citizenId = '...' } or nil.
RegisterNUICallback('resolvePhoneNumber', function(payload, cb)
    CreateThread(function()
        local num = payload and payload.number
        if not num then cb({}); return end
        local res
        if lib and lib.callback and lib.callback.await then
            res = lib.callback.await('qb-banking:resolvePhone', false, { number = num })
        else
            local p = promise.new()
            local resolved = false
            QBCore.Functions.TriggerCallback('qb-banking:resolvePhone', function(r)
                if resolved then return end
                resolved = true; p:resolve(r)
            end, { number = num })
            SetTimeout(8000, function() if not resolved then resolved = true; p:resolve(nil) end end)
            res = Citizen.Await(p)
        end
        cb(res or {})
    end)
end)

-- Forwards to qb-banking's create-account callback. Same payload format.
RegisterNUICallback('phone_createAccount', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:createAccount', {
            name = payload.name,
            type = payload.type,
            pin  = tostring(payload.pin or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Forwards to qb-banking's change-PIN callback.
RegisterNUICallback('phone_changePin', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:changePin', {
            accountId = tonumber(payload.accountId),
            oldPin    = tostring(payload.oldPin or ''),
            newPin    = tostring(payload.newPin or ''),
        })
        cb(res or { ok = false })
    end)
end)

-- Owner-only: reset PIN without knowing the old one.
RegisterNUICallback('phone_resetPin', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:resetPin', {
            accountId = tonumber(payload.accountId),
            newPin    = tostring(payload.newPin or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Owner-only: rename an account.
RegisterNUICallback('phone_renameAccount', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:renameAccount', {
            accountId = tonumber(payload.accountId),
            name      = payload.name,
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Owner-only: change the icon and/or color.
RegisterNUICallback('phone_customizeAccount', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:customizeAccount', {
            accountId = tonumber(payload.accountId),
            icon      = payload.icon,
            color     = payload.color,
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Sets which account is "primary" (always shown first).
RegisterNUICallback('phone_setPrimary', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:setPrimary', {
            accountId = tonumber(payload.accountId),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Owner-only: close an account. Remaining balance becomes a "frozen"
-- balance the player can claim later from the home page.
RegisterNUICallback('phone_closeAccount', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:closeAccount', {
            accountId = tonumber(payload.accountId),
            pin       = tostring(payload.pin or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Joint accounts — owner invites a player by ID or citizen ID.
RegisterNUICallback('phone_invite', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:invite', {
            accountId   = tonumber(payload.accountId),
            targetType  = payload.targetType,
            targetValue = payload.targetValue,
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Joint accounts — invitee accepts/declines an invitation.
RegisterNUICallback('phone_respondInvite', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:respondInvite', {
            inviteId = tonumber(payload.inviteId),
            accept   = payload.accept and true or false,
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Joint accounts — non-owner leaves the account.
RegisterNUICallback('phone_leaveAccount', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:leaveAccount', {
            accountId = tonumber(payload.accountId),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Joint accounts — owner removes a member.
RegisterNUICallback('phone_removeMember', function(payload, cb)
    CreateThread(function()
        local res = srv('qb-banking:removeMember', {
            accountId = tonumber(payload.accountId),
            targetCid = tostring(payload.targetCid or ''),
        })
        cb(res or { ok = false })
        if res and res.ok then pushSnapshot() end
    end)
end)

-- Live re-sync if the player's cash/bank changes externally.
RegisterNetEvent('QBCore:Client:OnMoneyChange', function(moneytype)
    if moneytype ~= 'cash' and moneytype ~= 'bank' then return end
    pushSnapshot()
end)

-- ------------------------- register the app -----------------------------
CreateThread(function()
    -- Wait for lb-phone with 30s timeout
    print('^3[qb-banking]^7 waiting for lb-phone…')
    local waited = 0
    while GetResourceState('lb-phone') ~= 'started' do
        Wait(200)
        waited = waited + 200
        if waited > 30000 then
            print('^1[qb-banking]^7 lb-phone not started after 30s — phone app will NOT appear. Make sure ensure lb-phone is set in server.cfg.')
            return
        end
    end
    print('^2[qb-banking]^7 lb-phone detected, sleeping 1s for exports')
    Wait(1000)

    -- Verify AddCustomApp export actually exists
    local hasExport = false
    pcall(function()
        if exports['lb-phone'] and exports['lb-phone'].AddCustomApp then
            hasExport = true
        end
    end)
    if not hasExport then
        print('^1[qb-banking]^7 exports[lb-phone].AddCustomApp not found! Phone framework version may be incompatible.')
        return
    end

    local function pickStrings()
        local raw = detectPhoneLang() or 'en'
        local lc  = tostring(raw):lower()
        local isAr = lc:sub(1,2) == 'ar' or lc:find('arab', 1, true) ~= nil
        if isAr then
            return 'البنك', 'بنك فليكا — إدارة الحسابات والتحويل والسحب والإيداع'
        end
        return 'Bank', 'Fleeca Banking — manage accounts, transfer, withdraw, deposit'
    end

    local appName, appDesc = pickStrings()
    print(('^3[qb-banking]^7 registering with lb-phone: id=%s name=%s ui=%s/phone/ui/index.html'):format(APP_ID, appName, RESOURCE))

    local ok, errOrRes = pcall(function()
        return exports['lb-phone']:AddCustomApp({
            identifier  = APP_ID,
            name        = appName,
            description = appDesc,
            ui          = ('%s/phone/ui/index.html'):format(RESOURCE),
            icon        = 'https://cdn-icons-png.flaticon.com/512/2830/2830284.png',
            size        = 100,
            developer   = 'Sultan',
            fixBlur     = true,
            defaultApp  = true,
            onOpen  = function() CreateThread(pushSnapshot) end,
            onClose = function() end,
        })
    end)
    local err = ok and errOrRes or nil
    if not ok then
        print(('^1[qb-banking]^7 AddCustomApp threw: %s'):format(tostring(errOrRes)))
    end

    -- Live re-label: poll the phone's language every 4s and, when it
    -- flips, (1) update the app's launcher label, (2) push a snapshot to
    -- the open UI so it instantly re-renders in the new language.
    CreateThread(function()
        local lastLang = detectPhoneLang()
        while true do
            Wait(4000)
            local nowLang = detectPhoneLang()
            if nowLang ~= lastLang then
                lastLang = nowLang
                local n, d = pickStrings()
                local updated = false
                for _, fn in ipairs({ 'UpdateApp', 'SetCustomAppData', 'SetAppName' }) do
                    if not updated then
                        pcall(function()
                            exports['lb-phone'][fn](exports['lb-phone'], APP_ID, {
                                name        = n,
                                description = d,
                            })
                            updated = true
                        end)
                    end
                end
                -- Push a snapshot so the open UI swaps to the new locale
                -- without the user having to re-open the app.
                pushSnapshot()
            end
        end
    end)

    if err then
        print(('^1[qb-banking]^7 Failed to register app: %s'):format(tostring(err)))
    else
        print('^2[qb-banking]^7 App registered with lb-phone — should appear on the home screen.')
    end
end)

-- chat command لاختبار يدوي: /bankphone — يعيد محاولة التسجيل
RegisterCommand('bankphone', function()
    if GetResourceState('lb-phone') ~= 'started' then
        print('^1[qb-banking]^7 lb-phone not running')
        return
    end
    print('^3[qb-banking]^7 Manual phone test — open your phone and check for Bank app')
    pushSnapshot()
end, false)
