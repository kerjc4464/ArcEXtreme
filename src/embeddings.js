// Embedding：支持 openai / vllm / ollama，狠狠走后端代理规避 CORS
import { SETTINGS_KEY } from './config.js';

function getBackendBase() {
    try {
        const s = window.extension_settings?.[SETTINGS_KEY];
        let raw = s?.backendUrl;
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

async function fetchViaProxyOrDirect(targetUrl, payload, apiKey, timeout = 30) {
    const backendBase = getBackendBase();
    const { _source, ...cleanPayload } = payload || {};
    const source = _source || 'openai';
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
            }),
        });
        if (proxyRes.status === 404) {
            const txt = await proxyRes.clone().text().catch(()=>'');
            if (txt.includes('Not Found')) throw new Error(`PROXY_NOT_FOUND:${backendBase}`);
        }
        return proxyRes;
    } catch (e) {
        if (String(e.message).startsWith('PROXY_NOT_FOUND')) {
            const base = e.message.split(':')[1] || getBackendBase();
            throw new Error(`后端未更新：${base} 无 /api/embedding_proxy，请重启后端。已拦截直连。`);
        }
        if (e.name === 'TypeError' || e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
            throw new Error(`后端代理不可达：${backendBase}/api/embedding_proxy 无法连接（backendUrl=${backendBase}）。请检查后端运行且局域网改用 ${window.location.hostname}:9001。原错: ${e.message}`);
        }
        throw e;
    }
}

export async function embedTexts(cfg, texts) {
    if (!cfg || !cfg.apiUrl) throw new Error('Embedding apiUrl 未配置');
    const base = cfg.apiUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    if (cfg.source === 'ollama') {
        const out = [];
        for (const t of texts) {
            const payload = { model: cfg.model, prompt: t };
            const target = base.endsWith('/api/embeddings') ? base : `${base}/api/embeddings`;
            // 走代理
            const r = await fetchViaProxyOrDirect(target, { ...payload, _source: 'ollama' }, cfg.apiKey, 30);
            if (!r.ok) {
                const txt = await r.text().catch(()=> '');
                throw new Error(`Ollama embedding ${r.status}: ${txt.slice(0,200)}`);
            }
            const d = await r.json();
            // 代理返回的 d 可能是 {embedding: [...]} 或 {data: ...}，兼容两种
            const emb = d.embedding || d.data?.[0]?.embedding;
            if (!emb) throw new Error('Ollama embedding 返回异常');
            out.push(emb);
        }
        return out;
    }

    // openai / vllm 兼容 /embeddings
    const target = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
    const payload = { model: cfg.model, input: texts };
    const r = await fetchViaProxyOrDirect(target, { ...payload, _source: cfg.source }, cfg.apiKey, 30);
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
