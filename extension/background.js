import * as settings from './lib/settings.js';
import * as store from './lib/store.js';
import { migrate } from './lib/migrate.js';
import { formatBytes } from './lib/format.js';
import { init as initLanguage, t } from './lib/i18n.js';

const ALARM = 'clean';

// Chrome only wakes the worker for events whose listeners were added synchronously during the first run of the module.
chrome.runtime.onInstalled.addListener(() => setUp(true).catch(reportError));
chrome.runtime.onStartup.addListener(() => setUp(false).catch(reportError));
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) clean().catch(reportError);
});
chrome.runtime.onMessage.addListener(onMessage);

// Alarms are not guaranteed to survive a browser restart, so every start of the worker makes sure the alarm exists.
ensureAlarm().catch(reportError);

async function ensureAlarm() {
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 60 });
}

async function setUp(installed) {
    const { settings: stored } = await chrome.storage.local.get('settings');
    if (installed || stored?.schema !== settings.SCHEMA) await migrate();
    await settings.save();
    await clean();
}

async function clean() {
    const current = await settings.load();
    if (current.dedupe) await store.removeCopies();
    if (current.autoClean) await store.prune(current.keepNewest);
}

async function removeCopies() {
    if ((await settings.load()).dedupe) await store.removeCopies();
}

function onMessage(message, sender) {
    const tabId = sender.tab?.id;
    switch (message?.type) {
        case 'save_skipped':
            if (tabId !== undefined) {
                updateBadge(() => setTabBadge(tabId, 'MAX', '#b35c00', t('badge_too_large', [formatBytes(message.size), formatBytes(message.limit)])));
            }
            break;
        case 'save_resumed':
            // A null text falls back to the global badge, so a "!" from a failed save stays visible.
            if (tabId !== undefined) updateBadge(() => setTabBadge(tabId, null, null, chrome.runtime.getManifest().action.default_title));
            break;
        case 'field_done':
            removeCopies().catch(reportError);
            break;
        case 'save_failed':
            updateBadge(() => Promise.all([
                chrome.action.setBadgeBackgroundColor({ color: '#d00000' }),
                chrome.action.setBadgeText({ text: '!' }),
                chrome.action.setTitle({ title: t('badge_save_failed', [String(message.error)]) }),
            ]));
            break;
    }
}

let badges = Promise.resolve();

// Badge changes run one after another, each with the messages of the language set now, so a title still loading cannot land after a later change.
function updateBadge(change) {
    badges = badges.then(initLanguage).then(change).catch(reportError);
}

function setTabBadge(tabId, text, color, title) {
    const calls = [chrome.action.setBadgeText({ tabId, text }), chrome.action.setTitle({ tabId, title })];
    if (color) calls.push(chrome.action.setBadgeBackgroundColor({ tabId, color }));
    // The tab may be closed by the time this runs.
    Promise.all(calls).catch(() => {});
}

function reportError(error) {
    console.error('TextCache:', error);
}
