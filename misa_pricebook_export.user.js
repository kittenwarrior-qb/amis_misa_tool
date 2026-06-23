// ==UserScript==
// @name         MISA CRM - Export Chính sách giá JSON
// @namespace    https://amisapp.misa.vn/
// @version      1.2.1
// @description  Tự bắt token từ network, lấy toàn bộ chính sách giá (danh sách + chi tiết) và xuất file JSON
// @author       Satori
// @match        https://amisapp.misa.vn/crm/*
// @noframes
// @grant        unsafeWindow
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const BASE = 'https://amisapp.misa.vn/crm/g1/api/business/PriceBook';
    const PAGE_SIZE = 100;
    const DELAY_MS = 80;

    /* ══════════════════════════════════════════════════════════════
       1. LƯU FETCH GỐC TRƯỚC KHI PATCH
          Dùng fetch gốc + credentials:'include' để browser tự gửi
          session cookies — khác với GM_xmlhttpRequest (sandbox riêng,
          không có cookies của trang).
    ══════════════════════════════════════════════════════════════ */

    // Lưu ngay khi document-start, trước khi trang kịp override
    let _origFetch = null;
    try { _origFetch = W.fetch ? W.fetch.bind(W) : null; } catch (e) {}

    /* ══════════════════════════════════════════════════════════════
       2. BẮT CREDENTIALS TỪ NETWORK
    ══════════════════════════════════════════════════════════════ */

    const cap = { Authorization: '', companycode: '' };
    const hasCreds = () => !!(cap.Authorization && cap.companycode);

    function captureHeader(key, val) {
        if (!key || !val) return;
        const k = String(key).toLowerCase();
        if (k === 'authorization' && /^Bearer /i.test(String(val))) cap.Authorization = val;
        if (k === 'companycode' && String(val).trim()) cap.companycode = String(val).trim();
    }

    // XHR
    try {
        const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
        if (XP) {
            const _setH = XP.setRequestHeader;
            XP.setRequestHeader = function (k, v) {
                try { captureHeader(k, v); } catch (e) {}
                return _setH.apply(this, arguments);
            };
        }
    } catch (e) {}

    // fetch
    try {
        if (W.fetch) {
            const _fetch = W.fetch;
            W.fetch = function (input, init) {
                try {
                    const h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
                    if (h) {
                        if (typeof h.forEach === 'function') h.forEach((v, k) => captureHeader(k, v));
                        else if (typeof h === 'object') Object.keys(h).forEach(k => captureHeader(k, h[k]));
                    }
                } catch (e) {}
                return _fetch.apply(this, arguments);
            };
        }
    } catch (e) {}

    /* ══════════════════════════════════════════════════════════════
       3. API CALLS — dùng fetch gốc + credentials:'include'
    ══════════════════════════════════════════════════════════════ */

    function randomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function apiPost(url, referer, body, token, company) {
        const authVal = token  ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : cap.Authorization;
        const compVal = company || cap.companycode;

        const fetchFn = _origFetch || W.fetch;
        if (!fetchFn) return Promise.reject(new Error('Không tìm thấy fetch API'));

        return fetchFn(url, {
            method: 'POST',
            credentials: 'include',          // gửi session cookies của trình duyệt
            headers: {
                'Authorization':    authVal,
                'companycode':      compVal,
                'Content-Type':     'application/json',
                'Accept':           'application/json, text/plain, */*',
                'X-MISA-Language':  'vi-VN',
                'layoutcode':       'pricebook',
                'Referer':          referer,
                'crm2-aspxauth':    'undefined',
            },
            body: JSON.stringify(body),
        }).then(r => {
            if (r.status === 401) throw new Error('401 — token hết hạn hoặc sai companycode');
            if (r.status === 403) throw new Error('403 — không có quyền truy cập');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        });
    }

    async function fetchGridPage(page, token, company) {
        return apiPost(
            `${BASE}/Grid`,
            'https://amisapp.misa.vn/crm/price-book/list',
            {
                Columns: 'SUQsUHJpY2VCb29rQ29kZSxQcmljZUJvb2tOYW1lLE9iamVjdElELE9iamVjdElEVGV4dCxBY2NvdW50VHlwZUlELEFjY291bnRUeXBlSURUZXh0LEZyb21EYXRlLFRvRGF0ZSxJbmFjdGl2ZSxGb3JtTGF5b3V0SUQsRm9ybUxheW91dElEVGV4dCxPd25lcklELE93bmVySURUZXh0',
                Sorts: [{ SortBy: 'ModifiedDate', Type: 0, SortDirection: 1 }],
                Start: (page - 1) * PAGE_SIZE,
                Page: page,
                PageSize: PAGE_SIZE,
                Filters: [],
                Formula: '',
                LayoutCode: 'PriceBook',
                DefaultTotal: true,
                IsMappingData: false,
                MappingValueObject: {},
                IsApproved: false,
                CustomPagingData: {},
                IsUsedELTS: true,
                ListGmailPage: [],
                ListFacebookPage: {},
                IsListPaging: true,
                IsGetCache: false,
                IsCheckInactive: false,
                IsConverted: false,
                SessionID: randomUUID(),
                LayoutCodeCheckPermission: 'PriceBook',
                AISearchKeyword: '',
                SkipNormalSearch: false,
            },
            token, company
        );
    }

    async function fetchDetail(id, formLayoutId, token, company) {
        return apiPost(
            `${BASE}/FormDataNew/PriceBook/${formLayoutId}/4`,
            `https://amisapp.misa.vn/crm/price-book/view/${id}/${formLayoutId}`,
            { ID: String(id), MISAEntityState: 2, ActiveLayoutCode: null, CustomDicData: null },
            token, company
        );
    }

    /* ══════════════════════════════════════════════════════════════
       4. PARSE CURL (fallback cho user copy từ DevTools)
    ══════════════════════════════════════════════════════════════ */

    function parseCurl(text) {
        const tokenMatch   = text.match(/[Aa]uthorization['"^]*:\s*Bearer\s+([\w.\-]+)/);
        const companyMatch = text.match(/companycode['"^]*:\s*([\w]+)/i);
        return {
            token:   tokenMatch   ? tokenMatch[1]   : '',
            company: companyMatch ? companyMatch[1] : '',
        };
    }

    /* ══════════════════════════════════════════════════════════════
       5. EXPORT LOGIC
    ══════════════════════════════════════════════════════════════ */

    let exporting = false;

    async function runExport(token, company, setStatus) {
        if (exporting) return;
        exporting = true;
        try {
            setStatus('Đang lấy danh sách chính sách giá…');
            let allItems = [];
            let page = 1;
            while (true) {
                let resp;
                try { resp = await fetchGridPage(page, token, company); }
                catch (e) { throw new Error(`Trang ${page}: ${e.message}`); }

                if (!resp || !resp.Success) throw new Error(`API lỗi code=${resp?.Code ?? '?'}`);
                if (!Array.isArray(resp.Data) || resp.Data.length === 0) break;
                allItems = allItems.concat(resp.Data);
                if (resp.Data.length < PAGE_SIZE) break;
                page++;
            }

            if (!allItems.length) { setStatus('Không có dữ liệu.', 'warn'); return; }

            setStatus(`${allItems.length} chính sách — đang lấy chi tiết…`);

            const results = [];
            for (let i = 0; i < allItems.length; i++) {
                const item = allItems[i];
                setStatus(`Chi tiết ${i + 1}/${allItems.length}: ${item.PriceBookCode}`);
                try {
                    const det = await fetchDetail(item.ID, item.FormLayoutID, token, company);
                    results.push({
                        ...item,
                        Detail: (det.Success && det.Data?.CurrentData) ? det.Data.CurrentData : null,
                        DetailError: det.Success ? null : `code=${det.Code}`,
                    });
                } catch (e) {
                    results.push({ ...item, Detail: null, DetailError: e.message });
                }
                await sleep(DELAY_MS);
            }

            const filename = `price-books-${nowStr()}.json`;
            downloadJSON(results, filename);
            setStatus(`Xuất xong ${results.length} chính sách — "${filename}" đã tải về`, 'ok');
        } catch (e) {
            setStatus(`Lỗi: ${e.message}`, 'error');
        } finally {
            exporting = false;
        }
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function nowStr() { return new Date().toISOString().replace(/[T:]/g, '-').slice(0, 16); }

    function downloadJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 1500);
    }

    /* ══════════════════════════════════════════════════════════════
       6. GIAO DIỆN
    ══════════════════════════════════════════════════════════════ */

    function injectStyles() {
        if (document.getElementById('pb-style')) return;
        const s = document.createElement('style');
        s.id = 'pb-style';
        s.textContent = `
            #pb-fab {
                position:fixed;bottom:24px;right:88px;z-index:2147483647;
                width:50px;height:50px;border-radius:50%;background:#fff;overflow:hidden;
                display:flex;align-items:center;justify-content:center;
                cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.25);
                user-select:none;transition:transform .15s,box-shadow .15s;
            }
            #pb-fab:hover { transform:scale(1.1);box-shadow:0 5px 20px rgba(0,0,0,.35); }
            #pb-panel {
                position:fixed;bottom:84px;right:88px;z-index:2147483647;
                background:#fff;border:3px solid #1565c0;border-radius:12px;
                padding:20px;width:360px;display:none;
                box-shadow:0 8px 32px rgba(0,0,0,.18);
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            }
            #pb-panel h3 { margin:0 0 14px;font-size:17px;color:#1565c0; }
            .pb-label {
                font-size:12px;color:#777;margin:0 0 4px;display:block;
            }
            .pb-input {
                width:100%;box-sizing:border-box;padding:7px 10px;
                border:1.5px solid #ccc;border-radius:6px;
                font-size:13px;margin-bottom:10px;outline:none;
                font-family:monospace;
            }
            .pb-input:focus { border-color:#1565c0; }
            #pb-btn {
                width:100%;padding:12px;background:#1565c0;color:#fff;
                border:none;border-radius:8px;font-size:15px;font-weight:700;
                cursor:pointer;margin-top:4px;transition:background .15s;
            }
            #pb-btn:hover:not(:disabled) { background:#0d47a1; }
            #pb-btn:disabled { background:#90a4ae;cursor:not-allowed; }
            #pb-badge {
                font-size:12px;padding:6px 10px;border-radius:6px;
                margin-bottom:12px;text-align:center;line-height:1.4;
            }
            #pb-badge.ok   { background:#e8f5e9;color:#2e7d32; }
            #pb-badge.wait { background:#fff3e0;color:#e65100; }
            #pb-status {
                font-size:13px;min-height:18px;margin-bottom:10px;
                word-break:break-word;line-height:1.45;
            }
            #pb-status.ok    { color:#2e7d32; }
            #pb-status.error { color:#c62828; }
            #pb-status.warn  { color:#e65100; }
            .pb-section-title {
                font-size:11px;font-weight:700;color:#aaa;letter-spacing:.5px;
                text-transform:uppercase;margin:10px 0 6px;
            }
            #pb-curl-area {
                width:100%;box-sizing:border-box;height:60px;padding:6px 8px;
                border:1.5px solid #ccc;border-radius:6px;font-size:11px;
                font-family:monospace;resize:none;margin-bottom:6px;outline:none;
            }
            #pb-curl-area:focus { border-color:#1565c0; }
            #pb-parse-btn {
                padding:5px 12px;background:#546e7a;color:#fff;
                border:none;border-radius:5px;font-size:12px;cursor:pointer;
                margin-bottom:10px;
            }
            #pb-parse-btn:hover { background:#37474f; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function createPanel() {
        if (document.getElementById('pb-fab')) return;
        injectStyles();

        const fab = document.createElement('div');
        fab.id = 'pb-fab';
        fab.title = 'Export Chính sách giá';
        fab.innerHTML = `<img src="https://satoriwater.org/wp-content/uploads/2024/01/logo-satori-vuong.webp"
            style="width:100%;height:100%;object-fit:cover;display:block;" draggable="false">`;

        const panel = document.createElement('div');
        panel.id = 'pb-panel';
        panel.innerHTML = `
            <h3>Export Chính sách giá</h3>
            <div id="pb-badge" class="wait">Đang chờ bắt token từ trang…</div>
            <div id="pb-status"></div>

            <div class="pb-section-title">Thủ công (nếu tự bắt không được)</div>
            <span class="pb-label">Paste lệnh curl từ DevTools Network → Copy as cURL</span>
            <textarea id="pb-curl-area" placeholder="curl &quot;https://amisapp.misa.vn/crm/...&quot; -H &quot;Authorization: Bearer eyJ...&quot; -H &quot;companycode: ...&quot; ..."></textarea>
            <button id="pb-parse-btn">Trích xuất token từ curl</button>

            <span class="pb-label">Bearer Token</span>
            <input id="pb-token" class="pb-input" type="password" placeholder="eyJhbGci… (bỏ trống = tự bắt)" autocomplete="off" />
            <span class="pb-label">Company Code</span>
            <input id="pb-company" class="pb-input" type="text" placeholder="vd: 55ksn4bu (bỏ trống = tự bắt)" autocomplete="off" />

            <button id="pb-btn">Xuất JSON</button>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        const badge     = panel.querySelector('#pb-badge');
        const statusEl  = panel.querySelector('#pb-status');
        const tokenInp  = panel.querySelector('#pb-token');
        const compInp   = panel.querySelector('#pb-company');
        const btn       = panel.querySelector('#pb-btn');
        const curlArea  = panel.querySelector('#pb-curl-area');
        const parseBtn  = panel.querySelector('#pb-parse-btn');

        function setStatus(msg, type) {
            statusEl.textContent = msg;
            statusEl.className = type || '';
        }

        function refreshBadge() {
            if (hasCreds()) {
                const short = cap.Authorization.slice(-12);
                badge.textContent = `Token bắt được ✓  (…${short})  |  company: ${cap.companycode}`;
                badge.className = 'ok';
            } else if (cap.Authorization) {
                badge.textContent = `Token OK nhưng thiếu companycode — điền thủ công`;
                badge.className = 'wait';
            } else {
                badge.textContent = 'Chưa bắt được token — hãy thao tác trên trang hoặc paste curl';
                badge.className = 'wait';
            }
        }

        // Parse curl → điền vào inputs
        parseBtn.onclick = () => {
            const text = curlArea.value;
            if (!text.trim()) { setStatus('Paste lệnh curl vào ô trên trước.', 'warn'); return; }
            const { token, company } = parseCurl(text);
            if (token)   { tokenInp.value = token; }
            if (company) { compInp.value  = company; }
            if (token || company) setStatus(`Đã trích: token ${token ? '✓' : '✗'}  company ${company ? '✓' : '✗'}`, token && company ? 'ok' : 'warn');
            else setStatus('Không tìm thấy token/companycode trong curl đã paste.', 'error');
        };

        fab.onclick = () => {
            const open = panel.style.display !== 'none';
            panel.style.display = open ? 'none' : 'block';
            if (!open) { refreshBadge(); setStatus(''); }
        };

        btn.onclick = async () => {
            if (exporting) return;

            const manualToken   = tokenInp.value.trim().replace(/^Bearer\s+/i, '');
            const manualCompany = compInp.value.trim();

            const useToken   = manualToken   || cap.Authorization.replace(/^Bearer\s+/i, '');
            const useCompany = manualCompany || cap.companycode;

            if (!useToken)   { setStatus('Cần có token. Paste curl hoặc thao tác trên trang.', 'error'); return; }
            if (!useCompany) { setStatus('Cần có company code. Điền vào ô bên trên.', 'error'); return; }

            btn.disabled = true;
            setStatus('');
            await runExport(useToken, useCompany, setStatus);
            btn.disabled = false;
            refreshBadge();
        };

        // Cập nhật badge mỗi 2s
        setInterval(() => {
            if (panel.style.display !== 'none') refreshBadge();
        }, 2000);
    }

    /* ══════════════════════════════════════════════════════════════
       7. KHỞI ĐỘNG
    ══════════════════════════════════════════════════════════════ */

    function init() {
        if (document.body) createPanel();
        else document.addEventListener('DOMContentLoaded', createPanel);
    }

    init();
    setInterval(() => { if (!document.getElementById('pb-fab')) createPanel(); }, 3000);

})();
