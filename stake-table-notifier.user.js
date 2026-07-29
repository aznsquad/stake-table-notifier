// ==UserScript==
// @name         Stake Baccarat Table Notifier
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Play notification sound when new tables appear in multiview
// @author       You
// @match        https://stake.com/casino/games/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Store of previously seen table IDs
    const seenTables = new Set();

    // Audio context for notification sound
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    function playNotificationSound() {
        const now = audioContext.currentTime;

        // Create oscillator for a pleasant beep
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();

        osc.connect(gain);
        gain.connect(audioContext.destination);

        // Frequency sweep for pleasant notification
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1000, now + 0.1);

        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

        osc.start(now);
        osc.stop(now + 0.3);
    }

    function getTableSignature(element) {
        // Get unique identifier for a table card
        const title = element.textContent?.match(/[A-Za-z\s]+/)?.[0]?.trim() || '';
        const rate = element.textContent?.match(/\$[\d.]+/)?.[0] || '';
        return title + rate;
    }

    function checkForNewTables() {
        // Look for table cards in the multiview - adjust selector if needed
        const tableCards = document.querySelectorAll('[class*="card"], [class*="table"], .game-card, [role="button"]');

        let newTablesFound = 0;

        tableCards.forEach(card => {
            // Only look at cards that seem to be in the gaming area
            if (!card.textContent) return;

            const text = card.textContent.toLowerCase();
            if (!text.includes('baccarat') && !text.includes('speed') && !text.includes('dragon')) return;

            const signature = getTableSignature(card);

            if (signature && !seenTables.has(signature)) {
                seenTables.add(signature);
                newTablesFound++;

                // Visual highlight for a moment
                const originalBg = card.style.backgroundColor;
                card.style.backgroundColor = 'rgba(76, 175, 80, 0.3)';
                setTimeout(() => {
                    card.style.backgroundColor = originalBg;
                }, 1000);
            }
        });

        if (newTablesFound > 0) {
            playNotificationSound();
            console.log(`🎰 ${newTablesFound} new table(s) detected!`);
        }
    }

    // Start monitoring - check every 2 seconds
    console.log('Stake Table Notifier: Active');
    setInterval(checkForNewTables, 2000);

    // Also listen for DOM changes
    const observer = new MutationObserver(() => {
        checkForNewTables();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: false
    });
})();
