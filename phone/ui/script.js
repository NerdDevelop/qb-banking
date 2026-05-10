/* ╔══════════════════════════════════════════════════════════╗
   ║                  qb-banking — by Nerd                    ║
   ║          Developed & maintained by Nerd Studio           ║
   ║              Released under © Nerd 2026                  ║
   ╚══════════════════════════════════════════════════════════╝ */
/* =====================================================
   qb-banking — UI logic
   - Adapts theme via [data-theme="dark|light|phone"] (set by lb-phone)
   - Locale: EN (default) + AR with one-tap switch
   - Communicates with client.lua via fetch + onNuiEvent
   ===================================================== */

(() => {
const RES = 'qb-banking';  // Always our resource, regardless of iframe parent.

// Cross-resource NUI request. lb-phone exposes globalThis.fetchNui(event,
// data, scriptName) which routes to ANY resource — needed because custom
// apps run inside lb-phone's iframe (window.GetParentResourceName would
// resolve to 'lb-phone'). We fall back to a plain fetch when running the
// UI standalone (e.g. in a browser preview).
const _rawPost = (name, data = {}) => {
    if (typeof globalThis.fetchNui === 'function') {
        return Promise.resolve(globalThis.fetchNui(name, data, RES))
            .then(r => (r === undefined ? null : r))
            .catch(() => null);
    }
    const parent = (typeof GetParentResourceName === 'function')
        ? GetParentResourceName() : RES;
    return fetch(`https://${parent}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }).then(r => r.json()).catch(() => null);
};

// Public post() — same signature, but auto-refreshes the UI on every
// `{ok: true}` response. This makes every state-mutating action (create
// account, transfer, delete, change PIN, customise icon, invite, leave,
// claim frozen, etc.) IMMEDIATELY reflect in the UI, regardless of
// whether the server's asynchronous snapshot push reached us. The cost
// is one extra round-trip per action — negligible vs UX correctness.
const post = (name, data = {}) => {
    return _rawPost(name, data).then(r => {
        if (r && r.ok === true && typeof refresh === 'function') {
            // fire-and-forget — never block the action's result
            try { refresh(); } catch (e) {}
        }
        return r;
    });
};

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');

/* =====================================================
   STATE
   ===================================================== */
const state = {
    accounts: [],
    contacts: [],          // qb-banking saved contacts (legacy, unused in this build)
    phoneContacts: [],     // contacts pulled from lb-phone
    pickedContact: null,   // selected contact for current send: { name, number }
    invites:  [],          // pending joint-account invitations
    viewingAccountId: null,// account currently shown on the detail page
    cash:     0,
    frozen:   0,
    tier:     null,
    tab:      'home',
    sendType: 'phone_contact',
    histAccountId: null,
    lang:     'en',
    privacy:  false,    // hide all money values when true
};

// Account customization whitelist — must match qb-banking server-side
const ICONS  = ['fa-user','fa-users','fa-house','fa-car','fa-briefcase','fa-piggy-bank',
                'fa-vault','fa-gem','fa-plane','fa-shop','fa-graduation-cap','fa-heart',
                'fa-star','fa-gun','fa-cake-candles','fa-coins','fa-snowflake','fa-crown'];
const COLORS = ['green','blue','purple','orange','cyan','red','gold'];

/* =====================================================
   ICON / TINT HELPERS
   Mirrors the qb-banking (NUI) renderer so customisations the player set
   in the bank — chosen icon and chosen color — appear identically in the
   phone app. Priority: frozen → user color → joint default → individual.
   ===================================================== */
function iconNameOf(a) {
    if (!a) return 'fa-user';
    return a.icon
        || (a.frozen ? 'fa-snowflake'
            : (a.type === 'joint' ? 'fa-users' : 'fa-user'));
}
function tintClassOf(a) {
    if (!a) return '';
    if (a.frozen)   return 'frozen';
    if (a.color)    return `tint-${a.color}`;
    if (a.type === 'joint') return 'joint';
    return '';          // bare default — picks up brand pink via theme CSS
}

// "I am the owner of this account" — qb-banking exposes `myRole` per
// account ("owner" / "member"). Individual accounts get 'owner' by default.
const isOwner = (a) => !!a && a.myRole !== 'member';

/* =====================================================
   LOCALE
   ===================================================== */
const I18N = {
    en: {
        appName:        'Fleeca Bank',
        totalBalance:   'Total Balance',
        cash:           'Cash',
        accounts:       'Accounts',
        frozen:         'Frozen',
        claim:          'Claim',
        yourAccounts:   "Your Accounts",
        noAccounts:     'No accounts yet',
        visitBank:      'Visit a Fleeca to open one',
        send:           'Send',
        sendMoney:      'Send Money',
        from:           'From Account',
        recipientType:  'Recipient',
        playerId:       'Player ID',
        citizenId:      'Citizen ID',
        amount:         'Amount',
        pin:            'PIN',
        sendBtn:        'Send Transfer',
        history:        'History',
        noHistory:      'No transactions',
        home:           'Home',
        cancel:         'Cancel',
        confirm:        'Confirm',
        deposit:        'Deposit',
        withdraw:       'Withdraw',
        depositTitle:   'Deposit to {name}',
        withdrawTitle:  'Withdraw from {name}',
        claimTitle:     'Claim Frozen Balance',
        claimDest:      'Destination',
        cashOption:     'Cash',
        bankOption:     'Bank Account',
        chooseAccount:  'Choose Account',
        depositInfo:    'Cash from your wallet will be transferred into this account.',
        withdrawInfo:   'Withdrawing requires the PIN of this account.',
        claimInfo:      'Send the frozen balance to your wallet (cash) or one of your bank accounts.',
        primary:        'Primary',
        // history kinds
        deposit_:       'Deposit',
        withdraw_:      'Withdraw',
        transfer_in:    'Received',
        transfer_out:   'Sent',
        internal_in:    'Internal In',
        internal_out:   'Internal Out',
        admin:          'Admin',
        // errors
        err_no_money:        'Not enough cash',
        err_no_balance:      'Not enough balance',
        err_invalid_account: 'Invalid account',
        err_invalid_target:  'Recipient not found',
        err_self_transfer:   'Cannot send to yourself',
        err_invalid_amount:  'Invalid amount',
        err_pin_format:      'PIN must be 4 digits',
        err_invalid_pin:     'Wrong PIN',
        err_locked:          'Account locked. Try again later',
        err_account_frozen:  'Account is frozen',
        err_daily_limit:     'Daily ATM limit reached',
        err_required:        'This field is required',
        ok_deposit:          'Deposited {amt}',
        ok_withdraw:         'Withdrew {amt}',
        ok_transfer:         'Sent {amt}',
        ok_claim:            'Claimed {amt}',
        hideBalance:         'Hide balance',
        showBalance:         'Show balance',
        refresh:             'Refresh',
        hidden:              'Balance hidden',
        shown:               'Balance shown',
        // settings & new flows
        settings:            'Settings',
        createAccount:       'Create Account',
        createAccountSub:    'Open a new individual or joint account',
        changePin:           'Change PIN',
        changePinSub:        'Update the 4-digit PIN of an account',
        aboutApp:            'About',
        accountName:         'Account Name',
        accountType:         'Account Type',
        individual:          'Individual',
        joint:               'Joint',
        confirmPin:          'Confirm PIN',
        oldPin:              'Current PIN',
        newPin:              'New PIN',
        createBtn:           'Create',
        ok_account_created:  'Account created',
        ok_pin_changed:      'PIN changed',
        err_pin_mismatch:    'PINs do not match',
        err_max_accounts:    'Reached max accounts',
        err_unknown:         'Something went wrong',
        // contact picker
        phoneContact:        'Contact',
        tapToChoose:         'Tap to choose a contact',
        searchContacts:      'Search contacts',
        noContacts:          'No contacts saved on phone',
        contactNotPlayer:    'This number is not registered to any player',
        sendFromAccount:     'Send Money',
        accountFrozenShort:  'Frozen',
        aboutTitle:          'About Fleeca Bank',
        aboutBody:           'Manage your accounts, transfer money to friends from your contacts, and review your transaction history. Withdraw and deposit are available at any Fleeca branch or ATM.',
        // groups
        quickActions:        'Quick Actions',
        manageAccounts:      'Manage Accounts',
        app:                 'App',
        // per-account actions
        rename:              'Rename Account',
        renameSub:           'Change the display name',
        iconColor:           'Icon & Color',
        iconColorSub:        'Personalize how it looks',
        changePinSub2:       'Update with the current PIN',
        forgotPin:           'Forgot PIN',
        forgotPinSub:        'Reset without knowing the old one',
        setPrimary:          'Set as Primary',
        setPrimarySub:       'Pin to the top of your list',
        unsetPrimary:        'Already Primary',
        members:             'Members',
        membersSub:          'View and manage members',
        invite:              'Invite Player',
        inviteSub:           'Add someone to this joint account',
        leaveAccount:        'Leave Account',
        leaveAccountSub:     'Stop being a member',
        closeAccount:        'Close Account',
        closeAccountSub:     'Permanently delete · balance becomes frozen',
        ownerRole:           'Owner',
        memberRole:          'Member',
        owner:               'Owner',
        // invites
        pendingInvites:      'Pending Invitations',
        invitesCount:        '{n} pending',
        accept:              'Accept',
        decline:             'Decline',
        from:                'From',
        // misc
        tapToSelect:         'Tap to select',
        chooseIcon:          'Choose an Icon',
        chooseColor:         'Choose a Color',
        renameTitle:         'Rename {name}',
        customizeTitle:      'Customize {name}',
        membersTitle:        'Members of {name}',
        inviteTitle:         'Invite to {name}',
        closeAcctTitle:      'Close {name}',
        forgotPinTitle:      'Reset PIN for {name}',
        leaveTitle:          'Leave {name}',
        closeWarn:           'This deletes the account permanently. The balance becomes a frozen balance you can claim later as cash or into another account.',
        leaveWarn:           'You will lose access to this joint account. Only the owner can re-add you.',
        forgotPinWarn:       'Only the account owner can reset the PIN. The new PIN will replace the old one without verification.',
        currentBalance:      'Current Balance',
        memberOf:            'Member of {n} accounts',
        ownerOf:             'Owner of {n} accounts',
        kick:                'Remove',
        save:                'Save',
        ok_renamed:          'Account renamed',
        ok_customized:       'Updated',
        ok_primary_set:      'Set as primary',
        ok_invite_sent:      'Invitation sent',
        ok_invite_accepted:  'Joined account',
        ok_invite_declined:  'Invitation declined',
        ok_left_account:     'Left the account',
        ok_member_removed:   'Member removed',
        ok_account_closed:   'Account closed',
        ok_pin_reset:        'PIN reset',
        err_unauthorized:    'Only the owner can do this',
        err_max_members:     'Account is full',
        err_already_member:  'Already a member',
        err_invite_pending:  'Invitation already pending',
        active:              'Active',
    },
    ar: {
        appName:        'بنك فليكا',
        totalBalance:   'الرصيد الإجمالي',
        cash:           'كاش',
        accounts:       'الحسابات',
        frozen:         'مجمّد',
        claim:          'استرجاع',
        yourAccounts:   'حساباتك',
        noAccounts:     'لا توجد حسابات بعد',
        visitBank:      'زر أحد فروع فليكا لفتح حساب',
        send:           'تحويل',
        sendMoney:      'إرسال أموال',
        from:           'من حساب',
        recipientType:  'المستلم',
        playerId:       'رقم اللاعب',
        citizenId:      'الرقم المدني',
        amount:         'المبلغ',
        pin:            'الرمز',
        sendBtn:        'إرسال التحويل',
        history:        'السجل',
        noHistory:      'لا توجد معاملات',
        home:           'الرئيسية',
        cancel:         'إلغاء',
        confirm:        'تأكيد',
        deposit:        'إيداع',
        withdraw:       'سحب',
        depositTitle:   'إيداع في {name}',
        withdrawTitle:  'سحب من {name}',
        claimTitle:     'استرجاع الرصيد المجمّد',
        claimDest:      'الوجهة',
        cashOption:     'كاش',
        bankOption:     'حساب بنكي',
        chooseAccount:  'اختر الحساب',
        depositInfo:    'الكاش من جيبك راح ينتقل لهذا الحساب.',
        withdrawInfo:   'السحب يحتاج رمز الحساب.',
        claimInfo:      'حوّل الرصيد المجمّد إلى الكاش أو لأحد حساباتك البنكية.',
        primary:        'رئيسي',
        deposit_:       'إيداع',
        withdraw_:      'سحب',
        transfer_in:    'استلمت',
        transfer_out:   'أرسلت',
        internal_in:    'تحويل داخلي - وارد',
        internal_out:   'تحويل داخلي - صادر',
        admin:          'إدارة',
        err_no_money:        'الكاش غير كافٍ',
        err_no_balance:      'الرصيد غير كافٍ',
        err_invalid_account: 'حساب غير صالح',
        err_invalid_target:  'المستلم غير موجود',
        err_self_transfer:   'لا يمكنك التحويل لنفسك',
        err_invalid_amount:  'مبلغ غير صالح',
        err_pin_format:      'الرمز يجب أن يكون 4 أرقام',
        err_invalid_pin:     'رمز خاطئ',
        err_locked:          'الحساب مقفل، حاول لاحقاً',
        err_account_frozen:  'الحساب مجمّد',
        err_daily_limit:     'تجاوزت الحد اليومي للسحب من الصراف',
        err_required:        'هذا الحقل مطلوب',
        ok_deposit:          'تم إيداع {amt}',
        ok_withdraw:         'تم سحب {amt}',
        ok_transfer:         'تم إرسال {amt}',
        ok_claim:            'تم استرجاع {amt}',
        hideBalance:         'إخفاء الرصيد',
        showBalance:         'إظهار الرصيد',
        refresh:             'تحديث',
        hidden:              'تم إخفاء الرصيد',
        shown:               'تم إظهار الرصيد',
        // settings & new flows
        settings:            'الإعدادات',
        createAccount:       'إنشاء حساب',
        createAccountSub:    'افتح حساباً فردياً أو مشتركاً جديداً',
        changePin:           'تغيير الرمز',
        changePinSub:        'تحديث الرمز السري المكون من 4 أرقام',
        aboutApp:            'عن التطبيق',
        accountName:         'اسم الحساب',
        accountType:         'نوع الحساب',
        individual:          'فردي',
        joint:               'مشترك',
        confirmPin:          'تأكيد الرمز',
        oldPin:              'الرمز الحالي',
        newPin:              'الرمز الجديد',
        createBtn:           'إنشاء',
        ok_account_created:  'تم إنشاء الحساب',
        ok_pin_changed:      'تم تغيير الرمز',
        err_pin_mismatch:    'الرموز غير متطابقة',
        err_max_accounts:    'وصلت إلى الحد الأقصى من الحسابات',
        err_unknown:         'حصل خطأ غير متوقع',
        // contact picker
        phoneContact:        'جهة اتصال',
        tapToChoose:         'اضغط لاختيار جهة اتصال',
        searchContacts:      'ابحث في جهات الاتصال',
        noContacts:          'لا توجد جهات اتصال محفوظة',
        contactNotPlayer:    'هذا الرقم غير مسجل لأي لاعب',
        sendFromAccount:     'إرسال أموال',
        accountFrozenShort:  'مجمّد',
        aboutTitle:          'عن بنك باسيفيك',
        aboutBody:           'أدر حساباتك، حوّل الأموال لأصدقائك من جهات اتصالك، واطلع على سجل معاملاتك. السحب والإيداع متاحان من أي فرع فليكا أو صراف آلي.',
        quickActions:        'إجراءات سريعة',
        manageAccounts:      'إدارة الحسابات',
        app:                 'التطبيق',
        rename:              'تغيير اسم الحساب',
        renameSub:           'غيّر الاسم الظاهر',
        iconColor:           'الأيقونة واللون',
        iconColorSub:        'خصّص شكل الحساب',
        changePinSub2:       'حدّث الرمز بمعرفة الرمز الحالي',
        forgotPin:           'نسيت الرمز',
        forgotPinSub:        'إعادة تعيين بدون الرمز القديم',
        setPrimary:          'تعيين كرئيسي',
        setPrimarySub:       'يثبت في أعلى القائمة',
        unsetPrimary:        'حالياً رئيسي',
        members:             'الأعضاء',
        membersSub:          'استعراض وإدارة الأعضاء',
        invite:              'دعوة لاعب',
        inviteSub:           'أضف شخصاً لهذا الحساب المشترك',
        leaveAccount:        'مغادرة الحساب',
        leaveAccountSub:     'التوقف عن كونك عضواً',
        closeAccount:        'إغلاق الحساب',
        closeAccountSub:     'حذف نهائي · الرصيد يصبح مجمّداً',
        ownerRole:           'المالك',
        memberRole:          'عضو',
        owner:               'المالك',
        pendingInvites:      'دعوات معلّقة',
        invitesCount:        '{n} معلّقة',
        accept:              'قبول',
        decline:             'رفض',
        from:                'من',
        tapToSelect:         'اضغط للاختيار',
        chooseIcon:          'اختر أيقونة',
        chooseColor:         'اختر لوناً',
        renameTitle:         'إعادة تسمية {name}',
        customizeTitle:      'تخصيص {name}',
        membersTitle:        'أعضاء {name}',
        inviteTitle:         'دعوة إلى {name}',
        closeAcctTitle:      'إغلاق {name}',
        forgotPinTitle:      'إعادة تعيين رمز {name}',
        leaveTitle:          'مغادرة {name}',
        closeWarn:           'هذا يحذف الحساب نهائياً. الرصيد يصبح رصيداً مجمّداً تقدر تستلمه لاحقاً كاش أو في حساب آخر.',
        leaveWarn:           'راح تفقد الوصول لهذا الحساب المشترك. المالك فقط يقدر يضيفك مرة أخرى.',
        forgotPinWarn:       'فقط مالك الحساب يقدر يعيد تعيين الرمز. الرمز الجديد يستبدل القديم بدون تحقق.',
        currentBalance:      'الرصيد الحالي',
        memberOf:            'عضو في {n} حسابات',
        ownerOf:             'مالك {n} حسابات',
        kick:                'إزالة',
        save:                'حفظ',
        ok_renamed:          'تمت إعادة تسمية الحساب',
        ok_customized:       'تم التحديث',
        ok_primary_set:      'تم التعيين كرئيسي',
        ok_invite_sent:      'تم إرسال الدعوة',
        ok_invite_accepted:  'انضممت للحساب',
        ok_invite_declined:  'تم رفض الدعوة',
        ok_left_account:     'تمت المغادرة',
        ok_member_removed:   'تمت إزالة العضو',
        ok_account_closed:   'تم إغلاق الحساب',
        ok_pin_reset:        'تمت إعادة تعيين الرمز',
        err_unauthorized:    'فقط المالك يقدر يسوي هذا',
        err_max_members:     'الحساب ممتلئ',
        err_already_member:  'أصلاً عضو',
        err_invite_pending:  'دعوة معلّقة بالفعل',
        active:              'نشط',
    },
};

const t = (key, vars = {}) => {
    let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
    Object.entries(vars).forEach(([k, v]) => { s = s.replace('{' + k + '}', v); });
    return s;
};

function applyLocale() {
    // The phone owns dir via its own theme — we set our iframe's dir to
    // match so layouts mirror correctly when the phone is in Arabic.
    document.documentElement.setAttribute('lang', state.lang);
    document.documentElement.setAttribute('dir', state.lang === 'ar' ? 'rtl' : 'ltr');
    // Walk every element marked translatable and update its text/title.
    // We do NOT call render*() here — that would wipe the list DOM and
    // cause a visible flash. The renderers themselves drop data-i18n
    // attributes on translatable bits so this walker covers them too.
    $$('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        el.textContent = t(key);
    });
    $$('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        el.title = t(key);
    });
    syncPrivacyTitle();
}

// Mask money values when privacy is on. Used by every renderer that prints
// a $ amount.
function money(n) {
    if (state.privacy) return '$ • • • •';
    return '$' + fmt(n);
}

function syncPrivacyTitle() {
    const btn = $('#privacyBtn');
    if (btn) btn.title = state.privacy ? t('showBalance') : t('hideBalance');
}

/* =====================================================
   UTILITIES
   ===================================================== */
const errorKeyMap = {
    no_money:        'err_no_money',
    no_balance:      'err_no_balance',
    invalid_account: 'err_invalid_account',
    invalid_target:  'err_invalid_target',
    self_transfer:   'err_self_transfer',
    invalid_amount:  'err_invalid_amount',
    pin_format:      'err_pin_format',
    invalid_pin:     'err_invalid_pin',
    locked:          'err_locked',
    locked_now:      'err_locked',
    frozen:          'err_account_frozen',
    daily_limit:     'err_daily_limit',
    max_accounts:    'err_max_accounts',
    pin_mismatch:    'err_pin_mismatch',
    unauthorized:    'err_unauthorized',
    max_members:     'err_max_members',
    already_member:  'err_already_member',
    invite_pending:  'err_invite_pending',
    unknown:         'err_unknown',
};
const formatErr = (res) => {
    if (!res) return 'Network error';
    if (res.detail) return String(res.detail).split('\n')[0];
    const k = errorKeyMap[res.err];
    return k ? t(k) : (res.err || 'Error');
};

/* =====================================================
   TOAST
   ===================================================== */
let toastTimer;
function toast(msg, kind = 'info') {
    const el = $('#toast');
    el.className = `toast ${kind}`;
    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
    el.innerHTML = `<i class="fas ${icons[kind] || icons.info}"></i><span>${msg}</span>`;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

/* =====================================================
   RENDERERS
   ===================================================== */
function renderHero() {
    const total = state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    $('#totalBalance').textContent = money(total);
    $('#hdrCash').textContent      = money(state.cash);
    $('#hdrAccounts').textContent  = state.accounts.length;

    // Tier chip — colored class + hidden when empty (CSS :empty)
    const tierEl = $('#hdrTier');
    if (tierEl) {
        if (state.tier && state.tier.name && state.tier.id !== 'standard') {
            tierEl.textContent = state.tier.name;
            tierEl.className = 'hdr-tier ' + (state.tier.id || '');
        } else {
            tierEl.textContent = '';
            tierEl.className = 'hdr-tier';
        }
    }

    const frozen = Number(state.frozen) || 0;
    $('#frozenPill').classList.toggle('hidden', frozen <= 0);
    $('#frozenValue').textContent = money(frozen);
}

function renderAccounts() {
    const list = $('#accList');
    markFresh(list);
    if (!state.accounts.length) {
        list.innerHTML = `
            <div class="empty">
                <i class="fas fa-folder-open"></i>
                <div>${t('noAccounts')}</div>
                <div class="empty-sub">${t('visitBank')}</div>
            </div>`;
        return;
    }
    list.innerHTML = '';
    state.accounts.forEach(a => {
        const card = document.createElement('div');
        card.className = 'acc-card' + (a.frozen ? ' frozen-card' : '');
        // Match the bank: frozen → cyan, custom color → that color,
        // joint → purple, individual → brand default.
        const iconClass = tintClassOf(a);
        const iconName  = iconNameOf(a);
        // Translatable label keys — set as data-i18n so applyLocale() can
        // re-translate them in place when the user flips the phone language,
        // WITHOUT us having to rebuild the DOM.
        const tagKey = a.frozen ? 'accountFrozenShort'
                     : a.isPrimary ? 'primary'
                     : (a.type === 'joint' ? 'joint' : 'individual');
        const tag = a.frozen
            ? `<span class="acc-tag" style="color:var(--c-cyan);background:var(--c-cyan-bg)"><i class="fas fa-snowflake"></i> <span data-i18n="${tagKey}">${t(tagKey)}</span></span>`
            : (a.isPrimary
                ? `<span class="acc-tag primary"><i class="fas fa-star"></i> <span data-i18n="${tagKey}">${t(tagKey)}</span></span>`
                : `<span class="acc-tag" data-i18n="${tagKey}">${t(tagKey)}</span>`);
        card.innerHTML = `
            <div class="acc-top">
                <div class="acc-name">
                    <div class="acc-icon ${iconClass}"><i class="fas ${iconName}"></i></div>
                    <span>${a.name}</span>
                </div>
                ${tag}
            </div>
            <div class="acc-num">${a.accountNumber}</div>
            <div class="acc-balance">${money(a.balance)}</div>
            <button class="acc-send" data-id="${a.id}" ${a.frozen ? 'disabled' : ''}>
                <i class="fas fa-paper-plane"></i> <span data-i18n="sendFromAccount">${t('sendFromAccount')}</span>
            </button>
        `;
        const btn = card.querySelector('.acc-send');
        if (btn) btn.onclick = () => {
            if (a.frozen) { toast(t('err_account_frozen'), 'error'); return; }
            // Pre-fill the From account on the Send page and switch to it.
            setTab('send');
            const sel = $('#sendFrom');
            if (sel) sel.value = String(a.id);
        };
        list.appendChild(card);
    });
}

function refreshSendForm() {
    const sel = $('#sendFrom');
    sel.innerHTML = state.accounts
        .filter(a => !a.frozen)
        .map(a => `<option value="${a.id}">${a.name} — ${a.accountNumber} (${money(a.balance)})</option>`)
        .join('');
    updateSendLabel();
}

function updateSendLabel() {
    // Toggle visibility: contact picker for phone_contact, plain input for the rest
    const isContact = state.sendType === 'phone_contact';
    const targetWrap  = $('#sendTargetWrap');
    const contactWrap = $('#sendContactWrap');
    if (targetWrap)  targetWrap.classList.toggle('hidden',  isContact);
    if (contactWrap) contactWrap.classList.toggle('hidden', !isContact);

    if (!isContact) {
        $('#sendTargetLabel').textContent = state.sendType === 'player_id'
            ? t('playerId') : t('citizenId');
        $('#sendTarget').placeholder = state.sendType === 'player_id' ? '4' : 'ABC12345';
    } else {
        // Render the picker button label from the picked contact (if any).
        renderPickedContact();
    }
}

function renderPickedContact() {
    const btn   = $('#contactPickBtn');
    const name  = $('#contactPickedName');
    const num   = $('#contactPickedNum');
    if (!btn || !name || !num) return;
    if (state.pickedContact) {
        btn.classList.remove('empty');
        name.textContent = state.pickedContact.name || '';
        num.textContent  = state.pickedContact.number || '';
    } else {
        btn.classList.add('empty');
        name.textContent = t('tapToChoose');
        num.textContent  = '';
    }
}

function fillHistorySelect() {
    const sel = $('#histAcc');
    sel.innerHTML = state.accounts
        .map(a => `<option value="${a.id}">${a.name}</option>`)
        .join('');
    if (state.histAccountId && state.accounts.some(a => a.id === state.histAccountId)) {
        sel.value = state.histAccountId;
    } else if (state.accounts[0]) {
        sel.value = state.accounts[0].id;
        state.histAccountId = state.accounts[0].id;
    }
}

async function renderHistory() {
    fillHistorySelect();
    const list = $('#histList');
    markFresh(list);
    if (!state.accounts.length) {
        list.innerHTML = `<div class="empty"><i class="fas fa-receipt"></i><div>${t('noHistory')}</div></div>`;
        return;
    }
    if (!state.histAccountId) state.histAccountId = state.accounts[0].id;
    list.innerHTML = `<div class="empty"><i class="fas fa-spinner fa-spin"></i></div>`;
    const rows = await post('phone_transactions', { accountId: state.histAccountId });
    if (!Array.isArray(rows) || !rows.length) {
        list.innerHTML = `<div class="empty"><i class="fas fa-receipt"></i><div>${t('noHistory')}</div></div>`;
        return;
    }
    // Translation key per transaction kind. Stored as data-i18n on the
    // title element so applyLocale() can re-translate on language flip.
    const labelKey = {
        deposit:      'deposit_',
        withdraw:     'withdraw_',
        transfer_in:  'transfer_in',
        transfer_out: 'transfer_out',
        internal_in:  'internal_in',
        internal_out: 'internal_out',
        admin:        'admin',
    };
    const iconMap = {
        deposit: 'fa-arrow-up', withdraw: 'fa-arrow-down',
        transfer_in: 'fa-arrow-up', transfer_out: 'fa-arrow-down',
        internal_in: 'fa-arrow-right-arrow-left', internal_out: 'fa-arrow-right-arrow-left',
        admin: 'fa-screwdriver-wrench',
    };
    list.innerHTML = '';
    rows.forEach(r => {
        const isIn  = r.kind === 'deposit' || r.kind === 'transfer_in' || r.kind === 'internal_in';
        const isOut = r.kind === 'withdraw' || r.kind === 'transfer_out' || r.kind === 'internal_out';
        const cls   = isIn ? 'in' : (isOut ? 'out' : (r.kind === 'admin' ? 'adm' : 'int'));
        const sign  = isIn ? '+' : (isOut ? '−' : '');
        const item  = document.createElement('div');
        item.className = 'hist-item';
        const dateStr = (r.created_at !== null && r.created_at !== undefined)
            ? (typeof r.created_at === 'number'
                ? new Date(r.created_at > 1e12 ? r.created_at : r.created_at * 1000).toISOString().slice(0,16).replace('T',' ')
                : String(r.created_at).replace('T', ' ').replace(/\..*$/, '').slice(0, 16))
            : '';
        const key = labelKey[r.kind] || r.kind;
        item.innerHTML = `
            <div class="hist-icon ${cls}"><i class="fas ${iconMap[r.kind] || 'fa-circle'}"></i></div>
            <div class="hist-info">
                <div class="hist-title"><span data-i18n="${key}">${t(key)}</span>${r.target_label ? ` · ${r.target_label}` : ''}</div>
                <div class="hist-meta">${dateStr}</div>
            </div>
            <div class="hist-amt ${isIn ? 'pos' : (isOut ? 'neg' : '')}">${sign}${money(r.amount)}</div>
        `;
        list.appendChild(item);
    });
}

/* =====================================================
   MODAL HELPERS
   ===================================================== */
function showModal(title, bodyHTML, onOk, opts = {}) {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML;
    $('#modalOk').textContent = opts.okLabel || t('confirm');
    m.classList.remove('hidden');
    $('#modalOk').onclick    = () => onOk(closeModal);
    $('#modalCancel').onclick= closeModal;
    $('#modalClose').onclick = closeModal;
}
function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalOk').onclick = null;
    $('#modalCancel').onclick = null;
    $('#modalClose').onclick = null;
    // Restore the OK button — the contact picker hides it.
    const okBtn = $('#modalOk'); if (okBtn) okBtn.style.display = '';
}

// Deposit / Withdraw modals were intentionally removed: the phone app is
// transfer-only. Users go to a Fleeca branch or ATM for cash operations.

function openClaimModal() {
    const total = Number(state.frozen) || 0;
    if (total <= 0) return;
    const eligible = state.accounts.filter(a => !a.frozen);
    const accountOptions = eligible.length
        ? eligible.map(a => `<option value="${a.id}">${a.name} — ${a.accountNumber} (${money(a.balance)})</option>`).join('')
        : `<option value="" disabled>${t('noAccounts')}</option>`;
    showModal(t('claimTitle'), `
        <div class="opt-banner">
            <i class="fas fa-info-circle"></i>
            <span>${t('claimInfo')}</span>
        </div>
        <div class="hero-value" style="text-align:center;font-size:1.8rem;color:var(--c-cyan);margin-bottom:0.8rem;">
            ${money(total)}
        </div>
        <div class="field">
            <label>${t('claimDest')}</label>
            <div class="seg" id="cDest">
                <button class="seg-btn active" data-dest="cash"><i class="fas fa-wallet"></i> ${t('cashOption')}</button>
                <button class="seg-btn"        data-dest="bank"><i class="fas fa-vault"></i> ${t('bankOption')}</button>
            </div>
        </div>
        <div class="field hidden" id="cAccWrap">
            <label>${t('chooseAccount')}</label>
            <select id="cAcc">${accountOptions}</select>
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const dest = $('#cDest .seg-btn.active').dataset.dest;
        const payload = { destType: dest };
        if (dest === 'bank') {
            const id = parseInt($('#cAcc').value, 10);
            if (!id) { $('#mErr').textContent = t('err_invalid_account'); return; }
            payload.accountId = id;
        }
        const res = await post('phone_claimFrozen', payload);
        if (res && res.ok) {
            toast(t('ok_claim', { amt: '$' + fmt(res.amount || total) }), 'success');
            close();
        } else {
            $('#mErr').textContent = formatErr(res);
        }
    });
    $$('#cDest .seg-btn').forEach(b => b.onclick = () => {
        $$('#cDest .seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        $('#cAccWrap').classList.toggle('hidden', b.dataset.dest !== 'bank');
    });
}

/* =====================================================
   SEND TRANSFER
   ===================================================== */
async function submitSend() {
    $('#sendError').textContent = '';
    const fromAccountId = parseInt($('#sendFrom').value, 10);
    const amount        = parseInt($('#sendAmount').value, 10);
    const pin           = $('#sendPin').value;

    let targetType  = state.sendType;
    let targetValue = '';

    if (state.sendType === 'phone_contact') {
        if (!state.pickedContact || !state.pickedContact.number) {
            $('#sendError').textContent = t('err_required'); return;
        }
        // Resolve the phone number to a citizen ID so we can hand it to
        // qb-banking's existing transfer callback (which only knows
        // about player_id / citizen_id targets).
        const lookup = await post('resolvePhoneNumber', { number: state.pickedContact.number });
        if (!lookup || !lookup.citizenId) {
            $('#sendError').textContent = t('contactNotPlayer'); return;
        }
        targetType  = 'citizen_id';
        targetValue = lookup.citizenId;
    } else {
        targetValue = $('#sendTarget').value.trim();
        if (!targetValue) { $('#sendError').textContent = t('err_required'); return; }
    }

    if (!amount || amount <= 0) { $('#sendError').textContent = t('err_invalid_amount'); return; }
    if (pin.length !== 4 || !/^\d+$/.test(pin)) { $('#sendError').textContent = t('err_pin_format'); return; }

    const res = await post('phone_transfer', { fromAccountId, targetType, targetValue, amount, pin });
    if (res && res.ok) {
        toast(t('ok_transfer', { amt: '$' + fmt(amount) }), 'success');
        $('#sendTarget').value = '';
        $('#sendAmount').value = '';
        $('#sendPin').value    = '';
        state.pickedContact    = null;
        renderPickedContact();
        setTab('home');
    } else {
        $('#sendError').textContent = formatErr(res);
    }
}

/* =====================================================
   CONTACT PICKER — opens a modal with the player's lb-phone contacts
   ===================================================== */
function avatarOf(name) {
    const p = String(name || '').trim().split(/\s+/);
    const a = (p[0] || ' ').slice(0, 1);
    const b = (p[1] || '').slice(0, 1);
    return (a + b).toUpperCase() || '?';
}

async function openContactsPicker() {
    showModal(t('phoneContact'), `
        <div class="contact-search">
            <i class="fas fa-search"></i>
            <input id="contactSearch" placeholder="${t('searchContacts')}">
        </div>
        <div class="contact-list" id="contactList">
            <div class="empty"><i class="fas fa-spinner fa-spin"></i></div>
        </div>
    `, () => {});
    // Hide the OK button — selection happens by tapping a row.
    const okBtn = $('#modalOk');
    if (okBtn) okBtn.style.display = 'none';

    const rows = await post('getPhoneContacts');
    state.phoneContacts = Array.isArray(rows) ? rows : [];
    drawContactList(state.phoneContacts);

    const search = $('#contactSearch');
    if (search) {
        search.oninput = () => {
            const q = search.value.toLowerCase().trim();
            const filtered = !q
                ? state.phoneContacts
                : state.phoneContacts.filter(c =>
                    (c.name || '').toLowerCase().includes(q) ||
                    String(c.number || '').includes(q));
            drawContactList(filtered);
        };
    }
}

function drawContactList(rows) {
    const wrap = $('#contactList');
    if (!wrap) return;
    if (!rows.length) {
        wrap.innerHTML = `<div class="empty"><i class="fas fa-address-book"></i><div>${t('noContacts')}</div></div>`;
        return;
    }
    wrap.innerHTML = '';
    rows.forEach(c => {
        const item = document.createElement('button');
        item.className = 'contact-item';
        item.innerHTML = `
            <div class="contact-avatar">${avatarOf(c.name)}</div>
            <div class="contact-info">
                <div class="contact-name">${c.name || '—'}</div>
                <div class="contact-num">${c.number || ''}</div>
            </div>
        `;
        item.onclick = () => {
            state.pickedContact = { name: c.name || '', number: c.number || '' };
            renderPickedContact();
            // Restore the OK button for any future modal use, then close.
            const okBtn2 = $('#modalOk'); if (okBtn2) okBtn2.style.display = '';
            closeModal();
        };
        wrap.appendChild(item);
    });
}

/* =====================================================
   SETTINGS FLOWS — create account, change PIN, about
   ===================================================== */
function openCreateAccountModal() {
    showModal(t('createAccount'), `
        <div class="field">
            <label>${t('accountName')}</label>
            <input type="text" id="cName" maxlength="32" placeholder="My Savings">
        </div>
        <div class="field">
            <label>${t('accountType')}</label>
            <div class="seg" id="cType">
                <button class="seg-btn active" data-tt="individual">${t('individual')}</button>
                <button class="seg-btn"        data-tt="joint">${t('joint')}</button>
            </div>
        </div>
        <div class="field">
            <label>${t('newPin')}</label>
            <input type="password" id="cPin1" maxlength="4" placeholder="••••">
        </div>
        <div class="field">
            <label>${t('confirmPin')}</label>
            <input type="password" id="cPin2" maxlength="4" placeholder="••••">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const name = $('#cName').value.trim();
        const type = ($('#cType .seg-btn.active') || {}).dataset
                  ? ($('#cType .seg-btn.active').dataset.tt) : 'individual';
        const p1 = $('#cPin1').value;
        const p2 = $('#cPin2').value;
        if (!name) { $('#mErr').textContent = t('err_required'); return; }
        if (p1.length !== 4 || !/^\d+$/.test(p1)) { $('#mErr').textContent = t('err_pin_format'); return; }
        if (p1 !== p2) { $('#mErr').textContent = t('err_pin_mismatch'); return; }

        const res = await post('phone_createAccount', { name, type, pin: p1 });
        if (res && res.ok) {
            toast(t('ok_account_created'), 'success');
            close();
        } else {
            $('#mErr').textContent = formatErr(res);
        }
    }, { okLabel: t('createBtn') });

    $$('#cType .seg-btn').forEach(b => b.onclick = () => {
        $$('#cType .seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
    });
    setTimeout(() => $('#cName').focus(), 50);
}

// Legacy (generic) change-PIN modal removed — Settings now opens the
// per-account drawer where each account has its own Change PIN row.

function openAboutModal() {
    showModal(t('aboutTitle'), `
        <div class="opt-banner">
            <i class="fas fa-circle-info"></i>
            <span>${t('aboutBody')}</span>
        </div>
        <div style="text-align:center;color:var(--c-text-dim);font-size:0.9rem;margin-top:0.4rem;">
            Fleeca Bank · v1.0.0
        </div>
    `, (close) => close(), { okLabel: t('confirm') });
}

/* =====================================================
   SETTINGS PAGE — accounts list + invites badge
   ===================================================== */
function renderSettings() {
    // accounts list
    const list = $('#acctMgmtList');
    if (!list) return;
    markFresh(list);
    if (!state.accounts.length) {
        list.innerHTML = `<div class="empty"><i class="fas fa-folder-open"></i><div>${t('noAccounts')}</div></div>`;
    } else {
        list.innerHTML = '';
        state.accounts.forEach(a => {
            const row = document.createElement('button');
            row.className = 'settings-row';
            // Same icon/tint resolution the bank uses — so a crown set in
            // the bank shows as a crown here, with the same color tint.
            const tint = tintClassOf(a);
            const icon = iconNameOf(a);
            row.innerHTML = `
                <div class="srow-icon ${tint}"><i class="fas ${icon}"></i></div>
                <div class="srow-info">
                    <div class="srow-title">${a.name}</div>
                    <div class="srow-sub">${a.accountNumber} · ${money(a.balance)}</div>
                </div>
                ${a.isPrimary ? '<i class="fas fa-star" style="color:var(--c-orange);font-size:0.78rem;"></i>' : ''}
                <i class="fas fa-chevron-right srow-arrow"></i>
            `;
            row.onclick = () => openAccountDetail(a);
            list.appendChild(row);
        });
    }

    // invites badge
    const inviteRow = $('#rowInvites');
    const inviteSub = $('#invitesSub');
    if (inviteRow && inviteSub) {
        const n = state.invites.length;
        inviteRow.classList.toggle('hidden', n === 0);
        inviteSub.textContent = t('invitesCount', { n });
    }
}

/* =====================================================
   ACCOUNT DETAIL PAGE — opened from Settings
   ===================================================== */
function openAccountDetail(account) {
    state.viewingAccountId = account.id;
    setTab('acct-detail');
    renderAccountDetail();
}

function getViewingAccount() {
    return state.accounts.find(a => a.id === state.viewingAccountId) || null;
}

function renderAccountDetail() {
    const a = getViewingAccount();
    if (!a) { setTab('settings'); return; }

    // header + hero — uses the same resolver as the cards so a customised
    // icon/color carries over from the bank to this detail view.
    $('#acctDetTitle').textContent = a.name;
    const heroIcon = $('#acctHeroIcon');
    heroIcon.className = 'acct-hero-icon ' + tintClassOf(a);
    heroIcon.innerHTML = `<i class="fas ${iconNameOf(a)}"></i>`;
    $('#acctHeroName').textContent = a.name;
    $('#acctHeroNum').textContent  = a.accountNumber;
    $('#acctHeroBal').textContent  = money(a.balance);

    // build action rows
    const list = $('#acctActionsList');
    markFresh(list);
    list.innerHTML = '';
    const owner = isOwner(a);
    const joint = a.type === 'joint';

    // Helper takes translation KEYS (not pre-translated text). Stamps
    // data-i18n attributes so the locale switcher can re-translate in
    // place without us having to rebuild this list.
    const row = (icon, tint, titleKey, subKey, onClick, opts = {}) => {
        const b = document.createElement('button');
        b.className = 'settings-row' + (opts.danger ? ' danger' : '');
        b.innerHTML = `
            <div class="srow-icon ${tint}"><i class="fas ${icon}"></i></div>
            <div class="srow-info">
                <div class="srow-title" data-i18n="${titleKey}">${t(titleKey)}</div>
                <div class="srow-sub"   data-i18n="${subKey}">${t(subKey)}</div>
            </div>
            <i class="fas fa-chevron-right srow-arrow"></i>
        `;
        b.onclick = onClick;
        list.appendChild(b);
    };

    if (owner) {
        row('fa-pen',     'teal',   'rename',      'renameSub',     () => openRenameAcct(a));
        row('fa-palette', 'purple', 'iconColor',   'iconColorSub',  () => openCustomizeAcct(a));
    }
    row('fa-key',          'orange', 'changePin',    'changePinSub2',  () => openChangePinSpecific(a));
    if (owner) {
        row('fa-rotate',   'blue',   'forgotPin',    'forgotPinSub',   () => openForgotPinAcct(a));
    }
    if (a.isPrimary) {
        row('fa-star',     'orange', 'unsetPrimary', 'setPrimarySub',  () => {});
    } else {
        row('fa-star',     'orange', 'setPrimary',   'setPrimarySub',  () => doSetPrimary(a));
    }
    if (joint) {
        row('fa-users',    'purple', 'members',     'membersSub',     () => openMembersList(a));
        if (owner) row('fa-user-plus', 'teal', 'invite', 'inviteSub', () => openInviteMember(a));
        if (!owner) row('fa-door-open', 'red', 'leaveAccount', 'leaveAccountSub',
                        () => openLeaveAccount(a), { danger: true });
    }
    if (owner) {
        row('fa-trash', 'red', 'closeAccount', 'closeAccountSub',
            () => openCloseAccount(a), { danger: true });
    }
}

/* =====================================================
   PER-ACCOUNT MODALS
   ===================================================== */
function openRenameAcct(a) {
    showModal(t('renameTitle', { name: a.name }), `
        <div class="field">
            <label>${t('accountName')}</label>
            <input type="text" id="rnName" maxlength="32" value="${a.name.replace(/"/g,'&quot;')}">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const name = $('#rnName').value.trim();
        if (!name) { $('#mErr').textContent = t('err_required'); return; }
        const res = await post('phone_renameAccount', { accountId: a.id, name });
        if (res && res.ok) { toast(t('ok_renamed'), 'success'); close(); }
        else { $('#mErr').textContent = formatErr(res); }
    }, { okLabel: t('save') });
    setTimeout(() => $('#rnName').focus(), 50);
}

