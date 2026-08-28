// 调试日志与列表渲染 — Modernized + Trace (容错：trace 可选)
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function setStatus(state, text) {
    const dot = document.getElementById('arcextreme-status-dot');
    const lab = document.getElementById('arcextreme-status-label');
    if (!dot || !lab) return;
    dot.className = 'ax-status__dot' + (state ? ` is-${state}` : '');
    lab.textContent = text;
}

export function log(msg) {
    const el = document.getElementById('arcextreme-log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const lines = (el.textContent || '').split('\n');
    if (lines.length > 180) el.textContent = lines.slice(-120).join('\n') + '\n';
    el.textContent += `[${ts}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
    if (/后端状态|已重建|已记录|注入完成/.test(msg)) setStatus('ok', '已连接');
    else if (/不可达|失败|错误/.test(msg)) setStatus('err', '异常');
}

export function renderSoulsList(items) {
    const ul = document.getElementById('arcextreme-souls');
    if (!ul) return;
    if (!items.length) {
        ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-inbox"></i> 后端未提供 souls 文件</li>';
        setStatus('warn', '无 souls');
        return;
    }
    ul.innerHTML = items
        .map((s) => {
            const fmt = escapeHtml(s.format || 'soul');
            const name = escapeHtml(s.name);
            const title = escapeHtml(s.filename || s.name);
            return `<li title="${title}"><span class="tag tag--soul">${fmt}</span><span class="ax-event__text">${name}</span></li>`;
        })
        .join('');
}

export function renderEventsList(items, onDelete) {
    const ul = document.getElementById('arcextreme-events');
    if (!ul) return;
    if (!items.length) {
        ul.innerHTML = '<li class="ax-empty"><i class="fa-solid fa-feather"></i> 暂无已记录事件<br><small style="opacity:.6">与 AI 聊天后会自动提炼事件</small></li>';
        return;
    }
    ul.innerHTML = items
        .map((e) => {
            const bucket = escapeHtml(e.time_bucket || '—');
            const text = escapeHtml(e.event_text);
            // souls 兼容：可能是数组（无数个）或旧单串/逗号串
            let soulsArr = [];
            if (Array.isArray(e.souls)) soulsArr = e.souls;
            else if (typeof e.souls === 'string' && e.souls.trim()) {
                try {
                    const parsed = JSON.parse(e.souls);
                    soulsArr = Array.isArray(parsed) ? parsed : [e.souls];
                } catch {
                    soulsArr = e.souls.includes(',') ? e.souls.split(',').map(s=>s.trim()).filter(Boolean) : [e.souls];
                }
            } else if (e.souls_str) {
                soulsArr = String(e.souls_str).split(',').map(s=>s.trim()).filter(Boolean);
            }
            const soulsTags = soulsArr.length ? `<span class="ax-event__meta">${soulsArr.map(s=>`<span class="tag tag--soul" style="margin-right:4px"><i class="fa-solid fa-user-tag"></i> ${escapeHtml(s)}</span>`).join('')}</span>` : '';
            const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
            return `<li data-id="${e.id}">
                <span class="tag">${bucket}</span>
                <span class="ax-event__text">${text}${soulsTags}${time ? `<span class="ax-event__meta"><i class="fa-regular fa-clock"></i> ${escapeHtml(time)}</span>` : ''}</span>
                <span class="score" title="删除此事件"><i class="fa-solid fa-xmark"></i></span>
            </li>`;
        })
        .join('');
    ul.querySelectorAll('li .score').forEach((node) => {
        node.addEventListener('click', () => {
            const id = Number(node.closest('li')?.getAttribute('data-id'));
            if (!Number.isNaN(id)) onDelete(id);
        });
    });
}

// ---------- Pipeline / TOAST 辅助 ----------
export function pushToast(kind, msg) {
    try {
        const t = window.toastr;
        if (!t) return;
        const title = 'ArcEXtreme';
        if (kind === 'ok') t.success(msg, title);
        else if (kind === 'fail') t.error(msg, title);
        else if (kind === 'warn') t.warning(msg, title);
        else t.info(msg, title);
    } catch {}
}

// ---------- Trace 渲染（动态加载，失败则静默） ----------
function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString(); } catch { return ''; } }
function stepIcon(step) {
    if (step === 'extract') return 'fa-wand-magic-sparkles';
    if (step === 'route') return 'fa-route';
    if (step === 'rerank') return 'fa-arrow-up-wide-short';
    return 'fa-microchip';
}
function statusBadge(s) {
    if (s === 'running') return '<span class="ax-trace__badge is-running"><i class="fa-solid fa-spinner fa-spin"></i> 调用中</span>';
    if (s === 'ok') return '<span class="ax-trace__badge is-ok"><i class="fa-solid fa-check"></i> 成功</span>';
    if (s === 'fail') return '<span class="ax-trace__badge is-fail"><i class="fa-solid fa-triangle-exclamation"></i> 失败</span>';
    return `<span class="ax-trace__badge">${escapeHtml(s)}</span>`;
}

let _traceMod = null;
async function getTraceMod() {
    if (_traceMod) return _traceMod;
    try {
        _traceMod = await import('./trace.js');
        return _traceMod;
    } catch {
        _traceMod = null;
        return null;
    }
}

let _traceFilter = 'all';
let _traceAutoCollapse = true;
let _tracePage = 1;
const TRACE_PAGE_SIZE = 12;
export async function renderTraceList(entries) {
    const ul = document.getElementById('arcextreme-trace');
    const empty = document.getElementById('arcextreme-trace-empty');
    const countEl = document.getElementById('arcextreme-trace-count');
    const pagingEl = document.getElementById('arcextreme-trace-paging');
    // 折叠逻辑：perEvent 45条时折叠
    let collapse = false;
    try{
        const s = window.extension_settings?.['arcextreme'];
        collapse = !!(s?.shortPool?.subAgentCollapseTrace);
        const chk = document.getElementById('arcextreme-trace-autocollapse');
        if(chk) _traceAutoCollapse = chk.checked;
    }catch{}
    let displayEntries = entries;
    let collapsedGroups = [];
    if (collapse) {
        // 将 5秒内 的连续 subagent 条目折叠为1条汇总
        const groups=[];
        let cur=[];
        let lastTs=0;
        for(const e of entries){
            if(e.step==='subagent' || e.label?.includes('SubAgent')){
                if(!cur.length) { cur=[e]; lastTs=e.ts; }
                else if(Math.abs(e.ts - lastTs) < 8000) { cur.push(e); lastTs=e.ts; }
                else { if(cur.length) groups.push(cur); cur=[e]; lastTs=e.ts; }
            } else {
                if(cur.length){ groups.push(cur); cur=[]; }
            }
        }
        if(cur.length) groups.push(cur);
        // 若有折叠组且组内>2，则替换为汇总条
        if(groups.some(g=>g.length>2)){
            const set = new Set();
            for(const g of groups) for(const x of g) set.add(x.id);
            const collapsedMap = new Map();
            for(const g of groups){
                if(g.length>2){
                    const ok=g.filter(x=>x.status==='ok').length, fail=g.filter(x=>x.status==='fail').length, run=g.filter(x=>x.status==='running').length;
                    const summary={
                        id: g[0].id,
                        ts: g[0].ts,
                        step:'subagent',
                        label:`SubAgent 裁判 ×${g.length}（角色隔离${g.length<=15?'单角色':''} 折叠）`,
                        model: g[0].model||'—',
                        status: run? 'running' : (fail? 'fail':'ok'),
                        ms: g.reduce((a,b)=>a+(b.ms||0),0),
                        raw: g.map(x=>`[${x.label} ${x.status}] ${String(x.raw||x.error||'').slice(0,500)}`).join('\n---\n').slice(0,8000),
                        error: fail? `${fail}条失败`:'',
                        cfgSnapshot: g[0].cfgSnapshot,
                        _collapsed: true,
                        _count: g.length,
                        _children: g,
                    };
                    collapsedMap.set(g[0].id, summary);
                }
            }
            displayEntries = entries.filter(e=> !set.has(e.id) || collapsedMap.has(e.id)).map(e=> collapsedMap.get(e.id) || e);
            // 去重已折叠的后续项
            const seenCollapse=new Set();
            displayEntries = displayEntries.filter(e=>{
                if(e._collapsed){
                    if(seenCollapse.has(e.id)) return false;
                    seenCollapse.add(e.id);
                }
                return true;
            });
            collapsedGroups = groups;
        }
    }
    // 过滤
    let filtered = displayEntries;
    if(_traceFilter==='fail') filtered = displayEntries.filter(e=>e.status==='fail');
    else if(_traceFilter==='subagent') filtered = displayEntries.filter(e=>e.step==='subagent' || e.label?.includes('SubAgent'));
    else if(_traceFilter==='extract') filtered = displayEntries.filter(e=>e.step==='extract');

    // 密度优化：当不折叠时，按8秒批次插入分组头，不藏条目
    const needBatchHeaders = !collapse && filtered.some(e=>e.step==='subagent');
    let groupedForHeader = null;
    if(needBatchHeaders){
        groupedForHeader = [];
        let cur=[];
        let lastTs=0;
        for(const e of filtered){
            if(e.step==='subagent' || e.label?.includes('SubAgent')){
                if(!cur.length){ cur=[e]; lastTs=e.ts; }
                else if(Math.abs(e.ts-lastTs)<8000){ cur.push(e); lastTs=e.ts; }
                else{ groupedForHeader.push(cur); cur=[e]; lastTs=e.ts; }
            } else {
                if(cur.length){ groupedForHeader.push(cur); cur=[]; }
            }
        }
        if(cur.length) groupedForHeader.push(cur);
    }

    // 分页
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / TRACE_PAGE_SIZE));
    if(_tracePage>pages) _tracePage=pages;
    let pageSlice = filtered.slice((_tracePage-1)*TRACE_PAGE_SIZE, _tracePage*TRACE_PAGE_SIZE);
    if (countEl) countEl.textContent = String(entries.length) + (displayEntries.length!==entries.length? ` (折叠→${displayEntries.length})`:'') + (filtered.length!==displayEntries.length? ` · 筛选${filtered.length}`:'');
    if(pagingEl) pagingEl.textContent = `${_tracePage}/${pages} · ${total}条` + (_traceAutoCollapse?' · 自动折叠开':'');
    if (!ul) return;
    if (!entries.length) {
        ul.innerHTML = '';
        if (empty) empty.style.display = 'flex';
        return;
    }
    if (empty) empty.style.display = 'none';
    if(!filtered.length){
        ul.innerHTML = '<li class="ax-empty" style="padding:18px; text-align:center; opacity:.6">筛选无结果</li>';
        return;
    }
    // 插入批次头（不折叠时的清晰分组）
    let htmlParts=[];
    let renderedIds=new Set();
    if(needBatchHeaders && groupedForHeader){
        // 为分页切片重建带头结构
        const pageSet=new Set(pageSlice.map(x=>x.id));
        for(const g of groupedForHeader){
            const inPage=g.filter(x=>pageSet.has(x.id));
            if(inPage.length){
                const headerTs=new Date(g[0].ts).toLocaleTimeString();
                const ok=g.filter(x=>x.status==='ok').length, fail=g.filter(x=>x.status==='fail').length;
                htmlParts.push(`<li class="ax-trace__batchhead"><i class="fa-solid fa-layer-group"></i> SubAgent 批次 ${headerTs} · ${g.length}条 <span class="ax-trace__batchcount">${ok}✓ ${fail?fail+'✗':''}</span></li>`);
                for(const e of inPage){
                    renderedIds.add(e.id);
                }
            }
        }
    }
    ul.innerHTML = (htmlParts.join('') || '') + pageSlice.map(e => {
        const rawEsc = escapeHtml((e.raw || '').slice(0, 6000));
        const errEsc = escapeHtml(e.error || '');
        const modelEsc = escapeHtml(e.model || '—');
        const cfg = e.cfgSnapshot ? `temp=${e.cfgSnapshot.temperature ?? '—'} · max=${e.cfgSnapshot.maxTokens ?? '—'} · reasoning=${escapeHtml(e.cfgSnapshot.reasoningEffort || 'none')}` : '';
        const preview = e.raw ? rawEsc.slice(0, 500) : (e.error ? `<span style="color:#f87171">${errEsc.slice(0,300)}</span>` : '<span style="opacity:.5">等待返回…</span>');
        const autoCollapsed = _traceAutoCollapse && e.status==='ok' && e.step!=='subagent';
        return `<li class="ax-trace__item is-${e.status}${autoCollapsed?'':''}" data-id="${e.id}" ${autoCollapsed?'':''}>
            <div class="ax-trace__head">
                <span class="ax-trace__icon"><i class="fa-solid ${stepIcon(e.step)}"></i></span>
                <span class="ax-trace__name">${escapeHtml(e.label || e.step)}${e._collapsed?` <small style="opacity:.7">(${e._count}合1)</small>`:''}</span>
                <span class="ax-trace__model">${modelEsc}</span>
                ${statusBadge(e.status)}
                <span class="ax-trace__time">${fmtTime(e.ts)} · ${e.ms ? e.ms+'ms' : '…'}</span>
                <span class="ax-trace__chev"><i class="fa-solid fa-chevron-down"></i></span>
            </div>
            <div class="ax-trace__body" style="${autoCollapsed?'display:none':''}">
                ${e.cfgSnapshot ? `<div class="ax-trace__meta"><i class="fa-solid fa-sliders"></i> ${escapeHtml(cfg)}</div>` : ''}
                ${e.error ? `<div class="ax-trace__err"><i class="fa-solid fa-circle-xmark"></i> ${errEsc}</div>` : ''}
                <div class="ax-trace__rawwrap">
                    <div class="ax-trace__rawhead">
                        <span><i class="fa-solid fa-code"></i> 模型原始返回</span>
                        <span class="ax-trace__actions">
                            <span class="menu_button menu_button_icon ax-mini-btn ax-copy" data-copy="${e.id}" title="复制"><i class="fa-regular fa-copy"></i></span>
                        </span>
                    </div>
                    <pre class="ax-trace__raw">${rawEsc || (e.error ? '' : '（无内容）')}</pre>
                </div>
                ${preview && e.raw && e.raw.length>500 ? `<div class="ax-trace__preview">${preview}${e.raw.length>500?' …':''}</div>` : ''}
            </div>
        </li>`;
    }).join('');

    ul.querySelectorAll('.ax-trace__head').forEach(head => {
        head.addEventListener('click', () => {
            const li = head.closest('.ax-trace__item');
            li.classList.toggle('is-open');
        });
    });
    // 复制需拿到 traceStore
    const mod = await getTraceMod();
    const store = mod ? mod.traceStore : [];
    ul.querySelectorAll('.ax-copy').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const id = Number(btn.getAttribute('data-copy'));
            const ent = store.find(x=>x.id===id);
            if (!ent) return;
            try { await navigator.clipboard.writeText(ent.raw || ent.error || ''); pushToast('ok','已复制'); } catch { pushToast('fail','复制失败'); }
        });
    });
}

let _traceInit = false;
export async function initTraceUI() {
    if (_traceInit) return;
    _traceInit = true;
    try {
        const mod = await getTraceMod();
        if (!mod) return;
        const ul = document.getElementById('arcextreme-trace');
        if (!ul) return;
        mod.onTrace((entries) => renderTraceList(entries));
        renderTraceList([...mod.traceStore]);

        const clearBtn = document.getElementById('arcextreme-trace-clear');
        if (clearBtn) clearBtn.addEventListener('click', () => { try { mod.clearTrace(); _tracePage=1; } catch {} log('已清空调用轨迹'); });
        // 筛选
        document.querySelectorAll('.ax-trace__filter').forEach(f=>{
            f.addEventListener('click', ()=>{
                document.querySelectorAll('.ax-trace__filter').forEach(x=>x.classList.remove('is-active'));
                f.classList.add('is-active');
                _traceFilter=f.getAttribute('data-filter')||'all';
                _tracePage=1;
                renderTraceList([...mod.traceStore]);
            });
        });
        const collapseBtn=document.getElementById('arcextreme-trace-collapse-all');
        if(collapseBtn) collapseBtn.addEventListener('click', ()=>{ document.querySelectorAll('.ax-trace__item').forEach(li=> li.classList.remove('is-open')); });
        const expandBtn=document.getElementById('arcextreme-trace-expand-all2');
        if(expandBtn) expandBtn.addEventListener('click', ()=>{ document.querySelectorAll('.ax-trace__item').forEach(li=> li.classList.add('is-open')); });
        const autoChk=document.getElementById('arcextreme-trace-autocollapse');
        if(autoChk) autoChk.addEventListener('change', ()=>{ _traceAutoCollapse=autoChk.checked; renderTraceList([...mod.traceStore]); });
        // 分页点击由外部控制：简单上下页
        const pagingEl=document.getElementById('arcextreme-trace-paging');
        if(pagingEl){
            pagingEl.style.cursor='pointer';
            pagingEl.title='点击翻页';
            pagingEl.addEventListener('click', ()=>{
                _tracePage = (_tracePage % Math.max(1, Math.ceil((()=>{
                    let c=0; try{const s=window.extension_settings?.['arcextreme']; c= !!(s?.shortPool?.subAgentCollapseTrace);}catch{}; return c;
                })() ? 0 : 0)))+1; // 占位
                // 实际分页翻页通过下方按钮实现，这里简化为下一页
                const total = mod.traceStore.length;
                const pages = Math.max(1, Math.ceil(total/TRACE_PAGE_SIZE));
                _tracePage = _tracePage % pages +1;
                renderTraceList([...mod.traceStore]);
            });
        }
        // 滚轮分页
        ul.addEventListener('wheel', (e)=>{
            if(e.deltaY>30 && _tracePage < Math.ceil(mod.traceStore.length/TRACE_PAGE_SIZE)) { _tracePage++; renderTraceList([...mod.traceStore]); }
            else if(e.deltaY<-30 && _tracePage>1) { _tracePage--; renderTraceList([...mod.traceStore]); }
        }, {passive:true});

        const pipeline = document.getElementById('arcextreme-pipeline');
        if (pipeline) {
            mod.onTrace(entries => {
                const running = entries.find(e=>e.status==='running');
                if (running) {
                    pipeline.setAttribute('data-running', running.step);
                    pipeline.querySelectorAll('.ax-pipe__dot').forEach(d=>{
                        d.classList.toggle('is-active', d.getAttribute('data-step')===running.step);
                        d.classList.toggle('is-running', d.getAttribute('data-step')===running.step);
                    });
                } else {
                    pipeline.removeAttribute('data-running');
                    pipeline.querySelectorAll('.ax-pipe__dot').forEach(d=>{ d.classList.remove('is-active','is-running'); });
                }
            });
        }
    } catch (e) {
        console.warn('[ArcEXtreme] trace UI 初始化失败，已降级', e);
    }
}

export { setStatus };
