-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
-- =========================================================
-- qb-banking : qb-target integration
--   - ATMs: target on the prop model (all 4 ATM types)
--   - Banks: target via BoxZone at the teller counter coordinates
-- =========================================================

CreateThread(function()
    while GetResourceState('qb-target') ~= 'started' do Wait(250) end

    -- ============== ATM (model-based) ==============
    -- Single option only: "Use ATM". Quick Balance is still available
    -- inside the ATM UI itself (when Config.ATM.quickBalanceEnabled is true),
    -- but it's not exposed as a separate target option.
    exports['qb-target']:AddTargetModel(Config.ATM.models, {
        options = {
            {
                type   = 'client',
                icon   = Config.ATM.icon or 'fas fa-credit-card',
                label  = 'Use ATM',
                action = function() exports['qb-banking']:OpenATM() end,
            },
        },
        distance = Config.ATM.targetDistance or 2.0,
    })

    -- ============== BANKS (BoxZone at each teller) ==============
    -- Bank zones show ONLY bank options. ATM options live exclusively
    -- on the ATM models. Going to a Fleeca will show banking options,
    -- not ATM options — those are only on physical ATM props.
    for i, b in ipairs(Config.BankLocations) do
        local zoneName = ('qb_banking_%d'):format(i)
        exports['qb-target']:AddBoxZone(zoneName,
            vec3(b.coords.x, b.coords.y, b.coords.z),
            b.length or 1.0,
            b.width  or 1.0,
            {
                name      = zoneName,
                heading   = b.coords.w or 0.0,
                debugPoly = false,
                minZ      = b.coords.z - 1.0,
                maxZ      = b.coords.z + 1.5,
            },
            {
                options = {
                    {
                        type   = 'client',
                        icon   = 'fas fa-university',
                        label  = ('Open %s'):format(b.label or 'Bank'),
                        action = function() exports['qb-banking']:OpenBank() end,
                    },
                },
                distance = 1.8,
            }
        )
    end
end)

-- cleanup on resource stop
AddEventHandler('onResourceStop', function(res)
    if res ~= GetCurrentResourceName() then return end
    if GetResourceState('qb-target') ~= 'started' then return end
    exports['qb-target']:RemoveTargetModel(Config.ATM.models, { 'Use ATM' })
    for i = 1, #Config.BankLocations do
        exports['qb-target']:RemoveZone(('qb_banking_%d'):format(i))
    end
end)
