/* ╔══════════════════════════════════════════════════════════╗
   ║                  qb-banking — by Nerd                    ║
   ║          Developed & maintained by Nerd Studio           ║
   ║              Released under © Nerd 2026                  ║
   ╚══════════════════════════════════════════════════════════╝ */
/* =====================================================
   qb-banking : NUI script (Sultan theme)
   ===================================================== */

const RES = (typeof GetParentResourceName === 'function') ? GetParentResourceName() : 'qb-banking';
const post = (name, data = {}) => fetch(`https://${RES}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
}).then(r => r.json()).catch(() => ({}));

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Privacy mask: when state.privacy is true, every money number is replaced
// with dots so the user can hide their balance from people peeking.
// Counts (non-money numbers) get masked separately via maskCount().
const PRIVACY_MASK = '••••';
const fmt = (n) => {
    if (typeof state !== 'undefined' && state.privacy) return PRIVACY_MASK;
    return (Number(n) || 0).toLocaleString('en-US');
};
// For "X accounts" / "Y members" style integer counts.
const maskCount = (n) => (typeof state !== 'undefined' && state.privacy) ? '••' : String(n);
const initials = (s) => (s || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

// Stable hue index for consistent per-account avatar colors (5 hues)
function hueOf(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 5;
}

// Robust DATETIME formatter — handles MySQL string ('YYYY-MM-DD HH:MM:SS'),
// ISO string, Unix timestamp in seconds, or ms timestamp. Always returns
// a clean 'YYYY-MM-DD HH:MM' for display.
function formatDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') {
        const ms = v > 1e12 ? v : v * 1000;
        const d = new Date(ms);
        if (isNaN(d.getTime())) return String(v);
        return d.toISOString().slice(0, 16).replace('T', ' ');
    }
    return String(v).replace('T', ' ').replace(/\..*$/, '').slice(0, 16);
}

// Smooth count-up animation for balance numbers — eases over ~600ms.
// Stores per-element previous values so subsequent calls animate from "current"
// to the new value rather than from 0 every time.
const _animState = new WeakMap();
function animateNumber(el, target, prefix = '$', duration = 600) {
    if (!el) return;
    target = Number(target) || 0;
    // Privacy: skip the count-up entirely (fmt returns the mask anyway).
    if (state.privacy) {
        el.textContent = prefix + fmt(target);
        _animState.set(el, target);
        return;
    }
    const start = _animState.get(el) ?? target;
    const range = target - start;
    if (range === 0) {
        el.textContent = prefix + fmt(target);
        _animState.set(el, target);
        return;
    }
    const t0 = performance.now();
    function step(now) {
        const p = Math.min((now - t0) / duration, 1);
        // ease-out cubic for a polished, fast-then-slow curve
        const eased = 1 - Math.pow(1 - p, 3);
        const v = Math.round(start + range * eased);
        el.textContent = prefix + fmt(v);
        if (p < 1) requestAnimationFrame(step);
        else _animState.set(el, target);
    }
    requestAnimationFrame(step);
}

const state = {
    accounts: [],
    invites:  [],
    contacts: [],
    cash:     0,
    frozen:   0,
    tier:     null,
    privacy:  false,    // hides balances and counts when true
    config:   { currency: '$', pinLength: 4, atmDailyLimit: 5000, jointMax: 4, maxAccounts: 5, newFee: 0, lockoutMinutes: 5 },
    locale:   {},
    atm:  { stage: 'pick', accountId: null, pin: '', op: null, balance: 0 },
    bank: { tab: 'overview', transferType: 'player_id', newType: 'individual', selectedAccountId: null },
};

// Restore the saved privacy preference so the UI opens consistently.
try {
    const sp = localStorage.getItem('qbk_privacy');
    if (sp === '1') state.privacy = true;
} catch (e) {}

const root   = $('#root');
const atmEl  = $('#atm');
const bankEl = $('#bank');

// ----------------------------- sounds ---------------------------------
// Custom synthesized sound effects via the Web Audio API. No external
// files needed — every sound is generated programmatically. Designed
// specifically for the banking UI — clean, modern, never out of place.
let _audioCtx = null;
function _ctx() {
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { return null; }
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
}

// Helper: spawn an oscillator with an envelope (vol→silence over duration).
function _tone(freq, duration, type = 'sine', vol = 0.06, slideTo, when = 0) {
    const ctx = _ctx(); if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0   = ctx.currentTime + when;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

const SFX = {
    // Soft glassy click — short, high, gentle
    click:      () => _tone(1800, 0.04, 'sine',     0.05),
    // Tab pop — even subtler
    tabSwitch:  () => _tone(1400, 0.035, 'sine',    0.025),
    // PIN key — soft tap, slightly muted
    pinKey:     () => _tone(900,  0.05, 'triangle', 0.045, 720),
    // PIN accepted — bright two-note ascending bell
    pinOk:      () => { _tone(880, 0.18, 'sine', 0.07); _tone(1320, 0.22, 'sine', 0.06, null, 0.07); },
    // PIN rejected — descending dissonant pair
    pinFail:    () => { _tone(380, 0.10, 'square', 0.05); _tone(280, 0.18, 'square', 0.06, null, 0.10); },
    // Open bank UI — soft swell upward
    openBank:   () => _tone(420, 0.22, 'sine', 0.06, 880),
    // Open ATM UI — slightly higher pitch
    openAtm:    () => _tone(520, 0.18, 'sine', 0.06, 980),
    // Close UI — gentle downward swell
    close:      () => _tone(820, 0.22, 'sine', 0.05, 360),
    // Transaction success — three-note ka-ching arpeggio
    txnSuccess: () => {
        _tone(1318, 0.10, 'triangle', 0.07, null, 0.00); // E6
        _tone(1568, 0.10, 'triangle', 0.07, null, 0.07); // G6
        _tone(2093, 0.30, 'triangle', 0.07, null, 0.14); // C7 long
    },
    // Account created — celebratory rising arpeggio
    accountNew: () => {
        _tone(1046, 0.10, 'sine', 0.07, null, 0.00); // C6
        _tone(1318, 0.10, 'sine', 0.07, null, 0.08); // E6
        _tone(1568, 0.10, 'sine', 0.07, null, 0.16); // G6
        _tone(2093, 0.40, 'sine', 0.07, null, 0.24); // C7
    },
    // Generic error — short low buzz
    error:      () => _tone(220, 0.16, 'sawtooth', 0.05, 160),
};

// ----------------------------- notifications --------------------------
// Single source of truth — both toast(...) and receiptToast(...) route
// through the in-house "notifications:sendNotification" event so the
// player only ever sees one visual style of notification.
function toast(msg, kind = 'info') {
    const colorMap = { success: 'success', error: 'error', info: 'primary', warning: 'primary' };
    post('notify', { color: colorMap[kind] || 'primary', message: msg });
}
// Kept for backward compatibility with the old call sites — now just
// formats a single-line message and forwards to toast().
function receiptToast(opts) {
    const cur = state.config.currency;
    const sym = (opts.sign === 'neg') ? '−' : '+';
    const head = (opts.type || 'Transaction').toUpperCase();
    const line = `${head}: ${sym}${cur}${fmt(opts.amount)}`;
    toast(line, 'success');
}

// ----------------------------- error map ------------------------------
function mapError(err, attempts) {
    const L = state.locale;
    const map = {
        no_money:        L.err_no_money       || 'Not enough cash',
        no_balance:      L.err_no_balance     || 'Not enough balance',
        invalid_account: L.err_invalid_account|| 'Invalid account',
        invalid_target:  L.err_invalid_target || 'Recipient not found',
        self_transfer:   L.err_self_transfer  || 'You cannot transfer to yourself',
        invalid_amount:  L.err_invalid_amount || 'Invalid amount',
        max_accounts:    L.err_max_accounts   || 'Maximum accounts reached',
        pin_format:      L.err_pin_format     || 'PIN must be 4 digits',
        daily_limit:     L.err_daily_limit    || 'Daily withdraw limit reached',
        frozen:          L.err_account_frozen || 'Account is frozen',
        max_members:     L.err_max_members    || 'Maximum members reached',
        already_member:  L.err_already_member || 'Already a member',
        invite_pending:  L.err_invite_pending || 'Invite already pending',
        invalid_pin:     L.err_invalid_pin    || 'Wrong PIN',
        rate_limit:      'Slow down a bit',
        unauthorized:    'Not authorized',
        locked:          (mins) => (L.err_locked || 'Locked. Try again in %s minute(s)').replace('%s', mins),
    };
    if (err === 'locked')     return map.locked(attempts || state.config.lockoutMinutes || 5);
    if (err === 'locked_now') return map.locked(state.config.lockoutMinutes || 5);
    return map[err] || err || 'Error';
}
function formatServerError(res) {
    if (!res) return 'No response (server timeout?)';
    if (res.detail) return `server_error — ${String(res.detail).split('\n')[0]}`;
    return mapError(res.err, res.attempts);
}

// ============================================================
// Dialog: confirmDialog + formDialog
// ============================================================
function _setupDialog(opts) {
    const m = $('#modal');
    $('#modalTitle').innerHTML = `<i class="fas ${opts.icon || 'fa-circle-info'}"></i> ${opts.title || ''}`;
    $('#modalBody').innerHTML = opts.body || '';
    $('#modalOk').innerHTML = `<i class="fas ${opts.okIcon || 'fa-check'}"></i> ${opts.okLabel || 'Confirm'}`;
    $('#modalOk').className = `dlg-btn confirm ${opts.okClass || ''}`;
    m.classList.remove('hidden');
}

function confirmDialog(opts) {
    return new Promise(resolve => {
        _setupDialog(opts);
        const close = (ok) => {
            $('#modal').classList.add('hidden');
            $('#modalOk').onclick = null;
            $('#modalCancel').onclick = null;
            $('#modalCancelBtn').onclick = null;
            resolve(ok);
        };
        $('#modalOk').onclick        = () => close(true);
        $('#modalCancel').onclick    = () => close(false);
        $('#modalCancelBtn').onclick = () => close(false);
    });
}

function formDialog(opts) {
    return new Promise(resolve => {
        const fields = (opts.fields || []).map(f => `
            <div class="field">
                <label>${f.label}${f.hint ? `<span class="opt"> ${f.hint}</span>` : ''}</label>
                ${f.prefix ? `
                    <div class="fin-input-wrap">
                        <span class="fin-currency">${f.prefix}</span>
                        <input type="${f.type || 'text'}" class="fin-input" data-name="${f.name}"
                               ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}
                               ${f.min ? `min="${f.min}"` : ''}
                               ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} />
                    </div>
                ` : `
                    <input type="${f.type || 'text'}" class="field-input" data-name="${f.name}"
                           ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}
                           ${f.min ? `min="${f.min}"` : ''}
                           ${f.placeholder ? `placeholder="${f.placeholder}"` : ''} />
                `}
            </div>
        `).join('');

        _setupDialog({
            title: opts.title,
            icon: opts.icon,
            okLabel: opts.okLabel,
            okIcon: opts.okIcon,
            okClass: opts.okClass,
            body: fields + (opts.afterFields || ''),
        });

        const firstInput = $('#modalBody input');
        if (firstInput) firstInput.focus();

        const close = (ok) => {
            const values = {};
            $$('#modalBody [data-name]').forEach(el => values[el.dataset.name] = el.value);
            $('#modal').classList.add('hidden');
            $('#modalOk').onclick = null;
            $('#modalCancel').onclick = null;
            $('#modalCancelBtn').onclick = null;
            resolve({ confirmed: ok, values });
        };
        $('#modalOk').onclick        = () => close(true);
        $('#modalCancel').onclick    = () => close(false);
        $('#modalCancelBtn').onclick = () => close(false);
    });
}

// ============================================================
// ATM
// ============================================================
function atmShowStage(s) {
    state.atm.stage = s;
    $$('.atm-stage').forEach(el => el.classList.toggle('hidden', el.dataset.stage !== s));
    const labels = { pick: 'Select Account', pin: 'Enter PIN', ops: 'Account', quick: 'Quick Balance' };
    $('#atmStep').textContent = labels[s] || '';
}

function renderAtmAccounts() {
    const list = $('#atmAccList');
    list.innerHTML = '';
    if (!state.accounts.length) {
        $('#atmNoAcc').textContent = state.locale.atm_no_accounts || 'You have no accounts. Visit a bank to open one.';
        return;
    }
    $('#atmNoAcc').textContent = '';
    state.accounts.forEach(a => {
        const row = document.createElement('div');
        row.className = 'acc-row';
        // Mirror the bank UI logic: respect the user's customized icon + color
        // when set, fall back to type-based defaults otherwise. The avatar
        // tint classes match `.emp-avatar.color-*` so styling is shared.
        const ico = a.icon || (a.frozen ? 'fa-snowflake' : (a.type === 'joint' ? 'fa-users' : 'fa-user'));
        const tintClass = a.frozen ? 'hue-frozen'
            : (a.color ? `color-${a.color}` : `hue-${hueOf(a.accountNumber || a.name)}`);
        // Primary-account marker — same star used in the bank Overview
        const primaryStar = a.isPrimary
            ? `<span class="primary-star" title="Primary account"><i class="fas fa-star"></i></span>`
            : '';
        row.innerHTML = `
            <div class="acc-ico ${tintClass}"><i class="fas ${ico}"></i></div>
            <div class="acc-info">
                <div class="ar-name">${a.name}${primaryStar}</div>
                <div class="ar-num">${a.accountNumber}</div>
            </div>
            <div class="grade-tag ${a.frozen ? 'frozen' : a.type}">${a.frozen ? 'Frozen' : a.type}</div>
        `;
        if (!a.frozen) {
            row.addEventListener('click', () => {
                state.atm.accountId = a.id;
                state.atm.pin = '';
                renderPinDots();
                $('#atmAccTitle').textContent = `${a.name} • ${a.accountNumber}`;
                $('#atmError').textContent = '';
                atmShowStage('pin');
            });
        }
        list.appendChild(row);
    });
}

function renderPinDots() {
    const wrap = $('#atmPinDisplay');
    wrap.classList.remove('shake');
    wrap.innerHTML = '';
    for (let i = 0; i < state.config.pinLength; i++) {
        const d = document.createElement('div');
        d.className = 'dot-cell' + (i < state.atm.pin.length ? ' filled' : '');
        wrap.appendChild(d);
    }
}

function pinPress(key) {
    if (key === 'back') {
        state.atm.pin = state.atm.pin.slice(0, -1);
        renderPinDots();
        SFX.pinKey();
        return;
    }
    if (key === 'ok') {
        if (state.atm.pin.length !== state.config.pinLength) return;
        atmTryAuth();
        return;
    }
    if (state.atm.pin.length < state.config.pinLength) {
        state.atm.pin += key;
        renderPinDots();
        SFX.pinKey();
        if (state.atm.pin.length === state.config.pinLength) atmTryAuth();
    }
}

async function atmTryAuth() {
    const res = await post('verifyPin', { accountId: state.atm.accountId, pin: state.atm.pin });
    if (!res || !res.ok) {
        $('#atmPinDisplay').classList.add('shake');
        $('#atmError').textContent = formatServerError(res);
        SFX.pinFail();
        setTimeout(() => { state.atm.pin = ''; renderPinDots(); }, 350);
        return;
    }
    $('#atmError').textContent = '';
    state.atm.balance = res.balance;
    animateNumber($('#atmBalance'), res.balance, state.config.currency, 800);
    $('#atmAccSub').textContent = `${res.name} • ${res.accountNumber}`;
    atmShowStage('ops');
    refreshAtmMeta();
    SFX.pinOk();
}

function refreshAtmMeta() {
    const limit = state.config.atmDailyLimit;
    if (!limit) { $('#atmMeta').textContent = ''; return; }
    $('#atmMeta').textContent = `Daily ATM limit: ${state.config.currency}${fmt(limit)}`;
}

let pendingOp = null;
function startOp(op) {
    pendingOp = op;
    $('#atmAmountWrap').classList.remove('hidden');
    $('#atmAmount').value = '';
    $('#atmAmount').focus();
    $('#atmError').textContent = '';
}
function cancelOp() { pendingOp = null; $('#atmAmountWrap').classList.add('hidden'); }

async function confirmOp() {
    if (!pendingOp) return;
    const amount = parseInt($('#atmAmount').value, 10);
    if (!amount || amount <= 0) { $('#atmError').textContent = mapError('invalid_amount'); return; }
    const payload = { mode: 'atm', accountId: state.atm.accountId, pin: state.atm.pin, amount };
    const fn = pendingOp === 'deposit' ? 'deposit' : 'withdraw';
    const res = await post(fn, payload);
    if (res && res.ok) {
        state.atm.balance = res.balance;
        animateNumber($('#atmBalance'), res.balance, state.config.currency, 700);
        toast(`${pendingOp.toUpperCase()}: ${state.config.currency}${fmt(amount)}`, 'success');
        cancelOp();
        const fresh = await post('refresh');
        if (fresh && fresh.accounts) state.accounts = fresh.accounts;
    } else {
        const msg = formatServerError(res);
        $('#atmError').textContent = msg;
        $('#atmPinDisplay').classList.add('shake');
        if (res && (res.err === 'invalid_pin' || res.err === 'locked' || res.err === 'locked_now' || res.err === 'pin_format')) {
            setTimeout(() => {
                state.atm.pin = '';
                renderPinDots();
                atmShowStage('pin');
                $('#atmError').textContent = msg;
            }, 350);
        }
    }
}

// ============================================================
// BANK navigation
// ============================================================
function setTab(name) {
    if (state.bank.tab !== name) SFX.tabSwitch();
    state.bank.tab = name;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === name));
    if (name === 'overview')    { renderOverview(); renderSidebar(); }
    if (name === 'transfer')    renderTransferForm();
    if (name === 'contacts')    renderContacts();
    if (name === 'history')     renderHistoryPicker();
    if (name === 'invitations') renderInvites();
    if (name === 'settings')    renderSettingsPicker();
    if (name === 'create')      renderCreateForm();
}

// ----- SIDEBAR / STATS -----
function renderSidebar() {
    const total  = state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    const joint  = state.accounts.filter(a => a.type === 'joint').length;
    const active = state.accounts.filter(a => !a.frozen).length;
    const frozen = Number(state.frozen) || 0;
    const cur    = state.config.currency;

    // money values animate (count-up); counts pop instantly
    animateNumber($('#s-total'),  total,  cur);
    animateNumber($('#s-cash'),   state.cash || 0, cur);
    animateNumber($('#d-total'),  total,  cur);
    animateNumber($('#s-frozen'), frozen, cur);

    $('#s-accounts').textContent = maskCount(state.accounts.length);
    $('#s-joint').textContent    = maskCount(joint);
    $('#d-accounts').textContent = maskCount(state.accounts.length);
    $('#d-joint').textContent    = maskCount(joint);
    $('#d-active').textContent   = maskCount(active);

    // frozen pill only when > 0; also flag the sidebar so the layout
    // re-balances (both balance pills shrink to the same compact size).
    $('#frozenDisplay').classList.toggle('hidden', frozen <= 0);
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('has-frozen', frozen > 0);

    // VIP tier badge
    if (state.tier) {
        const t = state.tier;
        const badge = $('#vipBadge');
        const oldId = (badge.className.match(/tier-(\w+)/) || [])[1];
        badge.className = `vip-badge tier-${t.id || 'standard'}`;
        $('#vipName').textContent = t.name || 'Standard';
        $('#vipIcon').className = `fas ${t.icon || 'fa-user'}`;
        // Pop animation when tier changes
        if (oldId && oldId !== t.id) {
            badge.style.animation = 'none';
            void badge.offsetWidth;
            badge.style.animation = 'scaleIn 0.6s var(--ease-spring)';
        }
    }

    // invitations badge
    const badge = $('#invBadge');
    badge.textContent = state.invites.length;
    badge.classList.toggle('hidden', !state.invites.length);
}

// Claim frozen balance — user picks Cash or a Bank account as destination.
async function claimFrozen() {
    const list = await post('getFrozenList');
    const items = Array.isArray(list) ? list : [];
    const total = items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    if (total <= 0) { toast('No frozen balance', 'info'); return; }

    const breakdown = items.map(x => `
        <div class="member-row" style="border:none;padding:6px 0">
            <div style="flex:1">
                <div style="font-size:12px;color:var(--text)">${x.source_name || 'Account'} · ${x.source_type}</div>
                <div style="font-size:10px;color:var(--text-dim);letter-spacing:0.5px">${x.source_account || ''}</div>
            </div>
            <div style="font-size:13px;color:var(--cyan);font-weight:600;font-variant-numeric:tabular-nums">
                ${state.config.currency}${fmt(x.amount)}
            </div>
        </div>
    `).join('');

    // Only non-frozen accounts can receive the claim
    const eligibleAccounts = (state.accounts || []).filter(a => !a.frozen);

    const m = $('#modal');
    $('#modalTitle').innerHTML = `<i class="fas fa-hand-holding-dollar"></i> Claim Frozen Balance`;
    $('#modalBody').innerHTML = `
        <div style="font-size:12px;color:var(--text-sec);margin-bottom:12px">
            Released frozen funds will be sent to your chosen destination:
        </div>
        ${breakdown}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);
                    display:flex;justify-content:space-between;font-size:14px">
            <span style="color:var(--text-sec);text-transform:uppercase;letter-spacing:0.5px;font-size:11px">Total</span>
            <span style="color:var(--cyan);font-weight:700;font-variant-numeric:tabular-nums">
                ${state.config.currency}${fmt(total)}
            </span>
        </div>

        <label style="display:block;font-size:10px;color:var(--text-dim);
                       text-transform:uppercase;letter-spacing:0.5px;margin:16px 0 6px">
            Destination
        </label>
        <div class="filter-pills" id="claimDestPills">
            <button class="pill active" data-dest="cash"><i class="fas fa-wallet"></i> Cash</button>
            <button class="pill"        data-dest="bank"><i class="fas fa-vault"></i> Bank Account</button>
        </div>

        <div id="claimAccountWrap" class="hidden" style="margin-top:10px">
            <label style="display:block;font-size:10px;color:var(--text-dim);
                           text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">
                Choose Account
            </label>
            ${eligibleAccounts.length
                ? `<select id="claimAccountSelect" class="field-select">
                       ${eligibleAccounts.map(a =>
                           `<option value="${a.id}">${a.name} — ${a.accountNumber} (${state.config.currency}${fmt(a.balance)})</option>`
                       ).join('')}
                   </select>`
                : `<div class="opt" style="border-left-color:var(--orange);margin-top:0">
                       <i class="fas fa-triangle-exclamation"></i>
                       No eligible accounts. Choose Cash, or open an account first.
                   </div>`}
        </div>

        <div id="claimError" class="form-error" style="margin-top:8px"></div>
    `;
    $('#modalOk').innerHTML = `<i class="fas fa-check"></i> Claim`;
    $('#modalOk').className = 'dlg-btn confirm';
    m.classList.remove('hidden');

    let destType = 'cash';
    const wrap = $('#claimAccountWrap');
    $$('#claimDestPills .pill').forEach(p => p.onclick = () => {
        $$('#claimDestPills .pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        destType = p.dataset.dest;
        wrap.classList.toggle('hidden', destType !== 'bank');
    });

    const close = () => {
        m.classList.add('hidden');
        $('#modalOk').onclick = null;
        $('#modalCancel').onclick = null;
        $('#modalCancelBtn').onclick = null;
    };
    $('#modalCancel').onclick    = close;
    $('#modalCancelBtn').onclick = close;

    $('#modalOk').onclick = async () => {
        $('#claimError').textContent = '';
        const payload = { destType };
        if (destType === 'bank') {
            const sel = $('#claimAccountSelect');
            if (!sel || !sel.value) {
                $('#claimError').textContent = 'No account available — pick Cash instead';
                return;
            }
            payload.accountId = parseInt(sel.value, 10);
        }
        const res = await post('claimFrozen', payload);
        if (res && res.ok) {
            close();
            const dest = res.destType === 'bank'
                ? `${res.accountName} · ${res.accountNumber}`
                : 'Cash';
            toast(`Claimed ${state.config.currency}${fmt(res.amount || total)} → ${dest}`, 'success');
            await refreshAll();
            renderOverview();
        } else {
            $('#claimError').textContent = formatServerError(res);
        }
    };
}

// ----- OVERVIEW (account table) -----
function renderOverview() {
    const list = $('#accList');
    list.innerHTML = '';
    if (!state.accounts.length) {
        list.innerHTML = `
            <div class="empty-box">
                <i class="fas fa-folder-open"></i>
                <span>No accounts yet — open your first one</span>
                <button class="main-btn cta" id="emptyCreateBtn">
                    <i class="fas fa-plus"></i> Create Account
                </button>
            </div>`;
        const btn = $('#emptyCreateBtn');
        if (btn) btn.onclick = () => setTab('create');
        return;
    }
    state.accounts.forEach(a => {
        const row = document.createElement('div');
        row.className = 'emp-row';
        const tagClass = a.frozen ? 'frozen' : a.type;
        const tagText  = a.frozen ? 'Frozen' : (a.type === 'joint' ? 'Joint' : 'Individual');
        // custom icon overrides default; fallbacks: joint→users, individual→user, frozen→snowflake
        const icon = a.icon || (a.frozen ? 'fa-snowflake' : (a.type === 'joint' ? 'fa-users' : 'fa-user'));
        // Owners get a red Close button. Non-owner joint members get an
        // orange Leave button. Solo individual accounts only show owner's close.
        const dangerBtn = (a.myRole === 'owner')
            ? `<button class="icon-btn close" data-act="close" title="Close Account"><i class="fas fa-trash"></i></button>`
            : (a.type === 'joint'
                ? `<button class="icon-btn leave" data-act="leave" title="Leave Account"><i class="fas fa-door-open"></i></button>`
                : '');

        // custom color overrides hash-based hue
        const avClass = a.frozen ? 'hue-frozen'
            : (a.color ? `color-${a.color}` : `hue-${hueOf(a.accountNumber || a.name)}`);
        const primaryStar = a.isPrimary
            ? `<span class="primary-star" title="Primary account"><i class="fas fa-star"></i></span>`
            : '';
        row.innerHTML = `
            <div class="emp-td name">
                <div class="emp-avatar ${avClass}"><i class="fas ${icon}"></i></div>
                ${a.name}${primaryStar}
            </div>
            <div class="emp-td cid">${a.accountNumber}</div>
            <div class="emp-td grade"><span class="grade-tag ${tagClass}">${tagText}</span></div>
            <div class="emp-td salary">${state.config.currency}${fmt(a.balance)}</div>
            <div class="emp-td actions">
                <button class="icon-btn dep"      data-act="deposit"  ${a.frozen ? 'disabled' : ''} title="Deposit"><i class="fas fa-arrow-up"></i></button>
                <button class="icon-btn wit"      data-act="withdraw" ${a.frozen ? 'disabled' : ''} title="Withdraw"><i class="fas fa-arrow-down"></i></button>
                <button class="icon-btn transfer" data-act="transfer" ${a.frozen ? 'disabled' : ''} title="Transfer"><i class="fas fa-paper-plane"></i></button>
                <button class="icon-btn manage"   data-act="manage" title="Manage"><i class="fas fa-gear"></i></button>
                ${dangerBtn}
            </div>
        `;
        row.querySelectorAll('button[data-act]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const act = b.dataset.act;
                if (a.frozen && (act === 'deposit' || act === 'withdraw')) {
                    toast('Account is frozen', 'error');
                    return;
                }
                if      (act === 'deposit')  quickDeposit(a);
                else if (act === 'withdraw') quickWithdraw(a);
                else if (act === 'transfer') quickTransfer(a);
                else if (act === 'close')    quickClose(a);
                else if (act === 'leave')    quickLeave(a);
                else if (act === 'manage') {
                    state.bank.selectedAccountId = a.id;
                    if ($('#setSelect').querySelector(`option[value="${a.id}"]`)) {
                        $('#setSelect').value = a.id;
                    }
                    setTab('settings');
                }
            };
        });
        list.appendChild(row);
    });
}

async function quickDeposit(account) {
    const r = await formDialog({
        title: `Deposit · ${account.name}`,
        icon: 'fa-arrow-up',
        okLabel: 'Deposit', okIcon: 'fa-arrow-up', okClass: '',
        fields: [
            { name: 'amount', label: 'Amount', type: 'number', min: 1, placeholder: '0', prefix: '$' },
        ],
        afterFields: `<div class="opt"><i class="fas fa-info-circle"></i> Cash from your wallet will be transferred into this account.</div>`,
    });
    if (!r.confirmed) return;
    const amount = parseInt(r.values.amount, 10);
    if (!amount || amount <= 0) { toast(mapError('invalid_amount'), 'error'); return; }
    const res = await post('deposit', { mode: 'bank', accountId: account.id, amount });
    if (res.ok) {
        SFX.txnSuccess();
        receiptToast({
            type: 'Deposit', account: `${account.name} · ${account.accountNumber}`,
            amount, balance: res.balance, sign: 'pos',
        });
        await refreshAll();
        renderOverview();
        renderSidebar();
    } else {
        toast(formatServerError(res), 'error');
    }
}

// Quick transfer FROM this account → own account / player / citizen.
// Opens a dialog with destination type pills and a smart input that
// switches between a dropdown (for own accounts) and a text input.
async function quickTransfer(account) {
    if (account.frozen) { toast('Account is frozen', 'error'); return; }
    const others = state.accounts.filter(a => a.id !== account.id && !a.frozen);

    // Build the dialog body inline so we can manage state without reopening
    const m = $('#modal');
    $('#modalTitle').innerHTML = `<i class="fas fa-paper-plane"></i> Transfer · ${account.name}`;
    $('#modalBody').innerHTML = `
        <div class="form modal-form">
            <div class="opt" style="margin-top:0;border-left-color:var(--blue)">
                <i class="fas fa-info-circle"></i> Sending from
                <b style="color:var(--text)">${account.name}</b>
                (${account.accountNumber}) · Balance ${state.config.currency}${fmt(account.balance)}
            </div>

            <label style="margin-top:14px">Send To</label>
            <div class="filter-pills" id="qtPills" style="margin-bottom:6px">
                <button class="pill active" data-tt="own_account"><i class="fas fa-folder"></i> My Account</button>
                <button class="pill" data-tt="player_id"><i class="fas fa-user"></i> Player ID</button>
                <button class="pill" data-tt="citizen_id"><i class="fas fa-id-card"></i> Citizen ID</button>
            </div>

            <div class="field" style="margin:0">
                <label id="qtLabel">Destination Account</label>
                <select id="qtSelect" class="field-select">
                    ${others.length
                        ? others.map(a => `<option value="${a.accountNumber}">${a.name} — ${a.accountNumber} (${state.config.currency}${fmt(a.balance)})</option>`).join('')
                        : '<option value="">No other account available</option>'
                    }
                </select>
                <input type="text" id="qtInput" class="field-input hidden" placeholder="" />
            </div>

            <div class="field">
                <label>Amount</label>
                <div class="fin-input-wrap">
                    <span class="fin-currency">$</span>
                    <input type="number" id="qtAmount" class="fin-input" min="1" placeholder="0" />
                </div>
            </div>

            <div class="field">
                <label>Note <span class="opt" style="background:none;border:none;border-left:none;padding:0;display:inline">(optional)</span></label>
                <input type="text" id="qtNote" class="field-input" maxlength="120" placeholder="" />
            </div>

            <div class="field">
                <label>PIN <span class="opt" style="background:none;border:none;border-left:none;padding:0;display:inline">(4 digits)</span></label>
                <input type="password" id="qtPin" class="field-input" maxlength="${state.config.pinLength}" placeholder="••••" />
            </div>

            <div id="qtError" class="form-error"></div>
        </div>
    `;
    $('#modalOk').innerHTML = `<i class="fas fa-paper-plane"></i> Send Transfer`;
    $('#modalOk').className = 'dlg-btn confirm';
    m.classList.remove('hidden');

    // Local state for which destination type is active
    let tt = 'own_account';
    const refresh = () => {
        const sel = $('#qtSelect');
        const inp = $('#qtInput');
        if (tt === 'own_account') {
            $('#qtLabel').textContent = 'Destination Account';
            sel.classList.remove('hidden');
            inp.classList.add('hidden');
        } else {
            $('#qtLabel').textContent = tt === 'player_id' ? 'Player Server ID' : 'Citizen ID';
            inp.placeholder = tt === 'player_id' ? 'e.g. 4' : 'e.g. ABC12345';
            inp.classList.remove('hidden');
            sel.classList.add('hidden');
        }
    };
    $$('#qtPills .pill').forEach(p => p.onclick = () => {
        $$('#qtPills .pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        tt = p.dataset.tt;
        refresh();
    });
    refresh();
    setTimeout(() => $('#qtAmount').focus(), 50);

    const close = () => {
        m.classList.add('hidden');
        $('#modalOk').onclick = null;
        $('#modalCancel').onclick = null;
        $('#modalCancelBtn').onclick = null;
    };
    $('#modalCancel').onclick    = close;
    $('#modalCancelBtn').onclick = close;
    $('#modalOk').onclick = async () => {
        $('#qtError').textContent = '';
        const targetValue = (tt === 'own_account')
            ? ($('#qtSelect').value || '').trim()
            : ($('#qtInput').value  || '').trim();
        const amount = parseInt($('#qtAmount').value, 10);
        const note   = $('#qtNote').value.trim();
        const pin    = $('#qtPin').value;
        if (!targetValue) { $('#qtError').textContent = 'Recipient required'; return; }
        if (!amount || amount <= 0) { $('#qtError').textContent = mapError('invalid_amount'); return; }
        if (pin.length !== state.config.pinLength || !/^\d+$/.test(pin)) { $('#qtError').textContent = mapError('pin_format'); return; }
        const res = await post('transfer', {
            fromAccountId: account.id,
            targetType: tt,
            targetValue, amount, note, pin,
        });
        if (res && res.ok) {
            const targetLabel = (tt === 'own_account')
                ? `Account ${targetValue}`
                : (tt === 'player_id' ? `Player #${targetValue}` : `CID ${targetValue}`);
            receiptToast({
                type: 'Transfer', account: `${account.name} · ${account.accountNumber}`,
                amount, balance: res.balance, target: targetLabel, sign: 'neg',
            });
            close();
            await refreshAll();
            renderOverview();
            renderSidebar();
        } else {
            $('#qtError').textContent = formatServerError(res);
        }
    };
}

