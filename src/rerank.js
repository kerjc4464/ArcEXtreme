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

function isMissingSessionError(text) {
    const lower = String(text || '').toLowerCase();
    return lower.includes('missingsessionid') || lower.includes('x-opencode-session');
}

function pickScore(x) {
    if (x == null || typeof x !== 'object') return 0;
    for (const k of ['relevance_score', 'relevanceScore', 'rerank_score', 'rerankScore', 'score', 'similarity', 'relevance', 'confidence']) {
        const v = Number(x[k]);
        if (Number.isFinite(v)) return v;
    }
    return 0;
}

function pickResults(d) {
    if (!d || typeof d !== 'object') return [];
    if (Array.isArray(d)) return d;
    for (const k of ['results', 'data', 'ranked_results', 'rankedResults', 'reranked', 'items']) {
        if (Array.isArray(d[k])) return d[k];
    }
    // OpenAI / Cohere / Jina 各家包装差异：{ output: [...] } / { response: {...} }
    if (Array.isArray(d.output)) return d.output;
    if (d.response && typeof d.response === 'object') return pickResults(d.response);
    return [];
}

let _traceCache = null;
async function getTrace() {
    if (_traceCache !== null) return _traceCache;
    try { _traceCache = await import('./trace.js'); return _traceCache; } catch { _traceCache = { beginTrace:()=>null, finishTraceOk:()=>{}, finishTraceFail:()=>{} }; return _traceCache; }
}

export async function rerank(cfg, query, documents) {
    if (!cfg || !cfg.enabled || !cfg.apiUrl) return null;
    if (!Array.isArray(documents) || !documents.length) return [];
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
    let session_id = null;
    try {
        const ctx = window.SillyTavern?.getContext?.() || null;
        const chatId = ctx?.chatId;
        if (chatId) {
            const s = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
            session_id = s ? (s.startsWith('arcextreme-') ? s : `arcextreme-${s}`) : null;
        }
    } catch {}
    if (!session_id) {
        try {
            const KEY = 'arcextreme_opencode_session';
            session_id = localStorage.getItem(KEY) || 'arcextreme-backend';
        } catch { session_id = 'arcextreme-backend'; }
    }
    // 超时三层对齐：后端 httpx(timeout) <= 前端 Abort(timeout+10s)。index.js 的 withTimeout 再包一层同样用 cfg.timeout。
    const timeout = Math.max(5, Math.min(300, Number(cfg.timeout) || 40));
    const tryProxy = async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, (timeout + 10) * 1000);
        try {
            const proxyRes = await fetch(`${backendBase}/api/rerank_proxy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: cfg.apiUrl, api_key: cfg.apiKey || '', payload: body, timeout, verify_ssl: false, session_id }),
                signal: ctrl.signal,
            });
            if (proxyRes.status === 404) {
                const txt = await proxyRes.clone().text().catch(()=> '');
                if (txt.includes('Not Found')) throw new Error('PROXY_NOT_FOUND');
            }
            return proxyRes;
        } finally {
            clearTimeout(timer);
        }
    };

    let r;
    try {
        r = await tryProxy();
    } catch (e) {
        if (e && (e.name === 'AbortError' || String(e.message || '').includes('aborted'))) {
            try { traceMod && tid && traceMod.finishTraceFail(tid, `Rerank代理请求超时(${timeout}s+缓冲)`); } catch {}
            throw new Error(`Rerank代理请求超时(${timeout}s+缓冲)，已跳过精排直接用原序`);
        }
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

    // 非 200 不再吞成 null：透出真实状态码+云端原文，否则 400 参数错永远查不到
    if (!r.ok) {
        const txt = await r.text().catch(() => '');
        try { traceMod && tid && traceMod.finishTraceFail(tid, `HTTP ${r.status}: ${txt.slice(0, 800)}`, txt); } catch {}
        if (r.status === 400 && isMissingSessionError(txt)) {
            throw new Error(`Rerank 400 MissingSessionID（缺 x-opencode-session）：${txt.slice(0, 300)}。请更新后端到最新版（需转发该请求头）`);
        }
        throw new Error(`Rerank ${r.status}: ${txt.slice(0, 300) || '无返回体'}（已透出云端原文，非欠费问题请按此排查）`);
    }
    try {
        const d = await r.json();
        try { traceMod && tid && traceMod.finishTraceOk(tid, JSON.stringify(d, null, 2).slice(0, 8000), d); } catch {}
        const results = pickResults(d);
        if (!results.length) {
            try { traceMod && tid && traceMod.finishTraceFail(tid, `云端返回 200 但无可用排序数组，keys=[${Object.keys(d || {}).join(',')}]`); } catch {}
            throw new Error(`Rerank 返回为空：云端 200 但无 results/data 数组（keys=[${Object.keys(d || {}).join(',') || '空'}]），已用原序放行`);
        }
        return results
            .map((x, i) => ({ index: Number.isInteger(x?.index) ? x.index : i, score: pickScore(x) }))
            .filter(x => Number.isInteger(x.index) && x.index >= 0 && x.index < documents.length)
            .sort((a, b) => b.score - a.score);
    } catch (e) {
        // 上面主动 throw 的业务错直接透出，不二次包装
        if (e && /Rerank (400|404|422|429|500|502|503)|Rerank 返回为空|MissingSessionID/.test(String(e.message || ''))) throw e;
        try { traceMod && tid && traceMod.finishTraceFail(tid, e.message || String(e)); } catch {}
        throw new Error(`Rerank 解析失败：${e.message || String(e)}（已用原序放行，请看 Trace 原始返回）`);
    }
}
