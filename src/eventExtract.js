// 事件提取：从用户消息中提炼事件 + 匹配 souls 角色（支持 5 层上下文 + 可编辑模板 + 无数角色）
import { chatCompletion, parseJson } from './llm.js';
import { BUCKETS, DEFAULT_EXTRACT_SYS, DEFAULT_EXTRACT_USER, renderPrompt } from './config.js';

function normalizeSoulsArray(raw, soulsList) {
    if (raw == null || raw === 'null' || raw === '') return [];
    let arr = [];
    if (Array.isArray(raw)) arr = raw.map(v => String(v).trim()).filter(Boolean);
    else if (typeof raw === 'string') {
        const s = raw.trim();
        if (s && s !== 'null') {
            if (s.includes(',')) arr = s.split(',').map(x => x.trim()).filter(Boolean);
            else arr = [s];
        }
    }
    if (soulsList && soulsList.length) {
        const set = new Set(soulsList);
        arr = arr.filter(x => set.has(x));
    }
    return [...new Set(arr)];
}
function clampCounter(v){
    const n=Number(v);
    if(!Number.isFinite(n)) return 2;
    return Math.max(0, Math.min(3, Math.round(n)));
}

export async function extractEvents(settings, userMessage, soulsList, contextText = '', soulsContentsMap = null) {
    const cfg = settings.extractLLM;
    // soulsText 优先使用带内容的版本，供LLM结合人设判断counter初值
    let soulsText = '(无)';
    if (soulsList.length) {
        if (soulsContentsMap && typeof soulsContentsMap === 'object') {
            // Map or {name:content}
            const lines = soulsList.map(name=>{
                const content = soulsContentsMap[name] || '';
                const snippet = String(content).slice(0, 800).replace(/\s+/g,' ').trim();
                return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
            });
            soulsText = lines.join('\n');
        } else {
            soulsText = soulsList.map((s) => `- ${s}`).join('\n');
        }
    }
    const buckets = BUCKETS.join('、');
    const soulCount = soulsList.length || 0;

    const tplSys = settings.prompts?.extractSys || DEFAULT_EXTRACT_SYS;
    const tplUser = settings.prompts?.extractUser || DEFAULT_EXTRACT_USER;

    const sys = renderPrompt(tplSys, { soulsText, userMessage, soulCount: String(soulCount), context: contextText || userMessage, buckets, soulsTextWithContent: soulsText });
    const user = renderPrompt(tplUser, { soulsText, userMessage, soulCount: String(soulCount), context: contextText || userMessage, buckets, soulsTextWithContent: soulsText });

    const content = await chatCompletion(
        cfg,
        [
            { role: 'system', content: sys },
            { role: 'user', content: user },
        ],
        { json: true, _traceStep: 'extract', _traceLabel: '事件提取' },
    );

    const p = parseJson(content) || {};
    // 新格式: {events:[{event,soul,counter}]}
    let events = [];
    if (Array.isArray(p.events) && p.events.length) {
        for (const ev of p.events) {
            const txt = String(ev.event || ev.text || '').trim().slice(0, 500);
            if (!txt) continue;
            let soul = String(ev.soul || ev.role1 || '').trim();
            if (soul && soulsList.length && !soulsList.includes(soul)) soul = '';
            if (!soul && soulsList.length) {
                soul = soulsList[events.length % soulsList.length];
            }
            const counter = clampCounter(ev.counter ?? ev.score ?? 2);
            const why = String(ev.why || ev.reason || '').trim().slice(0, 500);
            if (!soul && !soulsList.length) soul = 'general';
            events.push({ event: txt, soul: soul || null, counter, why, souls: soul?[soul]:[], role1: soul||null, role2: null });
        }
    }
    // 兼容旧格式: {event, souls:[]}
    if (!events.length) {
        const soulsArr = normalizeSoulsArray(p.souls, soulsList);
        const extraRoles = [];
        if (p.role1 && p.role1 !== 'null') extraRoles.push(String(p.role1).trim());
        if (p.role2 && p.role2 !== 'null') extraRoles.push(String(p.role2).trim());
        for (const r of extraRoles) {
            if (r && !soulsArr.includes(r) && (!soulsList.length || soulsList.includes(r))) soulsArr.push(r);
        }
        const primary = soulsArr[0] || null;
        const singleEvent = String(p.event || '').trim().slice(0,500);
        if (singleEvent) {
            // 旧格式拆为每soul一条
            if (soulsArr.length) {
                for (const s of soulsArr) events.push({ event: singleEvent, soul: s, counter: 2, why: String(p.why||'').trim().slice(0,500), souls:[s], role1:s, role2:null });
            } else if (soulsList.length) {
                for (const s of soulsList) events.push({ event: singleEvent, soul: s, counter: 1, why: String(p.why||'').trim().slice(0,500), souls:[s], role1:s, role2:null });
            } else {
                events.push({ event: singleEvent, soul: null, counter: 2, why: String(p.why||'').trim().slice(0,500), souls:[], role1: primary, role2: null });
            }
        }
    }
    // 兜底：确保数量 ≥ soul数
    if (soulsList.length && events.length < soulsList.length) {
        const need = soulsList.length - events.length;
        const baseText = events[0]?.event || String(p.event||'').trim().slice(0,500) || userMessage.slice(0,200);
        const baseWhy = events[0]?.why || '';
        for (let i=0;i<need;i++) {
            const s = soulsList[(events.length+i)%soulsList.length];
            if (!events.some(e=>e.soul===s)) events.push({ event: baseText, soul: s, counter: 1, why: baseWhy, souls:[s], role1:s, role2:null });
        }
    }
    // 兼容旧调用：返回首条 + 全量
    const first = events[0] || { event:'', soul:null, counter:2, souls:[], role1:null, role2:null };
    return {
        event: first.event,
        souls: first.souls,
        soulsStr: (first.souls||[]).join(', '),
        role1: first.role1,
        role2: first.role2,
        soulsList: first.souls,
        counter: first.counter,
        events, // 新：全量 1:1 列表
    };
}
// 兼容旧 import
export async function extractEvent(...args){ return extractEvents(...args); }
