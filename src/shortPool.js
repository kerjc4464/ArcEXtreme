// 短期池本地镜像与策略（复用后端为源，本地仅缓存）
// A13省大核：小池候选少，过滤后排序即可；排序 comparator 与原来完全一致
import { backend } from './backend.js';

export function medianBirthId(items) {
    if (!items || !items.length) return null;
    const copy = items.slice();
    copy.sort((a,b)=> (a.birth_ts||a.timestamp||0) - (b.birth_ts||b.timestamp||0));
    const mid = Math.floor(copy.length/2);
    return copy[mid]?.id ?? copy[mid]?.event_id ?? null;
}

export function sortBySkipDesc(items) {
    // 调用方若只需前K，建议改用candidatesForEvict；此处保留语义但避免mutate入参
    return items.slice().sort((a,b)=> (b.skip||0)-(a.skip||0) || ((a.birth_ts||0)-(b.birth_ts||0)));
}

// 对前端已拿到的池数据做驱逐候选计算（与后端一致，仅用于预判/UI高亮）
export function candidatesForEvict(poolItems, skipThreshold=3) {
    const out = [];
    for (let i = 0; i < poolItems.length; i++) {
        const x = poolItems[i];
        if ((x.skip || 0) > skipThreshold) out.push(x);
    }
    // 候选通常很少，排序开销可忽略
    out.sort((a,b)=> (b.skip||0)-(a.skip||0));
    return out;
}

// 按soul分组
export function groupBySoul(items) {
    const g={};
    for(const it of items){
        const s=it.pool_soul||it.state_soul||it.soul||'unknown';
        (g[s]||(g[s]=[])).push(it);
    }
    return g;
}

// 简单的本地池大小检查
export function needVacancyCount(poolItems, cap, need=1) {
    if (poolItems.length >= cap) return need;
    return 0;
}
