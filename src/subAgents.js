// SubAgent：支持 perRole(每角色一次) / mixed(混合15) / perEvent(每事件一请求) 三档，默认 perRole 保证隔离
import { chatCompletion, parseJson } from './llm.js';
import { DEFAULT_SUBAGENT_SYS, DEFAULT_SUBAGENT_USER, renderPrompt, translateCounter, COUNTER_ATTITUDES, COUNTER_LABELS } from './config.js';

function chunk(arr, n){
    const out=[];
    for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
    return out;
}
function groupBySoul(items){
    const g={};
    for(const it of items){
        const k=it.soul||it.pool_soul||'unknown';
        (g[k]||(g[k]=[])).push(it);
    }
    return g;
}

async function callSubAgentBatch(settings, batchItems, soulsContentMap, contextText, traceLabel) {
    let cfg = settings.subAgentLLM?.useExtract ? settings.extractLLM : settings.subAgentLLM;
    if ((!cfg || !cfg.apiUrl) && settings.extractLLM?.apiUrl) cfg = settings.extractLLM;
    if (!cfg || !cfg.apiUrl) throw new Error('SubAgent LLM 未配置（请在SubAgent面板填BaseURL或勾选“复用提取”）');
    const sysTpl = settings.prompts?.subAgentSys || DEFAULT_SUBAGENT_SYS;
    const userTpl = settings.prompts?.subAgentUser || DEFAULT_SUBAGENT_USER;

    const eventsDesc = batchItems.map((it, idx)=>{
        const soulContent = (soulsContentMap[it.soul] || '').slice(0, 1200);
        const label = COUNTER_LABELS[it.counter] || String(it.counter);
        const att = COUNTER_ATTITUDES[it.counter] || translateCounter(it.counter);
        return `#${idx} soul=${it.soul} counter=${it.counter}(${label}/${att}) event="${String(it.event_text||it.event||'').slice(0,200)}" soulContent="${soulContent.slice(0,300).replace(/\n/g,' ')}"`;
    }).join('\n');

    let sys = renderPrompt(sysTpl, { counter: 'batch', counterLabel: '批量', attitude: '', soul: batchItems[0]?.soul||'batch', event: `批量${batchItems.length}条`, soulSnippet: (soulsContentMap[batchItems[0]?.soul]||'').slice(0,1200), soulContent: (soulsContentMap[batchItems[0]?.soul]||'').slice(0,1200) });
    // 角色隔离提示：若batch内同魂，则强调单角色
    const soulsInBatch = [...new Set(batchItems.map(x=>x.soul))];
    const isoNote = soulsInBatch.length===1 ? `\n[角色隔离] 本次仅裁判 soul=${soulsInBatch[0]} 的 ${batchItems.length} 条短期记忆，禁止跨角色串扰。` : `\n[批量模式] 你将一次性收到 ${batchItems.length} 个事件，每个需独立判断。`;
    sys = sys + isoNote + `\n只输出 JSON：{"results":[{"id":0,"action":"+1"|"-1"|"Skip","reason":"..."}, ...]}`;
    if (!sys.includes('results')) sys += `\n只输出 JSON：{"results":[{"id":0,"action":"+1"|"-1"|"Skip"}]}`;

    const renderedPerEvent = batchItems.map((it, idx)=>{
        const snippet = String(soulsContentMap[it.soul]||'').slice(0,1200);
        const label = COUNTER_LABELS[it.counter] || String(it.counter);
        const att = COUNTER_ATTITUDES[it.counter] || translateCounter(it.counter);
        const vars = { soul: it.soul, event: it.event_text||it.event||'', counter: String(it.counter), counterLabel: label, attitude: att, soulSnippet: snippet, soulContent: snippet, context: contextText||'', userMessage: it.userMessage||'' };
        const tplRendered = renderPrompt(userTpl, vars);
        return `#${idx} ${tplRendered.slice(0,600).replace(/\n/g,' | ')}`;
    }).join('\n');

    const soulBlocks = soulsInBatch.map(k=> `=== ${k} ===\n${String(soulsContentMap[k]||'').slice(0, s.shortPool?.subAgentMode==='perEvent'? 4000 : 1200)}`).join('\n\n');
    const user = `最近对话:\n${contextText||''}\n\n当前用户消息:\n${batchItems[0]?.userMessage||''}\n\n待裁判事件列表(${batchItems.length}):\n${eventsDesc}\n\n--- 模板渲染(每事件) ---\n${renderedPerEvent}\n\nSoul设定:\n${soulBlocks}`;

    const raw = await chatCompletion(cfg, [
        { role:'system', content: sys },
        { role:'user', content: user },
    ], { json:true, _traceStep:'subagent', _traceLabel: traceLabel || `SubAgent×${batchItems.length}` });

    const parsed = parseJson(raw) || {};
    let results = [];
    if (Array.isArray(parsed.results)) results = parsed.results;
    else if (Array.isArray(parsed)) results = parsed;
    else if (parsed.action) results = [{id:0, action:parsed.action}];

    const out = [];
    for (let i=0;i<batchItems.length;i++) {
        const found = results.find(r=> Number(r.id)===i || Number(r.index)===i || r.event_id===batchItems[i].event_id);
        let action = found?.action || found?.act || 'Skip';
        let why = String(found?.why || found?.reason || '').trim().slice(0,300);
        if (action !== '+1' && action !== '-1' && action !== 'Skip') {
            const s = String(action).toLowerCase();
            if (s.includes('+1')||s.includes('inc')||s.includes('up')) action='+1';
            else if (s.includes('-1')||s.includes('dec')||s.includes('down')) action='-1';
            else action='Skip';
        }
        if (action==='Skip') why=''; // Skip不追加why
        out.push({ event_id: batchItems[i].event_id, soul: batchItems[i].soul, action, why, reason: why, rawIdx:i });
    }
    return out;
}