// Close an account from the row — owner only (server enforces). PIN required.
async function quickClose(account) {
    const r = await formDialog({
        title: `Close · ${account.name}`,
        icon: 'fa-triangle-exclamation',
        okLabel: 'Close Account', okIcon: 'fa-trash', okClass: 'danger',
        fields: [
            { name: 'pin', label: 'PIN', hint: '(4 digits)', type: 'password', maxlength: state.config.pinLength, placeholder: '••••' },
        ],
        afterFields: `<div class="opt" style="border-left-color:var(--orange)"><i class="fas fa-info-circle"></i> Closing returns the remaining <b style="color:var(--green)">${state.config.currency}${fmt(account.balance)}</b> to your cash. Account is permanently deleted.</div>`,
    });
    if (!r.confirmed) return;
    const pin = r.values.pin || '';
    if (pin.length !== state.config.pinLength || !/^\d+$/.test(pin)) { toast(mapError('pin_format'), 'error'); return; }
    const res = await post('closeAccount', { accountId: account.id, pin });
    if (res.ok) {
        toast(`${account.name} closed`, 'success');
        await refreshAll();
        renderOverview();
        renderSidebar();
    } else {
        toast(formatServerError(res), 'error');
    }
}

// Leave a joint account (non-owner members only)
async function quickLeave(account) {
    const ok = await confirmDialog({
        title: `Leave · ${account.name}`,
        icon: 'fa-door-open',
        okLabel: 'Leave', okClass: 'danger',
        body: `<div style="font-size:13px;line-height:1.6;color:var(--text-sec)">Leave joint account <b style="color:var(--text)">${account.name}</b>? You'll lose access. The account remains with the owner.</div>`,
    });
    if (!ok) return;
    const res = await post('leaveAccount', { accountId: account.id });
    if (res.ok) {
        toast(state.locale.ok_left_account || 'Left account', 'info');
        await refreshAll();
        renderOverview();
        renderSidebar();
    } else {
        toast(formatServerError(res), 'error');
    }
}

