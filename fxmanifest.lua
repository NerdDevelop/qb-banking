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
    'html/index.html',
    'html/style.css',
    'html/script.js',
    -- phone app UI (lb-phone iframe)
    'phone/ui/index.html',
    'phone/ui/style.css',
    'phone/ui/script.js',
}

dependencies {
    'qb-core',
    'oxmysql',
    'ox_lib',
    'qb-target',
    -- 'lb-phone' optional — only needed إذا تبي تطبيق الجوال يشتغل
}
