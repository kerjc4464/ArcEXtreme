// 路由 LLM：根据用户消息 + souls 设定，决定检索哪些时间分桶 / souls（支持上下文 + 模板）
import { chatCompletion, parseJson } from './llm.js';
import { BUCKETS, DEFAULT_ROUTE_SYS, DEFAULT_ROUTE_USER, renderPrompt } from './config.js';

export async function routeQuery(settings, userMessage, soulsContents, contextText = '') {
    const cfg = settings.routeLLM.useExtract ? settings.extractLLM : settings.routeLLM;
    const soulsText = soulsContents.length
        ? soulsContents.map((s) => `=== ${s.name} ===\n${s.content}`).join('\n\n')
        : '(无)';
    const buckets = BUCKETS.join('、');

    const tplSys = settings.prompts?.routeSys || DEFAULT_ROUTE_SYS;
    const tplUser = settings.prompts?.routeUser || DEFAULT_ROUTE_USER;

    const sys = renderPrompt(tplSys, { soulsText, userMessage, context: contextText || userMessage, buckets });
    const user = renderPrompt(tplUser, { soulsText, userMessage, context: contextText || userMessage, buckets });

    const content = await chatCompletion(
        cfg,
        [
            { role: 'system', content: sys },
            { role: 'user', content: user },
        ],
        { json: true, _traceStep: 'route', _traceLabel: '路由决策' },
    );

    const p = parseJson(content) || {};
    const bucketsSel = Array.isArray(p.buckets) ? p.buckets.filter((b) => BUCKETS.includes(b)) : [];
    const soulsSel = Array.isArray(p.souls) ? p.souls.map(String) : [];
    return { buckets: bucketsSel, souls: soulsSel };
}
