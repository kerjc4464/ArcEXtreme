// @ts-nocheck
import {
    eventSource,
    event_types,
    getCurrentChatId,
    saveSettingsDebounced,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import { SETTINGS_KEY, EXTENSION_NAME, defaultSettings, mergeDefaults, BUCKETS, DEFAULT_EXTRACT_SYS, DEFAULT_EXTRACT_USER, DEFAULT_ROUTE_SYS, DEFAULT_ROUTE_USER, DEFAULT_SUBAGENT_SYS, DEFAULT_SUBAGENT_USER, DEFAULT_SUBLIMATE_SYS, DEFAULT_SUBLIMATE_USER, buildContextText, filterEnabledSouls, getEnabledSoulNames } from './src/config.js';
import { backend } from './src/backend.js';
import { embedTexts } from './src/embeddings.js';
import { rerank } from './src/rerank.js';
import { extractEvents } from './src/eventExtract.js';
import { routeQuery } from './src/router.js';
import {
    injectMemory,
    clearInjection,
    buildRecentBlock,
    buildRetrievedBlock,
    buildShortPoolBlock,
    injectSublimated,
    clearAllKnownSublimated,
    clearAllSublimatedForChat,
} from './src/inject.js';
import { log, renderSoulsList, renderEventsList, setStatus, initTraceUI, pushToast } from './src/ui.js';
import { evaluateShortPool } from './src/subAgents.js';
import { checkAndSublimate } from './src/sublimation.js';

const toastr = window.toastr;

const S = () => extension_settings[SETTINGS_KEY];

let lastQueryTs = 0;
let lastQueryChatId = '';
const QUERY_COOLDOWN = 2000;

// ---- 生成拦截防阻塞：快慢分离 ----
// 快路径（阻塞聊天）：近期/短期池快照 + 路由 + 向量检索 + 注入
// 慢路径（后台追赶）：短期池SubAgent裁判 + A1检索二次裁判 + 升华，只改分/固化，不阻塞本次回复
// 超时三层对齐：withTimeout(前端) >= fetch Abort(cfg.timeout+10s) >= 后端 httpx(cfg.timeout)
// 起步 60s：mimo 等慢模型 + 5万 token 大包，12s/25s 会误杀
const FAST_BACKEND_MS = 60000;
const ROUTE_LLM_MS = 70000; // >= 路由 cfg.timeout(60)+10s 缓冲
const EMBED_MS = 60000;
const QUERY_MS = 60000;
const RERANK_MS = 60000; // 兜底：实际以 s.rerank.timeout 为准，需 >= 后端 httpx timeout，避免前端先掐
const MAX_FAST_PATH_MS = 180000; // 总预算：容纳 60s 级多步串行，快模式也不误杀
// 后台任务按 chat 隔离，防止切聊后互相饿死；TTL 自清防止 LLM hang 死后永久占位
const BG_FLAG_TTL_MS = 5 * 60 * 1000;
const bgRunning = new Map(); // key: `${chatId}::${kind}` -> startTs
function bgTake(chatId, kind) {
    const key = `${chatId}::${kind}`;
    const ts = bgRunning.get(key);
    if (ts && (Date.now() - ts) < BG_FLAG_TTL_MS) return false;
    bgRunning.set(key, Date.now());
    return true;
}
function bgRelease(chatId, kind) { try { bgRunning.delete(`${chatId}::${kind}`); } catch {} }
function bgBusy(chatId, kind) {
    const ts = bgRunning.get(`${chatId}::${kind}`);
    return !!ts && (Date.now() - ts) < BG_FLAG_TTL_MS;
}

function withTimeout(promise, ms, label) {
    let timer = null;
    const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || '请求'}超时(${ms}ms)`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeoutP]).then(
        (v) => { clearTimeout(timer); return v; },
        (e) => { clearTimeout(timer); throw e; }
    );
}

function launchBackground(promise, label, done) {
    promise.then(
        () => { try { done && done(false); } catch {} },
        (e) => {
            try { log(`${label}后台失败: ${e && e.message ? e.message : e}`); } catch {}
            try { done && done(false); } catch {}
        }
    );
}

function hashStr(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return String(h);
}
function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

let lastUserHash = null;
let lastChatLen = 0;

// --------------------------------------------------------------------------- //
// 流水线 UI 辅助（扩展到7步）
// --------------------------------------------------------------------------- //
function setPipeline(step) {
    const track = document.getElementById('arcextreme-pipeline');
    if (!track) return;
    const dots = track.querySelectorAll('.ax-pipe__dot');
    dots.forEach(d => {
        const s = d.getAttribute('data-step');
        d.classList.remove('is-active','is-running');
        if (s === step) d.classList.add('is-running');
        else if (step && compareStep(s, step) < 0) d.classList.add('is-active');
    });
    if (!step) dots.forEach(d=>d.classList.remove('is-active','is-running'));
}
function compareStep(a, b) {
    const order = ['extract','subagent','route','query','rerank','inject','sublimate'];
    return order.indexOf(a) - order.indexOf(b);
}
function clearPipelineDelayed() {
    setTimeout(()=>setPipeline(null), 2800);
}
function notify(stepLabel, ok, msg) {
    if (ok === true) { log(`${stepLabel} ✓ ${msg||''}`.trim()); pushToast('ok', `${stepLabel} 成功` + (msg?` · ${msg}`:'')); }
    else if (ok === false) { log(`${stepLabel} ✗ ${msg||''}`.trim()); pushToast('fail', `${stepLabel} 失败` + (msg?` · ${msg}`:'')); }
    else { log(`${stepLabel}… ${msg||''}`.trim()); pushToast('info', `${stepLabel}…` + (msg?` · ${msg}`:'')); }
}

// --------------------------------------------------------------------------- //
// 初始化
// --------------------------------------------------------------------------- //
function ensureSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = defaultSettings();
    } else {
        mergeDefaults(extension_settings[SETTINGS_KEY], defaultSettings());
    }
}

// Soul 启用（B方案 后端持久化）—— 统一过滤入口
async function getEnabledSouls() {
    try {
        const full = await backend.listSoulsFull().catch(()=>null);
        if (full && Array.isArray(full.souls)) {
            const enabledMap = full.enabled_map || {};
            const filtered = filterEnabledSouls(full.souls, enabledMap);
            return { all: full.souls, enabled: filtered, map: enabledMap };
        }
        const souls = await backend.listSouls().catch(()=>[]);
        return { all: souls, enabled: souls.filter(s=>s.enabled!==false), map: {} };
    } catch { return { all: [], enabled: [], map: {} }; }
}
function soulsToNames(souls){ return (souls||[]).map(x=>x.name); }
function isValidChatId(id){
    const s = String(id||'').trim();
    return !!s && s !== 'undefined' && s !== 'null' && s !== 'false';
}

// --------------------------------------------------------------------------- //
// 主开关：关闭后全部停用 — 清除所有注入并阻断后续链路
// --------------------------------------------------------------------------- //
async function clearAllMemoryInjections() {
    const s = S();
    try { clearInjection(s); } catch {}
    try {
        const souls = await backend.listSouls().catch(()=>[]);
        if (souls.length) clearAllSublimatedForChat(s, souls.map(x=>x.name));
        else {
            try { clearAllSublimatedForChat(s, []); } catch {}
        }
    } catch {}
}

function updateMasterUI(enabled) {
    const panel = document.querySelector('.arcextreme-panel');
    if (panel) panel.classList.toggle('is-master-off', !enabled);
    const banner = document.getElementById('arcextreme-master-off-banner');
    if (banner) banner.style.display = enabled ? 'none' : 'flex';
    const pipeline = document.getElementById('arcextreme-pipeline');
    if (pipeline) {
        pipeline.style.opacity = enabled ? '' : '0.38';
        pipeline.style.pointerEvents = enabled ? '' : 'none';
    }
    if (!enabled) {
        setStatus('err', '已关闭 · 全停用');
        setPipeline(null);
    }
}

async function applyMasterState(enabled) {
    updateMasterUI(enabled);
    if (!enabled) {
        await clearAllMemoryInjections();
        log('主开关已关闭 · 已清除所有记忆注入，全部链路暂停');
        pushToast('warn', 'ArcEXtreme 已关闭 · 全部功能停用');
    } else {
        log('主开关已开启 · 恢复全部记忆链路');
        pushToast('ok', 'ArcEXtreme 已开启');
        try { await refreshStatus(); } catch {}
    }
}

// --------------------------------------------------------------------------- //
// 写入链路：用户发消息 -> 提取N事件(1:1 soul) -> 向量化 -> 入库+进短期池
// --------------------------------------------------------------------------- //
async function onUserMessage(mesId) {
    const s = S();
    if (!s.enabled) {
        if (s.debug) log('主开关已关闭，跳过事件提取');
        return;
    }
    const ctx = getContext();
    const chat = ctx.chat || [];
    let targetText = null;
    let contextText = '';
    try {
        const win = buildContextText(chat, s.contextWindow || 5);
        contextText = win;
    } catch {}
    if (typeof mesId === 'number' && chat[mesId]?.is_user) {
        const curHash = hashStr(chat[mesId].mes);
        if (curHash === lastUserHash) {
            if (s.debug) log('swipe/编辑 user 消息未变，跳过重提');
            return;
        }
        lastUserHash = curHash;
        targetText = chat[mesId].mes;
    } else {
        const lastUser = [...chat].reverse().find((m) => m.is_user);
        if (!lastUser || !lastUser.mes || !lastUser.mes.trim()) return;
        const curHash = hashStr(lastUser.mes);
        if (curHash === lastUserHash && typeof mesId === 'number') {
        } else {
            lastUserHash = curHash;
        }
        targetText = lastUser.mes;
    }
    if (!targetText || !targetText.trim()) return;
    try {
        await processUserInput(targetText, ctx.chatId || getCurrentChatId(), contextText);
    } catch (e) {
        console.error('[ArcEXtreme] 事件写入失败', e);
        notify('事件写入', false, e.message);
    }
}

async function processUserInput(text, chatId, contextText = '') {
    const s = S();
    if (!isValidChatId(chatId)) {
        if (s.debug) log(`事件提炼：chatId 无效(${chatId})，跳过`);
        return;
    }
    if (!s.extractLLM.apiUrl) {
        if (s.debug) log('未配置提取 LLM，跳过事件记录');
        return;
    }
    if (!s.embedding.apiUrl) {
        if (s.debug) log('未配置 Embedding，跳过事件记录');
        return;
    }
    if (!contextText) {
        try {
            const ctx = getContext();
            contextText = buildContextText(ctx.chat || [], s.contextWindow || 5);
        } catch {}
    }
    let souls = [];
    let enabledSouls = [];
    try {
        const en = await getEnabledSouls();
        souls = en.all;
        enabledSouls = en.enabled;
        if (!enabledSouls.length && souls.length) {
            if (s.debug) log('全部 Souls 已禁用，跳过事件提炼');
            notify('事件提炼', false, '全部 Souls 已禁用');
            return;
        }
    } catch (e) {
        if (s.debug) log(`获取 souls 列表失败: ${e.message}`);
    }
    // 仅对启用 souls 提炼（B方案）
    souls = enabledSouls.length ? enabledSouls : souls.filter(s=>s.enabled!==false);
    const soulNames = souls.map((x) => x.name);
    // 预取 souls 内容供2bit初值判断（结合人设）——必须全量，保证每个soul都能读到原文
    const soulsContentsMapForExtract = {};
    let fetchedCount=0, failedCount=0;
    try{
        // 逐项限时：单个soul失败不拖累整批
        const _rets = await Promise.all(souls.map(so=> withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `Soul原文:${so.name}`).then(txt=>({so, txt, ok:true})).catch(e=>({so, err:e.message, ok:false}))));
        for(const r of _rets){ if(r.ok){ soulsContentsMapForExtract[r.so.name]=r.txt; fetchedCount++; if(s.debug) log(`[extract] soul原文已读 ${r.so.name} ${r.txt.length}字`);} else { failedCount++; log(`[extract] soul原文读取失败 ${r.so.name}: ${r.err}`);} }
        if(s.debug) log(`[extract] souls原文拉取完成 成功${fetchedCount} 失败${failedCount} / ${souls.length}`);
        if(!fetchedCount && souls.length) { notify('事件提炼', false, 'soul原文全部读取失败，2bit初值将无依据'); }
    }catch{}
    notify('事件提炼', null, `模型 ${s.extractLLM.model||'—'} 开始调用 (${soulNames.length} souls，含人设)`);
    setPipeline('extract');
    let extracted;
    try {
        // 写入链路同样限时：超时则本轮跳过提炼，不卡 pipeline
        const extractMs = (Number(s.extractLLM?.timeout) || 60) * 1000;
        extracted = await withTimeout(extractEvents(s, text, soulNames, contextText, soulsContentsMapForExtract), extractMs, '事件提炼');
        const evts = extracted.events || [];
        if (!evts.length || !evts[0].event) {
            notify('事件提炼', false, '未提炼出有效事件');
            setPipeline(null);
            return;
        }
        notify('事件提炼', true, `${evts.length} 条 1:1 已提炼`);
        // 向量化
        setPipeline('query');
        const texts = evts.map(e=>e.event);
        let vecs;
        try {
            vecs = await withTimeout(embedTexts(s.embedding, texts), EMBED_MS, '向量化');
        } catch (e) {
            notify('向量化', false, e.message);
            setPipeline(null);
            throw e;
        }
        // 入库（批量，含why）
        const batchPayload = evts.map((e, i)=> ({
            event_text: e.event,
            soul: e.soul,
            counter: e.counter ?? 2,
            why: e.why || '',
            vector: vecs[i],
            timestamp: Date.now(),
            metadata: { source:'extract', userMessage: text.slice(0,200), why: e.why||'' },
        }));
        try {
            const capForInsert = Number(s.shortPool?.perSoulCap || 15);
            const res = await withTimeout(backend.insertBatch(chatId, batchPayload, capForInsert), FAST_BACKEND_MS, '事件入库');
            const okCount = (res.results||[]).filter(r=>!r.error).length;
            notify('事件入库', true, `${okCount}/${evts.length} 已入短期池`);
            log(`已记录 ${okCount} 事件: ${evts.map(e=>`【${e.soul}】${e.event.slice(0,30)}(${e.counter})`).join(' | ')}`);
        } catch (e) {
            notify('事件入库', false, e.message);
            setPipeline(null);
            throw e;
        }
        setPipeline('inject');
        if (s.debug) { refreshEvents(); refreshShortPool(); if(isDataModalOpen()){ refreshModalEvents(); refreshModalShortPool(); } }
        clearPipelineDelayed();
    } catch (e) {
        notify('事件提炼', false, e.message);
        setPipeline(null);
        throw e;
    }
}

// --------------------------------------------------------------------------- //
// 生成拦截：检索并注入（含2bit短期池全链路）
// --------------------------------------------------------------------------- //
async function arcextreme_generate(chat, contextSize, abort, type) {
    const s = S();
    if (!s.enabled) {
        try { clearInjection(s); } catch {}
        backend.listSouls().then(souls=>{
            try{ if(souls.length) clearAllSublimatedForChat(s, souls.map(x=>x.name)); }catch{}
        }).catch(()=>{});
        if (s.debug) log('主开关已关闭，跳过生成拦截');
        return;
    }
    // quiet 生成（总结/重排等）不应携带记忆：同步清主TAG与本会话已知升华TAG
    if (type === 'quiet') {
        try { clearInjection(s); } catch {}
        try { clearAllKnownSublimated(s); } catch {}
        return;
    }

    const now = Date.now();
    // 冷却内同chat沿用上轮注入（上下文几乎不变）；已切chat则正常执行，防止旧记忆串味
    const cdChatId = (() => { try { return getContext()?.chatId || getCurrentChatId(); } catch { return ''; } })();
    if (now - lastQueryTs < QUERY_COOLDOWN) {
        if (cdChatId && cdChatId === lastQueryChatId) {
            if (s.debug) log('生成拦截：冷却中，沿用上轮注入');
            return;
        }
        if (s.debug) log('生成拦截：冷却中但已切chat，正常执行防串味');
    }
    lastQueryChatId = cdChatId;
    lastQueryTs = now;

    try {
        const ctx = getContext();
        const chatId = ctx.chatId || getCurrentChatId();
        if (!isValidChatId(chatId)) {
            if (s.debug) log(`生成拦截：chatId 无效(${chatId})，跳过`);
            try{ clearInjection(s); }catch{}
            try{ clearAllKnownSublimated(s); }catch{}
            return;
        }
        const source = chat && chat.length ? chat : ctx.chat || [];
        const lastUser = [...source].reverse().find((m) => m.is_user);
        const userText = lastUser ? lastUser.mes : '';
        if (!userText) {
            clearInjection(s);
            try{ clearAllKnownSublimated(s); }catch{}
            return;
        }
        const contextTextExtract = buildContextText(source, s.contextWindow || 5);
        const contextTextRoute = buildContextText(source, s.routeContextWindow || 5);
        const contextTextSubAgent = buildContextText(source, s.subAgentContextWindow || 10);
        const contextText = contextTextExtract; // 兼容旧变量，默认用extract
        // 快路径总预算：超时则跳过剩余慢阶段，直接用快照注入放行聊天（全量模式不设限）
        const fastT0 = Date.now();
        const isFull = (s.pipelineMode === 'full');
        const fastExpired = () => isFull ? false : (Date.now() - fastT0) > MAX_FAST_PATH_MS;
        if (isFull && s.debug) log('管线模式：全量·同步（池裁判+A1+升华全阻塞跑完再注入）');

        // ---- Group0: 近期事件 + enabledSouls + 短期池 并发（无依赖，后端 IO，60s兜底） ----
        setPipeline('extract');
        let recent = [];
        let enabledSoulsForStage = [];
        let enabledSetForStage = new Set();
        let spRaw = { pools: {}, events: [] };
        const cap0 = Number(s.shortPool?.perSoulCap||15);
        try {
            const [recentRes, enStage, spRes] = await Promise.all([
                withTimeout(backend.recentEvents(chatId, s.recentDays), FAST_BACKEND_MS, '近期事件').catch(e=>{ notify('近期事件', false, e.message); return []; }),
                withTimeout(getEnabledSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>({all:[], enabled:[]})),
                withTimeout(backend.getShortPool(chatId, undefined, cap0), FAST_BACKEND_MS, '短期池拉取').catch(e=>{ log(`短期池拉取失败: ${e.message}`); return {pools:{}, events:[]}; })
            ]);
            recent = recentRes || [];
            log(`近期事件: ${recent.length} 条`);
            enabledSoulsForStage = enStage.enabled || [];
            enabledSetForStage = new Set(enabledSoulsForStage.map(x=>x.name));
            spRaw = spRes || {pools:{}, events:[]};
        } catch (e) {
            notify('近期事件', false, e.message);
        }

        let shortPoolGrouped = {};
        let shortPoolItems = [];
        {
            let rawGrouped = spRaw.pools || {};
            let rawItems = spRaw.events || [];
            if (enabledSetForStage.size) {
                const fg = {};
                for (const [k,v] of Object.entries(rawGrouped)) if (enabledSetForStage.has(k)) fg[k]=v;
                shortPoolGrouped = fg;
                shortPoolItems = rawItems.filter(it=> enabledSetForStage.has(it.pool_soul || it.state_soul || it.soul));
            } else { shortPoolGrouped = rawGrouped; shortPoolItems = rawItems; }
        }

        // ---- 统一 Soul 并行拉取：池内 souls + Route前12 去重后一次 Promise.all（快路径，超时降级为空） ----
        let unifiedSoulMap = {};
        let soulMapUsable = true;
        {
            const soulsAll = enabledSoulsForStage.length ? enabledSoulsForStage : await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
            const poolSoulSet = new Set(shortPoolItems.map(it=> it.pool_soul || it.state_soul || it.soul).filter(Boolean));
            const soulsToFetchForPool = poolSoulSet.size ? soulsAll.filter(so=> poolSoulSet.has(so.name)) : soulsAll;
            const fetchListPool = poolSoulSet.size ? soulsToFetchForPool : soulsAll;
            const routeCandidates = soulsAll.slice(0, 12);
            const unionMap = new Map();
            for (const so of fetchListPool) unionMap.set(so.name, so);
            for (const so of routeCandidates) if (!unionMap.has(so.name)) unionMap.set(so.name, so);
            const unionList = [...unionMap.values()];
            if (unionList.length && !fastExpired()) {
                // 逐项限时 + 全量结算：单个soul失败/超时不拖累整批，保留部分成功
                const results = await Promise.all(unionList.map(so =>
                    withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `Soul原文:${so.name}`)
                        .then(txt=>({so, txt, ok:true}))
                        .catch(e=>({so, err:e.message, ok:false}))
                ));
                let fetched=0, failed=0;
                for (const r of results) {
                    if (r.ok) { unifiedSoulMap[r.so.name]=r.txt; fetched++; if(s.debug) log(`[Soul并行] 已读 ${r.so.name} ${r.txt.length}字`);} else { failed++; log(`[Soul并行] 读取失败 ${r.so.name}: ${r.err}`);}
                }
                if(s.debug) log(`[Soul并行] 完成 成功${fetched} 失败${failed} / 需${unionList.length} 池内${poolSoulSet.size}`);
                if(!fetched && unionList.length) notify('Soul读取', false, 'soul原文全部读取失败');
            }
            // soul原文可用性：需要soul但全部拉取失败时，本轮跳过裁判/路由（无依据不乱判），下轮重试
            if (!Object.keys(unifiedSoulMap).length && unionList.length) {
                soulMapUsable = false;
                log('[Soul并行] 原文全失败：本轮跳过SubAgent裁判与路由，下轮重试');
            }
        }

        // ---- 快路径：清理同步 + 路由/Embedding限时；池裁判丢后台（最终一致，下轮生效） ----
        let vacanciesTotal = 0;
        let freedInfo = null;
        let buckets = [];
        let soulsSel = [];
        let qvec = null;
        const cap = Number(s.shortPool?.perSoulCap||15);
        const skipThr = Number(s.shortPool?.skipThreshold||3);
        const routeCfgLocal = s.routeLLM.useExtract ? s.extractLLM : s.routeLLM;

        // 池SubAgent裁判：高速模式丢后台（最终一致，下轮生效）；全量模式同步阻塞跑完再继续
        if (shortPoolItems.length && !soulMapUsable) {
            log('[SubAgent]跳过：soul原文全失败，无依据不判，下轮重试');
        } else if (isFull && shortPoolItems.length && soulMapUsable) {
            // 全量同步：本次注入即含最新 counter/why
            setPipeline('subagent');
            try {
                const poolFull = shortPoolItems.map(it=> ({
                    event_id: it.id,
                    soul: it.pool_soul || it.state_soul || it.soul,
                    event_text: it.event_text,
                    event: it.event_text,
                    counter: it.counter ?? it.scounter ?? 2,
                    birth_ts: it.birth_ts,
                })).filter(x=>x.soul);
                const effCfgFull = s.subAgentLLM?.useExtract ? s.extractLLM : s.subAgentLLM;
                log(`[SubAgent同步] 启动 池${poolFull.length}条 (模型 ${(effCfgFull && effCfgFull.model)||'—'})`);
                notify('SubAgent裁判', null, `${poolFull.length} 事件同步裁判中…阻塞本次注入`);
                const evaluationsFull = await evaluateShortPool(s, poolFull, { ...unifiedSoulMap }, contextTextSubAgent, userText);
                if (evaluationsFull.length) {
                    const syncFull = await withTimeout(backend.syncShortPool(chatId, evaluationsFull), FAST_BACKEND_MS, '短期池同步');
                    const cntFull = syncFull.count || 0;
                    log(`[SubAgent同步]完成: ${evaluationsFull.map(e=>`${e.soul}#${e.event_id}:${e.action}`).join(' | ')}`);
                    notify('SubAgent裁判', true, `${cntFull} 已更新(同步)`);
                    const spFull = await withTimeout(backend.getShortPool(chatId, undefined, cap), FAST_BACKEND_MS, '短期池重拉').catch(()=>null);
                    if (spFull) {
                        let gFull = spFull.pools || {};
                        if (enabledSetForStage.size) {
                            const fg={}; for(const [k,v] of Object.entries(gFull)) if(enabledSetForStage.has(k)) fg[k]=v;
                            gFull=fg;
                        }
                        shortPoolGrouped = gFull;
                        shortPoolItems = (spFull.events || []).filter(it=> !enabledSetForStage.size || enabledSetForStage.has(it.pool_soul || it.state_soul || it.soul));
                    }
                }
            } catch(e) {
                log(`[SubAgent同步]失败，本轮用快照继续: ${e.message}`);
                notify('SubAgent裁判', false, `${e.message}(已用快照继续)`);
            }
        } else if (shortPoolItems.length && !fastExpired() && bgTake(chatId, 'pool')) {
            const poolSnap = shortPoolItems.map(it=> ({
                event_id: it.id,
                soul: it.pool_soul || it.state_soul || it.soul,
                event_text: it.event_text,
                event: it.event_text,
                counter: it.counter ?? it.scounter ?? 2,
                birth_ts: it.birth_ts,
            })).filter(x=>x.soul);
            const soulMapSnap = { ...unifiedSoulMap };
            const ctxSnap = contextTextSubAgent, userSnap = userText, chatSnap = chatId, capSnap = cap;
            const enabledSnap = new Set(enabledSetForStage);
            if (poolSnap.length) {
                const effCfgBg = s.subAgentLLM?.useExtract ? s.extractLLM : s.subAgentLLM;
                const effBg = (effCfgBg && effCfgBg.apiUrl) ? effCfgBg : (s.extractLLM?.apiUrl ? s.extractLLM : null);
                log(`[SubAgent后台] 启动 池${poolSnap.length}条 (模型 ${effBg?.model||'—'})`);
                notify('SubAgent裁判', null, `${poolSnap.length} 事件后台裁判中…不阻塞聊天`);
                launchBackground((async () => {
                    const evaluations = await evaluateShortPool(s, poolSnap, soulMapSnap, ctxSnap, userSnap);
                    if (evaluations.length) {
                        let syncRes = null;
                        try {
                            syncRes = await withTimeout(backend.syncShortPool(chatSnap, evaluations), FAST_BACKEND_MS, '短期池同步');
                        } catch (e) {
                            log(`[SubAgent后台]同步失败，本轮裁判丢弃，下轮重判: ${e.message}`);
                            return;
                        }
                        const cnt = syncRes.count || 0;
                        log(`[SubAgent后台]完成: ${evaluations.map(e=>`${e.soul}#${e.event_id}:${e.action}`).join(' | ')}`);
                        notify('SubAgent裁判', true, `${cnt} 已更新(后台)`);
                        if (s.debug) { try { refreshShortPool(); if(isDataModalOpen()){ refreshModalShortPool(); } } catch {} }
                    }
                })(), '[SubAgent后台]', () => { bgRelease(chatSnap, 'pool'); });
            } else {
                bgRelease(chatId, 'pool');
            }
        } else if (shortPoolItems.length && bgBusy(chatId, 'pool')) {
            log('SubAgent后台裁判进行中，本轮跳过（防堆积）');
        } else if (!shortPoolItems.length) {
            log('短期池为空，跳过SubAgent');
        }

        // 同步：短期池清理（纯后端轻IO，为回填腾空位，必须在检索前）
        try {
            setPipeline('subagent');
            const prep = await withTimeout(backend.prepareShortPool(chatId, cap, skipThr), FAST_BACKEND_MS, '短期池清理');
            freedInfo = prep;
            if (enabledSetForStage.size && freedInfo && freedInfo.vacancies) {
                const filtVac = {};
                for (const [k,v] of Object.entries(freedInfo.vacancies)) if (enabledSetForStage.has(k)) filtVac[k]=v;
                freedInfo.vacancies = filtVac;
            }
            vacanciesTotal = Object.values((freedInfo&&freedInfo.vacancies)||{}).reduce((a,b)=>a+b,0);
            if (prep.count) {
                log(`短期池清理: 释放 ${prep.count} 条 vacancies=${JSON.stringify(freedInfo.vacancies)} freed=${JSON.stringify(prep.freed)}`);
                const sp3 = await withTimeout(backend.getShortPool(chatId, undefined, cap), FAST_BACKEND_MS, '短期池重拉').catch(()=>null);
                if (sp3) {
                    let g3 = sp3.pools || {};
                    if (enabledSetForStage.size) {
                        const fg={}; for(const [k,v] of Object.entries(g3)) if(enabledSetForStage.has(k)) fg[k]=v;
                        g3=fg;
                    }
                    shortPoolGrouped = g3;
                }
            }
        } catch(e){
            log(`短期池清理失败/超时: ${e.message}`);
        }

        const routeChain = (async ()=>{
            if (!routeCfgLocal.apiUrl) { log('路由 LLM 未配置，跳过分桶选择'); return {buckets:[], souls:[]}; }
            if (fastExpired()) { log('快路径超时，跳过路由'); return {buckets:[], souls:[]}; }
            if (!soulMapUsable) { log('路由跳过：soul原文全失败，无依据不分桶'); return {buckets:[], souls:[]}; }
            setPipeline('route');
            notify('路由决策', null, `模型 ${routeCfgLocal.model||'—'} 开始调用`);
            try {
                const souls = enabledSoulsForStage.length ? enabledSoulsForStage : await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
                const soulsContents = [];
                for (const so of souls.slice(0, 12)) {
                    if (fastExpired()) break;
                    const c = unifiedSoulMap[so.name];
                    if (c) soulsContents.push({ name: so.name, content: c });
                    else {
                        try { const txt = await withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, 'Soul原文'); soulsContents.push({name:so.name, content:txt}); unifiedSoulMap[so.name]=txt; } catch {}
                    }
                }
                if (!soulsContents.length && souls.length) { log('路由跳过：无可用soul设定'); return {buckets:[], souls:[]}; }
                const route = await withTimeout(routeQuery(s, userText, soulsContents, contextTextRoute), ROUTE_LLM_MS, '路由决策');
                let b = route.buckets;
                let ss = route.souls;
                if (enabledSetForStage.size) ss = ss.filter(n=> enabledSetForStage.has(n));
                notify('路由决策', true, `分桶[${b.join(',')||'无'}] souls[${ss.join(',')||'—'}]`);
                return {buckets:b, souls: ss};
            } catch(e) {
                notify('路由决策', false, e.message);
                return {buckets:[], souls:[]};
            }
        })();

        const embedChain = (async ()=>{
            if (!s.embedding.apiUrl) return null;
            if (fastExpired()) return null;
            try {
                const qText = contextTextRoute || contextText || userText;
                const [vec] = await withTimeout(embedTexts(s.embedding, [qText]), EMBED_MS, 'Embedding');
                return vec;
            } catch(e){
                log(`Embedding失败/超时: ${e.message}`);
                return null;
            }
        })();

        if (!fastExpired()) {
            const [routeRes, vecRes] = await Promise.all([routeChain, embedChain]);
            buckets = routeRes.buckets || [];
            soulsSel = routeRes.souls || [];
            qvec = vecRes;
        } else {
            log('快路径超时，跳过路由/检索，直接注入快照放行');
        }

        // Stage E：向量检索（含Y权重）
        setPipeline('query');
        let retrieved = [];
        let fillerEvents = [];
        let traditionalRetrieved = [];
        let fillItems = [];
        if (buckets.length && qvec && s.embedding.apiUrl) {
            try {
                let weightMultipliers = null;
                if (s.shortPool?.weight?.enabled) {
                    weightMultipliers = {
                        0: Number(s.shortPool.weight.m0||1),
                        1: Number(s.shortPool.weight.m1||1),
                        2: Number(s.shortPool.weight.m2||1),
                        3: Number(s.shortPool.weight.m3||1),
                        m0: Number(s.shortPool.weight.m0||1),
                        m1: Number(s.shortPool.weight.m1||1),
                        m2: Number(s.shortPool.weight.m2||1),
                        m3: Number(s.shortPool.weight.m3||1),
                    };
                }
                retrieved = await withTimeout(backend.queryEvents(chatId, qvec, buckets, soulsSel, 10, weightMultipliers), QUERY_MS, '向量检索');
                log(`向量检索: ${retrieved.length} 条${weightMultipliers?' (已加权)':''}`);
                if (vacanciesTotal>0 && retrieved.length) {
                    fillerEvents = retrieved.slice(0, vacanciesTotal);
                    traditionalRetrieved = retrieved.slice(vacanciesTotal);
                    const vacancySouls = [];
                    if (freedInfo && freedInfo.vacancies) {
                        for (const [soul, cnt] of Object.entries(freedInfo.vacancies)) {
                            for(let i=0;i<cnt;i++) vacancySouls.push(soul);
                        }
                    }
                    fillItems = [];
                    for (let i=0;i<fillerEvents.length;i++) {
                        const ev = fillerEvents[i];
                        let targetSoul = vacancySouls[i] || ev.souls?.[0] || soulsSel[0] || 'general';
                        if (ev.souls && vacancySouls[i] && ev.souls.includes(vacancySouls[i])) targetSoul = vacancySouls[i];
                        fillItems.push({ event_id: ev.id, soul: targetSoul });
                    }
                    if (fillItems.length) {
                        try {
                            const fillRes = await withTimeout(backend.fillShortPool(chatId, fillItems, cap), QUERY_MS, '短期池回填');
                            log(`短期池回填: ${fillRes.count} 条 ${JSON.stringify(fillItems)}`);
                            const sp4 = await withTimeout(backend.getShortPool(chatId, undefined, cap), FAST_BACKEND_MS, '短期池重拉').catch(()=>null);
                            if (sp4) {
                                shortPoolGrouped = sp4.pools || {};
                                shortPoolItems = sp4.events || shortPoolItems;
                            }
                        } catch(e){ log(`回填失败/超时: ${e.message}`); }
                    }
                } else {
                    traditionalRetrieved = retrieved;
                }

                // A1 二次裁判：只改分不阻塞本次注入，丢后台追赶（快照隔离 + 防重入）
                const raCfg = s.shortPool?.retrievedSubAgent;
                const raEnabled = raCfg ? raCfg.enabled !== false : true;
                if (raEnabled && retrieved.length && !soulMapUsable) {
                    log('[SubAgent检索]跳过：soul原文全失败，无依据不判，下轮重试');
                } else if (isFull && raEnabled && retrieved.length && soulMapUsable) {
                    // 全量同步：检索二次裁判阻塞跑完，本次注入即含最新分
                    setPipeline('subagent');
                    try {
                        const maxK = Math.max(1, Math.min(20, Number(raCfg?.maxItems ?? 10)));
                        const includeTrad = raCfg?.includeTraditional !== false;
                        let candEvents = [];
                        if (fillerEvents.length) candEvents = [...fillerEvents];
                        if (includeTrad && traditionalRetrieved.length) {
                            const need = maxK - candEvents.length;
                            if (need > 0) candEvents.push(...traditionalRetrieved.slice(0, need));
                        }
                        if (!candEvents.length) candEvents = retrieved.slice(0, maxK);
                        else candEvents = candEvents.slice(0, maxK);
                        const fillMapFull = new Map(fillItems.map(fi=>[fi.event_id, fi.soul]));
                        const poolKeysFull = new Set(shortPoolItems.map(it=> `${it.id||it.event_id}::${it.pool_soul||it.state_soul||it.soul}`));
                        const rawItemsFull = [];
                        for (const ev of candEvents) {
                            const soulsArr = Array.isArray(ev.souls) && ev.souls.length
                                ? ev.souls
                                : (ev.souls_str ? String(ev.souls_str).split(',').map(x=>x.trim()).filter(Boolean) : []);
                            if (fillMapFull.has(ev.id)) {
                                rawItemsFull.push({ event_id: ev.id, soul: fillMapFull.get(ev.id), event_text: ev.event_text || ev.event || '', event: ev.event_text || '', counter: ev.counter ?? ev.scounter ?? 2, birth_ts: ev.birth_ts || ev.timestamp || Date.now() });
                            } else if (soulsArr.length) {
                                for (const so of soulsArr) rawItemsFull.push({ event_id: ev.id, soul: so, event_text: ev.event_text || ev.event || '', event: ev.event_text || '', counter: ev.counter ?? ev.scounter ?? 2, birth_ts: ev.birth_ts || ev.timestamp || Date.now() });
                            } else {
                                rawItemsFull.push({ event_id: ev.id, soul: soulsSel[0] || 'general', event_text: ev.event_text || ev.event || '', event: ev.event_text || '', counter: ev.counter ?? ev.scounter ?? 2, birth_ts: ev.birth_ts || ev.timestamp || Date.now() });
                            }
                        }
                        const seenFull = new Set();
                        const evalItemsFull = [];
                        for (const it of rawItemsFull) {
                            if (!it.soul || !it.event_text) continue;
                            const key = `${it.event_id}::${it.soul}`;
                            if (poolKeysFull.has(key) || seenFull.has(key)) continue;
                            seenFull.add(key);
                            evalItemsFull.push(it);
                        }
                        if (!evalItemsFull.length) {
                            if (s.debug) log('[SubAgent检索同步]跳过：候选均已在短期池裁判过');
                        } else {
                            notify('SubAgent裁判(检索)', null, `${evalItemsFull.length} 条检索结果同步裁判中…阻塞本次注入`);
                            let localSoulMapFull = {};
                            const needSoulsFull = [...new Set(evalItemsFull.map(x=>x.soul))];
                            const missingFull = needSoulsFull.filter(n=> !unifiedSoulMap[n]);
                            if (missingFull.length) {
                                try {
                                    const allSoulsFull = await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
                                    const toFetchFull = allSoulsFull.filter(x=> missingFull.includes(x.name));
                                    const resFull = await Promise.all(toFetchFull.map(so=> withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `Soul原文:${so.name}`).then(txt=>({name:so.name, txt})).catch(()=>null)));
                                    for (const r of resFull) if (r) { localSoulMapFull[r.name]=r.txt; }
                                } catch {}
                            }
                            for (const n of needSoulsFull) if (unifiedSoulMap[n]) localSoulMapFull[n]=unifiedSoulMap[n];
                            if (!Object.keys(localSoulMapFull).length) { log('[SubAgent检索同步]跳过：无可用soul原文，下轮重试'); }
                            else {
                                const evalFull = await evaluateShortPool(s, evalItemsFull, localSoulMapFull, contextTextSubAgent, userText);
                                if (evalFull.length) {
                                    const hasRealFull = evalFull.some(e=> e.action !== 'Skip');
                                    const syncFull2 = await withTimeout(backend.syncShortPool(chatId, evalFull), FAST_BACKEND_MS, '短期池同步');
                                    const cntFull2 = syncFull2.count ?? evalFull.length;
                                    if (hasRealFull) log(`[SubAgent检索同步]完成: ${evalFull.map(e=>`${e.soul}#${e.event_id}:${e.action}${e.why?`(${e.why.slice(0,30)})`:''}`).join(' | ')}`);
                                    else log(`[SubAgent检索同步]完成: 全部Skip ${evalItemsFull.length}条`);
                                    notify('SubAgent裁判(检索)', true, `${cntFull2} 已更新(同步)${hasRealFull?'':'(全Skip)'}`);
                                    const spFull2 = await withTimeout(backend.getShortPool(chatId, undefined, cap), FAST_BACKEND_MS, '短期池重拉').catch(()=>null);
                                    if (spFull2) {
                                        let gFull2 = spFull2.pools || {};
                                        if (enabledSetForStage.size) {
                                            const fg={}; for(const [k,v] of Object.entries(gFull2)) if(enabledSetForStage.has(k)) fg[k]=v;
                                            gFull2=fg;
                                        }
                                        shortPoolGrouped = gFull2;
                                        shortPoolItems = (spFull2.events || []).filter(it=> !enabledSetForStage.size || enabledSetForStage.has(it.pool_soul || it.state_soul || it.soul));
                                    }
                                }
                            }
                        }
                    } catch(e) {
                        log(`[SubAgent检索同步]失败，本轮用快照继续: ${e.message}`);
                        notify('SubAgent裁判(检索)', false, `${e.message}(已用快照继续)`);
                    }
                } else if (raEnabled && retrieved.length && bgTake(chatId, 'a1')) {
                    const retrievedSnap = retrieved.slice();
                    const fillerSnap = fillerEvents.slice();
                    const tradSnap = traditionalRetrieved.slice();
                    const fillSnap = fillItems.slice();
                    const poolKeysSnap = new Set(shortPoolItems.map(it=> `${it.id||it.event_id}::${it.pool_soul||it.state_soul||it.soul}`));
                    const soulMapSnapA1 = { ...unifiedSoulMap };
                    const ctxSnapA1 = contextTextSubAgent, userSnapA1 = userText, chatSnapA1 = chatId, capSnapA1 = cap;
                    const maxKSnap = Math.max(1, Math.min(20, Number(raCfg?.maxItems ?? 10)));
                    const includeTradSnap = raCfg?.includeTraditional !== false;
                    const soulsSelSnap = soulsSel.slice();
                    notify('SubAgent裁判(检索)', null, `${Math.min(retrievedSnap.length, maxKSnap)} 条检索结果后台裁判中…不阻塞聊天`);
                    launchBackground((async () => {
                        const maxK = maxKSnap;
                        const includeTrad = includeTradSnap;
                        let candEvents = [];
                        if (fillerSnap.length) candEvents = [...fillerSnap];
                        if (includeTrad && tradSnap.length) {
                            const need = maxK - candEvents.length;
                            if (need > 0) candEvents.push(...tradSnap.slice(0, need));
                        }
                        if (!candEvents.length) candEvents = retrievedSnap.slice(0, maxK);
                        else candEvents = candEvents.slice(0, maxK);

                        const fillMap = new Map(fillSnap.map(fi=>[fi.event_id, fi.soul]));
                        const rawItems = [];
                        for (const ev of candEvents) {
                            const soulsArr = Array.isArray(ev.souls) && ev.souls.length
                                ? ev.souls
                                : (ev.souls_str ? String(ev.souls_str).split(',').map(x=>x.trim()).filter(Boolean) : []);
                            if (fillMap.has(ev.id)) {
                                rawItems.push({
                                    event_id: ev.id,
                                    soul: fillMap.get(ev.id),
                                    event_text: ev.event_text || ev.event || '',
                                    event: ev.event_text || '',
                                    counter: ev.counter ?? ev.scounter ?? 2,
                                    birth_ts: ev.birth_ts || ev.timestamp || Date.now(),
                                });
                            } else if (soulsArr.length) {
                                for (const so of soulsArr) {
                                    rawItems.push({
                                        event_id: ev.id,
                                        soul: so,
                                        event_text: ev.event_text || ev.event || '',
                                        event: ev.event_text || '',
                                        counter: ev.counter ?? ev.scounter ?? 2,
                                        birth_ts: ev.birth_ts || ev.timestamp || Date.now(),
                                    });
                                }
                            } else {
                                const fallbackSoul = soulsSelSnap[0] || 'general';
                                rawItems.push({
                                    event_id: ev.id,
                                    soul: fallbackSoul,
                                    event_text: ev.event_text || ev.event || '',
                                    event: ev.event_text || '',
                                    counter: ev.counter ?? ev.scounter ?? 2,
                                    birth_ts: ev.birth_ts || ev.timestamp || Date.now(),
                                });
                            }
                        }
                        const seen2 = new Set();
                        const evalItems = [];
                        for (const it of rawItems) {
                            if (!it.soul || !it.event_text) continue;
                            const key = `${it.event_id}::${it.soul}`;
                            if (poolKeysSnap.has(key) || seen2.has(key)) continue;
                            seen2.add(key);
                            evalItems.push(it);
                        }
                        if (!evalItems.length) {
                            if (s.debug) log('[SubAgent检索后台]跳过：候选均已在短期池裁判过');
                            return;
                        }
                        let localSoulMap = {};
                        const needSouls = [...new Set(evalItems.map(x=>x.soul))];
                        const missing = needSouls.filter(n=> !soulMapSnapA1[n]);
                        if (missing.length) {
                            try {
                                const allSouls = await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
                                const toFetch = allSouls.filter(x=> missing.includes(x.name));
                                const res = await Promise.all(toFetch.map(so=> withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `Soul原文:${so.name}`).then(txt=>({name:so.name, txt})).catch(()=>null)));
                                for (const r of res) if (r) { localSoulMap[r.name]=r.txt; }
                            } catch {}
                        }
                        for (const n of needSouls) if (soulMapSnapA1[n]) localSoulMap[n]=soulMapSnapA1[n];
                        if (!Object.keys(localSoulMap).length) { log('[SubAgent检索后台]跳过：无可用soul原文，下轮重试'); return; }
                        const eval2 = await evaluateShortPool(s, evalItems, localSoulMap, ctxSnapA1, userSnapA1);
                        if (eval2.length) {
                            const hasReal = eval2.some(e=> e.action !== 'Skip');
                            let syncRes2 = null;
                            try {
                                syncRes2 = await withTimeout(backend.syncShortPool(chatSnapA1, eval2), FAST_BACKEND_MS, '短期池同步');
                            } catch (e) {
                                log(`[SubAgent检索后台]同步失败，本轮裁判丢弃，下轮重判: ${e.message}`);
                                return;
                            }
                            const cnt2 = syncRes2.count ?? eval2.length;
                            if (hasReal) log(`[SubAgent检索后台]完成: ${eval2.map(e=>`${e.soul}#${e.event_id}:${e.action}${e.why?`(${e.why.slice(0,30)})`:''}`).join(' | ')}`);
                            else log(`[SubAgent检索后台]完成: 全部Skip ${evalItems.length}条`);
                            notify('SubAgent裁判(检索)', true, `${cnt2} 已更新(后台)${hasReal?'':'(全Skip)'}`);
                            if (s.debug) { try { refreshShortPool(); if(isDataModalOpen()){ refreshModalShortPool(); } } catch {} }
                        }
                    })(), '[SubAgent检索后台]', () => { bgRelease(chatSnapA1, 'a1'); });
                } else if (raEnabled && retrieved.length && bgBusy(chatId, 'a1')) {
                    log('A1后台裁判进行中，本轮跳过（防堆积）');
                }
            } catch (e) {
                notify('向量检索', false, e.message);
            }
        } else if (!buckets.length) {
            log('无分桶，跳过向量检索');
        }

        // Stage F：Rerank（仅对传统检索部分，限时，超时直接用原序放行）
        // 超时三层对齐：withTimeout(前端) >= fetch Abort(cfg.timeout+10s) >= 后端 httpx(cfg.timeout)，避免 15s 误杀
        let rerankedTraditional = traditionalRetrieved;
        if (s.rerank.enabled && traditionalRetrieved.length && !fastExpired()) {
            setPipeline('rerank');
            notify('Rerank', null, '精排调用中…');
            try {
                const rerankMs = (Math.max(5, Math.min(300, Number(s.rerank?.timeout) || 60)) + 2) * 1000;
                const rr = await withTimeout(rerank(s.rerank, contextText || userText, traditionalRetrieved.map((e) => e.event_text)), Math.max(rerankMs, RERANK_MS), 'Rerank');
                if (rr && rr.length) {
                    rerankedTraditional = rr.map((r) => ({ ...traditionalRetrieved[r.index], score: r.score }));
                    notify('Rerank', true, `${rerankedTraditional.length} 条已重排`);
                } else if (rr && !rr.length) {
                    log('Rerank 返回 0 条（documents 为空或全过滤），用原序放行');
                } else {
                    notify('Rerank', false, '返回为空（已用原序放行，详见 Trace）');
                }
            } catch (e) {
                notify('Rerank', false, `${e.message}（已用原序放行，不阻塞注入）`);
            }
        } else if (s.rerank.enabled && traditionalRetrieved.length && fastExpired()) {
            log('快路径超时，跳过Rerank直接注入');
        } else if (s.rerank.enabled && !traditionalRetrieved.length && retrieved.length) {
            log('Rerank 跳过：传统检索部分为空（检索结果全被回填消费），用原序放行');
        }

        // Stage G：升华 —— 快路径只读已固化记录用于注入；深度推理丢后台，不阻塞聊天
        let sublimatedItems = [];
        try {
            const persisted = await withTimeout(backend.listSublimated(chatId), FAST_BACKEND_MS, '升华记录拉取').catch(()=>[]);
            if (persisted && persisted.length) {
                let recentSub = persisted.slice(0, 5);
                if (enabledSetForStage.size) recentSub = recentSub.filter(x=> enabledSetForStage.has(x.soul));
                if (recentSub.length) {
                    try { injectSublimated(s, recentSub); } catch {}
                    sublimatedItems = recentSub;
                }
            }
        } catch {}
        if (s.sublimation?.enabled === false) {
            if (s.debug) log('升华已关闭，跳过检测');
        } else if (isFull) {
            // 全量同步：升华深度推理阻塞跑完，本次注入即含新固化
            try {
                setPipeline('sublimate');
                notify('升华', null, '深度推理同步进行中…阻塞本次注入');
                const thr = Number(s.shortPool?.stuckThreshold || 8);
                let preCandidates = [];
                try {
                    const chk = await withTimeout(backend.checkSublimation(chatId, thr), FAST_BACKEND_MS, '升华检测');
                    preCandidates = chk.candidates || [];
                } catch (e) { log(`[升华同步]检测失败/超时: ${e.message}`); preCandidates = []; }
                if (enabledSetForStage.size) preCandidates = preCandidates.filter(c=> enabledSetForStage.has(c.soul));
                if (preCandidates.length) {
                    const candSoulSet = new Set(preCandidates.map(c=>c.soul).filter(Boolean));
                    let soulsAllSub = enabledSoulsForStage.length ? enabledSoulsForStage : await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
                    const soulsSub = enabledSetForStage.size ? soulsAllSub.filter(so=> enabledSetForStage.has(so.name)) : soulsAllSub;
                    const soulsToFetchForSub = candSoulSet.size ? soulsSub.filter(so=> candSoulSet.has(so.name)) : [];
                    const soulsContentMap = {};
                    if (soulsToFetchForSub.length) {
                        const subResArr = await Promise.all(soulsToFetchForSub.map(so=> withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `升华Soul:${so.name}`).then(txt=>({so, txt, ok:true})).catch(e=>({so, err:e.message, ok:false}))));
                        for (const r of (subResArr || [])) {
                            if (r && r.ok) soulsContentMap[r.so.name] = r.txt;
                        }
                    }
                    const mapForSub = Object.keys(soulsContentMap).length ? soulsContentMap : unifiedSoulMap;
                    if (!Object.keys(mapForSub).length) { log('[升华同步]跳过：无可用soul原文，不做无依据升华'); }
                    else {
                        const subRes = await checkAndSublimate(s, chatId, contextTextSubAgent || contextText, mapForSub);
                        if (subRes && subRes.length) {
                            log(`[升华同步]完成 ${subRes.length} 条: ${subRes.map(x=>`【${x.soul}】${x.sublimated.slice(0,30)}`).join(' | ')}`);
                            notify('升华', true, `${subRes.length} 条已固化到soul(同步)`);
                            let curChat = '';
                            try { curChat = getContext()?.chatId || getCurrentChatId(); } catch {}
                            if (curChat && curChat !== chatId) {
                                log(`[升华同步]已切chat(${String(chatId).slice(0,8)}→${String(curChat).slice(0,8)})：只写库不注入`);
                            } else {
                                try {
                                    injectSublimated(s, subRes);
                                    if (s.debug) refreshSouls();
                                } catch (e) { log(`[升华同步]注入失败: ${e.message}`); }
                            }
                            if (s.debug) { try { refreshSublimated(); if(isDataModalOpen()){ refreshModalSublimated(); } } catch {} }
                        } else {
                            log('[升华同步]完成：本轮无可固化项');
                        }
                    }
                } else {
                    log('[升华同步]完成：无候选');
                }
            } catch(e) {
                log(`[升华同步]失败，本轮跳过: ${e.message}`);
                notify('升华', false, `${e.message}(已跳过)`);
            }
        } else if (!fastExpired() && bgTake(chatId, 'sub')) {
            const chatSnapSub = chatId, ctxSnapSub = contextTextSubAgent || contextText;
            const soulMapSnapSub = { ...unifiedSoulMap };
            const enabledSnapSub = new Set(enabledSetForStage);
            const enabledSoulsSnapSub = enabledSoulsForStage.slice();
            const capSnapSub = cap;
            launchBackground((async () => {
                setPipeline('sublimate');
                const thr = Number(s.shortPool?.stuckThreshold || 8);
                let preCandidates = [];
                try {
                    const chk = await withTimeout(backend.checkSublimation(chatSnapSub, thr), FAST_BACKEND_MS, '升华检测');
                    preCandidates = chk.candidates || [];
                } catch (e) { log(`[升华后台]检测失败/超时: ${e.message}`); return; }
                if (enabledSnapSub.size) preCandidates = preCandidates.filter(c=> enabledSnapSub.has(c.soul));
                if (!preCandidates.length) return;
                const candSoulSet = new Set(preCandidates.map(c=>c.soul).filter(Boolean));
                let soulsAllSub = enabledSoulsSnapSub.length ? enabledSoulsSnapSub : await withTimeout(backend.listSouls(), FAST_BACKEND_MS, 'Soul列表').catch(()=>[]);
                const soulsSub = enabledSnapSub.size ? soulsAllSub.filter(so=> enabledSnapSub.has(so.name)) : soulsAllSub;
                const soulsToFetchForSub = candSoulSet.size ? soulsSub.filter(so=> candSoulSet.has(so.name)) : [];
                const soulsContentMap = {};
                if (soulsToFetchForSub.length) {
                    const subResArr = await Promise.all(soulsToFetchForSub.map(so=> withTimeout(backend.getSoul(so.filename), FAST_BACKEND_MS, `升华Soul:${so.name}`).then(txt=>({so, txt, ok:true})).catch(e=>({so, err:e.message, ok:false}))));
                    for (const r of (subResArr || [])) {
                        if (r && r.ok) soulsContentMap[r.so.name] = r.txt;
                    }
                }
                const mapForSub = Object.keys(soulsContentMap).length ? soulsContentMap : soulMapSnapSub;
                if (!Object.keys(mapForSub).length) { log('[升华后台]跳过：无可用soul原文，不做无依据升华'); return; }
                const subRes = await checkAndSublimate(s, chatSnapSub, ctxSnapSub, mapForSub);
                if (subRes && subRes.length) {
                    log(`[升华后台]完成 ${subRes.length} 条: ${subRes.map(x=>`【${x.soul}】${x.sublimated.slice(0,30)}`).join(' | ')}`);
                    notify('升华', true, `${subRes.length} 条已固化到soul(后台)`);
                    // 跨chat guard：已切聊只写库不注入，防止A聊固化污染B聊prompt
                    let curChat = '';
                    try { curChat = getContext()?.chatId || getCurrentChatId(); } catch {}
                    if (curChat && curChat !== chatSnapSub) {
                        log(`[升华后台]已切chat(${String(chatSnapSub).slice(0,8)}→${String(curChat).slice(0,8)})：只写库不注入`);
                    } else {
                        try {
                            injectSublimated(s, subRes);
                            if (s.debug) refreshSouls();
                        } catch (e) { log(`[升华后台]注入失败: ${e.message}`); }
                    }
                    if (s.debug) { try { refreshSublimated(); if(isDataModalOpen()){ refreshModalSublimated(); } } catch {} }
                }
            })(), '[升华后台]', () => { bgRelease(chatSnapSub, 'sub'); });
        } else if (bgBusy(chatId, 'sub')) {
            log('升华后台进行中，本轮跳过（防堆积）');
        }

        // Stage H：注入（高速模式慢任务已在后台追赶；全量模式全部已同步跑完）
        // 升华只走独立TAG（injectSublimated），主TAG不再重复内联，避免同一批出现两遍
        setPipeline('inject');
        const recentBlock = buildRecentBlock(recent, s.recentDays);
        const retrievedBlock = buildRetrievedBlock(rerankedTraditional);
        const shortPoolBlock = buildShortPoolBlock(shortPoolGrouped, cap);
        injectMemory(s, recentBlock, retrievedBlock, shortPoolBlock, '');
        const fastMs = Date.now() - fastT0;
        const modeTag = isFull ? '全量同步' : '高速异步';
        const bgNote = (!isFull && (bgBusy(chatId, 'pool') || bgBusy(chatId, 'a1') || bgBusy(chatId, 'sub'))) ? ' · 裁判/升华后台追赶中' : '';
        notify('记忆注入', true, `【${modeTag}】短期池${Object.keys(shortPoolGrouped).length}魂 ${shortPoolItems.length}条 · 检索${rerankedTraditional.length} · 升华${sublimatedItems.length} · 分桶[${buckets.join(',')||'无'}] · ${fastMs}ms${bgNote}`);
        log(`注入完成(${fastMs}ms,${modeTag})：短期池${shortPoolItems.length}条，检索${rerankedTraditional.length}条，升华${sublimatedItems.length}条，分桶[${buckets.join(',') || '无'}]${bgNote}`);
        clearPipelineDelayed();
        if (s.debug){ refreshShortPool(); refreshSublimated(); if(isDataModalOpen()){ refreshModalShortPool(); refreshModalSublimated(); } }
    } catch (e) {
        console.error('[ArcEXtreme] 生成拦截失败', e);
        notify('生成拦截', false, e.message);
        setPipeline(null);
    }
}

window['arcextreme_generate'] = arcextreme_generate;

// --------------------------------------------------------------------------- //
// UI
// --------------------------------------------------------------------------- //
async function refreshSouls() {
    try {
        const full = await backend.listSoulsFull().catch(async ()=> ({souls: await backend.listSouls(), enabled_map:{}}));
        const souls = full.souls || [];
        const enabledMap = full.enabled_map || {};
        // render with toggle (B方案 后端持久化)
        const summary = document.getElementById('arcextreme-souls-summary');
        if (summary) {
            const enabledCnt = souls.filter(s=> s.enabled!==false).length;
            summary.textContent = `${enabledCnt}/${souls.length} 启用`;
            summary.style.color = enabledCnt===0 ? '#ef4444' : enabledCnt===souls.length ? '#10b981' : '#f59e0b';
        }
        const onToggle = async (name, val) => {
            const curMap = {};
            for (const so of souls) curMap[so.name] = so.enabled !== false;
            curMap[name] = val;
            await backend.setSoulsEnabled(curMap);
            log(`Soul ${name} 已${val?'启用':'禁用'} (B方案已持久化)`);
            pushToast('ok', `${name} 已${val?'启用':'禁用'}`);
            await refreshSouls();
        };
        try { renderSoulsList(souls, {onToggle, enabledMap}); } catch { renderSoulsList(souls); }
        // 同步过滤下拉 - 显示全部但禁用项加标记
        const selShort = document.getElementById('arcextreme-short-filter-soul');
        const selLong = document.getElementById('arcextreme-long-filter-soul');
        const curShort = selShort ? selShort.value : '';
        const curLong = selLong ? selLong.value : '';
        const optHtml = '<option value="">全部soul</option>' + souls.map(s=>`<option value="${s.name}" ${s.enabled===false?'style="color:#ef4444"':''}>${s.name}${s.enabled===false?' (禁)':''}</option>`).join('');
        if (selShort){
            selShort.innerHTML = optHtml;
            selShort.value = curShort;
        }
        if (selLong){
            selLong.innerHTML = optHtml;
            selLong.value = curLong;
        }
        // 同步到模态框下拉
        try{ syncModalSoulFilters(); }catch{}
        // 若模态框打开则同步刷新模态Souls
        if (isDataModalOpen()) refreshModalSouls().catch(()=>{});
    } catch (e) {
        renderSoulsList([]);
        log(`souls 刷新失败: ${e.message}`);
    }
}

let longPage = 1;
const longPageSize = 20;
async function refreshEvents() {
    const chatId = getContext().chatId || getCurrentChatId();
    const soulFilter = document.getElementById('arcextreme-long-filter-soul')?.value || '';
    const counterFilter = document.getElementById('arcextreme-long-filter-counter')?.value || '';
    const bucketFilter = document.getElementById('arcextreme-long-filter-bucket')?.value || '';
    try {
        const offset = (longPage-1)*longPageSize;
        const opts = { withCounters:1, limit: longPageSize, offset };
        if (soulFilter) opts.soul = soulFilter;
        if (counterFilter!=='') opts.counter = Number(counterFilter);
        if (bucketFilter) opts.bucket = bucketFilter;
        let events = await backend.listEvents(chatId, opts);
        // 客户端兜底过滤 bucket（若后端未支持）
        if (bucketFilter && events.length && events[0].time_bucket!==undefined) {
            const filtered = events.filter(e=> (e.time_bucket||'')===bucketFilter);
            // 若后端已过滤则长度不变，否则用过滤后
            // 若过滤后为空但原有数据，说明后端未过滤，仍显示过滤后（可能分页变少属正常）
            if (filtered.length!==events.length) {
                // 尝试保留分页语义：若过滤后为空且当前页>1，提示
                events = filtered;
            }
        }
        // 复用现有渲染但增强显示counter
        const ul = document.getElementById('arcextreme-events');
        if (ul) {
            if (!events.length) {
                ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-feather"></i> 暂无数据</li>';
            } else {
                ul.innerHTML = events.map(e=>{
                    const bucket = e.time_bucket||'—';
                    const labelMap = {0:'0 强拒绝',1:'1 弱拒绝',2:'2 弱接纳',3:'3 强接纳'};
                    const counterBadge = e.counter!=null ? `<span class="ax-counter-badge c${e.counter}" title="${labelMap[e.counter]||e.counter}">${labelMap[e.counter]||e.counter}</span>` : '';
                    const cNum = e.counter!=null ? Number(e.counter) : null;
                    const soulForAdjust = (Array.isArray(e.souls)&&e.souls[0]) || e.state_soul || (e.souls_str? String(e.souls_str).split(',')[0].trim() : '') || '';
                    const minusDis = cNum===0 || cNum===null ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const plusDis = cNum===3 || cNum===null ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const adjustBtns = soulForAdjust ? `<span class="ax-event__meta" style="gap:4px; align-items:center"><span class="menu_button menu_button_icon ax-mini-btn" data-act="-1" data-id="${e.id}" data-soul="${String(soulForAdjust).replace(/"/g,'&quot;')}"${minusDis} title="-1"><i class="fa-solid fa-minus"></i></span><span class="menu_button menu_button_icon ax-mini-btn" data-act="+1" data-id="${e.id}" data-soul="${String(soulForAdjust).replace(/"/g,'&quot;')}"${plusDis} title="+1"><i class="fa-solid fa-plus"></i></span><small style="opacity:.5">${soulForAdjust}</small></span>` : '';
                    const skipStuck = (e.skip!=null||e.stuck!=null) ? `<small style="opacity:.6">skip${e.skip??0} stuck${e.stuck??0}</small>` : '';
                    const soulsArr = Array.isArray(e.souls)?e.souls: (e.state_soul?[e.state_soul]:[]);
                    const soulsTags = soulsArr.map(s=>`<span class="tag tag--soul"><i class="fa-solid fa-user-tag"></i> ${s}</span>`).join('');
                    const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
                    const whyInitFull = e.why_init ? String(e.why_init) : '';
                    const whyInit = whyInitFull ? `<span class="ax-event__meta" style="color:#a78bfa; white-space:pre-wrap; word-break:break-all" title="${String(whyInitFull).replace(/"/g,'&quot;')}"><i class="fa-solid fa-lightbulb"></i> 初因:${String(whyInitFull)}</span>` : '';
                    const whyLogArr = Array.isArray(e.why_log) ? e.why_log : [];
                    const whyLog = whyLogArr.length ? `<span class="ax-event__meta" style="color:#5eead4; white-space:pre-wrap; word-break:break-all; display:block; margin-top:4px; background:rgba(94,234,212,.08); padding:4px 6px; border-radius:6px; border:1px solid rgba(94,234,212,.15)"><i class="fa-solid fa-code-branch"></i> 溯因链(${whyLogArr.length}): ${whyLogArr.map(w=>`${w.action}→${String(w.why)}`).join(' <br>→ ')}</span>` : '';
                    return `<li data-id="${e.id}"><span class="tag">${bucket}</span>${counterBadge}${adjustBtns}<span class="ax-event__text">${e.event_text}${soulsTags?`<span class="ax-event__meta">${soulsTags}</span>`:''}${skipStuck?`<span class="ax-event__meta">${skipStuck}</span>`:''}${whyInit}${whyLog}${time?`<span class="ax-event__meta"><i class="fa-regular fa-clock"></i> ${time}</span>`:''}</span><span class="score" title="删除"><i class="fa-solid fa-xmark"></i></span></li>`;
                }).join('');
                ul.querySelectorAll('li .score').forEach(node=>{
                    node.addEventListener('click', async ()=>{
                        const id = Number(node.closest('li')?.getAttribute('data-id'));
                        if(!Number.isNaN(id)){ await backend.deleteEvent(id); refreshEvents(); refreshShortPool(); if(isDataModalOpen()){ refreshModalEvents(); refreshModalShortPool(); }}
                    });
                });
                ul.querySelectorAll('[data-act]').forEach(btn=>{
                    btn.addEventListener('click', async ()=>{
                        const id = Number(btn.getAttribute('data-id'));
                        const soul = btn.getAttribute('data-soul');
                        const act = btn.getAttribute('data-act');
                        if(!id || !soul || !act) return;
                        if(btn.hasAttribute('disabled')) return;
                        const chatId2 = getContext().chatId || getCurrentChatId();
                        try{
                            btn.style.opacity='.5'; btn.style.pointerEvents='none';
                            await backend.syncShortPool(chatId2, [{event_id:id, soul, action:act, why:`用户手动${act} (${soul})`}]);
                            // 短期池全量写 last_active，今天
                            log(`手动 ${act} #${id} ${soul}`);
                            await refreshEvents(); await refreshShortPool(); if(isDataModalOpen()){ refreshModalEvents(); refreshModalShortPool(); }
                            pushToast('ok', `已${act} ${soul}#${id}`);
                        }catch(e){ pushToast('fail', `手动失败: ${e.message}`); }
                    });
                });
            }
        }
        const pageEl = document.getElementById('arcextreme-long-page');
        if (pageEl) pageEl.textContent = `${longPage} · ${events.length}条`;
        if(isDataModalOpen()){
            // 侧边栏刷新后，若模态框也在看长期库，轻量同步提示但不强制翻页
            // 不自动强制刷新以免打断模态框独立分页，仅在debug或需要时用户可手动刷新
        }
    } catch (e) {
        log(`事件刷新失败: ${e.message}`);
    }
}

