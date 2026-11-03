// Embedding：支持 openai / vllm / ollama，狠狠走后端代理规避 CORS
import { getBackendBase } from './backendUrl.js';

async function fetchViaProxyOrDirect(targetUrl, payload, apiKey, timeout = 60) {
    const backendBase = getBackendBase();
    const { _source, _session_id, ...cleanPayload } = payload || {};
    const source = _source || 'openai';
    const session_id = _session_id || getOpencodeSessionId();
    const ctrl = new AbortController();
    const abortMs = (Number(timeout) || 60) * 1000 + 10000;
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, abortMs);
    try {
        const proxyRes = await fetch(`${backendBase}/api/embedding_proxy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: targetUrl.replace(/\/+$/, '').replace(/\/embeddings$/, '').replace(/\/api\/embeddings$/, ''),
                api_key: apiKey || '',
                payload: cleanPayload,
                source,
                timeout,
                session_id,
            }),
            signal: ctrl.signal,
        });
        if (proxyRes.status === 404) {
            const txt = await proxyRes.clone().text().catch(()=>'');
            if (txt.includes('Not Found')) throw new Error(`PROXY_NOT_FOUND:${backendBase}`);
        }
        return proxyRes;
    } catch (e) {
        if (e && (e.name === 'AbortError' || String(e.message || '').includes('aborted'))) {
            throw new Error(`Embedding代理请求超时(${Math.round(abortMs/1000)}s): ${backendBase}/api/embedding_proxy，请检查后端是否运行`);
        }
        if (String(e.message).startsWith('PROXY_NOT_FOUND')) {
            const base = e.message.split(':')[1] || getBackendBase();
            throw new Error(`后端未更新：${base} 无 /api/embedding_proxy，请重启后端。已拦截直连。`);
        }
        if (e.name === 'TypeError' || e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
            throw new Error(`后端代理不可达：${backendBase}/api/embedding_proxy 无法连接（backendUrl=${backendBase}）。请检查后端运行且局域网改用 ${window.location.hostname}:9001。原错: ${e.message}`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

const SID_SANITIZE_RE = /[^A-Za-z0-9_-]/g;
let _embChatCache = { chatId: null, sid: null };
let _embFallbackSid = null;
function getOpencodeSessionId() {
    try {
        const ctx = window.SillyTavern?.getContext?.() || null;
        const chatId = ctx?.chatId;
        if (chatId) {
            if (chatId === _embChatCache.chatId && _embChatCache.sid) return _embChatCache.sid;
            const s = String(chatId).replace(SID_SANITIZE_RE, '_').slice(0, 64);
            if (s) {
                const sid = s.startsWith('arcextreme-') ? s : `arcextreme-${s}`;
                _embChatCache = { chatId, sid };
                return sid;
            }
        }
    } catch {}
    if (_embFallbackSid) return _embFallbackSid;
    try {
        const KEY = 'arcextreme_opencode_session';
        const old = localStorage.getItem(KEY);
        if (old && String(old).startsWith('arcextreme-')) { _embFallbackSid = old; return old; }
        const hex = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
        const sid = `arcextreme-${hex}`;
        localStorage.setItem(KEY, sid);
        _embFallbackSid = sid;
        return sid;
    } catch { return 'arcextreme-backend'; }
}

export async function embedTexts(cfg, texts) {
    if (!cfg || !cfg.apiUrl) throw new Error('Embedding apiUrl 未配置');
    const base = cfg.apiUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    if (cfg.source === 'ollama') {
        // 并发但保序：Promise.all结果顺序与texts一致；限制单次并发避免小核过载
        const target = base.endsWith('/api/embeddings') ? base : `${base}/api/embeddings`;
        const CONC = Math.min(6, Math.max(2, texts.length));
        const out = new Array(texts.length);
        let idx = 0;
        const workers = new Array(Math.min(CONC, texts.length)).fill(0).map(async () => {
            while (true) {
                const i = idx++;
                if (i >= texts.length) return;
                const r = await fetchViaProxyOrDirect(target, { model: cfg.model, prompt: texts[i], _source: 'ollama' }, cfg.apiKey, 60);
                if (!r.ok) {
                    const txt = await r.text().catch(()=> '');
                    throw new Error(`Ollama embedding ${r.status}: ${txt.slice(0,200)}`);
                }
                const d = await r.json();
                const emb = d.embedding || d.data?.[0]?.embedding;
                if (!emb) throw new Error('Ollama embedding 返回异常');
                out[i] = emb;
            }
        });
        await Promise.all(workers);
        return out;
    }

    // openai / vllm 兼容 /embeddings
    const target = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
    const payload = { model: cfg.model, input: texts };
    const r = await fetchViaProxyOrDirect(target, { ...payload, _source: cfg.source }, cfg.apiKey, 60);
    if (!r.ok) {
        const txt = await r.text().catch(()=> '');
        throw new Error(`Embedding ${r.status}: ${txt.slice(0,200)}`);
    }
    const d = await r.json();
    // 兼容代理直接透传的格式
    if (d.data) return d.data.map((x) => x.embedding);
    if (Array.isArray(d.embeddings)) return d.embeddings;
    if (d.embedding) return [d.embedding];
    throw new Error('Embedding 返回格式异常');
}
