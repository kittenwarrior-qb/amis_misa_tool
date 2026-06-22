// ==UserScript==
// @name         MISA AMIS - Tô màu đơn đặt hàng theo xuất kho (API)
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  Tô màu dòng đơn đặt hàng dựa trên API get_paging_detail: Xanh=xuất đủ, Vàng=xuất một phần, Đỏ=chưa xuất kho. Tự bắt token, chạy được dù site có CSP.
// @author       You
// @match        https://actapp.misa.vn/*
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      actapp.misa.vn
// @connect      self
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Cửa sổ THẬT của trang (để chặn XHR của app). Chạy trong sandbox nên cần unsafeWindow.
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const hasGM = (typeof GM_xmlhttpRequest !== 'undefined');

    /* ══════════════════════════════════════════════════════════════
       1. CẤU HÌNH
    ══════════════════════════════════════════════════════════════ */
    const API_DETAIL_PATH = '/g2/api/sa/v1/sa_order/get_paging_detail';

    const FIELD_QTY      = 'quantity';              // Số lượng đặt
    const FIELD_EXPORTED = 'quantity_delivered_in'; // Số lượng đã xuất kho

    const CONCURRENCY = 6;

    // Cột "SL gốc" chèn thêm vào lưới
    let SHOW_COLUMN = false;
    const COL_TITLE = 'Số lượng';
    const COL_WIDTH = 110;
    const COL_ANCHOR = 'Giá trị đã xuất hóa đơn'; // chèn cột mới NGAY TRƯỚC cột này
    let qtyByNo = {}; // số đơn -> { qty, exported } (đổ đầy sau khi Quét)

    const DEFAULT_DETAIL_BODY = {
        columns: [2157, 1355, 5274, 3870, 3878, 3876, 5279, 308, 5364, 5350, 5936, 3404, 5476, 5575, 2358],
        sort: '[{"property":4555,"desc":false,"data_type":4,"operand":1}]',
        filter: [{ property: 3993, operator: 7, operand: 1, value: '__REFID__', data_type: 10 }],
        pageIndex: 1,
        pageSize: 20,
        useSp: false,
        summaryColumns: [3488, 3870, 3878, 3879, 3876, 3877, 2717, 2719, 308, 5350],
        loadMode: 3,
    };

    /* ══════════════════════════════════════════════════════════════
       2. MÀU SẮC
    ══════════════════════════════════════════════════════════════ */
    const COLOR = {
        full:    { bg: '#c8e6c9', activeBg: '#81c784', border: '#2e7d32', label: 'Đã xuất đủ số lượng' },
        partial: { bg: '#fff9c4', activeBg: '#ffd54f', border: '#f9a825', label: 'Xuất kho một phần' },
        none:    { bg: '#ffcdd2', activeBg: '#ef9a9a', border: '#c62828', label: 'Chưa có phiếu xuất kho' },
        zero:    { bg: '#eeeeee', activeBg: '#bdbdbd', border: '#9e9e9e', label: 'Đơn không có hàng' },
    };
    const COLOR_CLASSES = Object.keys(COLOR).map(k => `misa-${k}`);

    // Registry màu hiện tại để MutationObserver có thể re-apply khi MISA override
    const coloredRows = new Map();   // <tr> → COLOR entry
    const rowBaseClasses = new Map(); // <tr> → Set<string> — snapshot class lúc vừa tô màu
    let colorObserver = null;

    /* ══════════════════════════════════════════════════════════════
       3. STATE bắt được từ network
    ══════════════════════════════════════════════════════════════ */
    const cap = {
        creds: {},
        listUrl: null,
        listBody: null,
        listResp: null,
        detailBody: null,
    };
    const hasCreds = () => !!cap.creds.Authorization;

    const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    /* ══════════════════════════════════════════════════════════════
       4. INTERCEPT NETWORK (trên cửa sổ THẬT)
    ══════════════════════════════════════════════════════════════ */
    function captureCredHeader(k, v) {
        if (!k) return;
        const lk = String(k).toLowerCase();
        if (lk === 'authorization')  cap.creds.Authorization = v;
        if (lk === 'x-misa-context') cap.creds['X-MISA-Context'] = v;
        if (lk === 'x-device')       cap.creds['X-Device'] = v;
    }

    const isSaApi     = u => u && /\/g2\/api\/sa\//.test(u);
    const isDetailUrl = u => u && u.includes(API_DETAIL_PATH);

    // Một response là "danh sách đơn" nếu PageData[] có refid (GUID)
    function looksLikeOrderList(json) {
        const pd = json && json.Data && json.Data.PageData;
        if (!Array.isArray(pd) || !pd.length) return false;
        const o = pd[0];
        return Object.keys(o).some(k => /refid/i.test(k) && GUID.test(String(o[k])))
            || Object.values(o).some(v => GUID.test(String(v)));
    }

    function maybeStoreList(url, text, body) {
        try {
            const j = JSON.parse(text);
            if (looksLikeOrderList(j)) {
                cap.listResp = j.Data.PageData;
                cap.listUrl = new URL(url, location.origin).href;
                if (body != null) cap.listBody = body;
            }
        } catch (e) {}
    }

    // ----- XHR -----
    const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (XP) {
        const _open = XP.open, _send = XP.send, _setH = XP.setRequestHeader;
        XP.open = function (_m, url) { this.__u = url; return _open.apply(this, arguments); };
        XP.setRequestHeader = function (k, v) { try { captureCredHeader(k, v); } catch (e) {} return _setH.apply(this, arguments); };
        XP.send = function (body) {
            try {
                const url = this.__u || '';
                if (isDetailUrl(url) && body) cap.detailBody = body;
                if (isSaApi(url) && !isDetailUrl(url)) {
                    const self = this;
                    this.addEventListener('load', function () {
                        if (self.responseType === '' || self.responseType === 'text') {
                            maybeStoreList(url, self.responseText, body);
                        }
                    });
                }
            } catch (e) {}
            return _send.apply(this, arguments);
        };
    }

    // ----- fetch (dự phòng) -----
    if (W.fetch) {
        const _fetch = W.fetch;
        W.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url);
                const h = (init && init.headers) || (input && input.headers);
                if (h) {
                    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => captureCredHeader(k, v));
                    else Object.keys(h).forEach(k => captureCredHeader(k, h[k]));
                }
                if (isDetailUrl(url) && init && init.body) cap.detailBody = init.body;
                const body = init && init.body;
                const p = _fetch.apply(this, arguments);
                if (isSaApi(url) && !isDetailUrl(url)) {
                    p.then(r => { try { r.clone().text().then(t => maybeStoreList(url, t, body)).catch(() => {}); } catch (e) {} });
                }
                return p;
            } catch (e) {
                return _fetch.apply(this, arguments);
            }
        };
    }

    /* ══════════════════════════════════════════════════════════════
       5. GỌI API (GM_xmlhttpRequest → vượt CSP/CORS)
    ══════════════════════════════════════════════════════════════ */
    function num(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
        return isNaN(n) ? null : n;
    }

    function apiPost(url, body) {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const headers = Object.assign({
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
        }, cap.creds);

        if (hasGM) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST', url, headers, data,
                    onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
                    onerror: () => reject(new Error('network')),
                    ontimeout: () => reject(new Error('timeout')),
                });
            });
        }
        return W.fetch(url, { method: 'POST', headers, body: data, credentials: 'include' }).then(r => r.json());
    }

    async function fetchOrderList() {
        if (cap.listUrl && cap.listBody != null) {
            try {
                const j = await apiPost(cap.listUrl, cap.listBody);
                if (j && j.Data && j.Data.PageData) return j.Data.PageData;
            } catch (e) { console.warn('[MISA màu] replay list lỗi:', e); }
        }
        return cap.listResp || [];
    }

    function buildDetailBody(refid) {
        let obj;
        try {
            obj = cap.detailBody
                ? JSON.parse(typeof cap.detailBody === 'string' ? cap.detailBody : JSON.stringify(cap.detailBody))
                : JSON.parse(JSON.stringify(DEFAULT_DETAIL_BODY));
        } catch (e) { obj = JSON.parse(JSON.stringify(DEFAULT_DETAIL_BODY)); }

        if (Array.isArray(obj.filter) && obj.filter.length) {
            const f = obj.filter.find(x => x.property === 3993) || obj.filter[0];
            f.value = refid;
        } else {
            obj.filter = [{ property: 3993, operator: 7, operand: 1, value: refid, data_type: 10 }];
        }
        obj.loadMode = 3;
        return JSON.stringify(obj);
    }

    async function fetchOrderSummary(refid) {
        const j = await apiPost(location.origin + API_DETAIL_PATH, buildDetailBody(refid));
        const s = (j && j.Data && j.Data.SummaryData) || {};
        return { qty: num(s[FIELD_QTY]), exported: num(s[FIELD_EXPORTED]) };
    }

    /* ══════════════════════════════════════════════════════════════
       6. TRÍCH refid / số đơn
    ══════════════════════════════════════════════════════════════ */
    function pickRefid(o) {
        if (o.refid && GUID.test(String(o.refid))) return o.refid;
        for (const k of Object.keys(o)) if (/refid|ref_id/i.test(k) && GUID.test(String(o[k]))) return o[k];
        for (const k of Object.keys(o)) if (GUID.test(String(o[k]))) return o[k];
        return null;
    }
    function pickOrderNo(o) {
        for (const k of ['sa_order_no', 'order_no', 'no', 'code']) if (o[k]) return String(o[k]).trim();
        for (const k of Object.keys(o)) if (/(order_no|_no$|^no$|code)/i.test(k) && typeof o[k] === 'string') return o[k].trim();
        return null;
    }

    /* ══════════════════════════════════════════════════════════════
       7. DOM
    ══════════════════════════════════════════════════════════════ */
    function getOrderRows() {
        return Array.from(document.querySelectorAll('tr.ms-tr-viewer')).filter(r => r.querySelector('.drilldown'));
    }
    function orderNoOfRow(row) {
        const sp = row.querySelector('.drilldown .cell-text span') || row.querySelector('.drilldown span');
        return sp ? sp.textContent.trim() : '';
    }
    function classify(qty, exported) {
        qty = qty || 0; exported = exported || 0;
        if (qty === 0) return 'zero';
        if (exported >= qty) return 'full';
        if (exported > 0) return 'partial';
        return 'none';
    }

    function reapplyColor(row) {
        const c = coloredRows.get(row);
        if (!c) return;
        const base = rowBaseClasses.get(row);
        // Nếu có class mới so với lúc snapshot → MISA đang active row này
        const isActive = base && [...row.classList].some(cls => !base.has(cls));
        const bg = (isActive && c.activeBg) ? c.activeBg : c.bg;
        row.querySelectorAll('td').forEach((td, i) => {
            td.style.setProperty('background-color', bg, 'important');
            if (i === 0) td.style.setProperty('box-shadow', `inset 4px 0 0 ${c.border}`, 'important');
        });
    }

    function applyColor(row, key) {
        COLOR_CLASSES.forEach(c => row.classList.remove(c));
        row.querySelectorAll('td').forEach(td => {
            td.style.removeProperty('background-color');
            td.style.removeProperty('box-shadow');
        });
        if (!key) { coloredRows.delete(row); rowBaseClasses.delete(row); return; }
        row.classList.add(`misa-${key}`);
        row.title = COLOR[key] ? COLOR[key].label : '';
        coloredRows.set(row, COLOR[key]);
        rowBaseClasses.set(row, new Set(row.classList)); // snapshot sau khi add class misa-*
        reapplyColor(row);
    }

    function clearAllColors() {
        getOrderRows().forEach(r => {
            COLOR_CLASSES.forEach(c => r.classList.remove(c));
            r.title = '';
            r.querySelectorAll('td').forEach(td => {
                td.style.removeProperty('background-color');
                td.style.removeProperty('box-shadow');
            });
        });
        coloredRows.clear();
        rowBaseClasses.clear();
        if (colorObserver) { colorObserver.disconnect(); colorObserver = null; }
    }

    // Giữ màu khi MISA thêm class active/selected vào row
    function startColorGuard() {
        if (colorObserver) colorObserver.disconnect();
        if (coloredRows.size === 0) return;
        const table = document.querySelector('table');
        if (!table) return;
        colorObserver = new MutationObserver(mutations => {
            mutations.forEach(m => {
                if (m.attributeName !== 'class') return;
                const row = m.target;
                if (!row.isConnected) { coloredRows.delete(row); return; }
                if (coloredRows.has(row)) reapplyColor(row);
            });
        });
        colorObserver.observe(table, { attributes: true, attributeFilter: ['class'], subtree: true });
    }

    let styleEl = null;
    let _vAttrCache = '';
    function injectStyles() {
        // Detect Vue scoped attribute (data-v-*) để tăng specificity hơn MISA's active state CSS
        const vAttr = (() => {
            const cell = document.querySelector('td.ms-td-viewer');
            if (!cell) return '';
            for (const attr of cell.attributes) if (attr.name.startsWith('data-v-')) return attr.name;
            return '';
        })();
        // Bỏ qua nếu style đã được inject và data-v không đổi
        if (styleEl && styleEl.isConnected && vAttr === _vAttrCache) return;
        if (styleEl) { try { styleEl.remove(); } catch (e) {} }
        _vAttrCache = vAttr;
        const vs = vAttr ? `[${vAttr}]` : '';
        // Specificity (0,4,2) > MISA's active state (0,4,0) → màu của ta thắng kể cả khi row được chọn
        const css = Object.entries(COLOR).map(([k, c]) => `
            tr.ms-tr-viewer.misa-${k} td${vs}.ms-td-viewer,
            tr.ms-tr-viewer.misa-${k} td.misa-qty-cell { background-color: ${c.bg} !important; }
        `).join('');
        if (typeof GM_addStyle !== 'undefined') {
            styleEl = GM_addStyle(css);
        } else {
            styleEl = document.createElement('style');
            styleEl.textContent = css;
            (document.head || document.documentElement).appendChild(styleEl);
        }
    }

    /* ══════════════════════════════════════════════════════════════
       7b. CỘT "SL gốc" — chèn vào lưới chính
    ══════════════════════════════════════════════════════════════ */
    function formatVN(n) {
        if (n == null) return '';
        try { return Number(n).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        catch (e) { return String(n); }
    }

    // Liệt kê các ô (th/td) theo đúng thứ tự hiển thị, "mở phẳng" div.dis-contents
    function effectiveCells(tr) {
        const out = [];
        for (const child of tr.children) {
            if (child.tagName === 'TH' || child.tagName === 'TD') out.push(child);
            else if (child.classList && child.classList.contains('dis-contents')) {
                for (const c of child.children) if (c.tagName === 'TH' || c.tagName === 'TD') out.push(c);
            }
        }
        return out;
    }

    function headerThText(th) {
        const sp = th.querySelector('.ms-head-title') || th;
        return sp.textContent.trim();
    }
    // Tìm <th> header theo tiêu đề (vd "Giá trị đã xuất hóa đơn")
    function findHeaderTh(text) {
        for (const th of document.querySelectorAll('th.ms-th-viewer')) {
            if (headerThText(th) === text) return th;
        }
        return null;
    }

    // Header: chèn 1 <th> NGAY TRƯỚC cột mốc (COL_ANCHOR)
    function ensureHeaderCol() {
        if (document.querySelector('.misa-qty-col')) return;
        const refTh = findHeaderTh(COL_ANCHOR);
        const th = document.createElement('th');
        th.className = 'ms-th-viewer dymamic-col header misa-qty-col';
        th.style.cssText = `min-width:${COL_WIDTH}px;width:${COL_WIDTH}px;top:0px;`;
        th.innerHTML = `<div class="col-draggable justify-center">
            <span class="ms-head-title flex justify-center"><span>${COL_TITLE}</span></span></div>`;
        // Copy màu nền + data-v-* (Vue scoped) xuống cả cây con để CSS Vue áp dụng đúng
        if (refTh) {
            const cs = getComputedStyle(refTh);
            th.style.backgroundColor = cs.backgroundColor;
            th.style.color = cs.color;
            const va = [...refTh.attributes].find(a => a.name.startsWith('data-v-'));
            if (va) [th, ...th.querySelectorAll('*')].forEach(el => el.setAttribute(va.name, ''));
        }
        if (refTh && refTh.parentNode) refTh.parentNode.insertBefore(th, refTh);
        else { // fallback: cuối nhóm cột động
            const w = document.querySelector('div.dis-contents');
            if (w) w.appendChild(th);
        }
    }

    // Body + footer: chèn 1 <td> vào mỗi dòng, đúng cột với header
    function ensureBodyCells() {
        const refTh = findHeaderTh(COL_ANCHOR);
        if (!refTh) return;
        const headerTr = refTh.closest('tr');
        const table = refTh.closest('table');
        if (!table || !headerTr) return;

        // chỉ số cột mốc, LOẠI TRỪ cột của mình (tránh lệch 1 ô)
        const headerCells = effectiveCells(headerTr).filter(c => !c.classList.contains('misa-qty-col'));
        const idx = headerCells.indexOf(refTh);
        if (idx < 0) return;

        table.querySelectorAll('tr').forEach(row => {
            if (row === headerTr) return;                          // header chính → xử lý riêng

            if (row.querySelector('th.ms-th-viewer')) {
                // Phân biệt frozen header (có .header) vs dòng Tổng/footer (không có .header)
                if (row.querySelector('th.ms-th-viewer.header')) return;

                // Dòng Tổng → chèn <th> trống để thẳng cột
                if (!row.querySelector('.misa-qty-cell')) {
                    const fCells = effectiveCells(row).filter(c => !c.classList.contains('misa-qty-cell'));
                    if (fCells.length <= idx) return;
                    const ref = fCells[idx];
                    if (!ref || !ref.parentNode) return;
                    const emptyTh = document.createElement('th');
                    emptyTh.className = 'ms-th-viewer dymamic-col misa-qty-cell';
                    emptyTh.style.cssText = `min-width:${COL_WIDTH}px;width:${COL_WIDTH}px;bottom:${ref.style.bottom || '42px'};`;
                    emptyTh.innerHTML = `<div class="flex justify-end"><span></span></div>`;
                    // Copy background + data-v-* để màu xám footer và hover áp dụng đúng
                    try {
                        const cs = getComputedStyle(ref);
                        const bg = cs.backgroundColor;
                        if (bg && bg !== 'rgba(0, 0, 0, 0)') emptyTh.style.backgroundColor = bg;
                        const va = [...ref.attributes].find(a => a.name.startsWith('data-v-'));
                        if (va) [emptyTh, ...emptyTh.querySelectorAll('*')].forEach(el => el.setAttribute(va.name, ''));
                    } catch(e) {}
                    ref.parentNode.insertBefore(emptyTh, ref);
                }
                return;
            }

            // Dòng đơn (data row)
            let cell = row.querySelector('.misa-qty-cell');
            if (!cell) {
                const cells = effectiveCells(row);
                if (cells.length < idx + 1) return;               // dòng không đủ cột → bỏ
                cell = document.createElement('td');
                cell.className = 'ms-td-viewer text-right misa-qty-cell';
                cell.innerHTML = `<div class="cell-content line-clamp-2"><div>
                    <div class="cell-text"><span isnumeric="true"></span></div></div></div>`;
                const ref = cells[idx];
                // Copy border + data-v-* (Vue scoped) xuống cả cây con
                // để hover/active/border CSS của MISA áp dụng đúng
                try {
                    const cs = getComputedStyle(ref);
                    ['borderRight', 'borderBottom', 'borderTop', 'borderLeft'].forEach(p => {
                        const v = cs[p];
                        if (v && !v.startsWith('0px')) cell.style[p] = v;
                    });
                    const va = [...ref.attributes].find(a => a.name.startsWith('data-v-'));
                    if (va) [cell, ...cell.querySelectorAll('*')].forEach(el => el.setAttribute(va.name, ''));
                } catch (e) {}
                if (ref && ref.parentNode) ref.parentNode.insertBefore(cell, ref);
                else row.appendChild(cell);
            }
            const span = cell.querySelector('span');
            if (!span) return;
            if (row.querySelector('.drilldown')) {
                const rec = qtyByNo[orderNoOfRow(row)];
                span.textContent = rec ? formatVN(rec.qty) : '';
            } else {
                span.textContent = '';
            }
        });
    }

    function removeColumn() {
        document.querySelectorAll('.misa-qty-col, .misa-qty-cell').forEach(el => el.remove());
    }

    function maintainColumn() {
        if (!SHOW_COLUMN) { removeColumn(); return; }
        try { ensureHeaderCol(); ensureBodyCells(); } catch (e) {}
    }

    /* ══════════════════════════════════════════════════════════════
       8. POOL
    ══════════════════════════════════════════════════════════════ */
    async function runPool(items, limit, worker, onProgress) {
        let idx = 0, done = 0;
        async function run() {
            while (idx < items.length) {
                const i = idx++;
                try { await worker(items[i], i); } catch (e) {}
                done++; onProgress && onProgress(done, items.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    }

    /* ══════════════════════════════════════════════════════════════
       9. QUÉT
    ══════════════════════════════════════════════════════════════ */
    async function scan(onProgress) {
        if (!hasCreds()) {
            alert('Chưa bắt được phiên đăng nhập (token).\nHãy bấm nút Làm mới (⟳) trên lưới đơn đặt hàng rồi quét lại.');
            return null;
        }
        const orders = await fetchOrderList();
        if (!orders.length) {
            alert('Không lấy được danh sách đơn.\nHãy bấm Làm mới (⟳) trên lưới rồi thử lại.');
            return null;
        }
        console.log('[MISA màu] mẫu đơn:', orders[0]);

        const meta = orders.map(o => ({
            refid: pickRefid(o),
            no: pickOrderNo(o),
            qty: num(o[FIELD_QTY]),
            exported: num(o[FIELD_EXPORTED]),
        }));

        const needDetail = meta.some(m => m.qty == null || m.exported == null);
        if (needDetail) {
            await runPool(meta, CONCURRENCY, async (m) => {
                if ((m.qty == null || m.exported == null) && m.refid) {
                    const s = await fetchOrderSummary(m.refid);
                    m.qty = s.qty; m.exported = s.exported;
                }
            }, onProgress);
        } else {
            onProgress && onProgress(meta.length, meta.length);
        }

        meta.forEach(m => { m.status = classify(m.qty, m.exported); });

        // map đầy đủ theo số đơn của API
        const byNo = {};
        meta.forEach(m => { if (m.no) byNo[m.no] = m; });

        const rows = getOrderRows();
        console.log('[MISA màu] đơn API:', meta.length, '| dòng DOM:', rows.length, meta);
        if (!rows.length) {
            alert('Không tìm thấy dòng nào trên lưới (DOM). Mở Console xem log "[MISA màu]".');
            return { full: 0, partial: 0, none: 0, zero: 0 };
        }

        // Tô màu + đổ dữ liệu cột; key qtyByNo theo SỐ ĐƠN ĐỌC TỪ DOM (khớp lúc hiện cột),
        // còn giá trị lấy theo khớp số đơn API, không khớp thì dựa theo thứ tự dòng (index).
        qtyByNo = {};
        const counts = { full: 0, partial: 0, none: 0, zero: 0 };
        rows.forEach((row, i) => {
            const domNo = orderNoOfRow(row);
            const m = (domNo && byNo[domNo]) || meta[i];
            if (!m) return;
            if (domNo) qtyByNo[domNo] = { qty: m.qty, exported: m.exported };
            const status = m.status;
            if (status) { applyColor(row, status); counts[status]++; }
        });
        maintainColumn();
        startColorGuard();
        return counts;
    }

    /* ══════════════════════════════════════════════════════════════
       10. DEBUG — gõ __misaColor.diag() trong Console
    ══════════════════════════════════════════════════════════════ */
    const dbg = {
        cap, scan, getOrderRows,
        diag() {
            const rows = getOrderRows();
            const info = {
                'Chạy trong sandbox': !hasGM ? 'KHÔNG (grant none?)' : 'CÓ (ok)',
                'Đã bắt token': !!cap.creds.Authorization,
                'Đã bắt X-MISA-Context': !!cap.creds['X-MISA-Context'],
                'Đã bắt X-Device': !!cap.creds['X-Device'],
                'URL danh sách bắt được': cap.listUrl || '(chưa)',
                'Số đơn trong response': cap.listResp ? cap.listResp.length : 0,
                'Số dòng DOM': rows.length,
                'Đơn dòng đầu (DOM)': rows[0] ? orderNoOfRow(rows[0]) : '(không có)',
                'Panel tồn tại': !!document.getElementById('misa-fab'),
            };
            console.table(info);
            if (cap.listResp && cap.listResp[0]) console.log('[MISA màu] mẫu object đơn:', cap.listResp[0]);
            return info;
        },
    };
    try { W.__misaColor = dbg; } catch (e) {}
    window.__misaColor = dbg;

    /* ══════════════════════════════════════════════════════════════
       11. PANEL
    ══════════════════════════════════════════════════════════════ */
    function createPanel() {
        if (document.getElementById('misa-fab')) return;

        // ── FAB (nút tròn toggle) ─────────────────────────────────
        const fab = document.createElement('div');
        fab.id = 'misa-fab';
        fab.style.cssText = [
            'position:fixed;bottom:24px;right:24px;z-index:2147483647;',
            'width:50px;height:50px;border-radius:50%;background:#fff;overflow:hidden;',
            'display:flex;align-items:center;justify-content:center;',
            'cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.25);',
            'user-select:none;transition:transform .15s,box-shadow .15s;',
        ].join('');
        fab.innerHTML = `<img src="https://satoriwater.org/wp-content/uploads/2024/01/logo-satori-vuong.webp"
            style="width:100%;height:100%;object-fit:cover;display:block;" draggable="false">`;
        fab.addEventListener('mouseenter', () => { fab.style.transform = 'scale(1.07)'; fab.style.boxShadow = '0 4px 16px rgba(0,0,0,.28)'; });
        fab.addEventListener('mouseleave', () => { fab.style.transform = ''; fab.style.boxShadow = '0 3px 14px rgba(0,0,0,.25)'; });
        document.body.appendChild(fab);

        // ── Panel (ẩn mặc định) ───────────────────────────────────
        const legend = Object.values(COLOR).map(c => `
            <div style="display:flex;align-items:center;gap:9px;margin:5px 0">
                <span style="flex-shrink:0;width:20px;height:20px;border-radius:3px;
                    background:${c.bg};border-left:4px solid ${c.border};
                    box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);display:inline-block;"></span>
                <span style="font-size:13.5px;line-height:1.3">${c.label}</span>
            </div>`).join('');

        const panel = document.createElement('div');
        panel.id = 'misa-panel';
        panel.style.cssText = [
            'position:fixed;bottom:84px;right:24px;z-index:2147483647;',
            'background:#fff;border:2px solid #1565c0;border-radius:10px;',
            'padding:12px 14px 10px;box-shadow:0 8px 32px rgba(21,101,192,.22),0 2px 8px rgba(0,0,0,.12);',
            'font:14px/1.5 "Segoe UI",Arial,sans-serif;color:#1a1a2e;',
            'width:218px;user-select:none;display:none;',
        ].join('');
        panel.innerHTML = `
            <div id="misa-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:move;">
                <strong style="font-size:14px;letter-spacing:.2px">Màu xuất kho</strong>
                <span id="misa-close" style="cursor:pointer;color:#bbb;font-size:17px;line-height:1;padding:0 4px;">✕</span>
            </div>
            <div style="margin-bottom:11px;padding-bottom:10px;border-bottom:1px solid #f0f0f0">${legend}</div>
            <div style="display:flex;flex-direction:column;gap:7px;">
                <button id="misa-scan" style="background:#1565c0;color:#fff;border:none;padding:10px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700;width:100%;letter-spacing:.2px;">Quét &amp; tô màu</button>
                <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;">
                    <input type="checkbox" id="misa-auto" style="width:14px;height:14px;accent-color:#1565c0;cursor:pointer;"> Tự động quét
                </label>
                <label style="display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;">
                    <input type="checkbox" id="misa-col" style="width:14px;height:14px;accent-color:#1565c0;cursor:pointer;"> Hiện cột Số lượng
                </label>
                <button id="misa-clear" style="background:#f5f5f5;color:#555;border:1px solid #e0e0e0;padding:8px;border-radius:6px;cursor:pointer;font-size:13px;width:100%;">Xóa màu</button>
            </div>
            <div id="misa-status" style="margin-top:9px;padding-top:8px;border-top:1px solid #f0f0f0;font-size:12px;color:#666;text-align:center;min-height:16px;"></div>`;
        document.body.appendChild(panel);

        // ── Toggle panel khi bấm FAB ──────────────────────────────
        let isOpen = false;
        function togglePanel(v) {
            isOpen = (v === undefined) ? !isOpen : v;
            panel.style.display = isOpen ? 'block' : 'none';
        }
        fab.onclick = () => togglePanel();

        // ── Logic nội dung panel ──────────────────────────────────
        const status = panel.querySelector('#misa-status');
        const scanBtn = panel.querySelector('#misa-scan');
        const autoBox = panel.querySelector('#misa-auto');
        const setStatus = m => { status.innerHTML = m; };
        const credBadge = () => hasCreds()
            ? '<span style="color:#2e7d32">●</span> sẵn sàng'
            : '<span style="color:#c62828">●</span> chờ token (bấm ⟳ trên lưới)';

        setStatus(credBadge());
        const t = setInterval(() => {
            if (!document.getElementById('misa-fab')) return clearInterval(t);
            const s = status.textContent;
            if (s.includes('chờ') || s.includes('sẵn sàng')) setStatus(credBadge());
        }, 1500);

        panel.querySelector('#misa-close').onclick = () => togglePanel(false);
        const clearBtn = panel.querySelector('#misa-clear');
        clearBtn.onclick = () => { clearAllColors(); setStatus('Đã xóa màu.'); };
        clearBtn.style.transition = 'background .15s,transform .15s,box-shadow .15s,border-color .15s';
        clearBtn.addEventListener('mouseenter', () => { clearBtn.style.background = '#ebebeb'; clearBtn.style.transform = 'translateY(-1px)'; clearBtn.style.boxShadow = '0 2px 8px rgba(0,0,0,.1)'; clearBtn.style.borderColor = '#c8c8c8'; });
        clearBtn.addEventListener('mouseleave', () => { clearBtn.style.background = '#f5f5f5'; clearBtn.style.transform = ''; clearBtn.style.boxShadow = ''; clearBtn.style.borderColor = '#e0e0e0'; });

        const colBox = panel.querySelector('#misa-col');
        colBox.checked = SHOW_COLUMN;
        colBox.onchange = () => { SHOW_COLUMN = colBox.checked; maintainColumn(); };

        let scanning = false;
        async function doScan() {
            if (scanning) return;
            scanning = true; scanBtn.disabled = true;
            const old = scanBtn.textContent;
            scanBtn.textContent = 'Đang quét…'; setStatus('Đang lấy dữ liệu…');
            let counts = null;
            try { counts = await scan((d, tt) => { scanBtn.textContent = `${d} / ${tt}`; }); }
            catch (e) { console.error('[MISA màu] scan lỗi:', e); }
            scanBtn.disabled = false; scanBtn.textContent = old; scanning = false;
            setStatus(counts
                ? `Xanh ${counts.full} · Vàng ${counts.partial} · Đỏ ${counts.none} · Xám ${counts.zero}`
                : credBadge());
        }
        scanBtn.onclick = doScan;
        scanBtn.style.transition = 'background .15s,transform .15s,box-shadow .15s';
        scanBtn.addEventListener('mouseenter', () => { if (!scanBtn.disabled) { scanBtn.style.background = '#1976d2'; scanBtn.style.transform = 'translateY(-1px)'; scanBtn.style.boxShadow = '0 4px 12px rgba(21,101,192,.35)'; } });
        scanBtn.addEventListener('mouseleave', () => { scanBtn.style.background = '#1565c0'; scanBtn.style.transform = ''; scanBtn.style.boxShadow = ''; });

        let autoTimer = null;
        const obs = new MutationObserver(() => {
            if (!autoBox.checked) return;
            clearTimeout(autoTimer);
            autoTimer = setTimeout(() => { if (autoBox.checked && !scanning) doScan(); }, 900);
        });
        autoBox.onchange = () => {
            if (autoBox.checked) { obs.observe(document.body, { childList: true, subtree: true }); doScan(); }
            else obs.disconnect();
        };

        makeDraggable(panel, panel.querySelector('#misa-head'));
    }

    function makeDraggable(el, handle) {
        let ox, oy, dragging = false;
        handle.addEventListener('mousedown', e => {
            if (e.target.id === 'misa-close') return;
            dragging = true;
            const r = el.getBoundingClientRect();
            ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            el.style.left = (e.clientX - ox) + 'px'; el.style.top = (e.clientY - oy) + 'px';
            el.style.right = 'auto'; el.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    /* ══════════════════════════════════════════════════════════════
       12. KHỞI ĐỘNG (+ tự phục hồi panel)
    ══════════════════════════════════════════════════════════════ */
    function init() {
        try {
            injectStyles();
            createPanel();
            console.log('[MISA màu] v2.1 đã khởi động (sandbox=' + hasGM + '). Gõ __misaColor.diag() để kiểm tra.');
        } catch (e) { console.error('[MISA màu] lỗi init:', e); }
    }
    const ON_PAGE = () => location.pathname.startsWith('/app/SA/SAOrder');

    function start() {
        init();
        setInterval(() => {
            injectStyles();
            const fab = document.getElementById('misa-fab');
            const panel = document.getElementById('misa-panel');
            if (!document.body) return;
            if (ON_PAGE()) {
                if (!fab) createPanel();
                else fab.style.display = '';
                maintainColumn();
            } else {
                // Ẩn FAB + panel khi không ở trang Đơn đặt hàng
                if (fab) fab.style.display = 'none';
                if (panel) panel.style.display = 'none';
            }
        }, 2000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 1200));
    else setTimeout(start, 1200);

})();
