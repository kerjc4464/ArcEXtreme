// 与后端 REST 通信的封装

import { SETTINGS_KEY } from './config.js';

function resolveBackendUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) u = 'http://127.0.0.1:9001';
    u = u.replace(/\/+$/, '');
    // 局域网自动兼容：本机 127.0.0.1 在别的机器上会连到自己，自动替换为当前页面 host
    try {
        const pageHost = window.location.hostname;
        // 当后端未配置或为回环时，默认用页面 host:9001 更通用（纯本机访问仍可用 127.0.0.1）
        if (!raw || raw.trim() === '') {
            if (pageHost && pageHost !== '' && pageHost !== '127.0.0.1' && pageHost !== 'localhost') {
                return `http://${pageHost}:9001`;
            }
            return u;
        }
        const backendHost = new URL(u).hostname;
        if ((backendHost === '127.0.0.1' || backendHost === 'localhost') && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
            const fixed = u.replace(backendHost, pageHost);
            console.warn(`[ArcEXtreme] 后端地址局域网自动修正：${u} -> ${fixed}`);
            return fixed;
        }
    } catch {}
    return u;
}
function baseUrl() {
    const s = window.extension_settings?.[SETTINGS_KEY];
    return resolveBackendUrl(s?.backendUrl);
}
// 供 UI 显示实际生效地址
export function getEffectiveBackendUrl() { return baseUrl(); }

async function apiGet(path) {
    const res = await fetch(`${baseUrl()}${path}`, { method: 'GET' });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
}

async function apiPost(path, body) {
    const res = await fetch(`${baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(`${baseUrl()}${path}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`);
    return res.json();
}

export const backend = {
    status: () => apiGet('/api/status'),
    listSouls: async () => (await apiGet('/api/souls')).souls,
    getSoul: (filename) => fetch(`${baseUrl()}/api/souls/${encodeURIComponent(filename)}`).then(r => {
        if (!r.ok) throw new Error(`soul ${filename} -> ${r.status}`);
        return r.text();
    }),
    insertEvent: (payload) => apiPost('/api/events/insert', payload),
    insertBatch: (chatId, events, perSoulCap) => {
        const body = { chat_id: chatId, events };
        if (perSoulCap != null) body.perSoulCap = perSoulCap;
        return apiPost('/api/events/insert_batch', body);
    },
    recentEvents: (chatId, days) => apiGet(`/api/events/recent?chat_id=${encodeURIComponent(chatId)}&days=${days}`).then(d => d.events),
    queryEvents: (chatId, vector, buckets, souls, k, weightMultipliers) =>
        apiPost('/api/events/query', { chat_id: chatId, vector, buckets, souls, k, weightMultipliers }).then(d => d.results),
    listEvents: (chatId, opts={}) => {
        const p = new URLSearchParams({ chat_id: chatId });
        if (opts.withCounters) p.set('with_counters','1');
        if (opts.soul) p.set('soul', opts.soul);
        if (opts.counter!=null) p.set('counter', String(opts.counter));
        if (opts.bucket) p.set('bucket', opts.bucket);
        if (opts.limit) p.set('limit', String(opts.limit));
        if (opts.offset) p.set('offset', String(opts.offset));
        return apiGet(`/api/events?${p.toString()}`).then(d => d.events);
    },
    clearEvents: (chatId) => apiPost('/api/events/clear', { chat_id: chatId }),
    deleteEvent: (id) => apiDelete(`/api/events/${id}`),
    reload: () => apiPost('/api/reload', {}),
    // 短期池
    getShortPool: (chatId, soul, perSoulCap) => {
        const p = new URLSearchParams({ chat_id: chatId });
        if (soul) p.set('soul', soul);
        if (perSoulCap != null) p.set('perSoulCap', String(perSoulCap));
        return apiGet(`/api/short_pool?${p.toString()}`);
    },
    syncShortPool: (chatId, evaluations) => apiPost('/api/short_pool/sync', { chat_id: chatId, evaluations }),
    prepareShortPool: (chatId, perSoulCap, skipThreshold, needVacancies) => apiPost('/api/short_pool/prepare', { chat_id: chatId, perSoulCap, skipThreshold, needVacancies }),
    fillShortPool: (chatId, items, perSoulCap) => {
        const body = { chat_id: chatId, items };
        if (perSoulCap != null) body.perSoulCap = perSoulCap;
        return apiPost('/api/short_pool/fill', body);
    },
    enforceShortPool: (chatId, perSoulCap) => apiPost('/api/short_pool/enforce', { chat_id: chatId, perSoulCap }),
    checkSublimation: (chatId, stuckThreshold) => apiGet(`/api/short_pool/check_sublimation?chat_id=${encodeURIComponent(chatId)}&stuckThreshold=${stuckThreshold||8}`),
    markSublimated: (payload) => apiPost('/api/short_pool/mark_sublimated', payload),
    // soul追加 & 升华记录
    appendSoul: (payload) => apiPost('/api/souls/append', payload),
    listSublimated: (chatId, soul) => {
        const p = new URLSearchParams({ chat_id: chatId });
        if (soul) p.set('soul', soul);
        return apiGet(`/api/sublimated?${p.toString()}`).then(d=>d.items||[]);
    },
};