function openCustomizeAcct(a) {
    let pickedIcon  = a.icon  || (a.type === 'joint' ? 'fa-users' : 'fa-user');
    let pickedColor = a.color || 'green';
    const iconCells = ICONS.map(i =>
        `<button class="picker-cell ${i === pickedIcon ? 'active' : ''}" data-icon="${i}"><i class="fas ${i}"></i></button>`
    ).join('');
    const colorDots = COLORS.map(c =>
        `<button class="color-dot ${c === pickedColor ? 'active' : ''}" data-color="${c}"><i class="fas fa-check"></i></button>`
    ).join('');
    showModal(t('customizeTitle', { name: a.name }), `
        <label style="font-size:0.78rem;color:var(--c-text-dim);text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin-bottom:0.4rem;display:block;">${t('chooseIcon')}</label>
        <div class="picker-grid" id="iconGrid">${iconCells}</div>
        <label style="font-size:0.78rem;color:var(--c-text-dim);text-transform:uppercase;letter-spacing:0.1em;font-weight:700;margin:0.6rem 0 0.4rem;display:block;">${t('chooseColor')}</label>
        <div class="color-strip" id="colorStrip">${colorDots}</div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const res = await post('phone_customizeAccount', { accountId: a.id, icon: pickedIcon, color: pickedColor });
        if (res && res.ok) { toast(t('ok_customized'), 'success'); close(); }
        else { $('#mErr').textContent = formatErr(res); }
    }, { okLabel: t('save') });

    $$('#iconGrid .picker-cell').forEach(b => b.onclick = () => {
        $$('#iconGrid .picker-cell').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        pickedIcon = b.dataset.icon;
    });
    $$('#colorStrip .color-dot').forEach(b => b.onclick = () => {
        $$('#colorStrip .color-dot').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        pickedColor = b.dataset.color;
    });
}

function openChangePinSpecific(a) {
    showModal(t('changePin') + ' — ' + a.name, `
        <div class="field">
            <label>${t('oldPin')}</label>
            <input type="password" id="pOld" maxlength="4" placeholder="••••">
        </div>
        <div class="field">
            <label>${t('newPin')}</label>
            <input type="password" id="pNew1" maxlength="4" placeholder="••••">
        </div>
        <div class="field">
            <label>${t('confirmPin')}</label>
            <input type="password" id="pNew2" maxlength="4" placeholder="••••">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const oldPin = $('#pOld').value;
        const n1 = $('#pNew1').value, n2 = $('#pNew2').value;
        if (oldPin.length !== 4 || !/^\d+$/.test(oldPin)) { $('#mErr').textContent = t('err_pin_format'); return; }
        if (n1.length !== 4 || !/^\d+$/.test(n1))         { $('#mErr').textContent = t('err_pin_format'); return; }
        if (n1 !== n2)                                    { $('#mErr').textContent = t('err_pin_mismatch'); return; }
        const res = await post('phone_changePin', { accountId: a.id, oldPin, newPin: n1 });
        if (res && res.ok) { toast(t('ok_pin_changed'), 'success'); close(); }
        else { $('#mErr').textContent = formatErr(res); }
    });
}

