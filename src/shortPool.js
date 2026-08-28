// 短期池本地镜像与策略（复用后端为源，本地仅缓存）
import { backend } from './backend.js';

export function medianBirthId(items) {
    if (!items || !items.length) return null;
    const sorted = [...items].sort((a,b)=> (a.birth_ts||a.timestamp||0) - (b.birth_ts||b.timestamp||0));
    const mid = Math.floor(sorted.length/2);
    return sorted[mid]?.id ?? sorted[mid]?.event_id ?? null;
}

export function sortBySkipDesc(items) {
    return [...items].sort((a,b)=> (b.skip||0)-(a.skip||0) || (a.birth_ts||0)-(b.birth_ts||0));
}

// 对前端已拿到的池数据做驱逐候选计算（与后端一致，仅用于预判/UI高亮）
export function candidatesForEvict(poolItems, skipThreshold=3) {
    return poolItems.filter(x => (x.skip||0) > skipThreshold).sort((a,b)=> (b.skip||0)-(a.skip||0));
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
