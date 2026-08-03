// ==UserScript==
// @name         Stake Table Notifier (Evolution + Pragmatic)
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Escalating alerts (sound -> flashing tab -> Windows popup -> phone push) so you never miss a bet window, even when distracted on another tab or your phone
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

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
    // SETTINGS (persisted in localStorage, editable via the on-page panel)
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
        checkIntervalMs: 1500,
        escalationDelayMs: 8000,       // how long a bet window must stay open + you stay away before we buzz your phone
        telegramMinIntervalMs: 60000   // don't phone-ping more than once per minute, even if multiple windows escalate
    };

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
        } catch (e) {
            return { ...defaultSettings };
        }
    }

    function saveSettings(s) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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

    function sendTelegram(text) {
        if (!settings.telegramEnabled || !settings.masterEnabled) return;
        if (!settings.telegramBotToken || !settings.telegramChatId) return;

        const now = Date.now();
        if (now - lastTelegramSentAt < settings.telegramMinIntervalMs) return;
        lastTelegramSentAt = now;

        const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.telegramChatId, text })
        }).then(res => {
            if (!res.ok) console.warn('Stake Notifier: Telegram send failed', res.status);
        }).catch(err => console.warn('Stake Notifier: Telegram send error', err));
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
    const KEYWORDS = ['baccarat', 'speed', 'dragon', 'tiger', 'sic bo', 'andar', 'teen patti', 'roulette', 'blackjack', 'mega'];

    function getCardSignature(el) {
        const title = el.textContent?.match(/[A-Za-z][A-Za-z\s]+/)?.[0]?.trim() || '';
        const rate = el.textContent?.match(/\$[\d.]+/)?.[0] || '';
        return (title + rate).slice(0, 80);
    }

    function looksLikeTargetGame(text) {
        const lower = text.toLowerCase();
        return KEYWORDS.some(k => lower.includes(k));
    }

    function checkForNewTables() {
        const cards = document.querySelectorAll('[class*="card"], [class*="table"], .game-card, [role="button"]');
        let found = 0;

        cards.forEach(card => {
            if (!card.textContent || !looksLikeTargetGame(card.textContent)) return;

            const sig = getCardSignature(card);
            if (sig && !seenTables.has(sig)) {
                seenTables.add(sig);
                found++;

                const originalBg = card.style.backgroundColor;
                card.style.backgroundColor = 'rgba(76, 175, 80, 0.3)';
                setTimeout(() => { card.style.backgroundColor = originalBg; }, 1000);
            }
        });

        if (found > 0) {
            playSound('newTable');
            showPopup('New table available', `${found} new table(s) just showed up in the multiview.`);
            console.log(`Stake Notifier: ${found} new table(s) detected`);
        }
    }

    // ---------------------------------------------------------------
    // GAME FRAME: bet-window detection (only runs inside the actual
    // live table iframe - one frame = one table, so this is simple
    // single-state tracking, not a multi-key map). Fires exactly once
    // on the open->closed->open edge, not on every re-render, and never
    // on dealt cards or on placing a bet - only on the window opening.
    // ---------------------------------------------------------------
    let betWindowOpen = false;
    let betWindowEscalated = false;
    let betOpenConsecutiveHits = 0;
    const BET_HITS_TO_CONFIRM = 2; // require 2 consecutive polls agreeing before firing, to kill one-frame flicker false positives

    // Looks specifically for a real, enabled, clickable "Bet" button -
    // not bet-amount chips, not "bet placed" confirmation text, not card
    // elements. If this still misses or over-fires on your table, tell
    // me exactly what text/element you see when betting is open/closed
    // and I'll tighten this further.
    function findOpenBetButton() {
        const els = Array.from(document.querySelectorAll('button, [role="button"]'));
        return els.find(el => {
            const t = (el.textContent || '').trim();
            if (!t || t.length > 20) return false;
            if (!/^(place\s*)?bet\b/i.test(t)) return false;
            if (el.disabled) return false;
            if (/disabled|inactive/i.test(el.className || '')) return false;
            return true;
        });
    }

    function escalateToPhone() {
        if (!betWindowOpen || betWindowEscalated) return;
        if (!isUserAway()) return; // they came back on their own, no need to buzz the phone
        betWindowEscalated = true;
        sendTelegram('Bet window still open on Stake and you have not acted - go check.');
    }

    function checkForOpenBets() {
        const isOpenNow = !!findOpenBetButton();
        betOpenConsecutiveHits = isOpenNow ? betOpenConsecutiveHits + 1 : 0;
        const confirmedOpen = betOpenConsecutiveHits >= BET_HITS_TO_CONFIRM;

        if (confirmedOpen && !betWindowOpen) {
            betWindowOpen = true;
            betWindowEscalated = false;
            playSound('betOpen');
            showPopup('Bet window open', 'It is time to bet.');
            startFlashing();
            console.log('Stake Notifier: bet window opened');
            setTimeout(escalateToPhone, settings.escalationDelayMs);
        } else if (!isOpenNow && betWindowOpen) {
            betWindowOpen = false;
            betWindowEscalated = false;
            stopFlashing();
        }
    }

    function runChecks() {
        if (!settings.masterEnabled) { stopFlashing(); return; }
        if (currentMode === 'lobby') {
            checkForNewTables();
        } else if (currentMode === 'game-frame') {
            checkForOpenBets();
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

    // ---------------------------------------------------------------
    // UI PANEL (bottom-left, so it never collides with Windows'
    // bottom-right notification popups)
    // ---------------------------------------------------------------
    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'stake-notifier-panel';
        panel.style.cssText = `
            position: fixed; bottom: 12px; left: 12px; z-index: 999999;
            background: #1a1d29; color: #fff; font: 12px/1.4 sans-serif;
            border-radius: 8px; padding: 10px 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.5);
            width: 230px; opacity: 0.92;
        `;

        panel.innerHTML = `
            <div style="font-weight:600; margin-bottom:6px;">Stake Notifier</div>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
                <input type="checkbox" id="sn-master"> Enabled
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
                <input type="checkbox" id="sn-sound"> Sound
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                <span style="width:16px;">🔊</span>
                <input type="range" id="sn-volume" min="0" max="100" step="1" style="flex:1;">
                <span id="sn-volume-label" style="width:28px; text-align:right; font-size:10px; color:#aaa;"></span>
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:4px; cursor:pointer;">
                <input type="checkbox" id="sn-notif"> Windows popups
            </label>
            <label style="display:flex; align-items:center; gap:6px; margin-bottom:6px; cursor:pointer;">
                <input type="checkbox" id="sn-telegram"> Phone push (Telegram)
            </label>
            <div id="sn-telegram-fields" style="display:none; margin-bottom:8px;">
                <input id="sn-tg-token" type="password" placeholder="Bot token" style="width:100%; margin-bottom:4px; box-sizing:border-box; font-size:11px; padding:3px;">
                <input id="sn-tg-chatid" type="text" placeholder="Chat ID" style="width:100%; box-sizing:border-box; font-size:11px; padding:3px;">
            </div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <button id="sn-enable-notif" style="flex:1; font-size:11px; padding:4px; cursor:pointer;">Grant permission</button>
            </div>
            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <button id="sn-test-sound" style="flex:1; font-size:11px; padding:4px; cursor:pointer;">Test sound</button>
                <button id="sn-test-popup" style="flex:1; font-size:11px; padding:4px; cursor:pointer;">Test popup</button>
            </div>
            <div style="display:flex; gap:6px;">
                <button id="sn-test-telegram" style="flex:1; font-size:11px; padding:4px; cursor:pointer;">Test phone push</button>
            </div>
            <div id="sn-status" style="margin-top:6px; font-size:10px; color:#aaa;"></div>
        `;

        document.body.appendChild(panel);

        const masterCb = panel.querySelector('#sn-master');
        const soundCb = panel.querySelector('#sn-sound');
        const volumeSlider = panel.querySelector('#sn-volume');
        const volumeLabel = panel.querySelector('#sn-volume-label');
        const notifCb = panel.querySelector('#sn-notif');
        const telegramCb = panel.querySelector('#sn-telegram');
        const telegramFields = panel.querySelector('#sn-telegram-fields');
        const tokenInput = panel.querySelector('#sn-tg-token');
        const chatIdInput = panel.querySelector('#sn-tg-chatid');
        const status = panel.querySelector('#sn-status');

        masterCb.checked = settings.masterEnabled;
        soundCb.checked = settings.soundEnabled;
        volumeSlider.value = Math.round((settings.volume ?? 0.8) * 100);
        volumeLabel.textContent = `${volumeSlider.value}%`;
        notifCb.checked = settings.notifEnabled;
        telegramCb.checked = settings.telegramEnabled;
        tokenInput.value = settings.telegramBotToken;
        chatIdInput.value = settings.telegramChatId;
        telegramFields.style.display = settings.telegramEnabled ? 'block' : 'none';

        function refreshStatus() {
            const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
            status.textContent = `Notif permission: ${perm}`;
        }
        refreshStatus();

        masterCb.addEventListener('change', () => { settings.masterEnabled = masterCb.checked; saveSettings(settings); });
        soundCb.addEventListener('change', () => { settings.soundEnabled = soundCb.checked; saveSettings(settings); });
        volumeSlider.addEventListener('input', () => {
            settings.volume = Number(volumeSlider.value) / 100;
            volumeLabel.textContent = `${volumeSlider.value}%`;
            saveSettings(settings);
        });
        notifCb.addEventListener('change', () => { settings.notifEnabled = notifCb.checked; saveSettings(settings); });
        telegramCb.addEventListener('change', () => {
            settings.telegramEnabled = telegramCb.checked;
            telegramFields.style.display = settings.telegramEnabled ? 'block' : 'none';
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
        panel.querySelector('#sn-test-telegram').addEventListener('click', () => {
            if (!tokenInput.value.trim() || !chatIdInput.value.trim()) {
                alert('Enter your bot token and chat ID first.');
                return;
            }
            settings.telegramBotToken = tokenInput.value.trim();
            settings.telegramChatId = chatIdInput.value.trim();
            saveSettings(settings);
            lastTelegramSentAt = 0; // bypass rate limit for a manual test
            sendTelegram('Stake Notifier test - if you got this, your phone push is working.');
            status.textContent = 'Test message sent - check your phone.';
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
    function isStakeLobbyPage() {
        try {
            return location.hostname.endsWith('stake.com') && /\/casino\/(games|live)\//.test(location.pathname);
        } catch (e) {
            return false;
        }
    }

    // Generic markers present on both Evolution and Pragmatic Play live
    // baccarat tables - deliberately provider-agnostic so it doesn't need
    // separate rules per game studio.
    function looksLikeLiveCasinoFrame() {
        const text = document.body?.innerText || '';
        if (!text || text.length < 20) return false;
        const hasPlayerBanker = /\bPLAYER\b/.test(text) && /\bBANKER\b/.test(text);
        const hasRoadWord = /Big Road|Good Roads|Bead Road/i.test(text);
        const hasBetWord = /\bBET\b/i.test(text);
        return hasPlayerBanker || (hasRoadWord && hasBetWord);
    }

    let currentMode = null;

    function init(mode) {
        currentMode = mode;
        console.log(`Stake Notifier: active (v3.2, mode=${mode}, frame=${location.hostname})`);
        logIframeAccess();
        buildPanel();

        setInterval(runChecks, settings.checkIntervalMs);

        const observer = new MutationObserver(() => runChecks());
        observer.observe(document.body, { childList: true, subtree: true });

        document.addEventListener('visibilitychange', () => { if (!isUserAway()) stopFlashing(); });
        window.addEventListener('focus', () => { if (!isUserAway()) stopFlashing(); });
    }

    function bootWhenReady() {
        if (isStakeLobbyPage()) {
            init('lobby');
            return;
        }

        // Any other frame (including the game provider's iframe, whatever
        // its domain happens to be today): poll a few times for the table
        // UI to render, then either activate or give up quietly for good.
        let attempts = 0;
        const maxAttempts = 30; // ~60s
        const detector = setInterval(() => {
            attempts++;
            if (looksLikeLiveCasinoFrame()) {
                clearInterval(detector);
                init('game-frame');
            } else if (attempts >= maxAttempts) {
                clearInterval(detector);
                // Not a relevant page - stays completely inert from here on.
            }
        }, 2000);
    }

    bootWhenReady();
})();