function openForgotPinAcct(a) {
    showModal(t('forgotPinTitle', { name: a.name }), `
        <div class="opt-banner">
            <i class="fas fa-shield-halved"></i>
            <span>${t('forgotPinWarn')}</span>
        </div>
        <div class="field">
            <label>${t('newPin')}</label>
            <input type="password" id="rNew1" maxlength="4" placeholder="••••">
        </div>
        <div class="field">
            <label>${t('confirmPin')}</label>
            <input type="password" id="rNew2" maxlength="4" placeholder="••••">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const n1 = $('#rNew1').value, n2 = $('#rNew2').value;
        if (n1.length !== 4 || !/^\d+$/.test(n1)) { $('#mErr').textContent = t('err_pin_format'); return; }
        if (n1 !== n2)                            { $('#mErr').textContent = t('err_pin_mismatch'); return; }
        const res = await post('phone_resetPin', { accountId: a.id, newPin: n1 });
        if (res && res.ok) { toast(t('ok_pin_reset'), 'success'); close(); }
        else { $('#mErr').textContent = formatErr(res); }
    });
}

async function doSetPrimary(a) {
    const res = await post('phone_setPrimary', { accountId: a.id });
    if (res && res.ok) toast(t('ok_primary_set'), 'success');
    else toast(formatErr(res), 'error');
}

function openMembersList(a) {
    const owner = isOwner(a);
    const rows = (a.members || []).map(m => `
        <div class="member-row">
            <div class="member-avatar">${avatarOf(m.label || m.citizenid)}</div>
            <div class="member-info">
                <div class="member-name">${m.label || m.citizenid}</div>
                <div class="member-role">${m.role === 'owner' ? t('ownerRole') : t('memberRole')}</div>
            </div>
            ${owner && m.role !== 'owner'
                ? `<button class="kick-btn" data-cid="${m.citizenid}" title="${t('kick')}"><i class="fas fa-times"></i></button>`
                : ''}
        </div>
    `).join('');

    showModal(t('membersTitle', { name: a.name }), `
        <div class="member-list">${rows || `<div class="empty"><i class="fas fa-users"></i><div>—</div></div>`}</div>
    `, (close) => close(), { okLabel: t('confirm') });

    $$('.kick-btn').forEach(b => b.onclick = async () => {
        const cid = b.dataset.cid;
        const res = await post('phone_removeMember', { accountId: a.id, targetCid: cid });
        if (res && res.ok) {
            toast(t('ok_member_removed'), 'success');
            closeModal();
        } else {
            toast(formatErr(res), 'error');
        }
    });
}

function openInviteMember(a) {
    showModal(t('inviteTitle', { name: a.name }), `
        <div class="field">
            <label>${t('recipientType')}</label>
            <div class="seg" id="iType">
                <button class="seg-btn active" data-tt="player_id">${t('playerId')}</button>
                <button class="seg-btn"        data-tt="citizen_id">${t('citizenId')}</button>
            </div>
        </div>
        <div class="field">
            <label id="iLabel">${t('playerId')}</label>
            <input type="text" id="iVal" placeholder="">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const type = ($('#iType .seg-btn.active') || {}).dataset.tt || 'player_id';
        const val  = $('#iVal').value.trim();
        if (!val) { $('#mErr').textContent = t('err_required'); return; }
        const res = await post('phone_invite', { accountId: a.id, targetType: type, targetValue: val });
        if (res && res.ok) { toast(t('ok_invite_sent'), 'success'); close(); }
        else { $('#mErr').textContent = formatErr(res); }
    }, { okLabel: t('invite') });

    $$('#iType .seg-btn').forEach(b => b.onclick = () => {
        $$('#iType .seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        $('#iLabel').textContent = b.dataset.tt === 'player_id' ? t('playerId') : t('citizenId');
        $('#iVal').placeholder   = b.dataset.tt === 'player_id' ? '4' : 'ABC12345';
    });
}

