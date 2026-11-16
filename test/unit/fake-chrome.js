// A fake `chrome` with an in-memory storage.local, installed on globalThis before the lib modules are imported.
export const UNLIMITED = ['storage', 'unlimitedStorage', 'alarms', 'clipboardWrite', 'activeTab'];

export function installChrome({ permissions = UNLIMITED, stored = {} } = {}) {
    const data = structuredClone(stored);
    const local = {
        QUOTA_BYTES: 10485760,
        async get(keys) {
            if (keys === undefined || keys === null) return structuredClone(data);
            return Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
        },
        async set(items) {
            Object.assign(data, structuredClone(items));
        },
        async remove(keys) {
            for (const key of [].concat(keys)) delete data[key];
        },
        async clear() {
            for (const key of Object.keys(data)) delete data[key];
        },
        async getBytesInUse(keys) {
            if (keys !== null) throw new Error('only getBytesInUse(null) is faked');
            return JSON.stringify(data).length;
        },
    };
    globalThis.chrome = {
        runtime: { getManifest: () => ({ permissions }) },
        storage: { local },
    };
    return data;
}

let generation = 0;

// A fresh instance of a lib module, so that DEFAULTS is computed against the chrome installed just before.
export function importFresh(name) {
    return import(new URL(`../../extension/lib/${name}?v=${++generation}`, import.meta.url));
}
