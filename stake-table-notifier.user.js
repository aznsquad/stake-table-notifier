// ==UserScript==
// @name         Stake Table Notifier (Evolution + Pragmatic)
// @namespace    http://tampermonkey.net/
// @version      6.3
// @description  Escalating alerts (sound -> flashing tab -> Windows popup -> phone push) so you never miss a bet window, even when distracted on another tab or your phone
// @author       You
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/aznsquad/stake-table-notifier/main/stake-table-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/aznsquad/stake-table-notifier/main/stake-table-notifier.user.js
// ==/UserScript==

// INSTALL THIS FILE DIRECTLY AS A USERSCRIPT - do NOT wrap it in a second
// script that pulls this one in via @require. Tampermonkey caches @require
// payloads aggressively and does NOT re-fetch them just because the outer
// wrapper was saved, which silently pins you to old code that looks
// identical from the outside. With @updateURL/@downloadURL set above and
// the version bumped on each change, Tampermonkey's normal auto-update
// path handles this correctly instead.

// NOTE on @match *://*/*: the actual live-casino game client (Big Road,
// Good Roads tab, bet button) loads inside a separate iframe served from
// a randomized, rotating domain - not stake.com. Tampermonkey only injects
// a script into a frame whose OWN url matches @match, so there is no fixed
// domain we can pin here. Instead this script runs everywhere and
// self-detects (see FRAME GUARD below) whether the current page/frame is
// actually the Stake lobby or a live casino table before doing anything -
// everywhere else it stays completely inert (no timers, no audio, no DOM work).