function openLeaveAccount(a) {
    showModal(t('leaveTitle', { name: a.name }), `
        <div class="opt-banner" style="background:var(--c-red-bg);">
            <i class="fas fa-triangle-exclamation" style="color:var(--c-red);"></i>
            <span>${t('leaveWarn')}</span>
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const res = await post('phone_leaveAccount', { accountId: a.id });
        if (res && res.ok) {
            toast(t('ok_left_account'), 'success');
            close();
            setTab('settings');
        } else {
            $('#mErr').textContent = formatErr(res);
        }
    }, { okLabel: t('leaveAccount') });
}

function openCloseAccount(a) {
    showModal(t('closeAcctTitle', { name: a.name }), `
        <div class="opt-banner" style="background:var(--c-red-bg);">
            <i class="fas fa-triangle-exclamation" style="color:var(--c-red);"></i>
            <span>${t('closeWarn')}</span>
        </div>
        <div class="hero-value" style="text-align:center;font-size:1.6rem;color:var(--c-red);margin:0.6rem 0;">
            ${t('currentBalance')}: ${money(a.balance)}
        </div>
        <div class="field">
            <label>${t('pin')}</label>
            <input type="password" id="cPin" maxlength="4" placeholder="••••">
        </div>
        <div class="form-error" id="mErr"></div>
    `, async (close) => {
        const pin = $('#cPin').value;
        if (pin.length !== 4 || !/^\d+$/.test(pin)) { $('#mErr').textContent = t('err_pin_format'); return; }
        const res = await post('phone_closeAccount', { accountId: a.id, pin });
        if (res && res.ok) {
            toast(t('ok_account_closed'), 'success');
            close();
            setTab('settings');
        } else {
            $('#mErr').textContent = formatErr(res);
        }
    }, { okLabel: t('closeAccount') });
}

/* =====================================================
   INVITES INBOX
   ===================================================== */
function openInvitesInbox() {
    if (!state.invites.length) { toast(t('pendingInvites') + ' — 0', 'info'); return; }
    // qb-banking returns: { id, account_id, inviter_cid, created_at,
    // account_number, name, type } — so we read those exact field names.
    const rows = state.invites.map((inv) => `
        <div class="member-row">
            <div class="member-avatar"><i class="fas fa-users"></i></div>
            <div class="member-info">
                <div class="member-name">${inv.name || inv.account_number || '—'}</div>
                <div class="member-role">${inv.account_number || ''} · ${t('from')} ${inv.inviter_cid || '—'}</div>
            </div>
            <button class="fp-btn" data-act="accept"  data-id="${inv.id}" style="padding:0.45rem 0.75rem;font-size:0.78rem;"><i class="fas fa-check"></i></button>
            <button class="kick-btn" data-act="decline" data-id="${inv.id}" style="margin-inline-start:0.3rem;"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    showModal(t('pendingInvites'), `<div class="member-list">${rows}</div>`, (close) => close(), { okLabel: t('confirm') });

    $$('button[data-act]').forEach(b => b.onclick = async () => {
        const id     = parseInt(b.dataset.id, 10);
        const accept = b.dataset.act === 'accept';
        const res = await post('phone_respondInvite', { inviteId: id, accept });
        if (res && res.ok) {
            toast(accept ? t('ok_invite_accepted') : t('ok_invite_declined'), 'success');
            closeModal();
        } else {
            toast(formatErr(res), 'error');
        }
    });
}

/* =====================================================
   TABS
   ===================================================== */
function setTab(name) {
    const isNewTab = state.tab !== name;
    state.tab = name;
    // Bottom-tab visual updates only for the 4 main tabs; the acct-detail
    // page is reachable via the back button so no tab gets highlighted.
    const bottomTabs = ['home', 'send', 'history', 'settings'];
    $$('.tab').forEach(b => b.classList.toggle('active',
        bottomTabs.includes(name) ? b.dataset.tab === name : false));
    // Toggle .active and apply .is-fresh on the new active page only on
    // an actual navigation. State-update renders don't re-toggle .active,
    // so the pageEnter animation never re-fires from a snapshot.
    $$('.page').forEach(p => {
        const active = p.dataset.page === name;
        p.classList.toggle('active', active);
        p.classList.remove('is-fresh');
        if (active && isNewTab) {
            void p.offsetWidth;             // force reflow so the animation restarts
            p.classList.add('is-fresh');
            setTimeout(() => p.classList.remove('is-fresh'), 600);
        }
    });
    if (name === 'history')     renderHistory();
    if (name === 'send')        refreshSendForm();
    if (name === 'settings')    renderSettings();
    if (name === 'acct-detail') renderAccountDetail();
    // Home doesn't need a re-render — it's already painted by applySnapshot.
}

// Lists call markFresh() when they wipe + repopulate. The first time the
// app sees a given list element it gets the stagger animation; every
// subsequent render (after a snapshot push, language change, action…)
// the class is NOT added, so the items appear instantly without flicker.
const _listAnimated = new WeakSet();
function markFresh(el) {
    if (!el) return;
    if (_listAnimated.has(el)) {
        el.classList.remove('is-fresh');
        return;
    }
    _listAnimated.add(el);
    el.classList.add('is-fresh');
    setTimeout(() => el.classList.remove('is-fresh'), 600);
}

/* =====================================================
   STATE SYNC FROM CLIENT
   ===================================================== */
async function refresh() {
    const r = await post('phone_refresh');
    applySnapshot(r);
}

// Manual refresh triggered by the header button. Spins the icon for one
// rotation, locks the button so spamming taps doesn't fire 10 calls.
let _refreshing = false;
async function manualRefresh() {
    if (_refreshing) return;
    _refreshing = true;
    const icon = document.getElementById('refreshIcon');
    const btn  = document.getElementById('refreshBtn');
    if (icon) icon.classList.add('spin');
    if (btn)  btn.disabled = true;
    try { await refresh(); }
    finally {
        // Let the spin run for at least 600ms even if the call returned
        // instantly — gives the user visual confirmation it actually ran.
        setTimeout(() => {
            if (icon) icon.classList.remove('spin');
            if (btn)  btn.disabled = false;
            _refreshing = false;
        }, 600);
    }
}

// Cheap fingerprint of the data slices that affect each renderer. We only
// re-call a renderer when its slice actually changed — so a snapshot push
// from the server doesn't blow away DOM you haven't touched.
const _sigs = { hero: '', accounts: '', invites: '', acctDetail: '' };
function _sig(o) { try { return JSON.stringify(o); } catch (e) { return String(Math.random()); } }

function applySnapshot(r) {
    if (!r) return;
    // Lua-encoded empty tables come across as `{}` (object), not `[]` (array).
    // We treat anything that isn't undefined as a real update and coerce
    // non-arrays to empty arrays — this is what makes "delete the last
    // account" / "create the first account" actually reflect in the UI.
    if (r.accounts !== undefined) state.accounts = Array.isArray(r.accounts) ? r.accounts : [];
    if (r.contacts !== undefined) state.contacts = Array.isArray(r.contacts) ? r.contacts : [];
    if (r.invites  !== undefined) state.invites  = Array.isArray(r.invites)  ? r.invites  : [];
    if (typeof r.cash   === 'number') state.cash   = r.cash;
    if (typeof r.frozen === 'number') state.frozen = r.frozen;
    if (r.tier) state.tier = r.tier;

    // Authoritative language from server snapshot. applyLocale() ONLY
    // walks data-i18n elements — no DOM rebuild, no flash.
    if (r.lang) {
        const norm = normalizeLang(r.lang);
        if (norm && norm !== state.lang) {
            console.log('[qb-banking] lang from snapshot →', r.lang, '→', norm);
            state.lang = norm;
            applyLocale();
        }
    }

    // Hero summary depends on cash/frozen/tier/total. Re-render only on change.
    const heroSig = _sig({
        c: state.cash, f: state.frozen,
        t: state.tier && state.tier.id,
        tot: state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0),
        p: state.privacy,
    });
    if (heroSig !== _sigs.hero) { _sigs.hero = heroSig; renderHero(); }

    // Account cards only re-render when the account data really changed.
    const acctSig = _sig(state.accounts.map(a => [a.id, a.name, a.balance, a.icon, a.color,
                                                  a.isPrimary, a.frozen, a.type, a.accountNumber]));
    if (acctSig !== _sigs.accounts) { _sigs.accounts = acctSig; renderAccounts(); }

    // Settings page: list of accounts + invite count.
    if (state.tab === 'settings') {
        const setSig = acctSig + '|' + state.invites.length;
        if (setSig !== _sigs.invites) { _sigs.invites = setSig; renderSettings(); }
    }

    // Account-detail page: only refresh when the viewed account changed.
    if (state.tab === 'acct-detail') {
        const a = state.accounts.find(x => x.id === state.viewingAccountId);
        const detSig = _sig(a);
        if (detSig !== _sigs.acctDetail) { _sigs.acctDetail = detSig; renderAccountDetail(); }
    }

    // History and send form aren't affected by every snapshot field — only
    // re-render when the user is actually on those tabs (their data is
    // fetched on demand or driven by user input).
    if (state.tab === 'history') renderHistory();
    if (state.tab === 'send')    refreshSendForm();
}