async function quickWithdraw(account) {
    const r = await formDialog({
        title: `Withdraw · ${account.name}`,
        icon: 'fa-arrow-down',
        okLabel: 'Withdraw', okIcon: 'fa-arrow-down',
        fields: [
            { name: 'amount', label: 'Amount', type: 'number', min: 1, placeholder: '0', prefix: '$' },
            { name: 'pin',    label: 'PIN', hint: '(4 digits)', type: 'password', maxlength: state.config.pinLength, placeholder: '••••' },
        ],
        afterFields: `<div class="opt"><i class="fas fa-shield-halved"></i> Withdrawing requires your PIN.</div>`,
    });
    if (!r.confirmed) return;
    const amount = parseInt(r.values.amount, 10);
    const pin    = r.values.pin || '';
    if (!amount || amount <= 0) { toast(mapError('invalid_amount'), 'error'); return; }
    if (pin.length !== state.config.pinLength || !/^\d+$/.test(pin)) { toast(mapError('pin_format'), 'error'); return; }
    const res = await post('withdraw', { mode: 'bank', accountId: account.id, amount, pin });
    if (res.ok) {
        SFX.txnSuccess();
        receiptToast({
            type: 'Withdraw', account: `${account.name} · ${account.accountNumber}`,
            amount, balance: res.balance, sign: 'neg',
        });
        await refreshAll();
        renderOverview();
        renderSidebar();
    } else {
        toast(formatServerError(res), 'error');
    }
}

