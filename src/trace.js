// ArcEXtreme 调用轨迹 — 记录每一步 LLM 的请求/返回，供面板查看
let _seq = 0;
export const traceStore = []; // {id, ts, step, label, model, status, ms, raw, parsed, error, cfgSnapshot}

const listeners = new Set();
function emit() { for (const fn of listeners) try { fn([...traceStore]); } catch {} }

export function onTrace(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function clearTrace() {
    traceStore.length = 0;
    emit();
}

export function beginTrace(step, label, cfg, meta = {}) {
    const id = ++_seq;
    const entry = {
        id,
        ts: Date.now(),
        step,           // 'extract' | 'route' | 'rerank'
        label,          // 显示名
        model: cfg?.model || meta.model || '—',
        status: 'running',
        ms: 0,
        raw: '',
        parsed: null,
        error: '',
        cfgSnapshot: cfg ? { model: cfg.model, temperature: cfg.temperature, maxTokens: cfg.maxTokens, reasoningEffort: cfg.reasoningEffort, reasoningTokens: cfg.reasoningTokens } : null,
        meta,
        _t0: performance.now(),
    };
    traceStore.unshift(entry);
    if (traceStore.length > 30) traceStore.pop();
    emit();
    return id;
}

export function updateTrace(id, patch) {
    const e = traceStore.find(x => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    if (patch.status && e._t0) e.ms = Math.round(performance.now() - e._t0);
    emit();
}

export function finishTraceOk(id, raw, parsed) {
    updateTrace(id, { status: 'ok', raw: String(raw ?? ''), parsed });
}

export function finishTraceFail(id, error, raw = '') {
    updateTrace(id, { status: 'fail', error: String(error ?? ''), raw: String(raw ?? '') });
}
