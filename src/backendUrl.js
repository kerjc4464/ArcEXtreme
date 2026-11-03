// 统一后端地址解析，收敛三处重复的 getBackendBase
import { SETTINGS_KEY } from './config.js';

// A13省单核：缓存解析结果，backendUrl不变时零new URL/零正则
let _cachedRaw = null;
let _cachedBase = null;
let _cachedPageHost = null;

export function getBackendBase() {
    try {
        const s = window.extension_settings?.[SETTINGS_KEY];
        const raw = s?.backendUrl ?? localStorage.getItem('arcextreme_backend') ?? '';
        const pageHost = window.location.hostname || '';
        if (raw === _cachedRaw && pageHost === _cachedPageHost && _cachedBase) return _cachedBase;
        let u = String(raw || '').trim();
        let out;
        if (!u) {
            if (pageHost && pageHost !== '' && pageHost !== '127.0.0.1' && pageHost !== 'localhost') {
                out = `http://${pageHost}:9001`;
            } else {
                out = 'http://127.0.0.1:9001';
            }
        } else {
            u = u.replace(/\/+$/, '');
            try {
                const backendHost = new URL(u).hostname;
                if ((backendHost === '127.0.0.1' || backendHost === 'localhost') && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
                    const fixed = u.replace(backendHost, pageHost);
                    console.warn(`[ArcEXtreme] 后端地址自动修正：${u} -> ${fixed}（页面 ${pageHost}）`);
                    out = fixed;
                } else {
                    out = u;
                }
            } catch { out = u; }
        }
        _cachedRaw = raw;
        _cachedPageHost = pageHost;
        _cachedBase = out;
        return out;
    } catch { return 'http://127.0.0.1:9001'; }
}

export function invalidateBackendBaseCache() {
    _cachedRaw = null;
    _cachedBase = null;
    _cachedPageHost = null;
}