// ----- TRANSFER -----
async function renderTransferForm() {
    const sel = $('#trFrom');
    sel.innerHTML = state.accounts
        .filter(a => !a.frozen)
        .map(a => `<option value="${a.id}">${a.name} — ${a.accountNumber} (${state.config.currency}${fmt(a.balance)})</option>`)
        .join('');
    updateTrTargetLabel();
    $('#trError').textContent = '';
    ['#trAmount','#trNote','#trPin','#trTargetValue'].forEach(s => $(s).value = '');
    // refresh contacts strip
    state.contacts = await post('getContacts') || [];
    renderContactsStrip();
}

// Render the contacts strip below the recipient input on the Transfer page.
function renderContactsStrip() {
    const strip = $('#trContacts');
    const container = $('#trContactsChips');
    const tt = state.bank.transferType;
    if (tt !== 'citizen_id' && tt !== 'player_id') {
        strip.classList.add('hidden');
        return;
    }
    const list = (state.contacts || []).slice(0, 8); // top 8 by recency
    if (!list.length) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    container.innerHTML = list.map(c => {
        const name = c.label || c.target_cid;
        return `
            <button class="contact-chip" type="button" data-cid="${c.target_cid}" title="Transfer to ${name}">
                <span class="chip-avatar">${initials(name)}</span>
                <span>${name}</span>
                ${c.transfer_count > 1 ? `<span class="chip-count">×${c.transfer_count}</span>` : ''}
            </button>
        `;
    }).join('');
    container.querySelectorAll('.contact-chip').forEach(b => b.onclick = () => {
        // switch to citizen_id and fill the input
        if (state.bank.transferType !== 'citizen_id') {
            $$('[data-page="transfer"] .pill').forEach(x => x.classList.remove('active'));
            const cidPill = $('[data-page="transfer"] .pill[data-tt="citizen_id"]');
            if (cidPill) cidPill.classList.add('active');
            state.bank.transferType = 'citizen_id';
            updateTrTargetLabel();
        }
        $('#trTargetValue').value = b.dataset.cid;
        $('#trAmount').focus();
    });
}

// Rebuild the "Own Account" destination dropdown — excludes the source.
function updateOwnAccountSelect() {
    const fromId = parseInt($('#trFrom').value, 10);
    const sel    = $('#trTargetSelect');
    const others = state.accounts.filter(a => a.id !== fromId && !a.frozen);
    if (!others.length) {
        sel.innerHTML = `<option value="">No other account available</option>`;
        return;
    }
    sel.innerHTML = others.map(a =>
        `<option value="${a.accountNumber}">${a.name} — ${a.accountNumber} (${state.config.currency}${fmt(a.balance)})</option>`
    ).join('');
}

function updateTrTargetLabel() {
    const t = state.bank.transferType;
    const map = { player_id: 'Player Server ID', citizen_id: 'Citizen ID', own_account: 'Destination Account' };
    $('#trTargetLabel').textContent = map[t] || '';

    const inp = $('#trTargetValue');
    const sel = $('#trTargetSelect');
    if (t === 'own_account') {
        inp.classList.add('hidden');
        sel.classList.remove('hidden');
        updateOwnAccountSelect();
    } else {
        sel.classList.add('hidden');
        inp.classList.remove('hidden');
        inp.placeholder = t === 'player_id' ? 'e.g. 4' : 'e.g. ABC12345';
    }
    // refresh contacts strip visibility
    renderContactsStrip();
}

