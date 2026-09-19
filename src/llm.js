// 通用 OpenAI 兼容 chat/completions 调用 — 走后端代理根治 CORS，支持温度/推理兼容降级
// 有后端的插件就要狠狠依赖后端：优先走 backend /api/llm_proxy，失败才直连

import { SETTINGS_KEY } from './config.js';

let _traceMod = null;
async function getTrace() {
    if (_traceMod !== null) return _traceMod;
    try {
        _traceMod = await import('./trace.js');
        return _traceMod;
    } catch {
        _traceMod = { beginTrace: () => null, finishTraceOk: () => {}, finishTraceFail: () => {}, traceStore: [] };
        return _traceMod;
    }
}
function getTraceSync() {
    return _traceMod && _traceMod.beginTrace ? _traceMod : { beginTrace: () => null, finishTraceOk: () => {}, finishTraceFail: () => {}, traceStore: [] };
}

// OpenCode Go 会话 ID：同聊天复用同一 ID，同次 chatCompletion（含降级重试）保持不变。
// 规则：opts.session_id/sessionId 优先 > 当前 ST chatId > 浏览器持久化兜底；绝不每次随机。
function sanitizeSessionId(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    if (!s) return '';
    if (!s.startsWith('arcextreme-')) s = `arcextreme-${s}`;
    return s.slice(0, 80);
}
function getBrowserFallbackSessionId() {
    const KEY = 'arcextreme_opencode_session';
    try {
        const old = localStorage.getItem(KEY);
        if (old && sanitizeSessionId(old)) return sanitizeSessionId(old);
    } catch {}
    const hex = (() => {
        try {
            const b = new Uint8Array(6);
            (window.crypto || {}).getRandomValues?.(b);
            if (b.some(x => x !== 0)) return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        } catch {}
        return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    })();
    const sid = `arcextreme-${hex}`;
    try { localStorage.setItem(KEY, sid); } catch {}
    return sid;
}
function resolveOpencodeSessionId(opts = {}) {
    const explicit = opts.session_id ?? opts.sessionId ?? opts.opencodeSessionId;
    if (explicit && sanitizeSessionId(explicit)) return sanitizeSessionId(explicit);
    // 当前 ST 聊天：一句话按 chatId 隔离，后端 Go 侧缓存亲和更好
    try {
        const ctx = window.SillyTavern?.getContext?.() || null;
        const chatId = ctx?.chatId;
        if (chatId && sanitizeSessionId(chatId)) return sanitizeSessionId(chatId);
    } catch {}
    try {
        const m = String(window.location.hash || '').match(/chat[_-]?id=([^&]+)/i);
        if (m && m[1] && sanitizeSessionId(decodeURIComponent(m[1]))) return sanitizeSessionId(decodeURIComponent(m[1]));
    } catch {}
    return getBrowserFallbackSessionId();
}
function isMissingSessionError(text) {
    const lower = String(text || '').toLowerCase();
    return lower.includes('missingsessionid') || lower.includes('x-opencode-session');
}

function getBackendBase() {
    try {
        const s = window.extension_settings?.[SETTINGS_KEY];
        let raw = s?.backendUrl ?? localStorage.getItem('arcextreme_backend');
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
                console.warn(`[ArcEXtreme] 后端地址自动修正：${u} -> ${fixed}（页面 ${pageHost}）`);
                return fixed;
            }
        } catch {}
        return u;
    } catch { return 'http://127.0.0.1:9001'; }
}

/**
 * 构建请求体，处理推理模型兼容性：
 * - reasoningEffort !== 'none' 时默认不发送 temperature（避免 o1/o3 报错），除非 sendTempWithReasoning=true
 * - maxTokens 智能映射：推理启用时优先用 max_completion_tokens，回退 max_tokens
 */
function buildBody(cfg, messages, opts) {
    const eff = (cfg.reasoningEffort || opts.reasoningEffort || 'none').toLowerCase();
    const isReasoning = eff !== 'none' && eff !== '0' && eff !== '';
    const tempRaw = opts.temperature ?? cfg.temperature;
    const maxRaw = opts.maxTokens ?? cfg.maxTokens;
    const reasoningTokensRaw = opts.reasoningTokens ?? cfg.reasoningTokens;
    const sendTempWithReasoning = opts.sendTempWithReasoning ?? cfg.sendTempWithReasoning ?? false;

    const body = {
        model: cfg.model || 'gpt-4o-mini',
        messages,
    };

    if (tempRaw !== undefined && tempRaw !== null && tempRaw !== '') {
        const t = Number(tempRaw);
        if (!Number.isNaN(t)) {
            if (!isReasoning || sendTempWithReasoning) body.temperature = t;
        }
    }

    const maxN = Number(maxRaw);
    if (Number.isFinite(maxN) && maxN > 0) {
        if (isReasoning) body.max_completion_tokens = maxN;
        else body.max_tokens = maxN;
    }

    if (isReasoning) {
        body.reasoning_effort = eff;
        const budget = Number(reasoningTokensRaw);
        if (Number.isFinite(budget) && budget > 0) {
            body.reasoning = { effort: eff, max_tokens: budget, budget_tokens: budget };
            body.reasoning_tokens = budget;
        }
    }

    if (opts.json) body.response_format = { type: 'json_object' };

    return { body, isReasoning };
}