async function refreshShortPool(){
    const chatId = getContext().chatId || getCurrentChatId();
    const soulFilter = document.getElementById('arcextreme-short-filter-soul')?.value || '';
    const counterFilter = document.getElementById('arcextreme-short-filter-counter')?.value || '';
    try{
        const perCap = Number(S().shortPool?.perSoulCap || 15);
        const data = await backend.getShortPool(chatId, soulFilter||undefined, perCap);
        let events = data.events || [];
        // 合并 pools 为 events 若过滤 soul
        if (counterFilter!=='') {
            events = events.filter(e=> String(e.counter ?? e.scounter) === String(counterFilter));
        }
        const ul = document.getElementById('arcextreme-shortpool');
        const bySoulDiv = document.getElementById('arcextreme-shortpool-by-soul');
        const summary = document.getElementById('arcextreme-short-summary');
        if (summary) {
            const pools = data.pools || {};
            const total = events.length;
            const soulCount = Object.keys(pools).length;
            summary.textContent = `${soulCount} souls · ${total} 事件`;
        }
        if (ul){
            if(!events.length){
                ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-layer-group"></i> 短期池为空<br><small style="opacity:.6">新事件将自动进入短期池</small></li>';
                if(bySoulDiv) bySoulDiv.innerHTML='', bySoulDiv.style.display='none';
            } else {
                if(bySoulDiv) { bySoulDiv.innerHTML=''; bySoulDiv.style.display='none'; } // 已删下面分角色卡片，上方筛选器已支持分角色
                ul.style.maxHeight='460px';
                ul.style.minHeight='200px';
                ul.innerHTML = events.map(e=>{
                    const c = e.counter ?? e.scounter;
                    const labelMap2 = {0:'0 强拒绝',1:'1 弱拒绝',2:'2 弱接纳',3:'3 强接纳'};
                    const badge = c!=null ? `<span class="ax-counter-badge c${c}" title="${labelMap2[c]||c}">${labelMap2[c]||c}</span>`:'';
                    const cNum2 = Number(c);
                    const soulForAdjust2 = e.pool_soul || e.state_soul || '';
                    const minusDis2 = cNum2===0 ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const plusDis2 = cNum2===3 ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const adjustBtns2 = soulForAdjust2 ? `<span class="ax-event__meta" style="gap:4px; align-items:center"><span class="menu_button menu_button_icon ax-mini-btn" data-act="-1" data-pool="1" data-id="${e.id}" data-soul="${String(soulForAdjust2).replace(/"/g,'&quot;')}"${minusDis2} title="-1"><i class="fa-solid fa-minus"></i></span><span class="menu_button menu_button_icon ax-mini-btn" data-act="+1" data-pool="1" data-id="${e.id}" data-soul="${String(soulForAdjust2).replace(/"/g,'&quot;')}"${plusDis2} title="+1"><i class="fa-solid fa-plus"></i></span></span>` : '';
                    const skip = e.skip!=null?`skip${e.skip}`:'';
                    const stuck = e.stuck!=null?`stuck${e.stuck}`:'';
                    const whyInitFull2 = e.why_init ? String(e.why_init) : '';
                    const whyInit = whyInitFull2 ? `<span class="ax-event__meta" style="color:#a78bfa; white-space:pre-wrap; word-break:break-all" title="${String(whyInitFull2).replace(/"/g,'&quot;')}"><i class="fa-solid fa-lightbulb"></i> ${String(whyInitFull2)}</span>` : '';
                    const whyLogArr2 = Array.isArray(e.why_log) ? e.why_log : [];
                    const whyLog = whyLogArr2.length ? `<span class="ax-event__meta" style="color:#5eead4; white-space:pre-wrap; word-break:break-all; display:block; margin-top:4px; background:rgba(94,234,212,.08); padding:4px 6px; border-radius:6px; border:1px solid rgba(94,234,212,.15)"><i class="fa-solid fa-code-branch"></i> 链(${whyLogArr2.length}): ${whyLogArr2.map(w=>`${w.action}→${String(w.why)}`).join('<br>→ ')}</span>` : '';
                    return `<li data-id="${e.id}" data-soul="${e.pool_soul||''}"><span class="tag">${e.pool_soul||''}</span>${badge}${adjustBtns2}<span class="ax-event__text">${e.event_text}<span class="ax-event__meta">${skip} ${stuck} · birth ${e.birth_ts? new Date(e.birth_ts).toLocaleDateString():''}</span>${whyInit}${whyLog}</span></li>`;
                }).join('');
                ul.querySelectorAll('[data-act]').forEach(btn=>{
                    btn.addEventListener('click', async ()=>{
                        const id = Number(btn.getAttribute('data-id'));
                        const soul = btn.getAttribute('data-soul');
                        const act = btn.getAttribute('data-act');
                        if(!id || !soul || !act) return;
                        if(btn.hasAttribute('disabled')) return;
                        const chatId3 = getContext().chatId || getCurrentChatId();
                        try{
                            btn.style.opacity='.5'; btn.style.pointerEvents='none';
                            await backend.syncShortPool(chatId3, [{event_id:id, soul, action:act, why:`用户手动${act} (${soul})`}]);
                            log(`手动 ${act} #${id} ${soul}`);
                            await refreshShortPool(); await refreshEvents(); if(isDataModalOpen()){ refreshModalShortPool(); refreshModalEvents(); }
                            pushToast('ok', `已${act} ${soul}#${id}`);
                        }catch(e){ pushToast('fail', `手动失败: ${e.message}`); }
                    });
                });
            }
        }
        if(isDataModalOpen()){
            // 侧边短期池变动后，模态框若打开则静默同步（不强刷，避免分页跳变，由用户在模态内手动刷新更稳）
        }
    } catch(e){
        log(`短期池刷新失败: ${e.message}`);
    }
}