// Listen for messages pushed by the lb-phone integration
// (lb-phone provides onNuiEvent globally when the app is loaded)
function bindLbPhoneEvents() {
    if (typeof window.onNuiEvent === 'function') {
        // Single canonical channel
        window.onNuiEvent('snapshot', (data) => applySnapshot(data));
    } else {
        // Fallback: standard window message listener (works under plain NUI too)
        window.addEventListener('message', (ev) => {
            const m = ev.data || {};
            if (m.action === 'snapshot') applySnapshot(m);
        });
    }
}

/* =====================================================
   PRIVACY TOGGLE — hides every $ amount with a masked dot pattern
   ===================================================== */
function togglePrivacy() {
    state.privacy = !state.privacy;
    try { localStorage.setItem('qbp_privacy', state.privacy ? '1' : '0'); } catch (e) {}
    const ic = $('#privacyIcon');
    if (ic) ic.className = state.privacy ? 'fas fa-eye-slash' : 'fas fa-eye';
    syncPrivacyTitle();
    renderHero();
    renderAccounts();
    if (state.tab === 'history') renderHistory();
    if (state.tab === 'send')    refreshSendForm();
}

/* =====================================================
   LANGUAGE — auto-detect from lb-phone, no in-app toggle
   ===================================================== */
// Normalize ANYTHING (codes, full names, even Arabic script) → 'en' | 'ar'.
function normalizeLang(v) {
    if (!v) return null;
    const lc = String(v).toLowerCase().trim();
    // Arabic: 'ar', 'ar-sa', 'arabic', 'arab', or contains an Arabic letter
    if (lc.startsWith('ar') || lc.includes('arab') || /[؀-ۿ]/.test(lc)) return 'ar';
    // English variants
    if (lc.startsWith('en') || lc.includes('engl')) return 'en';
    return null;
}