// 核心：狠狠走后端代理，彻底规避 CORS（不再回退直连）
// 前端 fetch 自带 Abort 超时（cfg.timeout + 10s 缓冲），防止代理hang住时无限阻塞生成拦截
async function doFetch(bodyObj, cfg, directUrl, directHeaders, sessionId) {
    const backendBase = getBackendBase();
    const proxyUrl = `${backendBase}/api/llm_proxy`;
    const timeout = Number(cfg.timeout ?? 60) || 60;
    const ctrl = new AbortController();
    const abortMs = (timeout + 10) * 1000;
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, abortMs);
    try {
        const proxyRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: cfg.apiUrl,
                api_key: cfg.apiKey || '',
                payload: bodyObj,
                timeout,
                verify_ssl: false,
                session_id: sessionId || undefined,
            }),
            signal: ctrl.signal,
        });
        if (proxyRes.status === 404) {
            const txt = await proxyRes.clone().text().catch(() => '');
            if (txt.includes('Not Found') || txt.includes('not found')) {
                throw new Error(`PROXY_NOT_FOUND:${backendBase}`);
            }
        }
        return proxyRes;
    } catch (e) {
        if (e && (e.name === 'AbortError' || String(e.message || '').includes('aborted'))) {
            throw new Error(`LLM代理请求超时(${timeout}s+缓冲): ${proxyUrl}，模型 ${cfg.model||'—'}。请检查模型速度或调小超时/关闭A1二次裁判`);
        }
        if (String(e.message).startsWith('PROXY_NOT_FOUND')) {
            const base = e.message.split(':')[1] || backendBase;
            throw new Error(`后端未更新：${base} 无 /api/llm_proxy，请重启后端到最新版（git pull 后重启 Start.bat）。已拦截直连以避免 CORS`);
        }
        if (e.name === 'TypeError' || e.message.includes('Failed to fetch') || e.message.includes('NetworkError') || e.message.includes('fetch')) {
            throw new Error(`后端代理不可达：${proxyUrl} 无法连接（backendUrl=${backendBase}，页面 ${window.location.hostname}）。请检查：1) 后端是否运行 2) 端口 9001 是否开放 3) 若局域网访问请将后端地址改成 ${window.location.hostname}:9001 而非 127.0.0.1。原错: ${e.message}`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

export async function chatCompletion(cfg, messages, opts = {}) {
    if (!cfg || !cfg.apiUrl) throw new Error('LLM apiUrl 未配置');
    const traceStep = opts._traceStep;
    const traceLabel = opts._traceLabel || traceStep || 'llm';
    let traceId = null;
    let traceMod = null;
    if (traceStep) {
        try {
            traceMod = await getTrace();
            traceId = traceMod.beginTrace(traceStep, traceLabel, cfg, { messagesPreview: messages?.slice(-1)?.[0]?.content?.slice(0, 200) });
        } catch { traceId = null; }
    } else {
        getTrace().catch(()=>{});
    }

    const mergedOpts = {
        temperature: opts.temperature ?? cfg.temperature,
        maxTokens: opts.maxTokens ?? cfg.maxTokens,
        reasoningEffort: opts.reasoningEffort ?? cfg.reasoningEffort,
        reasoningTokens: opts.reasoningTokens ?? cfg.reasoningTokens,
        sendTempWithReasoning: opts.sendTempWithReasoning ?? cfg.sendTempWithReasoning,
        json: opts.json ?? false,
    };

    const base = cfg.apiUrl.replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    let { body, isReasoning } = buildBody(cfg, messages, mergedOpts);
    // 会话 ID 本次调用算一次，重试全程复用（任务要求：不要每次请求随机生成）
    const opencodeSessionId = resolveOpencodeSessionId(opts);

    try {
        let res = await doFetch(body, cfg, url, headers, opencodeSessionId);

        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            // MissingSessionID 也是 400，但不是推理参数不兼容：直接抛错，跳过降级循环
            if (res.status === 400 && isMissingSessionError(txt)) {
                if (traceId) {
                    const tm = traceMod || getTraceSync();
                    try { tm.finishTraceFail(traceId, txt.slice(0, 800), txt); } catch {}
                }
                throw new Error(`LLM 400 MissingSessionID（缺 x-opencode-session）：${txt.slice(0, 400)}。已跳过参数降级，请检查后端是否已更新（需转发该请求头）。`);
            }
            const lower = txt.toLowerCase();
            const needsRetry =
                res.status === 400 &&
                (lower.includes('reasoning_effort') || lower.includes('reasoning') || lower.includes('max_completion_tokens') || lower.includes('max_tokens') || lower.includes('temperature') || lower.includes('response_format') || lower.includes('unknown parameter') || lower.includes('unsupported'));

            if (needsRetry) {
                const tryBodies = [];
                if (body.reasoning_effort || body.reasoning || body.reasoning_tokens) {
                    const b = { ...body };
                    delete b.reasoning_effort; delete b.reasoning; delete b.reasoning_tokens;
                    if (b.max_completion_tokens && !b.max_tokens) { b.max_tokens = b.max_completion_tokens; delete b.max_completion_tokens; }
                    if (mergedOpts.temperature !== undefined && mergedOpts.temperature !== '' && b.temperature === undefined) b.temperature = Number(mergedOpts.temperature);
                    tryBodies.push(b);
                }
                if (body.max_completion_tokens) {
                    const b = { ...body };
                    b.max_tokens = b.max_completion_tokens; delete b.max_completion_tokens;
                    delete b.reasoning_effort; delete b.reasoning; delete b.reasoning_tokens;
                    tryBodies.push(b);
                }
                if (body.max_tokens && isReasoning) {
                    const b = { ...body };
                    b.max_completion_tokens = b.max_tokens; delete b.max_tokens;
                    tryBodies.push(b);
                }
                if (body.temperature !== undefined) {
                    const b = { ...body }; delete b.temperature; tryBodies.push(b);
                }
                if (body.response_format) {
                    const b = { ...body }; delete b.response_format; tryBodies.push(b);
                }
                tryBodies.push({ model: body.model, messages: body.messages });

                let retriedOk = false;
                for (const b of tryBodies) {
                    const r2 = await doFetch(b, cfg, url, headers, opencodeSessionId);
                    if (r2.ok) { res = r2; body = b; retriedOk = true; break; }
                    const t2 = await r2.text().catch(() => '');
                    // 降级重试中若撞上 MissingSessionID：同样直接抛，不继续剥参数
                    if (r2.status === 400 && isMissingSessionError(t2)) {
                        if (traceId) {
                            const tm = traceMod || getTraceSync();
                            try { tm.finishTraceFail(traceId, t2.slice(0, 800), t2); } catch {}
                        }
                        throw new Error(`LLM 400 MissingSessionID（缺 x-opencode-session）：${t2.slice(0, 400)}。已跳过参数降级，请检查后端是否已更新（需转发该请求头）。`);
                    }
                    if (r2.status !== 400 || (!t2.toLowerCase().includes('unknown') && !t2.toLowerCase().includes('unsupported'))) {
                        if (traceId) {
                            const tm = traceMod || getTraceSync();
                            try { tm.finishTraceFail(traceId, t2.slice(0, 800), t2); } catch {}
                        }
                        throw new Error(`LLM ${r2.status}: ${t2.slice(0, 400)}`);
                    }
                }
                if (!retriedOk && !res.ok) {
                    if (traceId) {
                        const tm = traceMod || getTraceSync();
                        try { tm.finishTraceFail(traceId, txt.slice(0, 800), txt); } catch {}
                    }
                    throw new Error(`LLM ${res.status}: ${txt.slice(0, 400)} (已尝试兼容降级)`);
                }
            } else {
                if (traceId) {
                    const tm = traceMod || getTraceSync();
                    try { tm.finishTraceFail(traceId, txt.slice(0, 800), txt); } catch {}
                }
                throw new Error(`LLM ${res.status}: ${txt.slice(0, 400)}`);
            }
        }

        const data = await res.json();
        const choice = data?.choices?.[0];
        const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? '';
        const out = String(content ?? (choice?.message?.reasoning_content ? String(choice.message.reasoning_content) : ''));
        if (traceId) {
            try {
                const tm = traceMod || getTraceSync();
                let parsed = null;
                try { parsed = JSON.parse(out.replace(/<think>[\s\S]*?<\/think>/gi, '').match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? out); } catch {}
                const p2 = (() => { try { return JSON.parse(out); } catch { return null; } })();
                tm.finishTraceOk(traceId, out, parsed || p2);
            } catch {}
        }
        if (!content && choice?.message?.reasoning_content) return String(choice.message.reasoning_content);
        return out;
    } catch (e) {
        if (traceId) {
            try {
                const tm = traceMod || getTraceSync();
                const cur = tm.traceStore.find(x => x.id === traceId);
                if (cur && cur.status === 'running') tm.finishTraceFail(traceId, e.message || String(e));
            } catch {}
        }
        // 对 CORS 特别提示
        if (e.message.includes('Failed to fetch') && e.message.includes('CORS') === false) {
            // 尝试判断是否为 CORS：浏览器会抛 TypeError: Failed to fetch 且无 status
            // 我们在 doFetch 已优先走后端，所以走到这里说明后端也挂了且直连 CORS
            throw new Error(`CORS 或网络错误：已尝试后端代理 ${getBackendBase()}/api/llm_proxy 仍失败，请检查后端是否运行、且已更新到最新版. 原错: ${e.message}`);
        }
        throw e;
    }
}

// 从模型输出中稳健解析 JSON（兼容 ```json 代码块 + 推理思考前缀）
export function parseJson(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim();
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.search(/[[{]/);
    const endChar = t.trim().startsWith('[') ? ']' : '}';
    const end = t.lastIndexOf(endChar);
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
    try { return JSON.parse(t); } catch { return null; }
}