// Render the dedicated Contacts page (manage list)
async function renderContacts() {
    const list = $('#contactsList');
    list.innerHTML = `<div class="empty-box"><i class="fas fa-spinner fa-spin"></i><span>Loading…</span></div>`;
    state.contacts = await post('getContacts') || [];
    if (!state.contacts.length) {
        list.innerHTML = `<div class="empty-box"><i class="fas fa-user-slash"></i><span>No saved contacts yet</span></div>`;
        return;
    }
    list.innerHTML = '';
    state.contacts.forEach(c => {
        const name = c.label || c.target_cid;
        const row = document.createElement('div');
        row.className = 'contact-row';
        row.innerHTML = `
            <div class="c-avatar">${initials(name)}</div>
            <div class="c-info">
                <div class="c-name">${name}</div>
                <div class="c-meta">CID ${c.target_cid} · ${c.transfer_count || 0} transfer(s) · last used ${formatDate(c.last_used)}</div>
            </div>
            <div class="c-actions">
                <button class="icon-btn" data-action="rename" title="Rename"><i class="fas fa-pen"></i></button>
                <button class="icon-btn close" data-action="remove" title="Remove"><i class="fas fa-trash"></i></button>
            </div>
        `;
        row.querySelector('[data-action="rename"]').onclick = async () => {
            const r = await formDialog({
                title: `Rename Contact`,
                icon: 'fa-pen',
                okLabel: 'Save',
                fields: [{ name: 'label', label: 'Custom Label', type: 'text', maxlength: 48, placeholder: name }],
            });
            if (!r.confirmed) return;
            const res = await post('renameContact', { contactId: c.id, label: r.values.label || '' });
            if (res.ok) { toast('Contact renamed', 'success'); renderContacts(); }
            else toast(formatServerError(res), 'error');
        };
        row.querySelector('[data-action="remove"]').onclick = async () => {
            const ok = await confirmDialog({
                title: 'Remove Contact', icon: 'fa-trash',
                okLabel: 'Remove', okClass: 'danger',
                body: `<div style="font-size:13px;color:var(--text-sec)">Remove <b style="color:var(--text)">${name}</b> from your contacts?</div>`,
            });
            if (!ok) return;
            const res = await post('removeContact', { contactId: c.id });
            if (res.ok) { toast('Contact removed', 'info'); renderContacts(); }
            else toast(formatServerError(res), 'error');
        };
        list.appendChild(row);
    });
}
async function submitTransfer() {
    $('#trError').textContent = '';
    const fromAccountId = parseInt($('#trFrom').value, 10);
    const targetType    = state.bank.transferType;
    // Read from the right element: dropdown for own_account, text input otherwise
    const targetValue   = (targetType === 'own_account')
        ? ($('#trTargetSelect').value || '').trim()
        : ($('#trTargetValue').value  || '').trim();
    const amount        = parseInt($('#trAmount').value, 10);
    const note          = $('#trNote').value.trim();
    const pin           = $('#trPin').value;
    if (!targetValue) { $('#trError').textContent = 'Recipient required'; return; }
    if (!amount || amount <= 0) { $('#trError').textContent = mapError('invalid_amount'); return; }
    if (pin.length !== state.config.pinLength) { $('#trError').textContent = mapError('pin_format'); return; }
    const res = await post('transfer', { fromAccountId, targetType, targetValue, amount, note, pin });
    if (res.ok) {
        SFX.txnSuccess();
        const fromAcc = state.accounts.find(a => a.id === fromAccountId);
        const targetLabel = (targetType === 'own_account')
            ? `Account ${targetValue}`
            : (targetType === 'player_id' ? `Player #${targetValue}` : `CID ${targetValue}`);
        receiptToast({
            type: 'Transfer',
            account: fromAcc ? `${fromAcc.name} · ${fromAcc.accountNumber}` : '—',
            amount, balance: res.balance, target: targetLabel, sign: 'neg',
        });
        await refreshAll();
        setTab('overview');
    } else {
        $('#trError').textContent = formatServerError(res);
    }
}

// ----- HISTORY -----
// History state — filtered + searched
const histState = { accountId: null, rows: [], filter: 'all', search: '' };

async function renderHistoryPicker() {
    const sel = $('#histSelect');
    sel.innerHTML = state.accounts.map(a =>
        `<option value="${a.id}">${a.name} — ${a.accountNumber}</option>`
    ).join('');
    if (state.accounts.length) {
        sel.value = state.accounts[0].id;
        await loadHistory(state.accounts[0].id);
    } else {
        $('#histList').innerHTML = `<div class="empty-box"><i class="fas fa-receipt"></i><span>No accounts</span></div>`;
    }
}

async function loadHistory(accountId) {
    histState.accountId = accountId;
    const list = $('#histList');
    list.innerHTML = `<div class="empty-box"><i class="fas fa-spinner fa-spin"></i><span>Loading…</span></div>`;
    const rows = await post('transactions', { accountId });
    histState.rows = Array.isArray(rows) ? rows : [];
    renderHistoryRows();
}

function renderHistoryRows() {
    const list = $('#histList');
    const labelMap = {
        deposit: 'Deposit', withdraw: 'Withdraw',
        transfer_in: 'Received', transfer_out: 'Sent',
        internal_in: 'Internal In', internal_out: 'Internal Out',
        admin: 'Admin',
    };
    const iconMap = {
        deposit:      'fa-arrow-up',    withdraw:     'fa-arrow-down',
        transfer_in:  'fa-arrow-up',    transfer_out: 'fa-arrow-down',
        internal_in:  'fa-arrow-right-arrow-left', internal_out: 'fa-arrow-right-arrow-left',
        admin:        'fa-screwdriver-wrench',
    };

    // filter
    const f = histState.filter;
    let rows = histState.rows.filter(r => {
        if (f === 'all')      return true;
        if (f === 'in')       return r.kind === 'deposit' || r.kind === 'transfer_in';
        if (f === 'out')      return r.kind === 'withdraw' || r.kind === 'transfer_out';
        if (f === 'transfer') return r.kind === 'transfer_in' || r.kind === 'transfer_out';
        if (f === 'internal') return r.kind === 'internal_in' || r.kind === 'internal_out';
        return true;
    });

    // search
    const q = (histState.search || '').toLowerCase().trim();
    if (q) {
        rows = rows.filter(r =>
            (r.target_label || '').toLowerCase().includes(q) ||
            (r.note || '').toLowerCase().includes(q) ||
            String(r.amount).includes(q) ||
            (labelMap[r.kind] || r.kind).toLowerCase().includes(q) ||
            (r.created_at || '').toString().includes(q)
        );
    }

    if (!rows.length) {
        list.innerHTML = `<div class="empty-box"><i class="fas fa-magnifying-glass"></i><span>No matching transactions</span></div>`;
        return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
        const isIn  = r.kind === 'deposit' || r.kind === 'transfer_in' || r.kind === 'internal_in';
        const isOut = r.kind === 'withdraw' || r.kind === 'transfer_out' || r.kind === 'internal_out';
        const sign  = isIn ? '+' : (isOut ? '−' : '');
        const cls   = isIn ? 'positive' : (isOut ? 'negative' : 'neutral');
        const date  = formatDate(r.created_at);
        const item  = document.createElement('div');
        item.className = 'hist-item';
        item.innerHTML = `
            <div class="hist-icon ${r.kind}"><i class="fas ${iconMap[r.kind] || 'fa-circle'}"></i></div>
            <div class="hist-info">
                <div class="hist-title">${labelMap[r.kind] || r.kind}${r.target_label ? ` · ${r.target_label}` : ''}</div>
                <div class="hist-meta">${r.note || '—'}</div>
            </div>
            <div class="hist-right">
                <div class="hist-amount ${cls}">${sign}${state.config.currency}${fmt(r.amount)}</div>
                <div class="hist-date">${date} · Bal: ${state.config.currency}${fmt(r.balance_after)}</div>
            </div>
        `;
        list.appendChild(item);
    });
}

// Export — builds a clean text statement from the visible transactions and
// shows it in a dialog. User can copy to clipboard, or select + Ctrl+C.
// No file download — just clean text.
function exportHistoryCSV() {
    if (!histState.rows.length) { toast('Nothing to export', 'info'); return; }
    const acc = state.accounts.find(a => a.id === histState.accountId);
    const accName = acc ? acc.name : 'Account';
    const accNum  = acc ? acc.accountNumber : '';
    const labelMap = {
        deposit: 'Deposit', withdraw: 'Withdraw',
        transfer_in: 'Received', transfer_out: 'Sent',
        internal_in: 'Internal In', internal_out: 'Internal Out',
        admin: 'Admin',
    };

    // Build a nicely-aligned plain-text table (more readable than CSV).
    const cols = histState.rows.map(r => [
        formatDate(r.created_at),
        labelMap[r.kind] || r.kind,
        `${state.config.currency}${fmt(r.amount)}`,
        `${state.config.currency}${fmt(r.balance_after)}`,
        r.target_label || '—',
        r.note || '—',
    ]);
    const headers = ['Date', 'Type', 'Amount', 'Balance', 'Target', 'Note'];
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...cols.map(row => String(row[i]).length))
    );
    const pad = (s, w) => String(s).padEnd(w);
    const sep = widths.map(w => '─'.repeat(w)).join('─┼─');

    const headerLine = headers.map((h, i) => pad(h, widths[i])).join(' │ ');
    const bodyLines  = cols.map(row =>
        row.map((cell, i) => pad(cell, widths[i])).join(' │ ')
    );
    const text =
        `Statement — ${accName} (${accNum})\n` +
        `Generated: ${formatDate(new Date().toISOString())}\n` +
        `Transactions: ${histState.rows.length}\n` +
        '\n' +
        headerLine + '\n' +
        sep + '\n' +
        bodyLines.join('\n');

    const m = $('#modal');
    $('#modalTitle').innerHTML = `<i class="fas fa-file-lines"></i> Export Statement`;
    $('#modalBody').innerHTML = `
        <div class="opt" style="margin-top:0;border-left-color:var(--blue)">
            <i class="fas fa-info-circle"></i>
            ${histState.rows.length} transaction(s) from
            <b style="color:var(--text)">${accName}</b>
            ${accNum ? `· <span style="color:var(--text-dim);letter-spacing:0.5px">${accNum}</span>` : ''}
        </div>
        <textarea id="exportArea" readonly
            style="width:100%;height:280px;margin-top:14px;padding:12px;
                   background:rgba(0,0,0,0.3);border:1px solid var(--border);
                   color:var(--text);font-family:'Consolas','Courier New',monospace;
                   font-size:11px;line-height:1.55;outline:none;resize:vertical;
                   white-space:pre;overflow-x:auto;
                   font-variant-numeric:tabular-nums;"></textarea>
        <button class="dlg-btn confirm" id="exportCopy"
                style="width:100%;justify-content:center;margin-top:12px">
            <i class="fas fa-clipboard"></i> Copy to Clipboard
        </button>
        <div id="exportFeedback" style="font-size:11px;color:var(--text-dim);margin-top:10px;min-height:14px;text-align:center"></div>
    `;
    $('#modalOk').classList.add('hidden');
    $('#modalCancelBtn').textContent = 'Close';
    m.classList.remove('hidden');

    const ta = $('#exportArea');
    ta.value = text;

    const close = () => {
        m.classList.add('hidden');
        $('#modalOk').classList.remove('hidden');
        $('#modalCancelBtn').textContent = 'Cancel';
        $('#modalCancel').onclick = null;
        $('#modalCancelBtn').onclick = null;
    };
    $('#modalCancel').onclick    = close;
    $('#modalCancelBtn').onclick = close;

    $('#exportCopy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(text);
            $('#exportFeedback').innerHTML = `<i class="fas fa-circle-check" style="color:var(--green)"></i> Copied — paste anywhere with Ctrl+V`;
            toast(`Copied ${histState.rows.length} transactions`, 'success');
        } catch (e) {
            ta.focus(); ta.select();
            try {
                document.execCommand('copy');
                $('#exportFeedback').innerHTML = `<i class="fas fa-circle-check" style="color:var(--green)"></i> Copied (selection mode)`;
                toast('Copied to clipboard', 'success');
            } catch (e2) {
                $('#exportFeedback').innerHTML = `<i class="fas fa-triangle-exclamation" style="color:var(--orange)"></i> Auto-copy blocked — text is selected, press Ctrl+C`;
                ta.select();
            }
        }
    };

    setTimeout(() => { ta.focus(); ta.select(); }, 60);
}