// Try to read the language from the document. lb-phone sets `data-lang` /
// `data-locale` on the iframe's <html> when it injects the app. We do NOT
// trust the plain `lang` attribute — that's our own default in index.html
// and it would mask the real phone setting.
function detectLangFromDoc() {
    const html = document.documentElement;
    const body = document.body;
    return normalizeLang(html.getAttribute('data-lang'))
        || normalizeLang(html.getAttribute('data-locale'))
        || (body && (
               normalizeLang(body.getAttribute('data-lang'))
            || normalizeLang(body.getAttribute('data-locale'))
        ));
}

// Async: ask lb-phone for the active language. lb-phone exposes
// `globalThis.getSettings` to custom apps — we prefer that since it's
// instant and reactive. Falls back to a Lua roundtrip and finally to
// the DOM if neither is available.
async function detectLangAsync() {
    // 1) lb-phone's own helper, exposed on globalThis inside custom apps.
    try {
        const fn = globalThis.getSettings;
        if (typeof fn === 'function') {
            const settings = await Promise.resolve(fn());
            const raw = settings && (settings.language || settings.locale || settings.lang
                                     || settings.currentLanguage || settings.currentLocale);
            const norm = normalizeLang(raw);
            if (norm) {
                console.log('[qb-banking] lang from globalThis.getSettings →', raw, '→', norm);
                return norm;
            }
        }
    } catch (e) {}

    // 2) Lua-side (slower but covers builds where the JS helper is absent).
    const r = await post('getPhoneLang');
    const fromLua = normalizeLang(r && r.lang);
    console.log('[qb-banking] lang from lb-phone export →', r && r.lang, '→', fromLua);
    if (fromLua) return fromLua;

    // 3) Fallback: lb-phone may have set data-lang on the iframe document.
    const fromDoc = detectLangFromDoc();
    if (fromDoc) {
        console.log('[qb-banking] lang from <html data-lang> →', fromDoc);
        return fromDoc;
    }
    return 'en';
}

