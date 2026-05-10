-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : server side
-- A thin layer — qb-banking owns the data + business logic. We just
-- echo a phone notification when a transaction completes so the player
-- sees it in the lb-phone notification centre.
-- =========================================================

local APP_ID = 'qb-banking'

-- The qb-banking server already triggers 'notifications:sendNotification'
-- for every successful op. We additionally fire an lb-phone notification
-- so it shows in the phone tray with the Bank app icon.
local function phoneNotify(src, title, content)
    if GetResourceState('lb-phone') ~= 'started' then return end
    local ok = pcall(function()
        exports['lb-phone']:SendNotification(src, {
            app     = APP_ID,
            title   = title or 'Bank',
            content = content or '',
        })
    end)
    if not ok then
        -- silent: app may not be installed yet for this player
    end
end

-- Hook into qb-banking's chat-friendly events if the user opted in.
-- This is best-effort — if the events don't exist, nothing happens.

RegisterNetEvent('qb-banking:notify', function(payload)
    local src = source
    if not payload or type(payload) ~= 'table' then return end
    phoneNotify(src, payload.title, payload.content)
end)

-- Optional command for admins to test the phone notification path
RegisterCommand('qbbankingphone_test', function(src)
    if src == 0 or QBCore_HasPermission(src) then
        phoneNotify(src, 'Bank', 'Test notification from qb-banking')
    end
end, false)

function QBCore_HasPermission(src)
    local QBCore = exports['qb-core']:GetCoreObject()
    for _, g in ipairs({ 'admin', 'god' }) do
        if QBCore.Functions.HasPermission(src, g) then return true end
    end
    return false
end

-- =========================================================
-- Callbacks the phone app uses
-- =========================================================
local QBCore = exports['qb-core']:GetCoreObject()

-- ox_lib-aware callback registrar (race-free) with QBCore fallback.
local function registerCallback(name, fn)
    if lib and lib.callback and lib.callback.register then
        lib.callback.register(name, fn)
    else
        QBCore.Functions.CreateCallback(name, function(source, cb, payload)
            cb(fn(source, payload))
        end)
    end
end

-- Returns the player's lb-phone contacts. Each entry: { name, number, ... }.
registerCallback('qb-banking:getMyContacts', function(source)
    if GetResourceState('lb-phone') ~= 'started' then return {} end

    -- Try to find the player's phone number first.
    local myNum
    pcall(function() myNum = exports['lb-phone']:GetEquippedPhoneNumber(source) end)

    -- GetContacts signature varies between lb-phone versions:
    --  - GetContacts(phoneNumber)  — most builds
    --  - GetContacts(source)       — some older builds
    -- We try with the phone number first, fall back to the source.
    local rows
    if myNum then
        pcall(function() rows = exports['lb-phone']:GetContacts(myNum) end)
    end
    if (not rows) or #rows == 0 then
        pcall(function() rows = exports['lb-phone']:GetContacts(source) end)
    end

    rows = rows or {}
    -- Normalise the field names so the UI can rely on { name, number }.
    local out = {}
    for _, c in ipairs(rows) do
        local name = c.name or c.display or c.contactName or ''
        local num  = c.number or c.phoneNumber or c.phone_number or ''
        if num ~= '' then
            out[#out+1] = { name = name, number = tostring(num) }
        end
    end
    return out
end)

-- Phone number → citizen ID. Used to translate a contact pick into something
-- qb-banking's transfer callback can consume (it accepts citizen_id).
registerCallback('qb-banking:resolvePhone', function(source, payload)
    if GetResourceState('lb-phone') ~= 'started' then return nil end
    local num = payload and payload.number
    if not num then return nil end

    local targetSrc
    pcall(function() targetSrc = exports['lb-phone']:GetSourceFromNumber(tostring(num)) end)
    if not targetSrc then
        -- Some builds call it differently; cover the common alternates.
        for _, fn in ipairs({ 'GetSource', 'GetSourceFromPhoneNumber' }) do
            pcall(function() targetSrc = exports['lb-phone'][fn](exports['lb-phone'], tostring(num)) end)
            if targetSrc then break end
        end
    end
    if not targetSrc then return nil end

    local Player = QBCore.Functions.GetPlayer(targetSrc)
    if not Player then return nil end
    return { citizenId = Player.PlayerData.citizenid }
end)