// ----- CREATE -----
function renderCreateForm() {
    $('#newName').value = '';
    $('#newPin').value = '';
    $('#newPin2').value = '';
    $('#newError').textContent = '';
    $('#newFeeLine').textContent = state.config.newFee > 0
        ? `Account opening fee: ${state.config.currency}${fmt(state.config.newFee)} (cash)`
        : '';
}
async function submitCreate() {
    $('#newError').textContent = '';
    const name = $('#newName').value.trim() || 'Account';
    const pin  = $('#newPin').value;
    const pin2 = $('#newPin2').value;
    if (pin !== pin2) { $('#newError').textContent = 'PINs do not match'; return; }
    if (pin.length !== state.config.pinLength || !/^\d+$/.test(pin)) {
        $('#newError').textContent = mapError('pin_format'); return;
    }
    const type = state.bank.newType;
    const res = await post('createAccount', { name, pin, type });
    if (res.ok) {
        SFX.accountNew();
        toast(state.locale.ok_account_created || 'Account created', 'success');
        await refreshAll();
        setTab('overview');
    } else {
        SFX.error();
        $('#newError').textContent = formatServerError(res);
        console.error('[qb-banking] createAccount failed:', res);
    }
}

// ----- INVITATIONS -----
function renderInvites() {
    const list = $('#invList');
    list.innerHTML = '';
    if (!state.invites.length) {
        list.innerHTML = `<div class="empty-box"><i class="fas fa-envelope-open"></i><span>No pending invitations</span></div>`;
        return;
    }
    state.invites.forEach(i => {
        const row = document.createElement('div');
        row.className = 'inv-card';
        row.innerHTML = `
            <div class="inv-icon"><i class="fas fa-envelope"></i></div>
            <div class="inv-info">
                <div class="inv-title">${i.name} · ${i.account_number}</div>
                <div class="inv-sub">From CID ${i.inviter_cid} · ${i.type}</div>
            </div>
            <div class="inv-acts">
                <button class="dlg-btn confirm" data-accept="${i.id}"><i class="fas fa-check"></i> Accept</button>
                <button class="dlg-btn cancel"  data-decline="${i.id}">Decline</button>
            </div>
        `;
        list.appendChild(row);
    });
}
async function respondInvite(id, accept) {
    const res = await post('respondInvite', { inviteId: parseInt(id, 10), accept });
    if (res.ok) {
        toast(accept ? (state.locale.ok_invite_accepted || 'Joined') : (state.locale.ok_invite_declined || 'Declined'),
              accept ? 'success' : 'info');
        await refreshAll();
        renderInvites();
    } else toast(formatServerError(res), 'error');
}

// ----- SETTINGS -----
function renderSettingsPicker() {
    const sel = $('#setSelect');
    sel.innerHTML = state.accounts.map(a =>
        `<option value="${a.id}">${a.name} — ${a.accountNumber}</option>`
    ).join('');
    if (state.bank.selectedAccountId && state.accounts.find(a => a.id === state.bank.selectedAccountId)) {
        sel.value = state.bank.selectedAccountId;
    } else if (state.accounts.length) {
        sel.value = state.accounts[0].id;
    }
    renderSettingsBody(parseInt(sel.value, 10));
}