// Re-runs detection one more time after a short delay. Some lb-phone
// builds set data-lang on the iframe AFTER the app loads; this catches
// that case so we don't get stuck on the default.
async function retryLangDetection() {
    await new Promise(r => setTimeout(r, 600));
    const lang = (await detectLangAsync()) || state.lang;
    if (lang && lang !== state.lang) {
        state.lang = lang;
        applyLocale();
    }
}

// Watches <html data-lang/data-theme> for runtime changes — when the user
// switches phone language while our app is open, we re-render in the new
// language without needing to reopen the app.
function watchPhoneAttrs() {
    const obs = new MutationObserver(() => {
        const newLang = detectLangFromDoc();
        if (newLang && newLang !== state.lang) {
            state.lang = newLang;
            applyLocale();
        }
        // data-theme is consumed by CSS variables — no JS work needed.
    });
    obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-lang', 'data-locale', 'lang', 'data-theme'],
    });
}

// In addition to the MutationObserver, poll lb-phone's globalThis.getSettings
// every 2 seconds. This is the fastest way to react to language flips
// because lb-phone exposes the helper directly to custom apps and it
// doesn't require a Lua roundtrip. applyLocale() does NOT rebuild lists,
// so calling it every couple seconds is cheap.
function startLangPoller() {
    if (typeof globalThis.getSettings !== 'function') return;
    setInterval(async () => {
        try {
            const s = await Promise.resolve(globalThis.getSettings());
            const raw  = s && (s.language || s.locale || s.lang || s.currentLanguage || s.currentLocale);
            const norm = normalizeLang(raw);
            if (norm && norm !== state.lang) {
                state.lang = norm;
                applyLocale();
            }
        } catch (e) {}
    }, 2000);
}

