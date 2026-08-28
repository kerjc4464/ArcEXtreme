// Rerank：走后端代理根治 CORS，有后端的插件就要狠狠依赖后端
import { SETTINGS_KEY } from './config.js';

function getBackendBase() {
    try {
        let raw = window.extension_settings?.[SETTINGS_KEY]?.backendUrl;
        let u = String(raw || '').trim();
        if (!u) {
            const pageHost = window.location.hostname;
            if (pageHost && pageHost !== '' && pageHost !== '127.0.0.1' && pageHost !== 'localhost') {
                return `http://${pageHost}:9001`;
            }
            return 'http://127.0.0.1:9001';
        }
        u = u.replace(/\/+$/, '');
        try {
            const pageHost = window.location.hostname;
            const backendHost = new URL(u).hostname;
            if ((backendHost === '127.0.0.1' || backendHost === 'localhost') && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
                const fixed = u.replace(backendHost, pageHost);
                console.warn(`[ArcEXtreme] 后端地址自动修正：${u} -> ${fixed}`);
                return fixed;
            }
        } catch {}
        return u;
    } catch { return 'http://127.0.0.1:9001'; }
}

let _traceCache = null;
async function getTrace() {
    if (_traceCache !== null) return _traceCache;
    try { _traceCache = await import('./trace.js'); return _traceCache; } catch { _traceCache = { beginTrace:()=>null, finishTraceOk:()=>{}, finishTraceFail:()=>{} }; return _traceCache; }
}

export async function rerank(cfg, query, documents) {
    if (!cfg || !cfg.enabled || !cfg.apiUrl) return null;
    let tid = null;
    let traceMod = null;
    try { traceMod = await getTrace(); tid = traceMod.beginTrace('rerank', 'Rerank 精排', cfg, { docCount: documents.length }); } catch {}
    const body = {
        model: cfg.model,
        query,
        documents,
        top_n: documents.length,
    };

    // 优先走后端代理
    const backendBase = getBackendBase();
    const tryProxy = async () => {
        const proxyRes = await fetch(`${backendBase}/api/rerank_proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: cfg.apiUrl, api_key: cfg.apiKey || '', payload: body }),
        });
        if (proxyRes.status === 404) {
            const txt = await proxyRes.clone().text().catch(()=> '');
            if (txt.includes('Not Found')) throw new Error('PROXY_NOT_FOUND');
        }
        return proxyRes;
    };

    let r;
    try {
        r = await tryProxy();
    } catch (e) {
        if (String(e.message).startsWith('PROXY_NOT_FOUND')) {
            const base = e.message.split(':')[1] || getBackendBase();
            try { traceMod && tid && traceMod.finishTraceFail(tid, `后端未更新：${base} 无 /api/rerank_proxy`); } catch {}
            throw new Error(`后端未更新：${base} 无 /api/rerank_proxy，请重启后端。已拦截直连`);
        }
        if (e.name === 'TypeError' || e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
            const backendBase = getBackendBase();
            try { traceMod && tid && traceMod.finishTraceFail(tid, `后端代理不可达：${backendBase}`); } catch {}
            throw new Error(`后端代理不可达：${backendBase}/api/rerank_proxy 无法连接（backendUrl=${backendBase}）。请检查后端运行且局域网改用 ${window.location.hostname}:9001`);
        }
        throw e;
    }

    try {
        if (!r.ok) {
            const txt = await r.text().catch(() => '');
            try { traceMod && tid && traceMod.finishTraceFail(tid, `HTTP ${r.status}: ${txt.slice(0, 400)}`, txt); } catch {}
            return null;
        }
        const d = await r.json();
        try { traceMod && tid && traceMod.finishTraceOk(tid, JSON.stringify(d, null, 2).slice(0, 8000), d); } catch {}
        const results = d.results || d.data || [];
        return results
            .map((x) => ({ index: x.index, score: x.relevance_score ?? x.score ?? 0 }))
            .sort((a, b) => b.score - a.score);
    } catch (e) {
        try { traceMod && tid && traceMod.finishTraceFail(tid, e.message || String(e)); } catch {}
        return null;
    }
}