function renderSettingsBody(accountId) {
    const acc = state.accounts.find(a => a.id === accountId);
    const box = $('#setBox');
    box.innerHTML = '';
    if (!acc) {
        box.innerHTML = `<div class="empty-box"><i class="fas fa-folder-open"></i><span>Select an account</span></div>`;
        return;
    }

    // Primary toggle (any member can set their own primary)
    const secPrimary = document.createElement('div');
    secPrimary.className = 'set-section';
    secPrimary.innerHTML = `
        <h4><i class="fas fa-star"></i> Primary Account</h4>
        <div class="opt" style="margin-top:0;border-left-color:var(--orange)">
            <i class="fas fa-info-circle"></i>
            Your primary account is shown first and used as the default destination.
        </div>
        <div class="set-row">
            <button class="main-btn" id="setPrimaryBtn">
                <i class="fas ${acc.isPrimary ? 'fa-star' : 'fa-star'}"></i>
                ${acc.isPrimary ? 'Unset as Primary' : 'Set as Primary'}
            </button>
        </div>
    `;
    box.appendChild(secPrimary);

    // Owner-only: customization (icon + color + rename)
    if (acc.myRole === 'owner') {
        const ICONS  = ['fa-user','fa-users','fa-house','fa-car','fa-briefcase','fa-piggy-bank','fa-vault','fa-gem','fa-plane','fa-shop','fa-graduation-cap','fa-heart','fa-star','fa-gun','fa-cake-candles','fa-coins','fa-snowflake','fa-crown'];
        const COLORS = ['green','blue','purple','orange','cyan','red','gold'];
        const currentIcon = acc.icon || (acc.type === 'joint' ? 'fa-users' : 'fa-user');
        const secCustom = document.createElement('div');
        secCustom.className = 'set-section';
        secCustom.innerHTML = `
            <h4><i class="fas fa-palette"></i> Customize</h4>
            <div class="picker-group">
                <div class="picker-row">
                    <span class="picker-label">Name</span>
                    <input type="text" id="custName" class="field-input" maxlength="48" value="${(acc.name || '').replace(/"/g,'&quot;')}" style="flex:1;min-width:160px">
                    <button class="icon-btn" id="custRename" title="Save name"><i class="fas fa-check"></i></button>
                </div>
                <div class="picker-row">
                    <span class="picker-label">Icon</span>
                    <div class="icon-picker-wrap" id="iconPickerWrap">
                        <div class="icon-picker-current">
                            <div class="icon-tile current selected" id="iconCurrentTile"><i class="fas ${currentIcon}"></i></div>
                            <button class="icon-expand-btn" id="iconExpandBtn" title="Choose icon"><i class="fas fa-chevron-down"></i></button>
                        </div>
                        <div class="icon-tiles-expanded" id="iconPicker">
                            ${ICONS.map((ic, i) => `<div class="icon-tile ${acc.icon === ic ? 'selected' : ''}" data-icon="${ic}" title="${ic}" style="--i: ${i}"><i class="fas ${ic}"></i></div>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="picker-row">
                    <span class="picker-label">Color</span>
                    <div class="picker-tiles" id="colorPicker" style="display:flex;gap:8px;flex:1">
                        ${COLORS.map(c => `<div class="color-tile ${c} ${acc.color === c ? 'selected' : ''}" data-color="${c}" title="${c}"></div>`).join('')}
                    </div>
                </div>
            </div>
        `;
        box.appendChild(secCustom);
    }

    // change pin (anyone with access)
    const sec1 = document.createElement('div');
    sec1.className = 'set-section';
    sec1.innerHTML = `
        <h4><i class="fas fa-key"></i> Change PIN</h4>
        <div class="set-row"><input type="password" maxlength="4" placeholder="Current PIN" id="setOldPin" class="field-input"></div>
        <div class="set-row"><input type="password" maxlength="4" placeholder="New PIN"     id="setNewPin" class="field-input"></div>
        <div class="set-row"><button class="main-btn" id="setChangePin"><i class="fas fa-rotate"></i> Update PIN</button></div>
    `;
    box.appendChild(sec1);

    // Forgot PIN — owner-only. Joint members cannot use this.
    if (acc.myRole === 'owner') {
        const secForgot = document.createElement('div');
        secForgot.className = 'set-section';
        secForgot.innerHTML = `
            <h4><i class="fas fa-circle-question"></i> Forgot PIN</h4>
            <div class="opt" style="margin-top:0;border-left-color:var(--orange)">
                <i class="fas fa-shield-halved"></i>
                As the account owner, you can reset the PIN without knowing the old one.
                ${acc.type === 'joint' ? 'Other members will be notified.' : ''}
            </div>
            <div class="set-row"><input type="password" maxlength="4" placeholder="New PIN"     id="forgotNewPin"  class="field-input"></div>
            <div class="set-row"><input type="password" maxlength="4" placeholder="Confirm PIN" id="forgotNewPin2" class="field-input"></div>
            <div class="set-row"><button class="main-btn" id="forgotReset"><i class="fas fa-rotate"></i> Reset PIN</button></div>
        `;
        box.appendChild(secForgot);
    }

    // Split Expense (joint owner only, when enabled)
    if (acc.type === 'joint' && acc.myRole === 'owner' && state.config.splitExpense) {
        const memberCount = (acc.members || []).length || 1;
        const secSplit = document.createElement('div');
        secSplit.className = 'set-section';
        secSplit.innerHTML = `
            <h4><i class="fas fa-users-rectangle"></i> Split Expense</h4>
            <div class="opt" style="margin-top:0;border-left-color:var(--cyan)">
                <i class="fas fa-info-circle"></i>
                Split a bill equally among all <b style="color:var(--text)">${memberCount} member(s)</b>.
                Each member's primary account gets charged. Total goes to this joint.
            </div>
            <div class="set-row">
                <div class="fin-input-wrap" style="flex:1">
                    <span class="fin-currency">$</span>
                    <input type="number" id="splitAmount" class="fin-input" min="${memberCount}" placeholder="0">
                </div>
            </div>
            <div class="set-row">
                <input type="text" id="splitDesc" class="field-input" maxlength="80" placeholder="Description (e.g. Rent, Bills)">
            </div>
            <div class="set-row">
                <button class="main-btn" id="splitBtn"><i class="fas fa-divide"></i> Split & Charge</button>
            </div>
        `;
        box.appendChild(secSplit);
    }

    // members (joint only)
    if (acc.type === 'joint') {
        const sec2 = document.createElement('div');
        sec2.className = 'set-section';
        const memHtml = (acc.members || []).map(m => `
            <div class="member-row">
                <div class="emp-avatar" style="width:30px;height:30px;font-size:11px">${initials(m.label || m.citizenid)}</div>
                <div class="mr-name">${m.label || m.citizenid}</div>
                <div class="mr-role">${m.role}</div>
                ${(acc.myRole === 'owner' && m.role !== 'owner') ?
                    `<button class="icon-btn" data-remove="${m.citizenid}" title="Remove"><i class="fas fa-user-minus"></i></button>` : ''}
            </div>
        `).join('');
        sec2.innerHTML = `
            <h4><i class="fas fa-users"></i> Members (${(acc.members || []).length}/${state.config.jointMax})</h4>
            ${memHtml || '<div class="empty-box" style="padding:20px"><i class="fas fa-user-slash"></i><span>No members</span></div>'}
            ${acc.myRole === 'owner' ? `
                <div class="set-row" style="margin-top:14px">
                    <select id="invType" class="field-select" style="flex:0 0 140px">
                        <option value="player_id">Player ID</option>
                        <option value="citizen_id">Citizen ID</option>
                    </select>
                    <input type="text" id="invValue" class="field-input" placeholder="ID">
                    <button class="main-btn" id="invSend"><i class="fas fa-user-plus"></i> Invite</button>
                </div>
            ` : ''}
        `;
        box.appendChild(sec2);
    }

    // danger zone
    const sec3 = document.createElement('div');
    sec3.className = 'set-section';
    if (acc.myRole === 'owner') {
        sec3.innerHTML = `
            <h4><i class="fas fa-triangle-exclamation"></i> Close Account</h4>
            <div class="opt" style="margin-top:0;border-left-color:var(--orange)"><i class="fas fa-info-circle"></i> Closing returns the remaining balance as cash.</div>
            <div class="set-row">
                <input type="password" maxlength="4" placeholder="PIN" id="setClosePin" class="field-input">
                <button class="main-btn danger" id="setClose"><i class="fas fa-trash"></i> Close</button>
            </div>
        `;
    } else {
        sec3.innerHTML = `
            <h4><i class="fas fa-door-open"></i> Leave Account</h4>
            <div class="set-row"><button class="main-btn danger" id="setLeave"><i class="fas fa-sign-out-alt"></i> Leave</button></div>
        `;
    }
    box.appendChild(sec3);

    bindSettingsHandlers(acc);
}

function bindSettingsHandlers(acc) {
    // Primary toggle
    const sp = $('#setPrimaryBtn');
    if (sp) sp.onclick = async () => {
        const target = acc.isPrimary ? null : acc.id;
        const res = await post('setPrimary', { accountId: target });
        if (res.ok) {
            toast(target ? 'Set as primary' : 'Primary cleared', 'success');
            await refreshAll();
            renderSettingsBody(acc.id);
            renderOverview();
        } else toast(formatServerError(res), 'error');
    };

    // Rename
    const rn = $('#custRename');
    if (rn) rn.onclick = async () => {
        const name = ($('#custName').value || '').trim();
        if (!name) { toast('Name required', 'error'); return; }
        const res = await post('renameAccount', { accountId: acc.id, name });
        if (res.ok) { toast('Name updated', 'success'); await refreshAll(); renderOverview(); renderSettingsPicker(); }
        else toast(formatServerError(res), 'error');
    };

    // Icon picker — expand/collapse + selection
    const iconWrap = $('#iconPickerWrap');
    const expandBtn = $('#iconExpandBtn');
    const currentTile = $('#iconCurrentTile');

    if (expandBtn) expandBtn.onclick = (e) => {
        e.stopPropagation();
        iconWrap.classList.toggle('expanded');
    };
    if (currentTile) currentTile.onclick = (e) => {
        e.stopPropagation();
        iconWrap.classList.toggle('expanded');
    };

    $$('#iconPicker .icon-tile').forEach(tile => tile.onclick = async (e) => {
        e.stopPropagation();
        const icon = tile.dataset.icon;
        const res = await post('customizeAccount', { accountId: acc.id, icon, color: acc.color });
        if (res.ok) {
            $$('#iconPicker .icon-tile').forEach(t => t.classList.remove('selected'));
            tile.classList.add('selected');
            // update the "current" preview tile
            const cIcon = $('#iconCurrentTile i');
            if (cIcon) cIcon.className = `fas ${icon}`;
            acc.icon = icon;
            // smoothly collapse after a short beat so user sees their choice "click"
            setTimeout(() => iconWrap.classList.remove('expanded'), 150);
            await refreshAll();
            renderOverview();
        } else toast(formatServerError(res), 'error');
    });

    // Color picker
    $$('#colorPicker .color-tile').forEach(tile => tile.onclick = async () => {
        const color = tile.dataset.color;
        const res = await post('customizeAccount', { accountId: acc.id, icon: acc.icon, color });
        if (res.ok) {
            $$('#colorPicker .color-tile').forEach(t => t.classList.remove('selected'));
            tile.classList.add('selected');
            acc.color = color;
            await refreshAll();
            renderOverview();
        } else toast(formatServerError(res), 'error');
    });

    const cp = $('#setChangePin');
    if (cp) cp.onclick = async () => {
        const oldPin = $('#setOldPin').value, newPin = $('#setNewPin').value;
        const res = await post('changePin', { accountId: acc.id, oldPin, newPin });
        if (res.ok) toast(state.locale.ok_pin_changed || 'PIN changed', 'success');
        else toast(formatServerError(res), 'error');
    };

    // Split Expense handler (joint, owner only)
    const sb = $('#splitBtn');
    if (sb) sb.onclick = async () => {
        const amount = parseInt($('#splitAmount').value, 10);
        const desc   = ($('#splitDesc').value || 'Split expense').trim();
        if (!amount || amount <= 0) { toast(mapError('invalid_amount'), 'error'); return; }
        const members = (acc.members || []).length || 1;
        const share   = Math.floor(amount / members);
        const ok = await confirmDialog({
            title: 'Confirm Split',
            icon: 'fa-divide',
            okLabel: 'Split & Charge', okIcon: 'fa-check',
            body: `<div style="font-size:13px;color:var(--text-sec);line-height:1.7">
                Split <b style="color:var(--green)">${state.config.currency}${fmt(amount)}</b>
                among <b style="color:var(--text)">${members} member(s)</b>.
                <br>Each member pays <b style="color:var(--orange)">${state.config.currency}${fmt(share)}</b> from their primary account.
                ${amount % members !== 0 ? `<br><span style="color:var(--text-dim);font-size:11px">Owner covers the ${state.config.currency}${fmt(amount - share * members)} remainder.</span>` : ''}
                <br><br>Description: <i>${desc}</i>
            </div>`,
        });
        if (!ok) return;
        const res = await post('splitExpense', { accountId: acc.id, amount, description: desc });
        if (res && res.ok) {
            toast(`Split ${state.config.currency}${fmt(amount)} among ${res.members}`, 'success');
            $('#splitAmount').value = '';
            $('#splitDesc').value = '';
            await refreshAll();
            renderSettingsBody(acc.id);
            renderOverview();
        } else toast(formatServerError(res), 'error');
    };

    // Forgot PIN handler — owner-only flow
    const fp = $('#forgotReset');
    if (fp) fp.onclick = async () => {
        const newPin  = $('#forgotNewPin').value;
        const newPin2 = $('#forgotNewPin2').value;
        if (newPin !== newPin2)            { toast('PINs do not match', 'error'); return; }
        if (newPin.length !== state.config.pinLength || !/^\d+$/.test(newPin)) {
            toast(mapError('pin_format'), 'error'); return;
        }
        const ok = await confirmDialog({
            title: 'Reset PIN',
            icon: 'fa-circle-question',
            okLabel: 'Reset PIN', okIcon: 'fa-rotate', okClass: 'danger',
            body: `<div style="font-size:13px;line-height:1.6;color:var(--text-sec)">Reset the PIN for <b style="color:var(--text)">${acc.name}</b>? ${acc.type === 'joint' ? 'All members will need to use the new PIN.' : ''}</div>`,
        });
        if (!ok) return;
        const res = await post('resetPin', { accountId: acc.id, newPin });
        if (res.ok) {
            toast('PIN reset successfully', 'success');
            $('#forgotNewPin').value = '';
            $('#forgotNewPin2').value = '';
        } else {
            toast(formatServerError(res), 'error');
        }
    };
    const inv = $('#invSend');
    if (inv) inv.onclick = async () => {
        const tt = $('#invType').value, val = $('#invValue').value.trim();
        if (!val) return;
        const res = await post('invite', { accountId: acc.id, targetType: tt, targetValue: val });
        if (res.ok) { toast(state.locale.ok_invite_sent || 'Invite sent', 'success'); await refreshAll(); renderSettingsBody(acc.id); }
        else toast(formatServerError(res), 'error');
    };
    $$('button[data-remove]').forEach(b => b.onclick = async () => {
        const res = await post('removeMember', { accountId: acc.id, targetCid: b.dataset.remove });
        if (res.ok) { toast('Member removed', 'success'); await refreshAll(); renderSettingsBody(acc.id); }
        else toast(formatServerError(res), 'error');
    });
    const closeBtn = $('#setClose');
    if (closeBtn) closeBtn.onclick = async () => {
        const ok = await confirmDialog({
            title: 'Close Account',
            icon: 'fa-triangle-exclamation',
            okLabel: 'Close', okIcon: 'fa-trash', okClass: 'danger',
            body: `<div style="font-size:13px;line-height:1.6;color:var(--text-sec)">Close <b style="color:var(--text)">${acc.name}</b>? Remaining <b style="color:var(--green)">${state.config.currency}${fmt(acc.balance)}</b> returns to your cash.</div>`,
        });
        if (!ok) return;
        const pin = $('#setClosePin').value;
        const res = await post('closeAccount', { accountId: acc.id, pin });
        if (res.ok) { toast('Account closed', 'success'); await refreshAll(); setTab('overview'); }
        else toast(formatServerError(res), 'error');
    };
    const leaveBtn = $('#setLeave');
    if (leaveBtn) leaveBtn.onclick = async () => {
        const ok = await confirmDialog({
            title: 'Leave Account',
            icon: 'fa-door-open',
            okLabel: 'Leave', okClass: 'danger',
            body: `<div style="font-size:13px;line-height:1.6;color:var(--text-sec)">Leave <b style="color:var(--text)">${acc.name}</b>? You'll lose access.</div>`,
        });
        if (!ok) return;
        const res = await post('leaveAccount', { accountId: acc.id });
        if (res.ok) { toast(state.locale.ok_left_account || 'Left account', 'info'); await refreshAll(); setTab('overview'); }
        else toast(formatServerError(res), 'error');
    };
}

