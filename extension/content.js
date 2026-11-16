// Saves what is typed into textareas and rich text editors. A classic script: Chrome does not load content scripts as modules.
// The decisions are plain top-level functions without side effects, so test/unit/content.test.js can run this file in a sandbox without `chrome`
// and call them; everything that touches the page or the extension happens inside start().

// Settings as the content script needs them. Missing or invalid values mean no limit and no skip list, so bad data fails towards saving.
function readSettings(raw) {
    const kb = Number(raw?.maxItemKb);
    const skip = Array.isArray(raw?.skip) ? raw.skip.filter(item => typeof item === 'string' && item !== '') : [];
    return { maxBytes: kb > 0 ? kb * 1024 : 0, skip };
}

function isSkipped(href, skip) {
    return skip.some(item => href.includes(item));
}

function utf8Size(text) {
    return new TextEncoder().encode(text).length;
}

// Returns the UTF-8 size when it is over the limit, else 0. One UTF-16 unit takes 1 to 3 bytes, so most texts are decided without encoding them.
function oversize(text, maxBytes) {
    if (!maxBytes || text.length * 3 <= maxBytes) return 0;
    const size = utf8Size(text);
    return size > maxBytes ? size : 0;
}

// A search box, whatever element it is. The field's own marks decide first: role="searchbox", enterkeyhint="search" (Brave Search) or type="search"
// (Bing) make it one, and any other enterkeyhint ("send", "enter") makes it a composer, as when DuckDuckGo turns its search box into a chat prompt
// in place. Unmarked fields are search boxes inside a search landmark, role="search" or <search> (Google, Bing, DuckDuckGo), looked for across
// open shadow roots too. role="combobox" alone is not enough: composers with @mention suggestions use it. A landmark in the parent document of a
// frame is not seen.
function isSearchField(element) {
    const attr = name => element.getAttribute?.(name)?.trim().toLowerCase() ?? '';
    const hint = attr('enterkeyhint');
    if (attr('role').split(/\s+/).includes('searchbox') || hint === 'search' || attr('type') === 'search') return true;
    if (hint) return false;
    for (let node = element; node; node = node.getRootNode?.().host) {
        if (node.closest?.('[role~="search" i], search')) return true;
    }
    return false;
}

// The element whose text is saved for an input event target: a textarea, or the outermost editing host around the target. Never an <input>, never a
// search box.
function fieldFor(target) {
    if (!target || target.nodeType !== 1) return null;
    let field = null;
    if (target.tagName === 'TEXTAREA') {
        field = { element: target, kind: 'text' };
    } else if (target.isContentEditable) {
        let host = target;
        while (host.parentElement?.isContentEditable) host = host.parentElement;
        field = { element: host, kind: 'html' };
    }
    return field && !isSearchField(field.element) ? field : null;
}

function readField({ element, kind }) {
    return kind === 'text'
        ? { value: element.value, text: element.value }
        : { value: element.innerHTML, text: element.innerText };
}

// crypto.randomUUID exists only in secure contexts, and this script also runs on plain http pages; getRandomValues exists everywhere.
function newId() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isBlank(text) {
    return text.trim() === '';
}

// Some pages replace an editor element with a copy while it is used. A field seen for the first time may continue the entry of a saved field of the
// same kind that has left the document (when its text continues, see below); of several, the one saved last. Candidates: {kind, connected, savedAt}.
function predecessor(candidates, kind) {
    let best = null;
    for (const candidate of candidates) {
        if (candidate.kind === kind && !candidate.connected && (!best || candidate.savedAt > best.savedAt)) best = candidate;
    }
    return best;
}

// Whether a rebuilt field's text carries on its predecessor's last saved text: the shared start and the shared end (not overlapping) cover at least
// 80 % of the longer one. An editor that the page empties after sending, then filled with the next message, must not overwrite the saved one.
function continues(before, after) {
    const a = before.trim();
    const b = after.trim();
    const shorter = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < shorter && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < shorter - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    return prefix + suffix >= 0.8 * Math.max(a.length, b.length);
}

