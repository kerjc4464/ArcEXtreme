// 升华：对 stuck≥阈值 且 counter∈{0,3} 的事件进行深度推理并追加到soul
import { chatCompletion, parseJson } from './llm.js';
import { DEFAULT_SUBLIMATE_SYS, DEFAULT_SUBLIMATE_USER, renderPrompt, translateCounter, COUNTER_LABELS } from './config.js';
import { backend } from './backend.js';

export async function sublimateOne(settings, item, soulContent, contextText) {
    let cfg = settings.sublimationLLM?.useExtract ? settings.extractLLM : settings.sublimationLLM;
    if ((!cfg || !cfg.apiUrl) && settings.extractLLM?.apiUrl) cfg = settings.extractLLM;
    if (!cfg || !cfg.apiUrl) throw new Error('升华LLM未配置（请在升华面板填BaseURL或勾选“复用提取”）');
    const sysTpl = settings.prompts?.sublimateSys || DEFAULT_SUBLIMATE_SYS;
    const userTpl = settings.prompts?.sublimateUser || DEFAULT_SUBLIMATE_USER;
    const att = translateCounter(item.counter);
    const label = COUNTER_LABELS[item.counter] || String(item.counter);
    const sys = renderPrompt(sysTpl, {});
    const full = (soulContent||'').slice(0, 4000);
    const snippet = (soulContent||'').slice(0, 1200);
    const whyInit = item.why_init || item.whyInit || '';
    let whyChain = '(无)';
    try{
        const log = item.why_log || item.whyLog || [];
        const arr = Array.isArray(log) ? log : (typeof log==='string' ? JSON.parse(log) : []);
        if(arr.length) whyChain = arr.map(w=> `[${w.action} ${w.new} ${String(w.why).slice(0,60)}]`).join(' → ');
    }catch{}
    const user = renderPrompt(userTpl, {
        soul: item.soul,
        soulContent: full,
        soulSnippet: snippet,
        soulContentFull: full,
        event: item.event_text||item.event||'',
        counter: item.counter,
        counterLabel: label,
        attitude: att,
        stuck: item.stuck||0,
        skip: item.skip||0,
        birth: item.birth_ts ? new Date(item.birth_ts).toLocaleString() : '',
        whyInit: whyInit.slice(0,200) || '(无)',
        whyChain,
        context: (contextText||'').slice(0,1500),
    });
    const raw = await chatCompletion(cfg, [
        { role:'system', content: sys },
        { role:'user', content: user },
    ], { json:true, _traceStep:'sublimate', _traceLabel:`升华:${item.soul}#${item.event_id}` });
    const parsed = parseJson(raw) || {};
    const content = String(parsed.sublimated || parsed.content || parsed.text || raw).trim().slice(0, 2000);
    const title = String(parsed.title || `升华记忆 · ${item.soul} · ${label}`).trim().slice(0,80);
    return { content, title, raw };
}

export async function checkAndSublimate(settings, chatId, contextText, soulsContentMap) {
    if (!settings.sublimation?.enabled) return [];
    const thr = Number(settings.shortPool?.stuckThreshold||8);
    let candidates=[];
    try {
        const r = await backend.checkSublimation(chatId, thr);
        candidates = r.candidates || [];
    } catch(e){ return []; }
    const results=[];
    for(const c of candidates.slice(0, 5)) { // 每轮最多5条防风暴
        try {
            const soulContent = soulsContentMap[c.soul] || '';
            const sub = await sublimateOne(settings, c, soulContent, contextText);
            // append to soul file: need filename
            // soul文件名通过 listSouls 映射 name->filename
            let filename=null;
            try{
                const souls = await backend.listSouls();
                const hit = souls.find(s=> s.name===c.soul);
                if(hit) filename=hit.filename;
            }catch{}
            if(filename){
                await backend.appendSoul({ filename, content: sub.content, title: sub.title, chat_id: chatId, soul: c.soul, event_id: c.event_id, counter: c.counter });
            }
            await backend.markSublimated({ chat_id: chatId, soul: c.soul, event_id: c.event_id });
            results.push({ ...c, sublimated: sub.content, title: sub.title });
        } catch(e){
            console.warn('[sublimation] failed', c, e);
        }
    }
    return results;
}
