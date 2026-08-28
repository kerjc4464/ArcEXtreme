// 组装并注入记忆块
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../../script.js';

const TAG = 'arcextreme_mem';
const TAG_SUB_PREFIX = 'arcextreme_sublimated_';

function pos(settings) {
    return extension_prompt_types[settings.inject.position] ?? extension_prompt_types.IN_CHAT;
}

function role(settings) {
    return extension_prompt_roles[settings.inject.depth_role] ?? extension_prompt_roles.SYSTEM;
}
function posSub(settings) {
    const inj = settings.sublimation?.inject || settings.inject;
    return extension_prompt_types[inj.position] ?? extension_prompt_types.IN_CHAT;
}
function roleSub(settings) {
    const inj = settings.sublimation?.inject || settings.inject;
    return extension_prompt_roles[inj.depth_role] ?? extension_prompt_roles.SYSTEM;
}

function fmtSouls(e) {
    let arr = e.souls;
    if (Array.isArray(arr)) arr = arr.filter(Boolean);
    else if (typeof arr === 'string' && arr.trim()) {
        try { const p = JSON.parse(arr); arr = Array.isArray(p) ? p : [arr]; } catch { arr = arr.includes(',') ? arr.split(',').map(s=>s.trim()).filter(Boolean) : [arr]; }
    } else if (e.souls_str) arr = String(e.souls_str).split(',').map(s=>s.trim()).filter(Boolean);
    else arr = [];
    return arr.length ? ` (${arr.join(', ')})` : '';
}
export function buildRecentBlock(events, days) {
    if (!events || !events.length) return '';
    const lines = events.map(
        (e) => `- [${e.time_bucket}] ${e.event_text}${fmtSouls(e)}`,
    );
    return `【近期事件（近${days}天）】\n${lines.join('\n')}`;
}

export function buildRetrievedBlock(events) {
    if (!events || !events.length) return '';
    const lines = events.map(
        (e) =>
            `- [${e.time_bucket}|${(Number(e.score) || 0).toFixed(3)}] ${e.event_text}${fmtSouls(e)}`,
    );
    return `【相关记忆检索】\n${lines.join('\n')}`;
}

const COUNTER_ATT = {0:'坚决否定/强烈排斥',1:'倾向否定/弱排斥',2:'倾向认可/弱接纳',3:'坚决认可/强烈接纳'};
function fmtCounter(e){
    const c = e.counter ?? e.scounter;
    if (c==null) return '';
    const att = COUNTER_ATT[c] || String(c);
    return ` [${c}:${att}${e.skip!=null?` skip${e.skip}`:''}${e.stuck!=null?` stuck${e.stuck}`:''}]`;
}
export function buildShortPoolBlock(poolsGrouped, perSoulCap){
    if (!poolsGrouped || !Object.keys(poolsGrouped).length) return '';
    const lines=[];
    for (const [soul, items] of Object.entries(poolsGrouped)){
        lines.push(`◆ ${soul} (${items.length}/${perSoulCap} 活跃池)`);
        for (const e of items) {
            const att = COUNTER_ATT[e.counter] || '';
            const soulTag = e.pool_soul || soul;
            const whyInit = e.why_init ? ` 初因:${String(e.why_init).slice(0,200)}` : '';
            const whyLog = Array.isArray(e.why_log) && e.why_log.length ? ` · 溯因:${e.why_log.slice(-3).map(w=>`${w.action}(${String(w.why).slice(0,120)})`).join('→')}` : '';
            lines.push(`- [${e.counter??'?'}:${att}${e.skip!=null?` skip${e.skip}`:''}] 【${soulTag}】${e.event_text}${fmtCounter(e)}${whyInit}${whyLog}`);
        }
    }
    return `【短期记忆池BTB】\n${lines.join('\n')}`;
}
export function buildSublimatedBlock(items){
    if (!items || !items.length) return '';
    const lines = items.slice(0, 12).map(it=> `- 【${it.soul}】${it.content||it.sublimated||''} (源#${it.event_id} ${it.counter})`);
    return `【升华记忆·已固化到Soul】\n${lines.join('\n')}`;
}

export function injectMemory(settings, recentBlock, retrievedBlock, shortPoolBlock, sublimatedBlock) {
    const parts = [recentBlock, retrievedBlock, shortPoolBlock, sublimatedBlock].filter(Boolean);
    const text = parts.join('\n\n');
    setExtensionPrompt(TAG, text, pos(settings), settings.inject.depth, settings.inject.include_wi, role(settings));
}
// 独立TAG注入升华（每soul一TAG，防覆盖）
export function injectSublimated(settings, items){
    const inj = settings.sublimation?.inject || settings.inject;
    const grouped={};
    for(const it of (items||[])){
        const s=it.soul||'unknown';
        (grouped[s]||(grouped[s]=[])).push(it);
    }
    // 先清不在当前升华列表中的旧TAG（避免残留）
    // 由调用方负责 clearAllSublimated 再逐个注入
    for(const [soul, list] of Object.entries(grouped)){
        const tag = TAG_SUB_PREFIX + soul;
        const block = buildSublimatedBlock(list);
        setExtensionPrompt(tag, block, posSub(settings), inj.depth, inj.include_wi, roleSub(settings));
    }
}
export function clearSublimated(settings, souls){
    const inj = settings.sublimation?.inject || settings.inject;
    if (souls && souls.length){
        for(const s of souls){
            setExtensionPrompt(TAG_SUB_PREFIX+s, '', posSub(settings), inj.depth, inj.include_wi, roleSub(settings));
        }
    } else {
        // 清所有：遍历已知 souls 通过后端获取？保守清5个占位
        // 调用方应传入 souls 列表
    }
}
export function clearAllSublimatedForChat(settings, allSouls){
    clearSublimated(settings, allSouls);
}

export function clearInjection(settings) {
    setExtensionPrompt(TAG, '', pos(settings), settings.inject.depth, settings.inject.include_wi, role(settings));
}
// 供外部取TAG名
export { TAG, TAG_SUB_PREFIX };