// --------------------------------------------------------------------------- //
// 弹出式模态框：数据库大窗
// --------------------------------------------------------------------------- //
let modalLongPage = 1;
const modalLongPageSize = 20;

function isDataModalOpen(){
    const m = document.getElementById('arcextreme-data-modal');
    return m && m.style.display !== 'none';
}
function openDataModal(preferTab){
    const modal = document.getElementById('arcextreme-data-modal');
    if (!modal) return;
    // 同步当前侧边栏Tab到模态框
    let tab = preferTab || null;
    if (!tab) {
        const active = document.querySelector('#arcextreme-data-tabs .ax-tab.is-active');
        tab = active ? active.getAttribute('data-tab') : 'souls';
    }
    // 切换模态Tab
    modal.querySelectorAll('#arcextreme-modal-tabs .ax-tab').forEach(x=> x.classList.toggle('is-active', x.getAttribute('data-tab')===tab));
    modal.querySelectorAll('.ax-modal__body .ax-tab-panel').forEach(p=> p.classList.toggle('is-active', p.getAttribute('data-panel')===tab));
    // 显示
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden','false');
    document.body.style.overflow = 'hidden';
    // 同步下拉选项（souls列表）
    try{ syncModalSoulFilters(); }catch{}
    // 刷新对应内容
    if(tab==='souls') refreshModalSouls();
    else if(tab==='short') refreshModalShortPool();
    else if(tab==='long') refreshModalEvents();
    else if(tab==='sublimated') refreshModalSublimated();
    else { refreshModalSouls(); refreshModalShortPool(); }
    log(`数据库大窗已打开 · ${tab}`);
}
function closeDataModal(){
    const modal = document.getElementById('arcextreme-data-modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden','true');
    document.body.style.overflow = '';
    log('数据库大窗已关闭');
}
function syncModalSoulFilters(){
    // 将 Souls 列表同步到模态框下拉（保留已选值）
    const selShort = document.getElementById('arcextreme-short-filter-soul');
    const selModalShort = document.getElementById('arcextreme-modal-short-filter-soul');
    const selLong = document.getElementById('arcextreme-long-filter-soul');
    const selModalLong = document.getElementById('arcextreme-modal-long-filter-soul');
    if (selShort && selModalShort) {
        const cur = selModalShort.value;
        selModalShort.innerHTML = selShort.innerHTML;
        // 若原值仍存在则保留
        if ([...selModalShort.options].some(o=>o.value===cur)) selModalShort.value = cur;
    }
    if (selLong && selModalLong) {
        const cur2 = selModalLong.value;
        selModalLong.innerHTML = selLong.innerHTML;
        if ([...selModalLong.options].some(o=>o.value===cur2)) selModalLong.value = cur2;
    }
}
async function refreshModalSouls(){
    try{
        const full = await backend.listSoulsFull().catch(async ()=>({souls: await backend.listSouls(), enabled_map:{}}));
        const souls = full.souls || [];
        const ul = document.getElementById('arcextreme-modal-souls');
        if (!ul) return;
        if (!souls.length) ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-ghost"></i> 暂无 souls</li>';
        else ul.innerHTML = souls.map(s=> {
            const en = s.enabled!==false;
            return `<li style="${en?'':'opacity:.5; background:rgba(239,68,68,.06)'}"><span class="tag tag--soul"><i class="fa-solid fa-user-tag"></i> ${s.name}</span><span class="ax-event__text">${s.filename||''}<small class="ax-event__meta" style="opacity:.5">${s.name} · ${en?'已启用':'已禁用'}</small></span>${en?'<small style="color:#10b981">●</small>':'<small style="color:#ef4444">○</small>'}</li>`;
        }).join('');
        // 同时同步下拉
        syncModalSoulFilters();
    }catch(e){ const ul=document.getElementById('arcextreme-modal-souls'); if(ul) ul.innerHTML=`<li class="ax-empty">加载失败: ${e.message}</li>`; }
}
async function refreshModalShortPool(){
    const chatId = getContext().chatId || getCurrentChatId();
    const soulFilter = document.getElementById('arcextreme-modal-short-filter-soul')?.value || '';
    const counterFilter = document.getElementById('arcextreme-modal-short-filter-counter')?.value || '';
    try{
        const perCapM = Number(S().shortPool?.perSoulCap || 15);
        const data = await backend.getShortPool(chatId, soulFilter||undefined, perCapM);
        let events = data.events || [];
        if (counterFilter!=='') events = events.filter(e=> String(e.counter ?? e.scounter) === String(counterFilter));
        const ul = document.getElementById('arcextreme-modal-shortpool');
        const summary = document.getElementById('arcextreme-modal-short-summary');
        if (summary){
            const pools = data.pools||{};
            summary.textContent = `${Object.keys(pools).length} souls · ${events.length} 事件`;
        }
        if(!ul) return;
        if(!events.length){
            ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-layer-group"></i> 短期池为空<br><small style="opacity:.6">新事件将自动进入短期池</small></li>';
        } else {
            ul.innerHTML = events.map(e=>{
                const c = e.counter ?? e.scounter;
                const labelMap2 = {0:'0 强拒绝',1:'1 弱拒绝',2:'2 弱接纳',3:'3 强接纳'};
                const badge = c!=null ? `<span class="ax-counter-badge c${c}" title="${labelMap2[c]||c}">${labelMap2[c]||c}</span>`:'';
                const cNum2 = Number(c);
                const soulForAdjust2 = e.pool_soul || e.state_soul || '';
                const minusDis2 = cNum2===0 ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                const plusDis2 = cNum2===3 ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                const adjustBtns2 = soulForAdjust2 ? `<span class="ax-event__meta" style="gap:4px; align-items:center"><span class="menu_button menu_button_icon ax-mini-btn" data-act="-1" data-pool="1" data-id="${e.id}" data-soul="${String(soulForAdjust2).replace(/"/g,'&quot;')}"${minusDis2} title="-1"><i class="fa-solid fa-minus"></i></span><span class="menu_button menu_button_icon ax-mini-btn" data-act="+1" data-pool="1" data-id="${e.id}" data-soul="${String(soulForAdjust2).replace(/"/g,'&quot;')}"${plusDis2} title="+1"><i class="fa-solid fa-plus"></i></span></span>` : '';
                const skip = e.skip!=null?`skip${e.skip}`:'';
                const stuck = e.stuck!=null?`stuck${e.stuck}`:'';
                const whyInitFull2 = e.why_init ? String(e.why_init) : '';
                const whyInit = whyInitFull2 ? `<span class="ax-event__meta" style="color:#a78bfa; white-space:pre-wrap; word-break:break-all" title="${String(whyInitFull2).replace(/"/g,'&quot;')}"><i class="fa-solid fa-lightbulb"></i> ${String(whyInitFull2)}</span>` : '';
                const whyLogArr2 = Array.isArray(e.why_log) ? e.why_log : [];
                const whyLog = whyLogArr2.length ? `<span class="ax-event__meta" style="color:#5eead4; white-space:pre-wrap; word-break:break-all; display:block; margin-top:4px; background:rgba(94,234,212,.08); padding:4px 6px; border-radius:6px; border:1px solid rgba(94,234,212,.15)"><i class="fa-solid fa-code-branch"></i> 链(${whyLogArr2.length}): ${whyLogArr2.map(w=>`${w.action}→${String(w.why)}`).join('<br>→ ')}</span>` : '';
                return `<li data-id="${e.id}" data-soul="${e.pool_soul||''}"><span class="tag">${e.pool_soul||''}</span>${badge}${adjustBtns2}<span class="ax-event__text">${e.event_text}<span class="ax-event__meta">${skip} ${stuck} · birth ${e.birth_ts? new Date(e.birth_ts).toLocaleDateString():''}</span>${whyInit}${whyLog}</span></li>`;
            }).join('');
            ul.querySelectorAll('[data-act]').forEach(btn=>{
                btn.addEventListener('click', async ()=>{
                    const id = Number(btn.getAttribute('data-id'));
                    const soul = btn.getAttribute('data-soul');
                    const act = btn.getAttribute('data-act');
                    if(!id || !soul || !act) return;
                    if(btn.hasAttribute('disabled')) return;
                    const chatId3 = getContext().chatId || getCurrentChatId();
                    try{
                        btn.style.opacity='.5'; btn.style.pointerEvents='none';
                        await backend.syncShortPool(chatId3, [{event_id:id, soul, action:act, why:`用户手动${act} (${soul})`}]);
                        log(`[大窗]手动 ${act} #${id} ${soul}`);
                        await refreshModalShortPool(); await refreshShortPool(); await refreshModalEvents(); await refreshEvents();
                        pushToast('ok', `已${act} ${soul}#${id}`);
                    }catch(e){ pushToast('fail', `手动失败: ${e.message}`); }
                });
            });
        }
    }catch(e){ log(`[大窗]短期池刷新失败: ${e.message}`); }
}
async function refreshModalEvents(){
    const chatId = getContext().chatId || getCurrentChatId();
    const soulFilter = document.getElementById('arcextreme-modal-long-filter-soul')?.value || '';
    const counterFilter = document.getElementById('arcextreme-modal-long-filter-counter')?.value || '';
    const bucketFilter = document.getElementById('arcextreme-modal-long-filter-bucket')?.value || '';
    try{
        const offset = (modalLongPage-1)*modalLongPageSize;
        const opts = { withCounters:1, limit: modalLongPageSize, offset };
        if (soulFilter) opts.soul = soulFilter;
        if (counterFilter!=='') opts.counter = Number(counterFilter);
        if (bucketFilter) opts.bucket = bucketFilter;
        let events = await backend.listEvents(chatId, opts);
        if (bucketFilter && events.length && events[0].time_bucket!==undefined) {
            const filtered = events.filter(e=> (e.time_bucket||'')===bucketFilter);
            if (filtered.length!==events.length) events = filtered;
        }
        const ul = document.getElementById('arcextreme-modal-events');
        if (ul){
            if (!events.length) {
                ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-feather"></i> 暂无数据</li>';
            } else {
                ul.innerHTML = events.map(e=>{
                    const bucket = e.time_bucket||'—';
                    const labelMap = {0:'0 强拒绝',1:'1 弱拒绝',2:'2 弱接纳',3:'3 强接纳'};
                    const counterBadge = e.counter!=null ? `<span class="ax-counter-badge c${e.counter}" title="${labelMap[e.counter]||e.counter}">${labelMap[e.counter]||e.counter}</span>` : '';
                    const cNum = e.counter!=null ? Number(e.counter) : null;
                    const soulForAdjust = (Array.isArray(e.souls)&&e.souls[0]) || e.state_soul || (e.souls_str? String(e.souls_str).split(',')[0].trim() : '') || '';
                    const minusDis = cNum===0 || cNum===null ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const plusDis = cNum===3 || cNum===null ? ' disabled style="opacity:.35;pointer-events:none"' : '';
                    const adjustBtns = soulForAdjust ? `<span class="ax-event__meta" style="gap:4px; align-items:center"><span class="menu_button menu_button_icon ax-mini-btn" data-act="-1" data-id="${e.id}" data-soul="${String(soulForAdjust).replace(/"/g,'&quot;')}"${minusDis} title="-1"><i class="fa-solid fa-minus"></i></span><span class="menu_button menu_button_icon ax-mini-btn" data-act="+1" data-id="${e.id}" data-soul="${String(soulForAdjust).replace(/"/g,'&quot;')}"${plusDis} title="+1"><i class="fa-solid fa-plus"></i></span><small style="opacity:.5">${soulForAdjust}</small></span>` : '';
                    const skipStuck = (e.skip!=null||e.stuck!=null) ? `<small style="opacity:.6">skip${e.skip??0} stuck${e.stuck??0}</small>` : '';
                    const soulsArr = Array.isArray(e.souls)?e.souls: (e.state_soul?[e.state_soul]:[]);
                    const soulsTags = soulsArr.map(s=>`<span class="tag tag--soul"><i class="fa-solid fa-user-tag"></i> ${s}</span>`).join('');
                    const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
                    const whyInitFull = e.why_init ? String(e.why_init) : '';
                    const whyInit = whyInitFull ? `<span class="ax-event__meta" style="color:#a78bfa; white-space:pre-wrap; word-break:break-all" title="${String(whyInitFull).replace(/"/g,'&quot;')}"><i class="fa-solid fa-lightbulb"></i> 初因:${String(whyInitFull)}</span>` : '';
                    const whyLogArr = Array.isArray(e.why_log) ? e.why_log : [];
                    const whyLog = whyLogArr.length ? `<span class="ax-event__meta" style="color:#5eead4; white-space:pre-wrap; word-break:break-all; display:block; margin-top:4px; background:rgba(94,234,212,.08); padding:4px 6px; border-radius:6px; border:1px solid rgba(94,234,212,.15)"><i class="fa-solid fa-code-branch"></i> 溯因链(${whyLogArr.length}): ${whyLogArr.map(w=>`${w.action}→${String(w.why)}`).join(' <br>→ ')}</span>` : '';
                    return `<li data-id="${e.id}"><span class="tag">${bucket}</span>${counterBadge}${adjustBtns}<span class="ax-event__text">${e.event_text}${soulsTags?`<span class="ax-event__meta">${soulsTags}</span>`:''}${skipStuck?`<span class="ax-event__meta">${skipStuck}</span>`:''}${whyInit}${whyLog}${time?`<span class="ax-event__meta"><i class="fa-regular fa-clock"></i> ${time}</span>`:''}</span><span class="score" title="删除"><i class="fa-solid fa-xmark"></i></span></li>`;
                }).join('');
                ul.querySelectorAll('li .score').forEach(node=>{
                    node.addEventListener('click', async ()=>{
                        const id = Number(node.closest('li')?.getAttribute('data-id'));
                        if(!Number.isNaN(id)){ await backend.deleteEvent(id); refreshModalEvents(); refreshEvents(); refreshModalShortPool(); refreshShortPool();}
                    });
                });
                ul.querySelectorAll('[data-act]').forEach(btn=>{
                    btn.addEventListener('click', async ()=>{
                        const id = Number(btn.getAttribute('data-id'));
                        const soul = btn.getAttribute('data-soul');
                        const act = btn.getAttribute('data-act');
                        if(!id || !soul || !act) return;
                        if(btn.hasAttribute('disabled')) return;
                        const chatId2 = getContext().chatId || getCurrentChatId();
                        try{
                            btn.style.opacity='.5'; btn.style.pointerEvents='none';
                            await backend.syncShortPool(chatId2, [{event_id:id, soul, action:act, why:`用户手动${act} (${soul})`}]);
                            log(`[大窗]手动 ${act} #${id} ${soul}`);
                            await refreshModalEvents(); await refreshEvents(); await refreshModalShortPool(); await refreshShortPool();
                            pushToast('ok', `已${act} ${soul}#${id}`);
                        }catch(e){ pushToast('fail', `手动失败: ${e.message}`); }
                    });
                });
            }
        }
        const pageEl = document.getElementById('arcextreme-modal-long-page');
        if (pageEl) pageEl.textContent = `${modalLongPage} · ${events.length}条`;
    }catch(e){ log(`[大窗]事件刷新失败: ${e.message}`); }
}
async function refreshModalSublimated(){
    const chatId = getContext().chatId || getCurrentChatId();
    try{
        const items = await backend.listSublimated(chatId);
        const ul = document.getElementById('arcextreme-modal-sublimated');
        if(!ul) return;
        if(!items.length){
            ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-fire"></i> 暂无升华<br><small style="opacity:.6">stuck≥阈值且0/3强态的记忆将自动升华到soul</small></li>';
        } else {
            ul.innerHTML = items.map(it=>`
                <li>
                    <span class="ax-counter-badge c${it.counter??3}">${it.counter??''}</span>
                    <span class="ax-event__text"><b>${it.title||it.soul}</b> — ${it.content.slice(0,140)}<span class="ax-event__meta"><i class="fa-solid fa-user"></i> ${it.soul} · ${new Date(it.created_at).toLocaleString()}</span></span>
                </li>
            `).join('');
        }
    }catch(e){ log(`[大窗]升华刷新失败: ${e.message}`); }
}
function setupDataModal(){
    const btn = document.getElementById('arcextreme-data-popout');
    if (btn){
        btn.addEventListener('click', (e)=>{
            e.preventDefault(); e.stopPropagation();
            const drawer = document.getElementById('arcextreme-data-drawer');
            if (drawer && !drawer.classList.contains('open')) drawer.classList.add('open');
            openDataModal();
        });
    }
    const backdrop = document.getElementById('arcextreme-modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDataModal);
    const closeBtn = document.getElementById('arcextreme-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDataModal);
    document.addEventListener('keydown', (e)=>{
        if (e.key==='Escape' && isDataModalOpen()) { e.preventDefault(); closeDataModal(); }
    });
    // 模态内Tabs
    document.querySelectorAll('#arcextreme-modal-tabs .ax-tab').forEach(tab=>{
        tab.addEventListener('click', ()=>{
            const t = tab.getAttribute('data-tab');
            document.querySelectorAll('#arcextreme-modal-tabs .ax-tab').forEach(x=>x.classList.toggle('is-active', x===tab));
            document.querySelectorAll('.ax-modal__body .ax-tab-panel').forEach(p=> p.classList.toggle('is-active', p.getAttribute('data-panel')===t));
            if(t==='souls') refreshModalSouls();
            if(t==='short') refreshModalShortPool();
            if(t==='long') refreshModalEvents();
            if(t==='sublimated') refreshModalSublimated();
        });
    });
    // 模态内筛选与分页
    document.getElementById('arcextreme-modal-short-filter-soul')?.addEventListener('change', refreshModalShortPool);
    document.getElementById('arcextreme-modal-short-filter-counter')?.addEventListener('change', refreshModalShortPool);
    document.getElementById('arcextreme-modal-long-filter-soul')?.addEventListener('change', ()=>{ modalLongPage=1; refreshModalEvents(); });
    document.getElementById('arcextreme-modal-long-filter-counter')?.addEventListener('change', ()=>{ modalLongPage=1; refreshModalEvents(); });
    document.getElementById('arcextreme-modal-long-filter-bucket')?.addEventListener('change', ()=>{ modalLongPage=1; refreshModalEvents(); });
    document.getElementById('arcextreme-modal-long-prev')?.addEventListener('click', ()=>{ if(modalLongPage>1){ modalLongPage--; refreshModalEvents(); }});
    document.getElementById('arcextreme-modal-long-next')?.addEventListener('click', ()=>{ modalLongPage++; refreshModalEvents(); });
    // 模态内刷新按钮
    document.getElementById('arcextreme-modal-enforce')?.addEventListener('click', async ()=>{
        const chatId = getContext().chatId || getCurrentChatId();
        const cap = Number(S().shortPool?.perSoulCap||15);
        try{
            const r = await backend.enforceShortPool(chatId, cap);
            log(`[大窗]校正: ${cap}/soul before=${JSON.stringify(r.before)} after=${JSON.stringify(r.after)}`);
            pushToast('ok', `大窗已校正 ${cap}/soul`);
            refreshModalShortPool(); refreshShortPool();
        }catch(e){ pushToast('fail', `校正失败: ${e.message}`); }
    });
    document.getElementById('arcextreme-modal-refresh-souls')?.addEventListener('click', refreshModalSouls);
    document.getElementById('arcextreme-modal-refresh-short')?.addEventListener('click', refreshModalShortPool);
    document.getElementById('arcextreme-modal-refresh-events')?.addEventListener('click', ()=>{ refreshModalEvents(); });
    document.getElementById('arcextreme-modal-refresh-sublimated')?.addEventListener('click', refreshModalSublimated);
    document.getElementById('arcextreme-modal-refresh-all')?.addEventListener('click', async ()=>{
        await refreshModalSouls(); await refreshModalShortPool(); await refreshModalEvents(); await refreshModalSublimated();
        pushToast('ok','大窗已刷新');
    });
    document.getElementById('arcextreme-modal-clear')?.addEventListener('click', async ()=>{
        if(!confirm('确认清空当前聊天的长期库？此操作不可撤销。')) return;
        const chatId = getContext().chatId || getCurrentChatId();
        try{ await backend.clearEvents(chatId); pushToast('ok','已清空'); refreshModalEvents(); refreshEvents(); refreshModalShortPool(); refreshShortPool(); }catch(e){ pushToast('fail', e.message); }
    });
}

async function refreshSublimated(){
    const chatId = getContext().chatId || getCurrentChatId();
    try{
        const items = await backend.listSublimated(chatId);
        const ul = document.getElementById('arcextreme-sublimated');
        if(!ul) return;
        if(!items.length){
            ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-fire"></i> 暂无升华<br><small style="opacity:.6">stuck≥阈值且0/3强态的记忆将自动升华到soul</small></li>';
        } else {
            ul.innerHTML = items.map(it=>`
                <li>
                    <span class="ax-counter-badge c${it.counter??3}">${it.counter??''}</span>
                    <span class="ax-event__text"><b>${it.title||it.soul}</b> — ${it.content.slice(0,120)}<span class="ax-event__meta"><i class="fa-solid fa-user"></i> ${it.soul} · ${new Date(it.created_at).toLocaleString()}</span></span>
                </li>
            `).join('');
        }
    }catch(e){ log(`升华刷新失败: ${e.message}`); }
}

// ---------------- Chat 迁移 & 备份 ----------------
async function refreshChats() {
    const tbody = document.getElementById('arcextreme-chats-tbody');
    const summary = document.getElementById('arcextreme-chats-summary');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; opacity:.6; padding:12px"><i class="fa-solid fa-spinner fa-spin"></i> 载入中…</td></tr>`;
    try {
        const data = await backend.listChats();
        const chats = data.chats || [];
        const curId = getContext().chatId || getCurrentChatId();
        if (summary) summary.textContent = `${chats.length} 个聊天`;
        if (!chats.length) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; opacity:.6; padding:12px"><i class="fa-solid fa-inbox"></i> 暂无聊天数据</td></tr>`;
            return;
        }
        tbody.innerHTML = chats.map(c=> {
            const shortId = c.chat_id.length>28 ? c.chat_id.slice(0,12)+'…'+c.chat_id.slice(-10) : c.chat_id;
            const curBadge = c.chat_id===curId ? '<span class="ax-badge" style="background:#10b981;color:#fff;font-size:10px">当前</span>':'' ;
            const soulsTxt = (c.souls||[]).slice(0,3).join(',') + ((c.souls||[]).length>3?',…':'');
            const ts = c.max_ts ? new Date(c.max_ts).toLocaleString() : '—';
            return `<tr data-chat="${c.chat_id.replace(/"/g,'&quot;')}" style="${c.chat_id===curId?'background:rgba(16,185,129,.08)':''}">
                <td><input type="radio" name="arcextreme-chat-radio" value="${c.chat_id.replace(/"/g,'&quot;')}"></td>
                <td title="${c.chat_id.replace(/"/g,'&quot;')}">${shortId} ${curBadge}</td>
                <td>${c.events}</td>
                <td>${c.short_pool}</td>
                <td>${c.sublimated}</td>
                <td title="${(c.souls||[]).join(', ')}">${soulsTxt||'—'}</td>
                <td style="font-size:11px; opacity:.7">${ts}</td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('input[name="arcextreme-chat-radio"]').forEach(r=>{
            r.addEventListener('change', ()=>{
                const v = r.value;
                const src = document.getElementById('arcextreme-migrate-source');
                if (src) src.value = v;
            });
        });
        tbody.querySelectorAll('tr[data-chat]').forEach(tr=>{
            tr.style.cursor='pointer';
            tr.addEventListener('click', (e)=>{
                if (e.target.tagName==='INPUT') return;
                const cid = tr.getAttribute('data-chat');
                const radio = tr.querySelector('input[type="radio"]');
                if (radio) radio.checked=true;
                const src = document.getElementById('arcextreme-migrate-source');
                if (src) src.value=cid;
            });
        });
    } catch(e){
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#ef4444; padding:12px">载入失败: ${e.message}</td></tr>`;
        log(`聊天清单刷新失败: ${e.message}`);
    }
}
async function doMigrate(mode) {
    const src = document.getElementById('arcextreme-migrate-source')?.value?.trim();
    let dst = document.getElementById('arcextreme-migrate-target')?.value?.trim();
    if (!dst) dst = getContext().chatId || getCurrentChatId();
    if (!src) { pushToast('warn','请选择源 chat_id'); return; }
    if (!dst) { pushToast('warn','目标 chat_id 为空'); return; }
    const overwrite = !!document.getElementById('arcextreme-migrate-overwrite')?.checked;
    const radios = document.querySelectorAll('input[name="arcextreme-migrate-mode"]');
    let radioMode = mode;
    if (!radioMode) {
        const checked = [...radios].find(r=>r.checked);
        radioMode = checked ? checked.value : 'copy';
    }
    if (radioMode==='move' && !confirm(`确认【移动】 ${src} → ${dst} ？\n源将被删除，此操作不可撤销。`)) return;
    if (overwrite && !confirm(`确认覆盖目标 ${dst} ？目标现有数据将被先清空`)) return;
    const status = document.getElementById('arcextreme-migrate-status');
    if (status) status.textContent = '迁移中…';
    try{
        const res = await backend.migrateChat({source_chat_id: src, target_chat_id: dst, mode: radioMode, overwrite, include_events:true, include_state:true, include_pool:true, include_sublimated:true});
        const s = res.stats || {};
        log(`迁移完成 ${radioMode} ${src}→${dst} 事件${s.events} 状态${s.state} 池${s.pool} 升华${s.sublimated} FAISS+${s.faiss_added||0}`);
        pushToast('ok', `迁移完成 ${radioMode} 事件${s.events}`);
        if (status) status.textContent = `完成 ${radioMode} 事件${s.events} 状态${s.state} 池${s.pool}`;
        refreshChats(); refreshEvents(); refreshShortPool(); refreshSublimated();
        try{ await backend.reload(); }catch{}
    }catch(e){
        log(`迁移失败: ${e.message}`);
        pushToast('fail', `迁移失败: ${e.message}`);
        if (status) status.textContent = `失败: ${e.message}`;
    }
}
async function doExportChat(){
    let cid = document.getElementById('arcextreme-export-chat')?.value?.trim();
    if (!cid) cid = getContext().chatId || getCurrentChatId();
    if (!cid) { pushToast('warn','无 chat_id'); return; }
    try{
        const data = await backend.exportChat(cid);
        const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href=url; a.download=`arcextreme-${cid.slice(0,12)}-${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        log(`已导出 ${cid} 事件${data.counts.events} 池${data.counts.pool}`);
        pushToast('ok', `已导出 ${data.counts.events} 事件`);
    }catch(e){ pushToast('fail', `导出失败: ${e.message}`); }
}
async function doImportChat(){
    const fileEl = document.getElementById('arcextreme-import-file');
    const targetEl = document.getElementById('arcextreme-import-target');
    const overwrite = !!document.getElementById('arcextreme-import-overwrite')?.checked;
    const file = fileEl?.files?.[0];
    if (!file) { pushToast('warn','请选择 JSON 文件'); return; }
    let target = targetEl?.value?.trim();
    if (!target) target = getContext().chatId || getCurrentChatId();
    if (!target) { pushToast('warn','目标 chat_id 为空'); return; }
    try{
        const text = await file.text();
        const data = JSON.parse(text);
        const payload = {chat_id: target, overwrite, events: data.events||[], states: data.states||[], pools: data.pools||[], sublimated: data.sublimated|| data.sub||[]};
        if (!payload.events.length && !payload.sublimated.length) { pushToast('warn','文件无有效数据'); return; }
        if (overwrite && !confirm(`覆盖导入到 ${target} ？目标将被先清空`)) return;
        const res = await backend.importChat(payload);
        log(`导入完成 → ${target} 事件${res.stats.events} 状态${res.stats.state} 池${res.stats.pool} 升华${res.stats.sublimated}`);
        pushToast('ok', `导入完成 事件${res.stats.events}`);
        refreshChats(); refreshEvents(); refreshShortPool(); refreshSublimated();
        try{ await backend.reload(); }catch{}
    }catch(e){ pushToast('fail', `导入失败: ${e.message}`); log(`导入失败: ${e.message}`); }
}
function setupMigrateUI(){
    document.getElementById('arcextreme-refresh-chats')?.addEventListener('click', refreshChats);
    document.getElementById('arcextreme-migrate-target-current')?.addEventListener('click', ()=>{
        const cur = getContext().chatId || getCurrentChatId();
        const el = document.getElementById('arcextreme-migrate-target');
        if (el) el.value = cur;
        pushToast('info', `已填入当前: ${cur.slice(0,16)}…`);
    });
    document.getElementById('arcextreme-migrate-do-copy')?.addEventListener('click', ()=> doMigrate('copy'));
    document.getElementById('arcextreme-migrate-do-move')?.addEventListener('click', ()=> doMigrate('move'));
    document.getElementById('arcextreme-chats-select-all')?.addEventListener('change', (e)=>{
        // radio 单选，select-all 仅提示
        if (e.target.checked) pushToast('info','聊天为单选迁移，请点行选择源');
        e.target.checked=false;
    });
    document.getElementById('arcextreme-chats-delete-tool')?.addEventListener('click', async ()=>{
        const src = document.getElementById('arcextreme-migrate-source')?.value?.trim();
        if (!src) { pushToast('warn','先选源 chat_id'); return; }
        const inp = prompt(`单做工具-删除聊天\n输入 DELETE 确认删除\n${src}`);
        if (inp!=='DELETE') { pushToast('info','已取消'); return; }
        try{ await backend.deleteChat(src); log(`已删除孤儿聊天 ${src}`); pushToast('ok','已删除'); refreshChats(); }catch(e){ pushToast('fail', e.message); }
    });
    document.getElementById('arcextreme-export-do')?.addEventListener('click', doExportChat);
    document.getElementById('arcextreme-import-do')?.addEventListener('click', doImportChat);
    // souls 批量
    document.getElementById('arcextreme-souls-enable-all')?.addEventListener('click', async ()=>{
        try{
            const full = await backend.listSoulsFull();
            const m={}; for(const so of full.souls) m[so.name]=true;
            await backend.setSoulsEnabled(m); pushToast('ok','全部已启用'); refreshSouls();
        }catch(e){ pushToast('fail', e.message); }
    });
    document.getElementById('arcextreme-souls-disable-all')?.addEventListener('click', async ()=>{
        if(!confirm('确认禁用全部 Souls？将暂停所有记忆注入')) return;
        try{
            const full = await backend.listSoulsFull();
            const m={}; for(const so of full.souls) m[so.name]=false;
            await backend.setSoulsEnabled(m); pushToast('warn','全部已禁用'); refreshSouls();
        }catch(e){ pushToast('fail', e.message); }
    });
}

async function refreshStatus() {
    const dot = document.getElementById('arcextreme-status-dot');
    if (dot) { dot.className = 'ax-status__dot is-warn'; document.getElementById('arcextreme-status-label').textContent = '检测中…'; }
    try {
        const st = await backend.status();
        log(`后端状态: OK，向量数=${st.faiss_count} 短期池=${st.short_pool_count||0} 升华=${st.sublimated_count||0}`);
        setStatus('ok', `已连接 · ${st.faiss_count}向量 · 池${st.short_pool_count||0}`);
    } catch (e) {
        log(`后端不可达: ${e.message}`);
        setStatus('err', '未连接');
        toastr?.error('ArcEXtreme 后端不可达，请启动 ArcEXtreme-BackEnd', 'ArcEXtreme');
    }
}

function populateForm() {
    const s = S();
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

    setCheck('arcextreme-enabled', s.enabled);
    setCheck('arcextreme-debug', s.debug);
    setVal('arcextreme-pipeline-mode', s.pipelineMode === 'full' ? 'full' : 'fast');
    setVal('arcextreme-backend', s.backendUrl);

    setVal('arcextreme-extract-url', s.extractLLM.apiUrl);
    setVal('arcextreme-extract-key', s.extractLLM.apiKey);
    setVal('arcextreme-extract-model', s.extractLLM.model);
    setVal('arcextreme-extract-temp', s.extractLLM.temperature);
    setVal('arcextreme-extract-temp-num', s.extractLLM.temperature);
    setVal('arcextreme-extract-maxtokens', s.extractLLM.maxTokens);
    setVal('arcextreme-extract-timeout', s.extractLLM.timeout);
    setVal('arcextreme-extract-reasoning', s.extractLLM.reasoningEffort);
    setVal('arcextreme-extract-reasoning-tokens', s.extractLLM.reasoningTokens);
    setCheck('arcextreme-extract-sendtemp', s.extractLLM.sendTempWithReasoning);

    setCheck('arcextreme-route-useextract', s.routeLLM.useExtract);
    setVal('arcextreme-route-url', s.routeLLM.apiUrl);
    setVal('arcextreme-route-key', s.routeLLM.apiKey);
    setVal('arcextreme-route-model', s.routeLLM.model);
    setVal('arcextreme-route-temp', s.routeLLM.temperature);
    setVal('arcextreme-route-temp-num', s.routeLLM.temperature);
    setVal('arcextreme-route-maxtokens', s.routeLLM.maxTokens);
    setVal('arcextreme-route-timeout', s.routeLLM.timeout);
    setVal('arcextreme-route-reasoning', s.routeLLM.reasoningEffort);
    setVal('arcextreme-route-reasoning-tokens', s.routeLLM.reasoningTokens);
    setCheck('arcextreme-route-sendtemp', s.routeLLM.sendTempWithReasoning);

    const ev = document.getElementById('arcextreme-extract-temp-val'); if (ev) ev.textContent = String(s.extractLLM.temperature ?? '');
    const rv = document.getElementById('arcextreme-route-temp-val'); if (rv) rv.textContent = String(s.routeLLM.temperature ?? '');

    // subAgent
    setCheck('arcextreme-subagent-useextract', s.subAgentLLM.useExtract);
    setVal('arcextreme-subagent-url', s.subAgentLLM.apiUrl);
    setVal('arcextreme-subagent-key', s.subAgentLLM.apiKey);
    setVal('arcextreme-subagent-model', s.subAgentLLM.model);
    setVal('arcextreme-subagent-temp', s.subAgentLLM.temperature);
    setVal('arcextreme-subagent-temp-num', s.subAgentLLM.temperature);
    setVal('arcextreme-subagent-maxtokens', s.subAgentLLM.maxTokens);
    setVal('arcextreme-subagent-timeout', s.subAgentLLM.timeout);
    setVal('arcextreme-subagent-reasoning', s.subAgentLLM.reasoningEffort);
    setVal('arcextreme-subagent-reasoning-tokens', s.subAgentLLM.reasoningTokens);
    setCheck('arcextreme-subagent-sendtemp', s.subAgentLLM.sendTempWithReasoning);
    const sv = document.getElementById('arcextreme-subagent-temp-val'); if(sv) sv.textContent = String(s.subAgentLLM.temperature??'');

    // sublimation
    setCheck('arcextreme-sublimate-enabled', s.sublimation.enabled);
    setCheck('arcextreme-sublimate-useextract', s.sublimationLLM.useExtract);
    setVal('arcextreme-sublimate-url', s.sublimationLLM.apiUrl);
    setVal('arcextreme-sublimate-key', s.sublimationLLM.apiKey);
    setVal('arcextreme-sublimate-model', s.sublimationLLM.model);
    setVal('arcextreme-sublimate-temp', s.sublimationLLM.temperature);
    setVal('arcextreme-sublimate-temp-num', s.sublimationLLM.temperature);
    setVal('arcextreme-sublimate-maxtokens', s.sublimationLLM.maxTokens);
    setVal('arcextreme-sublimate-timeout', s.sublimationLLM.timeout);
    setVal('arcextreme-sublimate-reasoning', s.sublimationLLM.reasoningEffort);
    setVal('arcextreme-sublimate-reasoning-tokens', s.sublimationLLM.reasoningTokens);
    setCheck('arcextreme-sublimate-sendtemp', s.sublimationLLM.sendTempWithReasoning);
    const mv = document.getElementById('arcextreme-sublimate-temp-val'); if(mv) mv.textContent = String(s.sublimationLLM.temperature??'');

    setVal('arcextreme-embed-source', s.embedding.source);
    setVal('arcextreme-embed-url', s.embedding.apiUrl);
    setVal('arcextreme-embed-key', s.embedding.apiKey);
    setVal('arcextreme-embed-model', s.embedding.model);

    setCheck('arcextreme-rerank-enabled', s.rerank.enabled);
    setVal('arcextreme-rerank-url', s.rerank.apiUrl);
    setVal('arcextreme-rerank-key', s.rerank.apiKey);
    setVal('arcextreme-rerank-model', s.rerank.model);
    setVal('arcextreme-rerank-timeout', s.rerank.timeout ?? 40);

    setVal('arcextreme-inject-position', s.inject.position);
    setVal('arcextreme-inject-depth', s.inject.depth);
    setCheck('arcextreme-inject-wi', s.inject.include_wi);
    setVal('arcextreme-inject-role', s.inject.depth_role);
    setVal('arcextreme-recentdays', s.recentDays);

    // shortPool
    setVal('arcextreme-short-cap', s.shortPool.perSoulCap);
    setVal('arcextreme-short-skip', s.shortPool.skipThreshold);
    setVal('arcextreme-short-stuck', s.shortPool.stuckThreshold);
    setVal('arcextreme-subagent-mode', s.shortPool.subAgentMode);
    setCheck('arcextreme-subagent-collapse', s.shortPool.subAgentCollapseTrace);
    setCheck('arcextreme-weight-enabled', s.shortPool.weight.enabled);
    setVal('arcextreme-weight-m0', s.shortPool.weight.m0);
    setVal('arcextreme-weight-m1', s.shortPool.weight.m1);
    setVal('arcextreme-weight-m2', s.shortPool.weight.m2);
    setVal('arcextreme-weight-m3', s.shortPool.weight.m3);
    setCheck('arcextreme-retrieved-subagent-enabled', s.shortPool.retrievedSubAgent.enabled);
    setVal('arcextreme-retrieved-subagent-max', s.shortPool.retrievedSubAgent.maxItems);
    setCheck('arcextreme-retrieved-subagent-trad', s.shortPool.retrievedSubAgent.includeTraditional);

    setVal('arcextreme-sublimate-position', s.sublimation.inject.position);
    setVal('arcextreme-sublimate-depth', s.sublimation.inject.depth);
    setCheck('arcextreme-sublimate-wi', s.sublimation.inject.include_wi);
    setVal('arcextreme-sublimate-role', s.sublimation.inject.depth_role);

    setVal('arcextreme-prompt-extract-sys', s.prompts?.extractSys ?? DEFAULT_EXTRACT_SYS);
    setVal('arcextreme-prompt-extract-user', s.prompts?.extractUser ?? DEFAULT_EXTRACT_USER);
    setVal('arcextreme-prompt-route-sys', s.prompts?.routeSys ?? DEFAULT_ROUTE_SYS);
    setVal('arcextreme-prompt-route-user', s.prompts?.routeUser ?? DEFAULT_ROUTE_USER);
    setVal('arcextreme-prompt-subagent-sys', s.prompts?.subAgentSys ?? DEFAULT_SUBAGENT_SYS);
    setVal('arcextreme-prompt-subagent-user', s.prompts?.subAgentUser ?? DEFAULT_SUBAGENT_USER);
    setVal('arcextreme-prompt-sublimate-sys', s.prompts?.sublimateSys ?? DEFAULT_SUBLIMATE_SYS);
    setVal('arcextreme-prompt-sublimate-user', s.prompts?.sublimateUser ?? DEFAULT_SUBLIMATE_USER);
    // 历史窗口：支持自定义
    function setHistorySelect(id, val){
        const sel=document.getElementById(id);
        const custom=document.getElementById(id+'-custom');
        if(!sel) return;
        const opts=[...sel.options].map(o=>o.value);
        if(opts.includes(String(val))) { sel.value=String(val); if(custom) custom.style.display='none'; }
        else { sel.value='custom'; if(custom){ custom.style.display='block'; custom.value=String(val); } }
    }
    setHistorySelect('arcextreme-context-window', s.contextWindow);
    setHistorySelect('arcextreme-route-context-window', s.routeContextWindow);
    setHistorySelect('arcextreme-subagent-context-window', s.subAgentContextWindow);

    fillEnumSelect('arcextreme-inject-position', extension_prompt_types, s.inject.position);
    fillEnumSelect('arcextreme-inject-role', extension_prompt_roles, s.inject.depth_role);
    fillEnumSelect('arcextreme-sublimate-position', extension_prompt_types, s.sublimation.inject.position);
    fillEnumSelect('arcextreme-sublimate-role', extension_prompt_roles, s.sublimation.inject.depth_role);
}

function fillEnumSelect(id, enumObj, current) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    for (const key of Object.keys(enumObj)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = key;
        if (key === current) opt.selected = true;
        el.appendChild(opt);
    }
}

function bindForm() {
    const s = S();
    const bindCheck = (id, apply) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { apply(el.checked); saveSettingsDebounced(); updateLocks(); });
    };
    const bindVal = (id, apply) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { apply(el.value); saveSettingsDebounced(); });
        if (el) el.addEventListener('input', () => { apply(el.value); saveSettingsDebounced(); });
    };
    function updateLocks() {
        const useRoute = document.getElementById('arcextreme-route-useextract')?.checked;
        ['arcextreme-route-url','arcextreme-route-key','arcextreme-route-model','arcextreme-route-temp','arcextreme-route-temp-num','arcextreme-route-maxtokens','arcextreme-route-timeout','arcextreme-route-reasoning','arcextreme-route-reasoning-tokens','arcextreme-route-sendtemp'].forEach(id=>{
            const el=document.getElementById(id); if(el){ el.disabled=!!useRoute; el.style.opacity=useRoute?'.45':''; }
        });
        const adv=document.getElementById('arcextreme-route-adv'); if(adv) adv.style.opacity=useRoute?'.45':'';
        const useSub = document.getElementById('arcextreme-subagent-useextract')?.checked;
        ['arcextreme-subagent-url','arcextreme-subagent-key','arcextreme-subagent-model','arcextreme-subagent-temp','arcextreme-subagent-temp-num','arcextreme-subagent-maxtokens','arcextreme-subagent-timeout','arcextreme-subagent-reasoning','arcextreme-subagent-reasoning-tokens','arcextreme-subagent-sendtemp'].forEach(id=>{
            const el=document.getElementById(id); if(el){ el.disabled=!!useSub; el.style.opacity=useSub?'.45':''; }
        });
        const adv2=document.getElementById('arcextreme-subagent-adv'); if(adv2) adv2.style.opacity=useSub?'.45':'';
        const useSub2 = document.getElementById('arcextreme-sublimate-useextract')?.checked;
        ['arcextreme-sublimate-url','arcextreme-sublimate-key','arcextreme-sublimate-model','arcextreme-sublimate-temp','arcextreme-sublimate-temp-num','arcextreme-sublimate-maxtokens','arcextreme-sublimate-timeout','arcextreme-sublimate-reasoning','arcextreme-sublimate-reasoning-tokens','arcextreme-sublimate-sendtemp'].forEach(id=>{
            const el=document.getElementById(id); if(el){ el.disabled=!!useSub2; el.style.opacity=useSub2?'.45':''; }
        });
        const adv3=document.getElementById('arcextreme-sublimate-adv'); if(adv3) adv3.style.opacity=useSub2?'.45':'';
        const weightOn = document.getElementById('arcextreme-weight-enabled')?.checked;
        const grid=document.getElementById('arcextreme-weight-grid'); if(grid){ grid.style.opacity= weightOn? '1':'.45'; grid.style.pointerEvents= weightOn? 'auto':'none'; }
        const raOn = document.getElementById('arcextreme-retrieved-subagent-enabled')?.checked;
        const raGrid=document.getElementById('arcextreme-retrieved-subagent-grid'); if(raGrid){ raGrid.style.opacity= raOn? '1':'.45'; raGrid.style.pointerEvents= raOn? 'auto':'none'; }
    }
    function bindRangePair(rangeId, numId, labelId, apply) {
        const r=document.getElementById(rangeId), n=document.getElementById(numId), lab=labelId?document.getElementById(labelId):null;
        if (!r || !n) return;
        const sync = (v) => { r.value=v; n.value=v; if(lab) lab.textContent=String(v); apply(v); saveSettingsDebounced(); };
        r.addEventListener('input', ()=> sync(r.value));
        n.addEventListener('input', ()=> sync(n.value));
        n.addEventListener('change', ()=> sync(n.value));
    }
    // 主开关状态同步到 UI（初始化与 updateLocks 时都会调用）
    const _origUpdateLocks = updateLocks;
    updateLocks = function() {
        _origUpdateLocks();
        try { updateMasterUI(!!S().enabled); } catch {}
    };
    setTimeout(updateLocks, 0);
    setTimeout(()=>{ try{ updateMasterUI(!!S().enabled); }catch{} }, 150);

    // 主开关单独接管：关闭后全部停用（清注入 + 置灰 + 阻断）
    const masterEl = document.getElementById('arcextreme-enabled');
    if (masterEl) masterEl.addEventListener('change', async () => {
        const v = masterEl.checked;
        s.enabled = v;
        saveSettingsDebounced();
        updateLocks();
        await applyMasterState(v);
    });
    bindCheck('arcextreme-debug', (v) => { s.debug = v; });
    bindVal('arcextreme-pipeline-mode', (v) => {
        s.pipelineMode = (v === 'full') ? 'full' : 'fast';
        try { log(`管线模式已切换为${s.pipelineMode === 'full' ? '全量·同步（池裁判+A1+升华全阻塞）' : '高速·异步（裁判/升华后台追赶）'}`); pushToast('ok', `管线：${s.pipelineMode === 'full' ? '全量·同步' : '高速·异步'}`); } catch {}
    });
    bindVal('arcextreme-backend', (v) => { s.backendUrl = v; updateBackendEffective(); });

    function updateBackendEffective() {
        const el = document.getElementById('arcextreme-backend-effective');
        if (!el) return;
        try {
            const raw = s.backendUrl || '';
            let effective = raw.trim() ? raw.trim().replace(/\/+$/, '') : 'http://127.0.0.1:9001';
            let fixedNote = '';
            try {
                const pageHost = window.location.hostname;
                if (!raw.trim() && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
                    effective = `http://${pageHost}:9001`;
                    fixedNote = `（空值已自动适配为局域网 ${effective}）`;
                } else if (raw.trim()) {
                    const backendHost = new URL(effective).hostname;
                    if ((backendHost === '127.0.0.1' || backendHost === 'localhost') && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
                        const fixed = effective.replace(backendHost, pageHost);
                        fixedNote = ` → 实际请求 <code>${fixed}</code>（已自动把 ${backendHost} 换成 ${pageHost} 适配局域网）`;
                        effective = fixed;
                    }
                }
            } catch {}
            el.style.display = 'block';
            el.innerHTML = `<i class="fa-solid fa-network-wired"></i> 实际生效：<code>${effective}</code>${fixedNote} <small style="opacity:.6">| 页面 ${window.location.hostname || 'localhost'}</small>`;
        } catch { el.style.display = 'none'; }
    }
    setTimeout(updateBackendEffective, 0);
    document.getElementById('arcextreme-backend')?.addEventListener('input', updateBackendEffective);

    bindVal('arcextreme-extract-url', (v) => { s.extractLLM.apiUrl = v; });
    bindVal('arcextreme-extract-key', (v) => { s.extractLLM.apiKey = v; });
    bindVal('arcextreme-extract-model', (v) => { s.extractLLM.model = v; });
    bindRangePair('arcextreme-extract-temp','arcextreme-extract-temp-num','arcextreme-extract-temp-val', (v)=>{ s.extractLLM.temperature = Number(v); });
    bindVal('arcextreme-extract-maxtokens', (v) => { s.extractLLM.maxTokens = Number(v)||0; });
    bindVal('arcextreme-extract-timeout', (v) => { s.extractLLM.timeout = Number(v)||60; });
    bindVal('arcextreme-extract-reasoning', (v) => { s.extractLLM.reasoningEffort = v; });
    bindVal('arcextreme-extract-reasoning-tokens', (v) => { s.extractLLM.reasoningTokens = Number(v)||0; });
    bindCheck('arcextreme-extract-sendtemp', (v) => { s.extractLLM.sendTempWithReasoning = v; });

    bindCheck('arcextreme-route-useextract', (v) => { s.routeLLM.useExtract = v; });
    bindVal('arcextreme-route-url', (v) => { s.routeLLM.apiUrl = v; });
    bindVal('arcextreme-route-key', (v) => { s.routeLLM.apiKey = v; });
    bindVal('arcextreme-route-model', (v) => { s.routeLLM.model = v; });
    bindRangePair('arcextreme-route-temp','arcextreme-route-temp-num','arcextreme-route-temp-val', (v)=>{ s.routeLLM.temperature = Number(v); });
    bindVal('arcextreme-route-maxtokens', (v) => { s.routeLLM.maxTokens = Number(v)||0; });
    bindVal('arcextreme-route-timeout', (v) => { s.routeLLM.timeout = Number(v)||60; });
    bindVal('arcextreme-route-reasoning', (v) => { s.routeLLM.reasoningEffort = v; });
    bindVal('arcextreme-route-reasoning-tokens', (v) => { s.routeLLM.reasoningTokens = Number(v)||0; });
    bindCheck('arcextreme-route-sendtemp', (v) => { s.routeLLM.sendTempWithReasoning = v; });

    bindCheck('arcextreme-subagent-useextract', (v)=>{ s.subAgentLLM.useExtract=v; });
    bindVal('arcextreme-subagent-url', (v)=>{ s.subAgentLLM.apiUrl=v; });
    bindVal('arcextreme-subagent-key', (v)=>{ s.subAgentLLM.apiKey=v; });
    bindVal('arcextreme-subagent-model', (v)=>{ s.subAgentLLM.model=v; });
    bindRangePair('arcextreme-subagent-temp','arcextreme-subagent-temp-num','arcextreme-subagent-temp-val', (v)=>{ s.subAgentLLM.temperature=Number(v); });
    bindVal('arcextreme-subagent-maxtokens', (v)=>{ s.subAgentLLM.maxTokens=Number(v)||0; });
    bindVal('arcextreme-subagent-timeout', (v)=>{ s.subAgentLLM.timeout=Number(v)||60; });
    bindVal('arcextreme-subagent-reasoning', (v)=>{ s.subAgentLLM.reasoningEffort=v; });
    bindVal('arcextreme-subagent-reasoning-tokens', (v)=>{ s.subAgentLLM.reasoningTokens=Number(v)||0; });
    bindCheck('arcextreme-subagent-sendtemp', (v)=>{ s.subAgentLLM.sendTempWithReasoning=v; });

    bindCheck('arcextreme-sublimate-enabled', (v)=>{ s.sublimation.enabled=v; });
    bindCheck('arcextreme-sublimate-useextract', (v)=>{ s.sublimationLLM.useExtract=v; });
    bindVal('arcextreme-sublimate-url', (v)=>{ s.sublimationLLM.apiUrl=v; });
    bindVal('arcextreme-sublimate-key', (v)=>{ s.sublimationLLM.apiKey=v; });
    bindVal('arcextreme-sublimate-model', (v)=>{ s.sublimationLLM.model=v; });
    bindRangePair('arcextreme-sublimate-temp','arcextreme-sublimate-temp-num','arcextreme-sublimate-temp-val', (v)=>{ s.sublimationLLM.temperature=Number(v); });
    bindVal('arcextreme-sublimate-maxtokens', (v)=>{ s.sublimationLLM.maxTokens=Number(v)||0; });
    bindVal('arcextreme-sublimate-timeout', (v)=>{ s.sublimationLLM.timeout=Number(v)||60; });
    bindVal('arcextreme-sublimate-reasoning', (v)=>{ s.sublimationLLM.reasoningEffort=v; });
    bindVal('arcextreme-sublimate-reasoning-tokens', (v)=>{ s.sublimationLLM.reasoningTokens=Number(v)||0; });
    bindCheck('arcextreme-sublimate-sendtemp', (v)=>{ s.sublimationLLM.sendTempWithReasoning=v; });

    bindVal('arcextreme-prompt-extract-sys', (v) => { s.prompts.extractSys = v; });
    bindVal('arcextreme-prompt-extract-user', (v) => { s.prompts.extractUser = v; });
    bindVal('arcextreme-prompt-route-sys', (v) => { s.prompts.routeSys = v; });
    bindVal('arcextreme-prompt-route-user', (v) => { s.prompts.routeUser = v; });
    bindVal('arcextreme-prompt-subagent-sys', (v)=>{ s.prompts.subAgentSys=v; });
    bindVal('arcextreme-prompt-subagent-user', (v)=>{ s.prompts.subAgentUser=v; });
    bindVal('arcextreme-prompt-sublimate-sys', (v)=>{ s.prompts.sublimateSys=v; });
    bindVal('arcextreme-prompt-sublimate-user', (v)=>{ s.prompts.sublimateUser=v; });
    function bindHistorySelect(selId, customId, apply){
        const sel=document.getElementById(selId), custom=document.getElementById(customId);
        if(sel) sel.addEventListener('change', ()=>{
            if(sel.value==='custom'){
                if(custom){ custom.style.display='block'; custom.focus(); }
            } else {
                if(custom) custom.style.display='none';
                apply(Number(sel.value));
                saveSettingsDebounced();
            }
        });
        if(custom) custom.addEventListener('change', ()=>{ if(sel.value==='custom'){ apply(Math.max(1, Math.min(50, Number(custom.value)||10))); saveSettingsDebounced(); }});
        if(custom) custom.addEventListener('input', ()=>{ if(sel.value==='custom'){ apply(Math.max(1, Math.min(50, Number(custom.value)||10))); saveSettingsDebounced(); }});
    }
    bindHistorySelect('arcextreme-context-window','arcextreme-context-window-custom', (v)=>{ s.contextWindow = Math.max(1, Math.min(50, v||5)); });
    bindHistorySelect('arcextreme-route-context-window','arcextreme-route-context-window-custom', (v)=>{ s.routeContextWindow = Math.max(1, Math.min(50, v||5)); });
    bindHistorySelect('arcextreme-subagent-context-window','arcextreme-subagent-context-window-custom', (v)=>{ s.subAgentContextWindow = Math.max(1, Math.min(50, v||10)); });
    const on = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    };
    on('arcextreme-prompt-reset-all', () => {
        if (!confirm('确认一键将全部8个提示词模板恢复为默认？当前自定义将丢失。')) return;
        s.prompts.extractSys = DEFAULT_EXTRACT_SYS; s.prompts.extractUser = DEFAULT_EXTRACT_USER;
        s.prompts.routeSys = DEFAULT_ROUTE_SYS; s.prompts.routeUser = DEFAULT_ROUTE_USER;
        s.prompts.subAgentSys = DEFAULT_SUBAGENT_SYS; s.prompts.subAgentUser = DEFAULT_SUBAGENT_USER;
        s.prompts.sublimateSys = DEFAULT_SUBLIMATE_SYS; s.prompts.sublimateUser = DEFAULT_SUBLIMATE_USER;
        const setVal2 = (id, v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
        setVal2('arcextreme-prompt-extract-sys', DEFAULT_EXTRACT_SYS); setVal2('arcextreme-prompt-extract-user', DEFAULT_EXTRACT_USER);
        setVal2('arcextreme-prompt-route-sys', DEFAULT_ROUTE_SYS); setVal2('arcextreme-prompt-route-user', DEFAULT_ROUTE_USER);
        setVal2('arcextreme-prompt-subagent-sys', DEFAULT_SUBAGENT_SYS); setVal2('arcextreme-prompt-subagent-user', DEFAULT_SUBAGENT_USER);
        setVal2('arcextreme-prompt-sublimate-sys', DEFAULT_SUBLIMATE_SYS); setVal2('arcextreme-prompt-sublimate-user', DEFAULT_SUBLIMATE_USER);
        saveSettingsDebounced(); pushToast('ok','已全部重置为默认');
    });
    on('arcextreme-prompt-extract-sys-reset', () => { if (confirm('确认恢复事件提取系统提示词为默认？')) { s.prompts.extractSys = DEFAULT_EXTRACT_SYS; document.getElementById('arcextreme-prompt-extract-sys').value = DEFAULT_EXTRACT_SYS; saveSettingsDebounced(); pushToast('ok','已恢复默认'); } });
    on('arcextreme-prompt-extract-user-reset', () => { if (confirm('确认恢复事件提取用户模板为默认？')) { s.prompts.extractUser = DEFAULT_EXTRACT_USER; document.getElementById('arcextreme-prompt-extract-user').value = DEFAULT_EXTRACT_USER; saveSettingsDebounced(); pushToast('ok','已恢复默认'); } });
    on('arcextreme-prompt-route-sys-reset', () => { if (confirm('确认恢复路由系统提示词为默认？')) { s.prompts.routeSys = DEFAULT_ROUTE_SYS; document.getElementById('arcextreme-prompt-route-sys').value = DEFAULT_ROUTE_SYS; saveSettingsDebounced(); pushToast('ok','已恢复默认'); } });
    on('arcextreme-prompt-route-user-reset', () => { if (confirm('确认恢复路由用户模板为默认？')) { s.prompts.routeUser = DEFAULT_ROUTE_USER; document.getElementById('arcextreme-prompt-route-user').value = DEFAULT_ROUTE_USER; saveSettingsDebounced(); pushToast('ok','已恢复默认'); } });
    on('arcextreme-prompt-subagent-sys-reset', ()=>{ if(confirm('恢复SubAgent系统提示词？')){ s.prompts.subAgentSys=DEFAULT_SUBAGENT_SYS; document.getElementById('arcextreme-prompt-subagent-sys').value=DEFAULT_SUBAGENT_SYS; saveSettingsDebounced(); pushToast('ok','已恢复'); }});
    on('arcextreme-prompt-subagent-user-reset', ()=>{ if(confirm('恢复SubAgent用户模板？')){ s.prompts.subAgentUser=DEFAULT_SUBAGENT_USER; document.getElementById('arcextreme-prompt-subagent-user').value=DEFAULT_SUBAGENT_USER; saveSettingsDebounced(); pushToast('ok','已恢复'); }});
    on('arcextreme-prompt-sublimate-sys-reset', ()=>{ if(confirm('恢复升华系统提示词？')){ s.prompts.sublimateSys=DEFAULT_SUBLIMATE_SYS; document.getElementById('arcextreme-prompt-sublimate-sys').value=DEFAULT_SUBLIMATE_SYS; saveSettingsDebounced(); pushToast('ok','已恢复'); }});
    on('arcextreme-prompt-sublimate-user-reset', ()=>{ if(confirm('恢复升华用户模板？')){ s.prompts.sublimateUser=DEFAULT_SUBLIMATE_USER; document.getElementById('arcextreme-prompt-sublimate-user').value=DEFAULT_SUBLIMATE_USER; saveSettingsDebounced(); pushToast('ok','已恢复'); }});

    bindVal('arcextreme-embed-source', (v) => { s.embedding.source = v; });
    bindVal('arcextreme-embed-url', (v) => { s.embedding.apiUrl = v; });
    bindVal('arcextreme-embed-key', (v) => { s.embedding.apiKey = v; });
    bindVal('arcextreme-embed-model', (v) => { s.embedding.model = v; });

    bindCheck('arcextreme-rerank-enabled', (v) => { s.rerank.enabled = v; });
    bindVal('arcextreme-rerank-url', (v) => { s.rerank.apiUrl = v; });
    bindVal('arcextreme-rerank-key', (v) => { s.rerank.apiKey = v; });
    bindVal('arcextreme-rerank-model', (v) => { s.rerank.model = v; });
    bindVal('arcextreme-rerank-timeout', (v) => { s.rerank.timeout = Math.max(5, Math.min(300, Number(v) || 60)); });

    bindVal('arcextreme-inject-position', (v) => { s.inject.position = v; });
    bindVal('arcextreme-inject-depth', (v) => { s.inject.depth = Number(v) || 4; });
    bindCheck('arcextreme-inject-wi', (v) => { s.inject.include_wi = v; });
    bindVal('arcextreme-inject-role', (v) => { s.inject.depth_role = v; });
    bindVal('arcextreme-recentdays', (v) => { s.recentDays = Number(v) || 3; });
    bindVal('arcextreme-short-cap', (v)=>{ s.shortPool.perSoulCap = Math.max(5, Math.min(30, Number(v)||15)); });
    bindVal('arcextreme-short-skip', (v)=>{ s.shortPool.skipThreshold = Math.max(1, Math.min(10, Number(v)||3)); });
    bindVal('arcextreme-short-stuck', (v)=>{ s.shortPool.stuckThreshold = Math.max(3, Math.min(20, Number(v)||8)); });
    bindVal('arcextreme-subagent-mode', (v)=>{ s.shortPool.subAgentMode = v; saveSettingsDebounced(); });
    bindCheck('arcextreme-subagent-collapse', (v)=>{ s.shortPool.subAgentCollapseTrace = v; saveSettingsDebounced(); });
    bindCheck('arcextreme-weight-enabled', (v)=>{ s.shortPool.weight.enabled=v; });
    bindVal('arcextreme-weight-m0', (v)=>{ s.shortPool.weight.m0=Number(v)||1; });
    bindVal('arcextreme-weight-m1', (v)=>{ s.shortPool.weight.m1=Number(v)||1; });
    bindVal('arcextreme-weight-m2', (v)=>{ s.shortPool.weight.m2=Number(v)||1; });
    bindVal('arcextreme-weight-m3', (v)=>{ s.shortPool.weight.m3=Number(v)||1; });
    bindCheck('arcextreme-retrieved-subagent-enabled', (v)=>{ s.shortPool.retrievedSubAgent.enabled=v; updateLocks(); });
    bindVal('arcextreme-retrieved-subagent-max', (v)=>{ s.shortPool.retrievedSubAgent.maxItems=Math.max(1, Math.min(20, Number(v)||10)); });
    bindCheck('arcextreme-retrieved-subagent-trad', (v)=>{ s.shortPool.retrievedSubAgent.includeTraditional=v; });
    bindVal('arcextreme-sublimate-position', (v)=>{ s.sublimation.inject.position=v; });
    bindVal('arcextreme-sublimate-depth', (v)=>{ s.sublimation.inject.depth=Number(v)||2; });
    bindCheck('arcextreme-sublimate-wi', (v)=>{ s.sublimation.inject.include_wi=v; });
    bindVal('arcextreme-sublimate-role', (v)=>{ s.sublimation.inject.depth_role=v; });

    const on2 = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    };
    on2('arcextreme-test', refreshStatus);
    on2('arcextreme-refresh-souls', refreshSouls);
    on2('arcextreme-refresh-events', ()=>{ longPage=1; refreshEvents(); });
    on2('arcextreme-refresh-short', refreshShortPool);
    on2('arcextreme-enforce-short', async ()=>{
        const chatId = getContext().chatId || getCurrentChatId();
        const cap = Number(S().shortPool?.perSoulCap||15);
        try{
            const r = await backend.enforceShortPool(chatId, cap);
            log(`短期池校正: perSoulCap=${cap} before=${JSON.stringify(r.before)} after=${JSON.stringify(r.after)}`);
            pushToast('ok', `已校正至 ${cap}/soul`);
            refreshShortPool(); if(isDataModalOpen()) refreshModalShortPool();
        }catch(e){ pushToast('fail', `校正失败: ${e.message}`); }
    });
    on2('arcextreme-refresh-sublimated', refreshSublimated);
    on2('arcextreme-expand-all', () => {
        document.querySelectorAll('.arcextreme-panel .ax-drawer').forEach(d=>d.classList.add('open'));
    });
    on2('arcextreme-collapse-all', () => {
        document.querySelectorAll('.arcextreme-panel .ax-drawer').forEach(d=>{
            if (d.id !== 'arcextreme-trace-drawer') d.classList.remove('open');
        });
    });
    on2('arcextreme-rebuild', async () => {
        try { await backend.reload(); notify('重建索引', true, '完成'); } catch (e) { notify('重建索引', false, e.message); }
    });
    on2('arcextreme-clear', async () => {
        const chatId = getContext().chatId || getCurrentChatId();
        try { await backend.clearEvents(chatId); notify('清空事件', true, '已清空'); refreshEvents(); refreshShortPool(); }
        catch (e) { notify('清空事件', false, e.message); }
    });
    // tabs
    document.querySelectorAll('#arcextreme-data-tabs .ax-tab').forEach(tab=>{
        tab.addEventListener('click', ()=>{
            const t = tab.getAttribute('data-tab');
            document.querySelectorAll('#arcextreme-data-tabs .ax-tab').forEach(x=>x.classList.toggle('is-active', x===tab));
            document.querySelectorAll('.ax-tab-panel').forEach(p=> p.classList.toggle('is-active', p.getAttribute('data-panel')===t));
            if(t==='short') refreshShortPool();
            if(t==='long') refreshEvents();
            if(t==='sublimated') refreshSublimated();
        });
    });
    // filters
    document.getElementById('arcextreme-short-filter-soul')?.addEventListener('change', refreshShortPool);
    document.getElementById('arcextreme-short-filter-counter')?.addEventListener('change', refreshShortPool);
    document.getElementById('arcextreme-long-filter-soul')?.addEventListener('change', ()=>{ longPage=1; refreshEvents(); });
    document.getElementById('arcextreme-long-filter-counter')?.addEventListener('change', ()=>{ longPage=1; refreshEvents(); });
    document.getElementById('arcextreme-long-filter-bucket')?.addEventListener('change', ()=>{ longPage=1; refreshEvents(); });
    document.getElementById('arcextreme-long-prev')?.addEventListener('click', ()=>{ if(longPage>1){ longPage--; refreshEvents(); }});
    document.getElementById('arcextreme-long-next')?.addEventListener('click', ()=>{ longPage++; refreshEvents(); });

    // 迁移 & Souls 批量
    try{ setupMigrateUI(); }catch(e){ console.warn('[ArcEXtreme] migrate setup 失败', e); }
    // 弹出式大窗初始化
    try{
        const modal = document.getElementById('arcextreme-data-modal');
        if (modal && modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
    }catch(e){ console.warn('[ArcEXtreme] modal 移到 body 失败', e); }
    try{ setupDataModal(); }catch(e){ console.warn('[ArcEXtreme] modal setup 失败', e); }

    // Hero 大标题折叠 — 漂漂亮亮的渐变也可收起
    try{
        const hero = document.getElementById('arcextreme-hero');
        const panel = document.querySelector('.arcextreme-panel');
        const storageKey = 'arcextreme-hero-collapsed';
        try{ if (localStorage.getItem(storageKey)==='1' && panel) panel.classList.add('is-hero-collapsed'); }catch{}
        if (hero && panel) {
            hero.addEventListener('click', (e)=>{
                if (e.target.closest('.ax-status')) return;
                panel.classList.toggle('is-hero-collapsed');
                const collapsed = panel.classList.contains('is-hero-collapsed');
                try{ localStorage.setItem(storageKey, collapsed?'1':'0'); }catch{}
            });
        }
    }catch(e){ console.warn('[ArcEXtreme] hero collapse setup 失败', e); }
}