// ============================================================
// quick balance (ATM)
// ============================================================
async function quickGo() {
    const num = $('#quickInput').value.trim();
    const out = $('#quickOut');
    out.innerHTML = '';
    if (!num) return;
    const res = await post('quickBalance', { accountNumber: num });
    if (!res || (res.balance === undefined || res.balance === null)) {
        out.innerHTML = `<div class="qo-name" style="color:var(--red)">Account not found</div>`;
        return;
    }
    out.innerHTML = `
        <div class="qo-name">${res.name}</div>
        <div class="qo-num">${res.accountNumber}</div>
        <div class="qo-bal">${state.config.currency}${fmt(res.balance)}</div>
    `;
}

// ============================================================
// global refresh
// ============================================================
// Refresh state from server. Defensive: only overwrite state when the
// response has the expected SHAPE — an empty {} (e.g. a Lua callback race
// with the QBCore single-key trigger) would otherwise blank the UI. If
// data is stale/missing, we keep the previous values intact and just
// re-render with what we have.
async function refreshAll() {
    const r = await post('refresh');
    if (r && Array.isArray(r.accounts)) state.accounts = r.accounts;
    if (r && Array.isArray(r.invites))  state.invites  = r.invites;
    if (r && typeof r.cash   === 'number') state.cash   = r.cash;
    if (r && typeof r.frozen === 'number') state.frozen = r.frozen;
    if (r && r.tier) state.tier = r.tier;
    renderSidebar();
}

// ============================================================
// open / close
// ============================================================
function openUI(payload) {
    state.accounts = payload.accounts || [];
    state.invites  = payload.invites  || [];
    state.cash     = (payload.cash   !== undefined ? payload.cash   : state.cash)   || 0;
    state.frozen   = (payload.frozen !== undefined ? payload.frozen : state.frozen) || 0;
    state.tier     = payload.tier || state.tier || null;
    state.config   = Object.assign(state.config, payload.config || {});
    state.locale   = payload.locale || {};
    root.classList.remove('hidden');
    if (payload.mode === 'atm') {
        atmEl.classList.remove('hidden');
        bankEl.classList.add('hidden');
        atmShowStage('pick');
        renderAtmAccounts();
        SFX.openAtm();
    } else {
        bankEl.classList.remove('hidden');
        atmEl.classList.add('hidden');
        setTab('overview');
        renderSidebar();
        startClock();
        SFX.openBank();
    }
}

function closeUI(skipPost) {
    if (root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    atmEl.classList.add('hidden');
    bankEl.classList.add('hidden');
    state.atm.pin = '';
    pendingOp = null;
    stopClock();
    if (!skipPost) { SFX.close(); post('close'); }
}

// ============================================================
// clock
// ============================================================
let clockTimer;
function tickClock() {
    const d = new Date();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    const t = `${h}:${m} ${ampm}`;
    const t1 = $('#time'), t2 = $('#time2');
    if (t1) t1.textContent = t;
    if (t2) t2.textContent = t;
}
function startClock() { tickClock(); clockTimer = setInterval(tickClock, 30000); }
function stopClock()  { clearInterval(clockTimer); }

// ============================================================
// event bindings
// ============================================================
document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-close]'); if (t) return closeUI();
});

// Subtle click feedback on every actionable button (delegated)
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.icon-btn, .op-btn, .quick-amt, .pill, .main-btn, .dlg-btn');
    if (!btn || btn.disabled) return;
    SFX.click();
});

// ATM
$('#atmQuickBtn').onclick = () => atmShowStage('quick');
$$('#atm [data-back]').forEach(b => b.onclick = () => atmShowStage('pick'));
$('#atm [data-back-ops]').onclick = () => atmShowStage('pick');
$$('#atm .pin-pad button').forEach(b => b.onclick = () => pinPress(b.dataset.key));
$('#atmAmtCancel').onclick = cancelOp;
$('#atmAmtOk').onclick = confirmOp;
$$('#atm [data-op]').forEach(b => b.onclick = () => startOp(b.dataset.op));
$$('.fin-quick-amounts .quick-amt').forEach(b => b.onclick = () => {
    if (b.dataset.amt === 'max') {
        const acc = state.accounts.find(a => a.id === state.atm.accountId);
        if (pendingOp === 'withdraw' && acc) $('#atmAmount').value = acc.balance;
        return;
    }
    $('#atmAmount').value = b.dataset.amt;
});
$('#quickGo').onclick = quickGo;

// ATM PIN keyboard
document.addEventListener('keydown', (e) => {
    if (atmEl.classList.contains('hidden')) return;
    if (state.atm.stage !== 'pin') return;
    if (e.key >= '0' && e.key <= '9') pinPress(e.key);
    else if (e.key === 'Backspace') pinPress('back');
    else if (e.key === 'Enter')     pinPress('ok');
});

// BANK navigation
$$('.nav-item').forEach(b => b.onclick = () => setTab(b.dataset.tab));

// Frozen balance: claim
$('#claimFrozenBtn').onclick = claimFrozen;

// ===================================================
// Privacy toggle — hides every $ amount + counts behind dots.
// Persists across sessions via localStorage. Re-renders the active
// tab + sidebar so the change is immediate without reopening.
// ===================================================
function syncPrivacyButton() {
    const btn  = $('#privacyBtn');
    const icon = $('#privacyIcon');
    if (!btn || !icon) return;
    btn.classList.toggle('on', state.privacy);
    icon.className = state.privacy ? 'fas fa-eye-slash' : 'fas fa-eye';
    btn.title = state.privacy ? 'Show balance' : 'Hide balance';
}
function togglePrivacy() {
    state.privacy = !state.privacy;
    try { localStorage.setItem('qbk_privacy', state.privacy ? '1' : '0'); } catch (e) {}
    syncPrivacyButton();
    SFX.tabSwitch?.();
    // Re-render: sidebar always, plus whatever tab is currently visible.
    renderSidebar();
    const tab = state.bank.tab;
    if (tab === 'overview')    renderOverview();
    if (tab === 'transfer')    renderTransferForm();
    if (tab === 'history')     renderHistoryRows();
    if (tab === 'settings')    renderSettingsPicker();
    if (tab === 'create')      renderCreateForm();
}
syncPrivacyButton();
const _privacyBtnEl = $('#privacyBtn');
if (_privacyBtnEl) _privacyBtnEl.onclick = togglePrivacy;

// transfer pills
$$('[data-page="transfer"] .pill').forEach(b => b.onclick = () => {
    $$('[data-page="transfer"] .pill').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.bank.transferType = b.dataset.tt;
    updateTrTargetLabel();
});
// keep the Own-Account destination list in sync with the From account
$('#trFrom').addEventListener('change', () => {
    if (state.bank.transferType === 'own_account') updateOwnAccountSelect();
});
$('#trSend').onclick = submitTransfer;

// new account pills
$$('[data-newtype]').forEach(b => b.onclick = () => {
    $$('[data-newtype]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.bank.newType = b.dataset.newtype;
});
$('#newSubmit').onclick = submitCreate;

// dropdowns
$('#histSelect').addEventListener('change', e => loadHistory(parseInt(e.target.value, 10)));

// History toolbar: search + filter + export
$('#histSearch').addEventListener('input', e => {
    histState.search = e.target.value;
    $('#histSearchClear').classList.toggle('hidden', !e.target.value);
    renderHistoryRows();
});
$('#histSearchClear').onclick = () => {
    $('#histSearch').value = '';
    histState.search = '';
    $('#histSearchClear').classList.add('hidden');
    renderHistoryRows();
};
$$('[data-page="history"] .pill').forEach(b => b.onclick = () => {
    $$('[data-page="history"] .pill').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    histState.filter = b.dataset.hf;
    renderHistoryRows();
});
$('#histExport').onclick = exportHistoryCSV;
$('#setSelect').addEventListener('change', e => {
    state.bank.selectedAccountId = parseInt(e.target.value, 10);
    renderSettingsBody(state.bank.selectedAccountId);
});

// invitations
$('#invList').addEventListener('click', (e) => {
    const a = e.target.closest('[data-accept]');
    const d = e.target.closest('[data-decline]');
    if (a) respondInvite(a.dataset.accept, true);
    else if (d) respondInvite(d.dataset.decline, false);
});

// ESC
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.classList.contains('hidden')) {
        // collapse expanded icon picker first
        const w = $('#iconPickerWrap');
        if (w && w.classList.contains('expanded')) { w.classList.remove('expanded'); return; }
        // if a dialog is open, close it next
        if (!$('#modal').classList.contains('hidden')) {
            $('#modal').classList.add('hidden');
            return;
        }
        closeUI();
    }
});

// Global listener: collapse the icon picker if click lands outside it
document.addEventListener('click', (e) => {
    const w = $('#iconPickerWrap');
    if (!w || !w.classList.contains('expanded')) return;
    if (!w.contains(e.target)) w.classList.remove('expanded');
});

// ============================================================
// FiveM messages
// ============================================================
window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.action === 'open')      openUI(msg);
    else if (msg.action === 'visible' && msg.visible === false) closeUI(true);
    else if (msg.action === 'gotoQuick' && !atmEl.classList.contains('hidden')) atmShowStage('quick');
    else if (msg.action === 'liveRefresh') refreshAll();
});