function start() {
    const SAVE_DELAY_MS = 400;
    const fields = new WeakMap();
    const pending = new Set();
    // fields saved from in this document, held weakly: an element collected by the garbage collector has left the document too
    let savedFields = [];
    let saveCount = 0;
    // a save was written since the background was last told that a field was finished
    let unfinished = false;
    let config = readSettings(null);
    let alive = true;

    function contextAlive() {
        try {
            return alive && chrome.runtime?.id !== undefined;
        }
        catch {
            return false;
        }
    }

    // After the extension is reloaded or removed this script keeps running with a dead connection; it then removes itself and stays quiet.
    function shutDown() {
        alive = false;
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('focusout', flushAll, true);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', flushAll);
        for (const element of pending) clearTimeout(fields.get(element)?.timer);
        pending.clear();
    }

    function send(message) {
        try {
            chrome.runtime.sendMessage(message).catch(() => {
                if (!contextAlive()) shutDown();
            });
        }
        catch {
            shutDown();
        }
    }

    function stateFor(field) {
        let state = fields.get(field.element);
        if (!state) {
            state = { id: newId(), kind: field.kind, created: Date.now(), timer: 0, over: false, saved: null, savedText: '', savedAt: 0 };
            const candidates = savedFields.map(({ ref, state: old }) => {
                const element = ref.deref();
                return { kind: old.kind, connected: element?.isConnected === true, savedAt: old.savedAt, element, state: old };
            });
            const heir = predecessor(candidates, field.kind);
            if (heir && continues(heir.state.savedText, readField(field).text)) {
                // the old element's own pending save would only write an older version of the same entry
                clearTimeout(heir.state.timer);
                if (heir.element) {
                    pending.delete(heir.element);
                    fields.delete(heir.element);
                }
                savedFields = savedFields.filter(item => item.state !== heir.state);
                state.id = heir.state.id;
                state.created = heir.state.created;
            }
            fields.set(field.element, state);
        }
        return state;
    }

    function onInput(event) {
        if (!contextAlive()) return shutDown();
        const field = fieldFor(event.composedPath()[0]);
        if (!field) return;
        const state = stateFor(field);
        clearTimeout(state.timer);
        state.timer = setTimeout(() => save(field.element), SAVE_DELAY_MS);
        pending.add(field.element);
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') flushAll();
    }

    // Leaving a field, hiding or leaving the page finishes the fields: pending saves are written, then the background may remove older copies.
    async function flushAll() {
        await Promise.all([...pending].map(save));
        if (!unfinished || !contextAlive()) return;
        unfinished = false;
        send({ type: 'field_done' });
    }

    async function save(element) {
        const state = fields.get(element);
        clearTimeout(state.timer);
        pending.delete(element);
        if (!contextAlive()) return;
        // Read on every save rather than followed through storage.onChanged: that event would wake every frame of every tab for each text
        // saved anywhere, carrying the old and the new value.
        try {
            config = readSettings((await chrome.storage.local.get('settings')).settings);
        }
        catch {
            if (!contextAlive()) return shutDown();
        }
        if (isSkipped(location.href, config.skip)) return;

        const { value, text } = readField({ element, kind: state.kind });
        if (isBlank(text)) return;
        const size = oversize(value, config.maxBytes);
        if (size) {
            // The last version that fitted stays saved; the background is told once per episode.
            if (!state.over) send({ type: 'save_skipped', size, limit: config.maxBytes });
            state.over = true;
            return;
        }
        if (state.over) {
            state.over = false;
            send({ type: 'save_resumed' });
        }
        if (value === state.saved) return;

        const entry = { id: state.id, url: location.href, title: document.title, kind: state.kind, value, created: state.created, modified: Date.now() };
        // The rendered line breaks, so the extension pages need not parse the HTML.
        if (state.kind === 'html') entry.text = text;
        try {
            await chrome.storage.local.set({ [`t:${state.id}`]: entry });
            state.saved = value;
            state.savedText = text;
            unfinished = true;
            if (!state.savedAt) savedFields.push({ ref: new WeakRef(element), state });
            state.savedAt = ++saveCount;
        }
        catch (error) {
            if (contextAlive()) send({ type: 'save_failed', error: String(error?.message ?? error) });
            else shutDown();
        }
    }

    document.addEventListener('input', onInput, true);
    document.addEventListener('focusout', flushAll, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushAll);
}

if (globalThis.chrome?.runtime?.id) start();