/* =====================================================
   BOOT
   ===================================================== */
async function boot() {
    // Restore privacy preference
    try {
        const savedP = localStorage.getItem('qbp_privacy');
        if (savedP === '1') state.privacy = true;
    } catch (e) {}

    // Default theme: dark (lb-phone overrides via data-theme)
    if (!document.documentElement.getAttribute('data-theme')) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }

    // Detect language from the phone (no manual toggle in our app)
    state.lang = await detectLangAsync();
    // Retry once after lb-phone has finished injecting its theme attrs
    retryLangDetection();

    // Apply privacy icon state
    const ic = $('#privacyIcon');
    if (ic) ic.className = state.privacy ? 'fas fa-eye-slash' : 'fas fa-eye';

    applyLocale();
    bindLbPhoneEvents();
    watchPhoneAttrs();
    startLangPoller();

    // tabs
    $$('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));

    // send type pills
    $$('#sendType .seg-btn').forEach(b => b.onclick = () => {
        $$('#sendType .seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.sendType = b.dataset.tt;
        updateSendLabel();
    });

    $('#sendBtn').onclick      = submitSend;
    $('#privacyBtn').onclick   = togglePrivacy;
    $('#refreshBtn').onclick   = manualRefresh;
    $('#claimBtn').onclick     = openClaimModal;
    $('#contactPickBtn').onclick = openContactsPicker;
    $('#histAcc').onchange     = (e) => {
        state.histAccountId = parseInt(e.target.value, 10);
        renderHistory();
    };

    // settings rows (top-level)
    $('#rowCreateAcc').onclick = openCreateAccountModal;
    $('#rowInvites').onclick   = openInvitesInbox;
    $('#rowAbout').onclick     = openAboutModal;

    // back button on the account-detail page
    const back = $('#acctBack');
    if (back) back.onclick = () => setTab('settings');

    // Default the recipient type to phone contact (the new primary flow)
    state.sendType = 'phone_contact';
    updateSendLabel();

    // initial fetch
    refresh();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

})();