(function() {
    'use strict';

    // ---------------------------------------------------------------
    // SETTINGS. Stored via Tampermonkey's GM_setValue/GM_getValue, NOT
    // localStorage - localStorage is scoped per-origin, and the game
    // iframe loads from a randomized, rotating domain, so localStorage
    // would silently reset (position, volume, Telegram token, everything)
    // whenever that domain changes between sessions. GM storage is scoped
    // to the script itself, so it's the same data no matter which domain
    // the game iframe happens to load from. Falls back to localStorage
    // only if GM_setValue/GM_getValue are somehow unavailable.
    // ---------------------------------------------------------------
    const STORAGE_KEY = 'stakeNotifierSettings_v3';
    const defaultSettings = {
        masterEnabled: true,
        soundEnabled: true,
        volume: 0.8, // 0.0 - 1.0
        notifEnabled: true,
        telegramEnabled: false,
        telegramBotToken: '',
        telegramChatId: '',
        panelCollapsed: false,
        panelPos: null // { left, top } in px once the user has dragged it; null = default bottom-left
    };

    // Tuning constants - deliberately NOT part of persisted settings, since
    // there's no UI to change them and a value saved under an old default
    // would otherwise silently stick around forever even after the default
    // itself is tightened later.
    // Single source of truth for the version, shown in the panel header and
    // in every log line - so "which version is actually loaded?" is never a
    // guess again. Tampermonkey caches @require content aggressively, and
    // several rounds of debugging were wasted testing stale code that
    // looked identical from the outside. Keep this in sync with @version.
    const SCRIPT_VERSION = '6.3';

    const CHECK_INTERVAL_MS = 500;
    const ESCALATION_DELAY_MS = 8000;      // how long a bet window must stay open + you stay away before we buzz your phone
    const TELEGRAM_MIN_INTERVAL_MS = 60000; // don't phone-ping more than once per minute, even if multiple windows escalate

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function loadSettings() {
        try {
            const raw = hasGM ? GM_getValue(STORAGE_KEY, null) : localStorage.getItem(STORAGE_KEY);
            return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
        } catch (e) {
            return { ...defaultSettings };
        }
    }

    function saveSettings(s) {
        const raw = JSON.stringify(s);
        if (hasGM) {
            GM_setValue(STORAGE_KEY, raw);
        } else {
            try { localStorage.setItem(STORAGE_KEY, raw); } catch (e) { /* ignore */ }
        }
    }

    let settings = loadSettings();

    // ---------------------------------------------------------------
    // TAB VISIBILITY / FOCUS
    // ---------------------------------------------------------------
    function isUserAway() {
        // "away" = they can't currently see this tab, whether it's
        // another tab/window on the same PC, or the screen is off/locked.
        return document.visibilityState !== 'visible' || !document.hasFocus();
    }

    // ---------------------------------------------------------------
    // FRAME BRIDGE
    //
    // Detection has to happen INSIDE the provider's game iframe (that's
    // where the tiles, Good/Hot Roads panel and bet spots live), but
    // alerting must NOT happen there:
    //
    //  - Audio: a cross-origin iframe has its own AudioContext and its own
    //    autoplay-unlock requirement. The user clicks around on stake.com,
    //    not inside Evolution's canvas, so that frame's audio stayed
    //    permanently blocked - which is exactly why Pragmatic made sound
    //    and Evolution never did. Previously "solved" by drawing a
    //    click-to-unlock badge in the game frame, which is the second box
    //    on screen the user has repeatedly asked to get rid of.
    //  - Popups/Telegram: firing from both frames means duplicates, and
    //    the game frame's own visibility/focus state is not a reliable
    //    stand-in for "is the user looking at this".
    //
    // So: game frame detects and posts events up; the top frame owns the
    // panel, the AudioContext (unlocked by ordinary clicking on stake.com),
    // notifications and Telegram. One box, one alert, working sound on
    // both providers.
    // ---------------------------------------------------------------
    const IS_TOP = (function () {
        try { return window.top === window; } catch (e) { return false; }
    })();

    const BRIDGE_MARKER = 'stake-notifier-event';

    // Unique per frame. Evolution runs several frames on the SAME hostname,
    // so keying anything by hostname alone makes them silently overwrite
    // each other - which is how the "30 tables, no tabs" frame and the
    // "tabs, no tables" frame looked like one contradictory frame.
    const FRAME_ID = `${location.hostname}#${Math.random().toString(36).slice(2, 8)}`;

    // A userscript can end up installed MORE THAN ONCE - a stale entry plus
    // a fresh install, or an "update" that lands as a second entry instead
    // of replacing the first. Both copies then run in the same frame, and
    // you get two panels and two of every sound. That is exactly what
    // happened here: after updating, the top frame had two v6.0 panels.
    //
    // Tampermonkey sandboxes each instance, so a window-level flag is not
    // reliably shared between them - but the DOM is. First instance to boot
    // in a given frame plants a marker and owns that frame; any later
    // instance goes completely inert. JS is single-threaded and each script
    // runs as its own task, so this check-then-set cannot interleave.
    function claimFrame() {
        const LOCK_ID = 'sn-instance-lock';
        if (document.getElementById(LOCK_ID)) return false;
        const lock = document.createElement('meta');
        lock.id = LOCK_ID;
        lock.setAttribute('data-version', SCRIPT_VERSION);
        (document.head || document.documentElement).appendChild(lock);
        return true;
    }

    // Second line of defence: even if two instances somehow both go live
    // (e.g. one in an about:blank subframe the lock can't see), don't let
    // the same alert fire twice within a second.
    const recentAlerts = new Map();
    function isDuplicateAlert(evt) {
        const key = `${evt.type}|${evt.key || evt.body || ''}`;
        const now = Date.now();
        const last = recentAlerts.get(key) || 0;
        if (now - last < 1500) return true;
        recentAlerts.set(key, now);
        return false;
    }

    function dispatchEvent_(evt) {
        if (IS_TOP) { handleAlertEvent(evt); return; }
        try {
            window.top.postMessage({ __marker: BRIDGE_MARKER, version: SCRIPT_VERSION, evt }, '*');
        } catch (e) { /* top frame unreachable - nothing we can do */ }
    }

    function handleAlertEvent(evt) {
        if (!settings.masterEnabled) return;
        if (isDuplicateAlert(evt)) return;

        if (evt.type === 'new-tables') {
            playSound('newTable');
            showPopup('Good Roads table found', evt.body);
            sendTelegram(evt.body);
            console.log('Stake Notifier: ALERT new tables -', evt.body);
        } else if (evt.type === 'bet-open') {
            playSound('betOpen');
            showPopup('Bet window open', `${evt.key || 'A table'} is accepting bets right now.`);
            startFlashing();
            console.log('Stake Notifier: ALERT bet window open -', evt.key);
            // Only buzz the phone if they still haven't come back by then.
            setTimeout(() => {
                if (!isUserAway()) return;
                sendTelegram(`Bet window open on Stake (${evt.key}) and you have not acted - go check.`);
            }, ESCALATION_DELAY_MS);
        } else if (evt.type === 'all-bets-closed') {
            stopFlashing();
        }
    }

    // Debug snapshots from the game frame land here so the (cross-origin)
    // frame's real markup can be inspected from the top frame instead of
    // guessed at. Read with:  window.__SN_DEBUG__
    function receiveDebugSnapshot(snap) {
        try {
            if (!window.__SN_DEBUG__) window.__SN_DEBUG__ = {};
            window.__SN_DEBUG__[snap.host] = snap;
        } catch (e) { /* sandboxed window - DOM mirror below covers it */ }

        // Tampermonkey runs granted scripts in a sandbox, so the window
        // property above may be invisible to page-context devtools. Mirror
        // it into the DOM, which is always reachable.
        let node = document.getElementById('sn-debug-data');
        if (!node) {
            node = document.createElement('script');
            node.type = 'application/json';
            node.id = 'sn-debug-data';
            document.documentElement.appendChild(node);
        }
        let store = {};
        try { store = JSON.parse(node.textContent || '{}'); } catch (e) { store = {}; }
        store[snap.frameId] = snap;
        node.textContent = JSON.stringify(store);
    }

    function listenForFrameEvents() {
        window.addEventListener('message', (e) => {
            const d = e.data;
            if (!d || d.__marker !== BRIDGE_MARKER) return;
            if (d.debug) { receiveDebugSnapshot(d.debug); return; }
            if (d.state) { receiveState(d.state); return; }
            if (d.evt) handleAlertEvent(d.evt);
        });
    }

    // ---------------------------------------------------------------
    // AUDIO
    // ---------------------------------------------------------------
    let audioContext = null;
    function getAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        return audioContext;
    }

    // Browsers block audio from playing until the page has had a genuine
    // user interaction (autoplay policy). Since alerts fire on their own
    // (not from a click), the very first automatic sound can silently do
    // nothing even though nothing errors - "Test sound" only ever worked
    // because clicking that button IS the required interaction. Unlock the
    // context as early as possible on the first real interaction anywhere
    // on the page, so by the time a genuine alert needs to fire, it can.
    function unlockAudioOnFirstInteraction(onUnlock) {
        const unlock = () => {
            getAudioContext();
            document.removeEventListener('click', unlock, true);
            document.removeEventListener('keydown', unlock, true);
            document.removeEventListener('touchstart', unlock, true);
            if (onUnlock) onUnlock();
        };
        document.addEventListener('click', unlock, true);
        document.addEventListener('keydown', unlock, true);
        document.addEventListener('touchstart', unlock, true);
    }

    // toneType: 'newTable' | 'betOpen' | 'test'
    function playSound(toneType) {
        if (!settings.soundEnabled || !settings.masterEnabled) return;
        const ctx = getAudioContext();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        const vol = Math.max(0, Math.min(1, settings.volume ?? 0.8));

        if (toneType === 'betOpen') {
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.setValueAtTime(900, now + 0.12);
            osc.frequency.setValueAtTime(600, now + 0.24);
            osc.frequency.setValueAtTime(900, now + 0.36);
            gain.gain.setValueAtTime(0.35 * vol, now);
            gain.gain.exponentialRampToValueAtTime(0.01 * vol + 0.0001, now + 0.5);
            osc.start(now);
            osc.stop(now + 0.5);
        } else {
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.exponentialRampToValueAtTime(1000, now + 0.1);
            gain.gain.setValueAtTime(0.3 * vol, now);
            gain.gain.exponentialRampToValueAtTime(0.01 * vol + 0.0001, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        }
    }

    // ---------------------------------------------------------------
    // OS / WINDOWS POPUP NOTIFICATIONS
    // ---------------------------------------------------------------
    // Whether this actually lands bottom-right is up to Windows' own
    // Action Center / Focus Assist settings, not this script - Chrome
    // just hands the notification off to the OS.
    function requestNotifPermission(callback) {
        if (!('Notification' in window)) {
            alert('This browser does not support desktop notifications.');
            return;
        }
        if (Notification.permission === 'granted') {
            callback && callback(true);
            return;
        }
        Notification.requestPermission().then(perm => callback && callback(perm === 'granted'));
    }

    function showPopup(title, body) {
        if (!settings.notifEnabled || !settings.masterEnabled) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (!isUserAway()) return;

        try {
            const n = new Notification(title, {
                body,
                icon: 'https://stake.com/favicon.ico',
                tag: 'stake-notifier-' + Date.now()
            });
            n.onclick = () => { window.focus(); n.close(); };
            setTimeout(() => n.close(), 10000);
        } catch (e) {
            console.warn('Stake Notifier: failed to show notification', e);
        }
    }

    // ---------------------------------------------------------------
    // TELEGRAM PHONE PUSH (last-resort channel for "away from the PC")
    // ---------------------------------------------------------------
    let lastTelegramSentAt = 0;

    // Returns a promise resolving to { ok: boolean, reason?: string } so
    // callers (like the test button) can report what actually happened,
    // instead of assuming success the moment the request was fired off.
    function sendTelegram(text, opts) {
        const bypassRateLimit = opts && opts.bypassRateLimit;

        if (!settings.telegramEnabled || !settings.masterEnabled) {
            return Promise.resolve({ ok: false, reason: 'Telegram/master toggle is off' });
        }
        if (!settings.telegramBotToken || !settings.telegramChatId) {
            return Promise.resolve({ ok: false, reason: 'missing bot token or chat ID' });
        }

        const now = Date.now();
        if (!bypassRateLimit && now - lastTelegramSentAt < TELEGRAM_MIN_INTERVAL_MS) {
            return Promise.resolve({ ok: false, reason: 'rate-limited, try again shortly' });
        }
        lastTelegramSentAt = now;

        const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.telegramChatId, text })
        }).then(async res => {
            if (res.ok) return { ok: true };
            let detail = '';
            try { detail = (await res.json()).description || ''; } catch (e) { /* ignore */ }
            console.warn('Stake Notifier: Telegram send failed', res.status, detail);
            return { ok: false, reason: detail || `HTTP ${res.status}` };
        }).catch(err => {
            console.warn('Stake Notifier: Telegram send error', err);
            return { ok: false, reason: err.message || 'network/CORS error' };
        });
    }

    // ---------------------------------------------------------------
    // TAB TITLE / FAVICON FLASH (catches "different tab, same PC")
    // ---------------------------------------------------------------
    const ORIGINAL_TITLE = document.title;
    let flashIntervalId = null;
    let flashOn = false;

    function startFlashing() {
        if (flashIntervalId) return;
        flashIntervalId = setInterval(() => {
            flashOn = !flashOn;
            document.title = flashOn ? '🔴 BET OPEN!' : ORIGINAL_TITLE;
        }, 1000);
    }

    function stopFlashing() {
        if (!flashIntervalId) return;
        clearInterval(flashIntervalId);
        flashIntervalId = null;
        document.title = ORIGINAL_TITLE;
    }

    // ---------------------------------------------------------------
    // LOBBY: new-table detection (only ever runs on the stake.com lobby
    // page, never inside an actual game frame - see runChecks below)
    // ---------------------------------------------------------------
    const seenTables = new Set();

    // Collapses all whitespace (including non-breaking spaces, which \s
    // matches in JS regex) down to single regular spaces and trims. Button
    // labels rendered as icon+text can end up with a literal NBSP or other
    // odd whitespace between words that a plain string comparison misses.
    function normalizeText(t) {
        return (t || '').replace(/\s+/g, ' ').trim();
    }

    // Finds the smallest/most specific element (by normalized text length)
    // whose text matches the given pattern, among a length ceiling. This
    // deliberately does NOT require the element to have zero children -
    // requiring that (an exact "leaf" match) is what broke Hot Roads
    // detection on Evolution: its label sits in its own span alongside an
    // icon span, so no single zero-children leaf ever held exactly "Hot
    // Roads" on its own. Searching all elements and taking the shortest
    // match converges on the most specific one regardless of how the icon
    // and label are split across child nodes.
    function findShortestTextMatch(pattern, maxLen) {
        const all = Array.from(document.querySelectorAll('button, div, span, a, label'));
        let best = null;
        let bestLen = Infinity;
        all.forEach(el => {
            const t = normalizeText(el.textContent);
            if (!t || t.length > maxLen || !pattern.test(t)) return;
            if (t.length < bestLen) { bestLen = t.length; best = el; }
        });
        return best;
    }

    // Evolution and Pragmatic use the same underlying idea (surface
    // tables matching a favourable pattern) but expose it completely
    // differently:
    //  - Pragmatic: a "Good Roads" TAB inside an already-open Multiplay
    //    game (handled separately, inside the game-frame section below).
    //  - Evolution: a "Hot Roads" FILTER BUTTON on the outer lobby page
    //    itself, which re-sorts/filters which game tiles appear in the
    //    grid - there's no per-game tab at all.
    // This checks the lobby-level filter row for either label, and
    // compares its text color against a neutral sibling filter (e.g.
    // "Speed") to tell whether it's the one currently active. Returns
    // null if we can't find enough of the filter row to tell.
    function isPatternFilterActive() {
        const patternEl = findShortestTextMatch(/hot\s*roads|good\s*roads/i, 24);
        const neutralEl = findShortestTextMatch(/^speed$/i, 12);
        if (!patternEl || !neutralEl) return null;

        function colorOf(el) {
            const target = el.closest('button') || el;
            return getComputedStyle(target).color;
        }
        return colorOf(patternEl) !== colorOf(neutralEl);
    }

    // ---------------------------------------------------------------
    // GAME FRAME: bet-window detection (runs inside the live table
    // iframe). "Baccarat Multiplay" renders SEVERAL tables at once in a
    // grid - each table opens/closes for betting independently - so this
    // tracks per-table state (keyed by table name), not one global flag.
    //
    // The real bet UI is three buttons labelled PLAYER / TIE / BANKER
    // that appear together only while that specific table is open for
    // betting - not a button whose text contains the word "bet" (that
    // was the earlier bug: it was matching a post-bet summary label).
    // ---------------------------------------------------------------
    const betOpenTables = new Map(); // key (table name) -> { escalated }
    let betOpenConsecutiveHits = new Map(); // key -> consecutive-hit counter
    let hadOpenTables = false;              // so "all closed" is sent once, not every poll
    const BET_HITS_TO_CONFIRM = 2; // require 2 consecutive polls agreeing before firing, to kill one-frame flicker false positives

    // Only true when the "Good Roads" tab is the one currently selected
    // (vs "All Tables") - so alerts are scoped to Stake's own
    // pattern-matched list, not every table. Returns null if we can't
    // tell (e.g. markup changed), in which case we proceed anyway rather
    // than going silently dead.
    function isGoodRoadsTabActive() {
        const allTablesEl = findShortestTextMatch(/all\s*tables/i, 24);
        const goodRoadsEl = findShortestTextMatch(/good\s*roads/i, 24);
        if (!allTablesEl || !goodRoadsEl) return null;

        function luminance(el) {
            const target = el.closest('button') || el;
            const bg = getComputedStyle(target).backgroundColor;
            const nums = bg.match(/[\d.]+/g);
            if (!nums || nums.length < 3) return null;
            const [r, g, b] = nums.map(Number);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        const goodRoadsLum = luminance(goodRoadsEl);
        const allTablesLum = luminance(allTablesEl);
        if (goodRoadsLum === null || allTablesLum === null) return null;
        return goodRoadsLum > allTablesLum; // active tab has the lighter pill background
    }

    // Finds every table currently showing its PLAYER/TIE/BANKER betting
    // spots, and returns a Set of table-name keys for those tables.
    function findActiveBetTables() {
        const leafEls = Array.from(document.querySelectorAll('button, div, span'))
            .filter(el => el.children.length === 0);
        const playerEls = leafEls.filter(el => (el.textContent || '').trim().toUpperCase() === 'PLAYER');

        const keys = new Set();
        playerEls.forEach(playerEl => {
            let betRow = playerEl.parentElement;
            let depth = 0;
            while (betRow && depth < 6) {
                const t = betRow.textContent || '';
                if (/\bTIE\b/.test(t) && /\bBANKER\b/.test(t)) break;
                betRow = betRow.parentElement;
                depth++;
            }
            if (!betRow) return;

            let nameContainer = betRow;
            depth = 0;
            while (nameContainer && depth < 8 && !/baccarat|dragon\s*tiger/i.test(nameContainer.textContent || '')) {
                nameContainer = nameContainer.parentElement;
                depth++;
            }
            const text = (nameContainer || betRow).textContent || '';
            const nameMatch = text.match(/[A-Za-z][A-Za-z\s]{2,30}(Baccarat|Dragon Tiger)\b/);
            keys.add(nameMatch ? nameMatch[0].trim() : text.slice(0, 40));
        });
        return keys;
    }

    // ---------------------------------------------------------------
    // GAME FRAME: "new Good Roads table appeared" detection. This is
    // the original ask - a sound when a table shows up matching your
    // preferred pattern - but it has to run HERE, inside the game
    // iframe, because the Good Roads list itself lives here, not on
    // the outer stake.com lobby page (that was the bug: the old
    // lobby-only detector was watching the wrong frame entirely).
    // Works for both Evolution and Pragmatic since it just looks for
    // table-name headings, not provider-specific markup.
    // ---------------------------------------------------------------
    const seenGoodRoadsTables = new Set();

    // Selector list matters more than it looks. This used to be
    // 'div, span, h1..h4', which on Evolution matched exactly ONE table
    // ("Elite VIP Speed Baccarat") out of the ~30 on screen - every other
    // tile puts its name in a p/a/button/li instead. A detector that can
    // only see 1 of 30 tables cannot possibly notice a new one appearing,
    // which is a large part of why Evolution never alerted.
    const NAME_LEAF_SELECTOR = 'div, span, p, a, button, li, h1, h2, h3, h4, h5, h6';

    // \p{L} rather than A-Za-z: "Salon Privé Baccarat A" was silently
    // excluded by the old ASCII-only class.
    const TABLE_NAME_RE = /^[\p{L}][\p{L}0-9\s'&\-]{2,40}(Baccarat|Dragon Tiger)[\p{L}0-9\s'&\-]{0,10}$/iu;

    function findVisibleTableNames() {
        const leafEls = Array.from(document.querySelectorAll(NAME_LEAF_SELECTOR))
            .filter(el => el.children.length === 0);
        const names = new Set();
        leafEls.forEach(el => {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (TABLE_NAME_RE.test(t)) names.add(t);
        });
        return names;
    }


    // ---------------------------------------------------------------
    // CROSS-FRAME AGGREGATION (top frame only)
    //
    // Evolution does not put everything in one frame the way Pragmatic
    // does. Captured live from its own frames: one reports the Multiplay
    // shell - "Big Road / ALL TABLES / GOOD ROADS / UNDO / REFRESH", chip
    // values, and ZERO table names; another reports ~30 table names and no
    // tabs at all. So a detector that runs per-frame and asks "is GOOD
    // ROADS selected AND do I see new tables?" can never answer yes on
    // Evolution: no single frame can see both halves of that question.
    //
    // So every frame just reports what it can see, and the top frame -
    // which already owns the panel and the alerting - joins those reports
    // together and makes the decision once, globally.
    // ---------------------------------------------------------------
    const frameStates = new Map(); // frameId -> { names, betKeys, goodRoadsActive, lastSeen }
    const FRAME_STALE_MS = 5000;

    function receiveState(state) {
        state.lastSeen = Date.now();
        frameStates.set(state.frameId, state);

        // Self-healing activation. If a game frame is reporting to us then
        // this IS the page hosting the game, whatever its URL looks like -
        // so stop depending on a URL pattern to decide that.
        if (IS_TOP && currentMode === null) init('lobby');

        // Aggregate right now rather than waiting for our own timer.
        // Chrome throttles timers in hidden tabs hard - down to roughly
        // once a minute after a few minutes backgrounded - which is
        // precisely the case the user cares most about, being in another
        // application. postMessage delivery is not throttled that way, so
        // driving aggregation off the incoming message keeps alerts prompt
        // while hidden. The interval stays on as a fallback.
        if (IS_TOP && currentMode === 'lobby') aggregateAndAlert();
    }

    // A frame that can see the tab row answers true/false; frames that
    // can't see it answer null and simply don't get a vote.
    function isPatternViewActive() {
        const tab = isGoodRoadsTabActive();
        if (tab !== null) return tab;
        return isPatternFilterActive();
    }

    function postState() {
        const state = {
            frameId: FRAME_ID,
            names: [...findVisibleTableNames()],
            betKeys: [...findActiveBetTables()],
            goodRoadsActive: isPatternViewActive()
        };
        if (IS_TOP) { receiveState(state); return; }
        try {
            window.top.postMessage({ __marker: BRIDGE_MARKER, state }, '*');
        } catch (e) { /* nothing to do */ }
    }

    let aggregateSeeded = false;

    function aggregateAndAlert() {
        const now = Date.now();
        for (const [id, s] of frameStates) {
            if (now - s.lastSeen > FRAME_STALE_MS) frameStates.delete(id);
        }
        const states = [...frameStates.values()];
        if (states.length === 0) return;

        // Whichever frame can actually see the tab row decides the gate.
        let gate = null;
        for (const s of states) {
            if (s.goodRoadsActive === true || s.goodRoadsActive === false) {
                gate = s.goodRoadsActive;
                break;
            }
        }

        const namesNow = new Set();
        const betKeysNow = new Set();
        states.forEach(s => {
            (s.names || []).forEach(n => namesNow.add(n));
            (s.betKeys || []).forEach(k => betKeysNow.add(k));
        });

        // Debounce bet detection: 2 consecutive agreeing polls, to kill
        // one-frame flicker.
        const nextHits = new Map();
        betKeysNow.forEach(key => nextHits.set(key, (betOpenConsecutiveHits.get(key) || 0) + 1));
        betOpenConsecutiveHits = nextHits;
        const confirmedOpenKeys = new Set(
            [...nextHits.entries()].filter(([, h]) => h >= BET_HITS_TO_CONFIRM).map(([k]) => k)
        );

        // "ALL TABLES" is explicitly selected - keep tracking state so
        // flipping back to GOOD ROADS doesn't spuriously alert, but stay
        // quiet. gate === null means we couldn't tell, in which case we
        // proceed rather than going silently dead.
        const quiet = (gate === false) || !aggregateSeeded;

        namesNow.forEach(name => {
            if (seenGoodRoadsTables.has(name)) return;
            seenGoodRoadsTables.add(name);
            if (quiet) return;
            dispatchEvent_({
                type: 'new-tables',
                count: 1,
                body: `${name} now matches your Good Roads pattern - go check.`
            });
        });
        for (const name of seenGoodRoadsTables) {
            if (!namesNow.has(name)) seenGoodRoadsTables.delete(name);
        }

        confirmedOpenKeys.forEach(key => {
            if (betOpenTables.has(key)) return;
            betOpenTables.set(key, { escalated: false });
            if (quiet) return;
            console.log('Stake Notifier: bet window opened for', key);
            dispatchEvent_({ type: 'bet-open', key });
        });
        for (const key of betOpenTables.keys()) {
            if (!confirmedOpenKeys.has(key)) betOpenTables.delete(key);
        }

        if (betOpenTables.size === 0 && hadOpenTables) stopFlashing();
        hadOpenTables = betOpenTables.size > 0;

        aggregateSeeded = true;
    }


    function runChecks() {
        // The lobby and game-frame each keep their own in-memory settings
        // object, loaded once at boot. Without this, toggling something in
        // the lobby panel would update storage but the already-running
        // game frame (where the actual alerting happens) would keep using
        // whatever it read at its own boot time, forever - so re-sync from
        // storage on every check, not just once.
        Object.assign(settings, loadSettings());

        if (!settings.masterEnabled) { stopFlashing(); return; }

        // The outer stake.com page deliberately scans NO DOM of its own.
        // On both providers the real tiles / Good Roads / bet buttons live
        // inside the provider's own iframe, which this frame cannot read
        // (cross-origin). The only baccarat-looking text reachable from
        // out here is stake.com's own bet-history table - which is exactly
        // what the old lobby detector was matching, firing alerts for
        // tables that were never on screen. Out here we only ever act on
        // what the game frames report to us.
        if (currentMode === 'game-frame') {
            // Report only. All decisions are made in the top frame, which
            // is the only place that can see every frame's half of the
            // picture at once.
            postState();
            maybeSendDebugSnapshot();
        } else if (currentMode === 'lobby') {
            aggregateAndAlert();
        }
    }

    // ---------------------------------------------------------------
    // DIAGNOSTIC: log iframe access so we can tell if the live game
    // client (Big Road / bet panel) lives in a cross-origin iframe this
    // script cannot see into. If it does, this script needs an extra
    // @match line for that iframe's domain to work at all.
    // ---------------------------------------------------------------
    function logIframeAccess() {
        const iframes = document.querySelectorAll('iframe');
        if (iframes.length === 0) {
            console.log('Stake Notifier: no iframes found on this page.');
            return;
        }
        iframes.forEach(f => {
            let accessible = true;
            try { if (!f.contentDocument) accessible = false; } catch (e) { accessible = false; }
            console.log(`Stake Notifier: iframe src="${f.src}" accessible=${accessible}`);
        });
    }

    // Evolution and Pragmatic render their tables differently enough
    // (Pragmatic's "Multiplay" grid vs Evolution's single-table + side
    // panel) that detection may need to diverge per-provider eventually.
    // For now this is used for logging/diagnostics so issues reported on
    // one provider can be told apart from the other.
    function detectProvider() {
        // Hostname first - it's authoritative. Evolution's own game frame
        // never prints the word "Evolution" anywhere in its lobby, so the
        // text sniff below reported "unknown" for it every single time.
        const host = location.hostname;
        if (/evo-games\.com|evolution/i.test(host)) return 'evolution';
        if (/pragmatic/i.test(host)) return 'pragmatic';

        const text = (document.body?.innerText || '').toUpperCase();
        if (/PRAGMATIC/.test(text)) return 'pragmatic';
        if (/EVOLUTION/.test(text)) return 'evolution';
        return 'unknown';
    }

    // On-demand dump of exactly what the detectors currently see - click
    // "Debug scan" in the panel while looking at the table in question,
    // then paste the console output back so detection can be tuned
    // against the real markup instead of guessing blind.
    function runDebugScan() {
        const provider = detectProvider();
        const goodRoadsActive = isGoodRoadsTabActive();
        const tableNames = [...findVisibleTableNames()];
        const openBetTables = [...findActiveBetTables()];

        const hasAllTablesLabel = !!findShortestTextMatch(/all\s*tables/i, 24);
        const hasGoodRoadsLabel = !!findShortestTextMatch(/good\s*roads/i, 24);
        const hasHotRoadsLabel = !!findShortestTextMatch(/hot\s*roads/i, 24);
        const patternFilterActive = isPatternFilterActive();

        // Logged as a JSON string, not a raw object - some console
        // readers/extensions collapse logged objects to just "Object"
        // and never show their contents.
        console.log('Stake Notifier DEBUG SCAN ' + JSON.stringify({
            provider,
            frameHostname: location.hostname,
            currentMode,
            allTablesLabelFound: hasAllTablesLabel,
            goodRoadsLabelFound: hasGoodRoadsLabel,
            goodRoadsTabActive: goodRoadsActive,
            hotRoadsLabelFound: hasHotRoadsLabel,
            patternFilterActive: patternFilterActive,
            tableNamesVisible: tableNames,
            tablesShowingBetButtons: openBetTables
        }, null, 2));
    }

    // Periodic digest of what the game frame can actually see, posted up
    // to the top frame and readable there via window.__SN_DEBUG__ or the
    // #sn-debug-data node. The game frame is cross-origin, so this is the
    // only way to inspect its real markup instead of guessing at it - and
    // guessing at it is precisely how Evolution stayed broken for days.
    let lastDebugSnapshotAt = 0;
    function maybeSendDebugSnapshot() {
        const now = Date.now();
        if (now - lastDebugSnapshotAt < 3000) return;
        lastDebugSnapshotAt = now;

        const leaves = Array.from(document.querySelectorAll('div, span, button, p, h1, h2, h3, h4'))
            .filter(el => el.children.length === 0);
        const leafTexts = {};
        leaves.forEach(el => {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 24) return;
            leafTexts[t] = (leafTexts[t] || 0) + 1;
        });

        // The filter row is the thing that decides whether we're looking at
        // the Hot/Good Roads view at all, so dump enough about each filter
        // chip (classes, aria state, computed colours) to work out which one
        // is selected without guessing.
        const FILTER_LABELS = /^(multiplay|favourite|favorite|speed|hot\s*roads|good\s*roads|all\s*tables|salon\s*priv)/i;
        const filters = [];
        Array.from(document.querySelectorAll(NAME_LEAF_SELECTOR)).forEach(el => {
            if (el.children.length !== 0) return;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 20 || !FILTER_LABELS.test(t)) return;
            const box = el.closest('button, [role="tab"], li, a') || el;
            const cs = getComputedStyle(box);
            filters.push({
                text: t,
                tag: box.tagName,
                cls: (box.className || '').toString().slice(0, 80),
                ariaSelected: box.getAttribute('aria-selected'),
                ariaCurrent: box.getAttribute('aria-current'),
                dataActive: box.getAttribute('data-active') || box.getAttribute('data-selected'),
                color: cs.color,
                bg: cs.backgroundColor,
                opacity: cs.opacity
            });
        });

        const snap = {
            frameId: FRAME_ID,
            host: location.hostname,
            isTop: IS_TOP,
            childFrames: (function () { try { return window.frames.length; } catch (e) { return -1; } })(),
            provider: detectProvider(),
            mode: currentMode,
            goodRoadsActive: isPatternViewActive(),
            filters,
            goodRoadsTabActive: isGoodRoadsTabActive(),
            patternFilterActive: isPatternFilterActive(),
            tableNames: [...findVisibleTableNames()],
            betTables: [...findActiveBetTables()],
            canvasCount: document.querySelectorAll('canvas').length,
            leafTexts,
            bodyTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000)
        };

        if (IS_TOP) { receiveDebugSnapshot(snap); return; }
        try {
            window.top.postMessage({ __marker: BRIDGE_MARKER, debug: snap }, '*');
        } catch (e) { /* nothing to do */ }
    }

    // ---------------------------------------------------------------
    // UI PANEL (bottom-left, so it never collides with Windows'
    // bottom-right notification popups)
    // ---------------------------------------------------------------
    function buildPanel() {
        const styleTag = document.createElement('style');
        styleTag.textContent = `
            #stake-notifier-panel * { box-sizing: border-box; }
            #stake-notifier-panel {
                position: fixed; bottom: 14px; left: 14px; z-index: 999999;
                background: #14151c; color: #e8e9ee;
                font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,0.45);
                border: 1px solid rgba(255,255,255,0.08);
                width: 200px; overflow: hidden;
            }
            #sn-header {
                display: flex; align-items: center; gap: 8px;
                padding: 9px 10px; cursor: grab; user-select: none; touch-action: none;
            }
            #sn-header:active { cursor: grabbing; }
            #sn-dot { width: 7px; height: 7px; border-radius: 50%; background: #4caf50; flex-shrink: 0; }
            #sn-title { font-weight: 600; font-size: 12px; flex: 1; }
            #sn-version { font-weight: 400; font-size: 10px; color: #8a8d99; }
            #sn-toggle-arrow { font-size: 10px; color: #8a8d99; }
            #sn-body { padding: 0 10px 10px 10px; }

            /* Compact icon toggles - one row covers Enabled/Sound/Popups/
               Telegram, replacing four separate checkbox rows. */
            #sn-toggle-row { display: flex; align-items: center; gap: 5px; padding-top: 2px; }
            .sn-icon-btn {
                width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;
                display: flex; align-items: center; justify-content: center;
                background: #1e2029; border: 1px solid rgba(255,255,255,0.12);
                cursor: pointer; font-size: 13px; color: #6b6e7a; line-height: 1;
            }
            .sn-icon-btn.active { background: #1f3d24; border-color: #4caf50; color: #e8e9ee; }
            .sn-icon-btn:hover { border-color: rgba(255,255,255,0.3); }
            #sn-toggle-advanced { margin-left: auto; }

            /* Advanced section - hidden until the gear icon is clicked. */
            #sn-advanced { display: none; margin-top: 10px; }
            #sn-advanced.open { display: block; }
            .sn-section { padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.07); }
            .sn-section:first-child { border-top: none; padding-top: 0; }
            .sn-sub-row { display: flex; align-items: center; gap: 8px; }
            .sn-sub-row input[type="range"] { flex: 1; accent-color: #4caf50; }
            #sn-volume-label { width: 30px; text-align: right; font-size: 10px; color: #8a8d99; }
            .sn-field { width: 100%; margin-top: 6px; font-size: 11px; padding: 6px 8px;
                background: #1e2029; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e8e9ee; }
            .sn-field::placeholder { color: #6b6e7a; }
            .sn-btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
            .sn-btn {
                font-size: 11px; padding: 6px 4px; cursor: pointer; border-radius: 6px;
                background: #23252f; border: 1px solid rgba(255,255,255,0.1); color: #e8e9ee;
            }
            .sn-btn:hover { background: #2b2e3a; }
            .sn-btn-full { grid-column: 1 / -1; }
            #sn-status { margin-top: 8px; font-size: 10px; color: #6b6e7a; }
        `;
        document.head.appendChild(styleTag);

        const panel = document.createElement('div');
        panel.id = 'stake-notifier-panel';

        panel.innerHTML = `
            <div id="sn-header">
                <div id="sn-dot"></div>
                <div id="sn-title">Stake Notifier <span id="sn-version"></span></div>
                <div id="sn-toggle-arrow">▾</div>
            </div>
            <div id="sn-body">
                <div id="sn-toggle-row">
                    <button id="sn-toggle-master" class="sn-icon-btn" title="Enabled">🔔</button>
                    <button id="sn-toggle-sound" class="sn-icon-btn" title="Sound">🔊</button>
                    <button id="sn-toggle-popup" class="sn-icon-btn" title="Windows popups">🖥</button>
                    <button id="sn-toggle-telegram" class="sn-icon-btn" title="Phone push (Telegram)">📱</button>
                    <button id="sn-toggle-advanced" class="sn-icon-btn" title="More settings">⚙</button>
                </div>

                <div id="sn-advanced">
                    <div class="sn-section">
                        <div class="sn-sub-row">
                            <span>🔊</span>
                            <input type="range" id="sn-volume" min="0" max="100" step="1">
                            <span id="sn-volume-label"></span>
                        </div>
                    </div>

                    <div class="sn-section">
                        <input id="sn-tg-token" class="sn-field" type="password" placeholder="Telegram bot token">
                        <input id="sn-tg-chatid" class="sn-field" type="text" placeholder="Telegram chat ID">
                    </div>

                    <div class="sn-section">
                        <button id="sn-enable-notif" class="sn-btn sn-btn-full" style="margin-bottom:6px;">Grant notification permission</button>
                        <div class="sn-btn-grid">
                            <button id="sn-test-sound" class="sn-btn">Test sound</button>
                            <button id="sn-test-popup" class="sn-btn">Test popup</button>
                            <button id="sn-test-telegram" class="sn-btn sn-btn-full">Test phone push</button>
                            <button id="sn-debug-scan" class="sn-btn sn-btn-full">Debug scan (check console)</button>
                        </div>
                        <div id="sn-status"></div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        if (settings.panelPos) {
            panel.style.left = settings.panelPos.left + 'px';
            panel.style.top = settings.panelPos.top + 'px';
            panel.style.bottom = 'auto';
        }

        panel.querySelector('#sn-version').textContent = `v${SCRIPT_VERSION}`;

        const header = panel.querySelector('#sn-header');
        const toggleArrow = panel.querySelector('#sn-toggle-arrow');
        const body = panel.querySelector('#sn-body');
        const dot = panel.querySelector('#sn-dot');
        const masterBtn = panel.querySelector('#sn-toggle-master');
        const soundBtn = panel.querySelector('#sn-toggle-sound');
        const popupBtn = panel.querySelector('#sn-toggle-popup');
        const telegramBtn = panel.querySelector('#sn-toggle-telegram');
        const advancedBtn = panel.querySelector('#sn-toggle-advanced');
        const advancedPanel = panel.querySelector('#sn-advanced');
        const volumeSlider = panel.querySelector('#sn-volume');
        const volumeLabel = panel.querySelector('#sn-volume-label');
        const tokenInput = panel.querySelector('#sn-tg-token');
        const chatIdInput = panel.querySelector('#sn-tg-chatid');
        const status = panel.querySelector('#sn-status');

        function applyCollapsed() {
            body.style.display = settings.panelCollapsed ? 'none' : 'block';
            toggleArrow.textContent = settings.panelCollapsed ? '▸' : '▾';
        }

        applyCollapsed();

        // Dragging the header moves the panel; a plain click (no movement)
        // toggles collapse instead - both live on the same pointer sequence.
        let dragging = false;
        let dragMoved = false;
        let dragStartX = 0, dragStartY = 0, panelStartLeft = 0, panelStartTop = 0;

        header.addEventListener('pointerdown', (e) => {
            dragging = true;
            dragMoved = false;
            const rect = panel.getBoundingClientRect();
            panelStartLeft = rect.left;
            panelStartTop = rect.top;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            header.setPointerCapture(e.pointerId);
        });

        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
            if (!dragMoved) return;

            const maxLeft = window.innerWidth - panel.offsetWidth - 4;
            const maxTop = window.innerHeight - panel.offsetHeight - 4;
            const newLeft = Math.max(4, Math.min(panelStartLeft + dx, maxLeft));
            const newTop = Math.max(4, Math.min(panelStartTop + dy, maxTop));

            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.bottom = 'auto';
        });

        header.addEventListener('pointerup', (e) => {
            if (!dragging) return;
            dragging = false;
            header.releasePointerCapture(e.pointerId);

            if (dragMoved) {
                settings.panelPos = { left: parseFloat(panel.style.left), top: parseFloat(panel.style.top) };
                saveSettings(settings);
            } else {
                settings.panelCollapsed = !settings.panelCollapsed;
                saveSettings(settings);
                applyCollapsed();
            }
        });

        function setActive(btn, active) {
            btn.classList.toggle('active', active);
        }

        setActive(masterBtn, settings.masterEnabled);
        setActive(soundBtn, settings.soundEnabled);
        setActive(popupBtn, settings.notifEnabled);
        setActive(telegramBtn, settings.telegramEnabled);

        volumeSlider.value = Math.round((settings.volume ?? 0.8) * 100);
        volumeLabel.textContent = `${volumeSlider.value}%`;
        tokenInput.value = settings.telegramBotToken;
        chatIdInput.value = settings.telegramChatId;

        function refreshStatus() {
            const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
            status.textContent = `Notification permission: ${perm}`;
        }
        refreshStatus();

        function updateDot() {
            dot.style.background = settings.masterEnabled ? '#4caf50' : '#5a5d68';
        }
        updateDot();

        masterBtn.addEventListener('click', () => {
            settings.masterEnabled = !settings.masterEnabled;
            saveSettings(settings);
            setActive(masterBtn, settings.masterEnabled);
            updateDot();
        });
        soundBtn.addEventListener('click', () => {
            settings.soundEnabled = !settings.soundEnabled;
            saveSettings(settings);
            setActive(soundBtn, settings.soundEnabled);
        });
        popupBtn.addEventListener('click', () => {
            settings.notifEnabled = !settings.notifEnabled;
            saveSettings(settings);
            setActive(popupBtn, settings.notifEnabled);
        });
        telegramBtn.addEventListener('click', () => {
            settings.telegramEnabled = !settings.telegramEnabled;
            saveSettings(settings);
            setActive(telegramBtn, settings.telegramEnabled);
        });
        advancedBtn.addEventListener('click', () => {
            const open = !advancedPanel.classList.contains('open');
            advancedPanel.classList.toggle('open', open);
            setActive(advancedBtn, open);
        });

        volumeSlider.addEventListener('input', () => {
            settings.volume = Number(volumeSlider.value) / 100;
            volumeLabel.textContent = `${volumeSlider.value}%`;
            saveSettings(settings);
        });
        tokenInput.addEventListener('change', () => { settings.telegramBotToken = tokenInput.value.trim(); saveSettings(settings); });
        chatIdInput.addEventListener('change', () => { settings.telegramChatId = chatIdInput.value.trim(); saveSettings(settings); });

        panel.querySelector('#sn-enable-notif').addEventListener('click', () => {
            requestNotifPermission(() => refreshStatus());
        });
        panel.querySelector('#sn-test-sound').addEventListener('click', () => {
            const wasSound = settings.soundEnabled, wasMaster = settings.masterEnabled;
            settings.soundEnabled = true; settings.masterEnabled = true;
            playSound('test');
            settings.soundEnabled = wasSound; settings.masterEnabled = wasMaster;
        });
        panel.querySelector('#sn-test-popup').addEventListener('click', () => {
            requestNotifPermission(granted => {
                refreshStatus();
                if (!granted) { alert('Notification permission was denied.'); return; }
                try {
                    const n = new Notification('Stake Notifier test', { body: 'If you can see this, popups are working.' });
                    setTimeout(() => n.close(), 6000);
                } catch (e) {
                    alert('Could not show notification: ' + e.message);
                }
            });
        });
        panel.querySelector('#sn-test-telegram').addEventListener('click', async () => {
            if (!tokenInput.value.trim() || !chatIdInput.value.trim()) {
                alert('Enter your bot token and chat ID first.');
                return;
            }
            settings.telegramBotToken = tokenInput.value.trim();
            settings.telegramChatId = chatIdInput.value.trim();
            settings.telegramEnabled = true;
            setActive(telegramBtn, true);
            saveSettings(settings);

            status.textContent = 'Sending test message...';
            const result = await sendTelegram(
                'Stake Notifier test - if you got this, your phone push is working.',
                { bypassRateLimit: true }
            );
            status.textContent = result.ok
                ? 'Sent - check your phone.'
                : `Failed: ${result.reason}`;
        });
        panel.querySelector('#sn-debug-scan').addEventListener('click', () => {
            runDebugScan();
            status.textContent = 'Debug info logged - open console (F12) to view.';
        });
    }

    // ---------------------------------------------------------------
    // FRAME GUARD - with @match *://*/*, this script loads on every
    // page/frame you visit. It must self-detect whether the current
    // frame is either the Stake lobby page, or the actual live-casino
    // game client (Evolution or Pragmatic Play - both load in a
    // separate, randomized-domain iframe Tampermonkey has no other way
    // to target by domain). Everywhere else it stays fully inert: no
    // audio context, no observers, no DOM scanning, nothing.
    // ---------------------------------------------------------------
    // Deliberately loose. The old version demanded stake.com AND a
    // /casino/games|live/ path; if either was off - a mirror domain
    // (stake.bet, stake.us, ...), a different route, an SPA navigation -
    // the top frame never entered lobby mode. The game frame would then
    // post its findings up to a top frame that wasn't listening, and the
    // whole thing went silent with no obvious symptom. Any top-level Stake
    // page is now enough; the panel is harmless on a page with no tables.
    function isStakeLobbyPage() {
        try {
            return IS_TOP && /(^|\.)stake\.[a-z.]+$/i.test(location.hostname);
        } catch (e) {
            return false;
        }
    }

    // Generic markers present on both Evolution and Pragmatic Play frames.
    //
    // This used to require PLAYER+BANKER (i.e. an already-open table) and
    // was the single biggest bug in the whole script: Evolution's iframe
    // shows a LOBBY GRID of table tiles first, with no PLAYER/BANKER text
    // anywhere, so this returned false, the boot poller gave up after 60s,
    // and the script stayed permanently dead in the one frame that
    // actually contains the tiles and the Good Roads panel. Meanwhile the
    // outer stake.com frame happily "detected" rows out of the bet-history
    // table. Net effect on Evolution: no real alerts, plus junk ones.
    //
    // Now it also accepts a provider LOBBY frame: the Hot/Good Roads or
    // All Tables filter labels, or simply several baccarat table names.
    function looksLikeLiveCasinoFrame() {
        const text = document.body?.innerText || '';
        if (!text || text.length < 20) return false;

        const hasPlayerBanker = /\bPLAYER\b/.test(text) && /\bBANKER\b/.test(text);
        const hasRoadWord = /Big Road|Good Roads|Hot Roads|Bead Road/i.test(text);
        const hasBetWord = /\bBET\b/i.test(text);
        const hasFilterLabels = /hot\s*roads|good\s*roads|all\s*tables/i.test(text);
        const tableNameCount = findVisibleTableNames().size;

        return hasPlayerBanker
            || hasFilterLabels
            || tableNameCount >= 2
            || (hasRoadWord && hasBetWord);
    }

    let currentMode = null;

    function init(mode) {
        currentMode = mode;
        console.log(`Stake Notifier: ACTIVE (v${SCRIPT_VERSION}, mode=${mode}, provider=${detectProvider()}, frame=${location.hostname})`);
        logIframeAccess();

        // Both the lobby page and the game iframe run this script, but the
        // panel only ever shows on the lobby/main window - never inside the
        // embedded multiplay/game frame itself, so there's exactly one box
        // on screen. All the actual detection (bet windows, Good/Hot Roads)
        // still runs in the game frame regardless; settings are shared
        // across both via GM storage, so toggles here still apply there.
        if (mode === 'lobby') {
            buildPanel();
            unlockAudioOnFirstInteraction();
        }
        // game-frame mode deliberately builds NO UI at all - not a panel,
        // not a sound-unlock badge. It detects and posts events up to the
        // top frame, which owns every user-visible thing. That is what
        // keeps exactly one box on screen, and what makes Evolution audible
        // (the top frame's audio is already unlocked by normal clicking on
        // stake.com, whereas the game frame's never was).

        setInterval(runChecks, CHECK_INTERVAL_MS);

        // Watch text/attribute changes too, not just node add/remove - a
        // table appearing under Good/Hot Roads is often a re-render of
        // existing DOM (React/Svelte reusing nodes) rather than a fresh
        // node being inserted, which childList-only would miss entirely
        // until the next poll tick. Throttled to at most once every 150ms
        // so a burst of unrelated mutations (video/canvas/countdown ticks)
        // can't turn this into a tight synchronous loop.
        let mutationThrottleTimer = null;
        const observer = new MutationObserver(() => {
            if (mutationThrottleTimer) return;
            mutationThrottleTimer = setTimeout(() => {
                mutationThrottleTimer = null;
                runChecks();
            }, 150);
        });
        observer.observe(document.body, {
            childList: true, subtree: true, characterData: true, attributes: true
        });

        document.addEventListener('visibilitychange', () => { if (!isUserAway()) stopFlashing(); });
        window.addEventListener('focus', () => { if (!isUserAway()) stopFlashing(); });
    }

    function bootWhenReady() {
        // Logged unconditionally in EVERY frame, before any guard, so it's
        // always possible to tell "the userscript never got injected here"
        // apart from "it was injected but the guard rejected the frame".
        // Not having this cost days of misdiagnosis.
        console.log(`Stake Notifier boot v${SCRIPT_VERSION}: frame=${location.hostname} isTop=${IS_TOP}`);

        if (!claimFrame()) {
            console.log(`Stake Notifier v${SCRIPT_VERSION}: another instance already owns this frame - staying inert. (You have the script installed twice in Tampermonkey; harmless now, but worth deleting the spare.)`);
            return;
        }

        // The top frame listens BEFORE and REGARDLESS of any frame-guard
        // decision. It is the only thing that can play a sound, so it must
        // never be the reason an alert is lost - even if it failed to
        // recognise itself as a Stake page.
        if (IS_TOP) listenForFrameEvents();

        if (isStakeLobbyPage()) {
            init('lobby');
            return;
        }

        // Any other frame (including the game provider's iframe, whatever
        // its randomized domain happens to be today). This poller used to
        // give up permanently after ~60s, which meant a frame that only
        // becomes recognisable later (user opens the Good Roads panel, or
        // opens a table) was never picked up. Keep checking indefinitely -
        // it's a cheap text test, and the frame's content genuinely does
        // change over the life of a session.
        const detector = setInterval(() => {
            if (looksLikeLiveCasinoFrame()) {
                clearInterval(detector);
                init('game-frame');
            }
        }, 1500);
    }

    bootWhenReady();
})();