// --------------------------------------------------------------------------- //
// 入口
// --------------------------------------------------------------------------- //
function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const started = Date.now();
        const timer = setInterval(() => {
            const found = document.querySelector(selector);
            if (found || Date.now() - started > timeout) {
                clearInterval(timer);
                resolve(found || null);
            }
        }, 200);
    });
}

(async function init() {
    ensureSettings();
    try {
        const html = await renderExtensionTemplateAsync('third-party/ArcEXtreme', 'settings');
        const container = await waitForElement('#extensions_settings2');
        if (!container) throw new Error('#extensions_settings2 不存在');
        if (typeof html === 'string') container.insertAdjacentHTML('beforeend', html);
        else container.appendChild(html);
        populateForm();
        bindForm();
        try { await initTraceUI(); } catch (e) { console.warn('[ArcEXtreme] trace init 失败', e); }
        try { updateMasterUI(!!S().enabled); } catch {}
        if (!S().enabled) {
            try { await clearAllMemoryInjections(); } catch {}
            setStatus('err', '已关闭 · 全停用');
        } else {
            await refreshStatus();
        }
        await refreshSouls();
        await refreshShortPool();
        // 记录初始 hash 用于 swipe 去重
        try {
            const ctx = getContext();
            const chat = ctx.chat || [];
            const lastUser = [...chat].reverse().find(m=>m.is_user);
            if (lastUser) lastUserHash = hashStr(lastUser.mes);
            lastChatLen = chat.length;
        } catch {}
        console.log('[ArcEXtreme] 设置面板已挂载 v0.2');
    } catch (e) {
        console.error('[ArcEXtreme] 初始化失败', e);
        toastr?.error('ArcEXtreme 设置面板加载失败，请看控制台', 'ArcEXtreme');
    }

    if (eventSource && event_types) {
        // 切换聊天时若主开关关闭，确保残留注入被清掉
        if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, async ()=>{
            if (!S().enabled) {
                try { await clearAllMemoryInjections(); } catch {}
                try { updateMasterUI(false); } catch {}
            }
        });
        eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
        const debouncedSwipe = debounce(async (mesId) => {
            try {
                const chat = getContext().chat || [];
                const msg = chat[mesId];
                if (!msg || !msg.is_user) return;
                if (hashStr(msg.mes) === lastUserHash) {
                    if (S().debug) log('swipe/edit 未变，跳过');
                    return;
                }
                await onUserMessage(mesId);
            } catch (e) { console.warn('[ArcEXtreme] swipe 处理异常', e); }
        }, 700);
        const debouncedEdit = debounce(async (mesId) => {
            try {
                const chat = getContext().chat || [];
                const msg = chat[mesId];
                if (!msg || !msg.is_user) return;
                if (hashStr(msg.mes) === lastUserHash) return;
                await onUserMessage(mesId);
            } catch (e) { console.warn('[ArcEXtreme] edit 处理异常', e); }
        }, 700);
        if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, debouncedSwipe);
        if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, debouncedEdit);
        if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, debouncedEdit);
        if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, () => { try { lastChatLen = (getContext().chat||[]).length; } catch {} });
    }
    console.log('[ArcEXtreme] 已加载 v0.2 2bit+BTB+升华');
})();

export {};