// 单事件单调（crazy 45并发用）
async function callSubAgentSingle(settings, item, soulsContentMap, contextText, traceLabel){
    let cfg = settings.subAgentLLM?.useExtract ? settings.extractLLM : settings.subAgentLLM;
    if ((!cfg || !cfg.apiUrl) && settings.extractLLM?.apiUrl) cfg = settings.extractLLM;
    if (!cfg || !cfg.apiUrl) throw new Error('SubAgent LLM 未配置');
    const sysTpl = settings.prompts?.subAgentSys || DEFAULT_SUBAGENT_SYS;
    const userTpl = settings.prompts?.subAgentUser || DEFAULT_SUBAGENT_USER;
    const snippet = String(soulsContentMap[item.soul]||'').slice(0,1200);
    const label = COUNTER_LABELS[item.counter] || String(item.counter);
    const att = COUNTER_ATTITUDES[item.counter] || translateCounter(item.counter);
    const sys = renderPrompt(sysTpl, { counter: String(item.counter), counterLabel: label, attitude: att, soul: item.soul, event: item.event_text||item.event||'', soulSnippet: snippet, soulContent: snippet });
    const user = renderPrompt(userTpl, { soul: item.soul, event: item.event_text||item.event||'', counter: String(item.counter), counterLabel: label, attitude: att, soulSnippet: snippet, soulContent: snippet, context: contextText||'', userMessage: item.userMessage||'' });
    const raw = await chatCompletion(cfg, [
        { role:'system', content: sys },
        { role:'user', content: user },
    ], { json:true, _traceStep:'subagent', _traceLabel: traceLabel || `SubAgent ${item.soul}#${item.event_id}` });
    const parsed = parseJson(raw) || {};
    let action = parsed.action || parsed.act || 'Skip';
    let why = String(parsed.why || parsed.reason || '').trim().slice(0,300);
    if (action !== '+1' && action !== '-1' && action !== 'Skip') {
        const s = String(action).toLowerCase();
        if (s.includes('+1')||s.includes('inc')||s.includes('up')) action='+1';
        else if (s.includes('-1')||s.includes('dec')||s.includes('down')) action='-1';
        else action='Skip';
    }
    if (action==='Skip') why='';
    return { event_id: item.event_id, soul: item.soul, action, why, reason: why };
}

export async function evaluateShortPool(settings, poolItems, soulsContentMap, contextText, userMessage) {
    if (!poolItems || !poolItems.length) return [];
    const enriched = poolItems.map(p=> ({ ...p, userMessage }));
    const mode = settings.shortPool?.subAgentMode || 'perRole';
    const collapse = settings.shortPool?.subAgentCollapseTrace !== false;

    if (mode === 'perEvent') {
        // 真·45并发：每事件一LLM请求，全部并发
        const promises = enriched.map(item =>
            callSubAgentSingle(settings, item, soulsContentMap, contextText, `SubAgent ${item.soul}#${item.event_id}`)
                .catch(e=> ({ event_id: item.event_id, soul: item.soul||item.pool_soul, action:'Skip', why:'', reason:`single fail: ${e.message}`}))
        );
        const results = await Promise.all(promises);
        // 若折叠，轨迹已每条一条会刷屏，前端 ui.js 会按 collapse 折叠
        return results;
    }

    if (mode === 'perRole') {
        // 角色隔离：每角色一批，角色间并发
        const grouped = groupBySoul(enriched);
        const roleBatches = Object.entries(grouped);
        const all = [];
        // 每角色内再分片15
        const promises = roleBatches.map(async ([soul, items])=>{
            const batches = chunk(items, 15);
            const res=[];
            for(const b of batches){
                try{
                    const r = await callSubAgentBatch(settings, b, soulsContentMap, contextText, `SubAgent ${soul}×${b.length}`);
                    res.push(...r);
                }catch(e){
                    for(const it of b) res.push({ event_id: it.event_id, soul, action:'Skip', why:'', reason:`batch fail: ${e.message}`});
                }
            }
            return res;
        });
        const settled = await Promise.all(promises);
        for(const arr of settled) all.push(...arr);
        return all;
    }

    // mixed：原逻辑，混合15分片
    const batches = chunk(enriched, 15);
    const all = [];
    for (const b of batches) {
        try {
            const r = await callSubAgentBatch(settings, b, soulsContentMap, contextText, `SubAgent裁判×${b.length}`);
            all.push(...r);
        } catch(e) {
            for(const it of b) all.push({ event_id: it.event_id, soul: it.soul||it.pool_soul, action:'Skip', why:'', reason:`batch fail: ${e.message}`});
        }
    }
    return all;
}
