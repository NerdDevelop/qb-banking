-- ╔══════════════════════════════════════════════════════════╗
-- ║                  qb-banking — by Nerd                    ║
-- ║          Developed & maintained by Nerd Studio           ║
-- ║              Released under © Nerd 2026                  ║
-- ╚══════════════════════════════════════════════════════════╝
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'qb-banking'
author 'Sultan'
description 'qb-banking + qb-banking-phone (All-in-one): ATM, joint accounts, transfers, lb-phone app'
version '1.0.0'

shared_scripts {
    '@ox_lib/init.lua',
    'config.lua',
    'shared/locale.lua',
}

client_scripts {
    'client/main.lua',
    'client/target.lua',
    -- phone integration (qb-banking-phone, مدمج)
    'phone/client.lua',
}

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server/bootstrap.lua',
    'server/database.lua',
    'server/main.lua',
    'server/admin.lua',
    -- phone integration (qb-banking-phone, مدمج)
    'phone/server.lua',
}

ui_page 'html/index.html'

files {
    'html