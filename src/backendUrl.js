// 统一后端地址解析，收敛三处重复的 getBackendBase
import { SETTINGS_KEY } from './config.js';

export function getBackendBase() {
    try {
        const s = window.extension_settings?.[SETTINGS_KEY];
        let raw = s?.backendUrl ?? localStorage.getItem('arcextreme_backend');
        let u = String(raw || '').trim();
        if (!u) {
            const pageHost = window.location.hostname;
            if (pageHost && pageHost !== '' && pageHost !== '127.0.0.1' && pageHost !== 'localhost') {
                return `http://${pageHost}:9001`;
            }
            return 'http://127.0.0.1:9001';
        }
        u = u.replace(/\/+$/, '');
        try {
            const pageHost = window.location.hostname;
            const backendHost = new URL(u).hostname;
            if ((backendHost === '127.0.0.1' || backendHost === 'localhost') && pageHost && pageHost !== '127.0.0.1' && pageHost !== 'localhost' && pageHost !== '') {
                const fixed = u.replace(backendHost, pageHost);
                console.warn(`[ArcEXtreme] 后端地址自动修正：${u} -> ${fixed}（页面 ${pageHost}）`);
                return fixed;
            }
        } catch {}
        return u;
    } catch { return 'http://127.0.0.1:9001'; }
}
