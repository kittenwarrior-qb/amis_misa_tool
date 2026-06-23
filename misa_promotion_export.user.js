// ==UserScript==
// @name         MISA CRM - Export Chương trình khuyến mãi JSON
// @namespace    https://amisapp.misa.vn/
// @version      1.2.0
// @description  Tự bắt token từ network, lấy toàn bộ CTKM (danh sách + chi tiết) và xuất file JSON
// @author       Satori
// @match        https://amisapp.misa.vn/promotion/*
// @noframes
// @grant        unsafeWindow
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const BASE = 'https://amisapp.misa.vn/promotion/g1/api/business/Promotion';
    const PAGE_SIZE = 100;
    const DELAY_MS = 80;

    /* ══════════════════════════════════════════════════════════════
       1. LƯU FETCH GỐC TRƯỚC KHI PATCH
          Promotion dùng token riêng (aud=PROMOTION), khác với CRM.
          Dùng fetch gốc + credentials:'include' để gửi session cookies.
    ══════════════════════════════════════════════════════════════ */

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
       3. API CALLS — fetch gốc + credentials:'include'
    ══════════════════════════════════════════════════════════════ */

    function randomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function apiPost(url, referer, body, token, company) {
        const authVal = token ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : cap.Authorization;
        const compVal = company || cap.companycode;

        const fetchFn = _origFetch || W.fetch;
        if (!fetchFn) return Promise.reject(new Error('Không tìm thấy fetch API'));

        return fetchFn(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Authorization':    authVal,
                'companycode':      compVal,
                'Content-Type':     'application/json',
                'Accept':           'application/json, text/plain, */*',
                'X-MISA-Language':  'vi-VN',
                'layoutcode':       'promotion',
                'Referer':          referer,
                'crm2-aspxauth':    'undefined',
                'Origin':           'https://amisapp.misa.vn',
            },
            body: JSON.stringify(body),
        }).then(r => {
            if (r.status === 401) throw new Error('401 — token hết hạn hoặc sai companycode');
            if (r.status === 403) throw new Error('403 — không có quyền truy cập');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        });
    }

    function apiGet(url, referer, token, company) {
        const authVal = token ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : cap.Authorization;
        const compVal = company || cap.companycode;

        const fetchFn = _origFetch || W.fetch;
        if (!fetchFn) return Promise.reject(new Error('Không tìm thấy fetch API'));

        return fetchFn(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Authorization':    authVal,
                'companycode':      compVal,
                'Accept':           'application/json, text/plain, */*',
                'X-MISA-Language':  'vi-VN',
                'layoutcode':       'promotion',
                'Referer':          referer,
                'crm2-aspxauth':    'undefined',
            },
        }).then(r => {
            if (r.status === 401) throw new Error('401 — token hết hạn hoặc sai companycode');
            if (r.status === 403) throw new Error('403 — không có quyền truy cập');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        });
    }

    // Lưu ý: Promotion dùng filter mặc định IsAccumulation=0 (loại trừ tích lũy)
    // Bỏ filter này để lấy TẤT CẢ chương trình
    async function fetchGridPage(page, token, company) {
        return apiPost(
            `${BASE}/Grid`,
            'https://amisapp.misa.vn/promotion/promotion/list',
            {
                // Base64 của: ID,PromotionCode,PromotionName,StartDate,EndDate,
                //              PromotionTypeID,PromotionTypeIDText,ObjectID,ObjectIDText,IsActive,FormLayoutID
                Columns: 'SUQsUHJvbW90aW9uQ29kZSxQcm9tb3Rpb25OYW1lLFN0YXJ0RGF0ZSxFbmREYXRlLFByb21vdGlvblR5cGVJRCxQcm9tb3Rpb25UeXBlSURUZXh0LE9iamVjdElELE9iamVjdElEVGV4dCxJc0FjdGl2ZSxGb3JtTGF5b3V0SUQ=',
                CustomColumns: 'Q3VzdG9tSUQ=',
                Sorts: [],
                Start: (page - 1) * PAGE_SIZE,
                Page: page,
                PageSize: PAGE_SIZE,
                Filters: [],          // bỏ filter mặc định → lấy tất cả
                LayoutCode: 'Promotion',
                DefaultTotal: false,
                IsMappingData: false,
                IsMappingDataWithCustom: false,
                IsApproved: false,
                CustomPagingData: {},
                IsUsedELTS: true,
                ListGmailPage: [],
                ListFacebookPage: {},
                IsGetCache: false,
                IsCheckInactive: false,
            },
            token, company
        );
    }

    // Chi tiết điều kiện mua/tặng của từng CTKM: GET PromoInfo/{id} (không phải FormDataNew)
    async function fetchPromoInfo(id, token, company) {
        return apiGet(
            `${BASE}/PromoInfo/${id}`,
            `https://amisapp.misa.vn/promotion/promotion/view/${id}/120`,
            token, company
        );
    }

    /* ══════════════════════════════════════════════════════════════
       4. PARSE CURL
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
            setStatus('Đang lấy danh sách chương trình khuyến mãi…');
            let allItems = [];
            let page = 1;
            while (true) {
                let resp;
                try { resp = await fetchGridPage(page, token, company); }
                catch (e) { throw new Error(`Trang ${page}: ${e.message}`); }

                // Promotion API trả về Data trực tiếp (không có Success flag như CRM)
                const data = Array.isArray(resp) ? resp
                           : Array.isArray(resp?.Data) ? resp.Data
                           : null;
                if (!data) throw new Error(`API lỗi hoặc phản hồi không hợp lệ`);
                if (data.length === 0) break;
                allItems = allItems.concat(data);
                if (data.length < PAGE_SIZE) break;
                page++;
            }

            if (!allItems.length) { setStatus('Không có chương trình nào.', 'warn'); return; }

            setStatus(`${allItems.length} chương trình — đang lấy chi tiết điều kiện mua/tặng…`);

            const results = [];
            for (let i = 0; i < allItems.length; i++) {
                const item = allItems[i];
                setStatus(`Chi tiết ${i + 1}/${allItems.length}: ${item.PromotionCode}`);
                try {
                    const info = await fetchPromoInfo(item.ID, token, company);
                    results.push({
                        ...item,
                        PromoInfo: (info?.Success && Array.isArray(info.Data)) ? info.Data : null,
                        PromoInfoError: info?.Success ? null : `code=${info?.Code}`,
                    });
                } catch (e) {
                    results.push({ ...item, PromoInfo: null, PromoInfoError: e.message });
                }
                await sleep(DELAY_MS);
            }

            const filename = `promotions-${nowStr()}.json`;
            downloadJSON(results, filename);
            setStatus(`Xuất xong ${results.length} chương trình — "${filename}" đã tải về`, 'ok');
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
       FAB ở right:152px (khác với pricebook=88px, order=24px)
    ══════════════════════════════════════════════════════════════ */

    function injectStyles() {
        if (document.getElementById('pm-style')) return;
        const s = document.createElement('style');
        s.id = 'pm-style';
        s.textContent = `
            #pm-fab {
                position:fixed;bottom:24px;right:152px;z-index:2147483647;
                width:50px;height:50px;border-radius:50%;
                background:#e65100;overflow:hidden;
                display:flex;align-items:center;justify-content:center;
                cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.25);
                user-select:none;transition:transform .15s,box-shadow .15s;
                font-size:22px;
            }
            #pm-fab:hover { transform:scale(1.1);box-shadow:0 5px 20px rgba(0,0,0,.35); }
            #pm-panel {
                position:fixed;bottom:84px;right:152px;z-index:2147483647;
                background:#fff;border:3px solid #e65100;border-radius:12px;
                padding:20px;width:360px;display:none;
                box-shadow:0 8px 32px rgba(0,0,0,.18);
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            }
            #pm-panel h3 { margin:0 0 14px;font-size:17px;color:#e65100; }
            .pm-label { font-size:12px;color:#777;margin:0 0 4px;display:block; }
            .pm-input {
                width:100%;box-sizing:border-box;padding:7px 10px;
                border:1.5px solid #ccc;border-radius:6px;
                font-size:13px;margin-bottom:10px;outline:none;font-family:monospace;
            }
            .pm-input:focus { border-color:#e65100; }
            #pm-btn {
                width:100%;padding:12px;background:#e65100;color:#fff;
                border:none;border-radius:8px;font-size:15px;font-weight:700;
                cursor:pointer;margin-top:4px;transition:background .15s;
            }
            #pm-btn:hover:not(:disabled) { background:#bf360c; }
            #pm-btn:disabled { background:#90a4ae;cursor:not-allowed; }
            #pm-badge {
                font-size:12px;padding:6px 10px;border-radius:6px;
                margin-bottom:12px;text-align:center;line-height:1.4;
            }
            #pm-badge.ok   { background:#e8f5e9;color:#2e7d32; }
            #pm-badge.wait { background:#fff3e0;color:#e65100; }
            #pm-status {
                font-size:13px;min-height:18px;margin-bottom:10px;
                word-break:break-word;line-height:1.45;
            }
            #pm-status.ok    { color:#2e7d32; }
            #pm-status.error { color:#c62828; }
            #pm-status.warn  { color:#e65100; }
            .pm-section-title {
                font-size:11px;font-weight:700;color:#aaa;letter-spacing:.5px;
                text-transform:uppercase;margin:10px 0 6px;
            }
            #pm-curl-area {
                width:100%;box-sizing:border-box;height:60px;padding:6px 8px;
                border:1.5px solid #ccc;border-radius:6px;font-size:11px;
                font-family:monospace;resize:none;margin-bottom:6px;outline:none;
            }
            #pm-curl-area:focus { border-color:#e65100; }
            #pm-parse-btn {
                padding:5px 12px;background:#546e7a;color:#fff;
                border:none;border-radius:5px;font-size:12px;cursor:pointer;margin-bottom:10px;
            }
            #pm-parse-btn:hover { background:#37474f; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function createPanel() {
        if (document.getElementById('pm-fab')) return;
        injectStyles();

        const fab = document.createElement('div');
        fab.id = 'pm-fab';
        fab.title = 'Export Chương trình khuyến mãi';
        fab.textContent = '🎁';

        const panel = document.createElement('div');
        panel.id = 'pm-panel';
        panel.innerHTML = `
            <h3>Export Chương trình KM</h3>
            <div id="pm-badge" class="wait">Đang chờ bắt token từ trang…</div>
            <div id="pm-status"></div>

            <div class="pm-section-title">Thủ công — paste curl từ DevTools</div>
            <span class="pm-label">Lệnh curl (Network → Copy as cURL) từ trang /promotion/</span>
            <textarea id="pm-curl-area" placeholder='curl "https://amisapp.misa.vn/promotion/..." -H "Authorization: Bearer eyJ..." -H "companycode: ..."'></textarea>
            <button id="pm-parse-btn">Trích xuất token từ curl</button>

            <span class="pm-label">Bearer Token</span>
            <input id="pm-token" class="pm-input" type="password" placeholder="eyJhbGci… (bỏ trống = tự bắt)" autocomplete="off" />
            <span class="pm-label">Company Code</span>
            <input id="pm-company" class="pm-input" type="text" placeholder="vd: 55ksn4bu (bỏ trống = tự bắt)" autocomplete="off" />

            <button id="pm-btn">Xuất JSON</button>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        const badge     = panel.querySelector('#pm-badge');
        const statusEl  = panel.querySelector('#pm-status');
        const tokenInp  = panel.querySelector('#pm-token');
        const compInp   = panel.querySelector('#pm-company');
        const btn       = panel.querySelector('#pm-btn');
        const curlArea  = panel.querySelector('#pm-curl-area');
        const parseBtn  = panel.querySelector('#pm-parse-btn');

        function setStatus(msg, type) {
            statusEl.textContent = msg;
            statusEl.className = type || '';
        }

        function refreshBadge() {
            if (hasCreds()) {
                badge.textContent = `Token bắt được ✓  (…${cap.Authorization.slice(-12)})  |  company: ${cap.companycode}`;
                badge.className = 'ok';
            } else if (cap.Authorization) {
                badge.textContent = 'Token OK nhưng thiếu companycode';
                badge.className = 'wait';
            } else {
                badge.textContent = 'Chưa có token — thao tác trên trang hoặc paste curl';
                badge.className = 'wait';
            }
        }

        parseBtn.onclick = () => {
            const text = curlArea.value;
            if (!text.trim()) { setStatus('Paste lệnh curl vào ô trên trước.', 'warn'); return; }
            const { token, company } = parseCurl(text);
            if (token)   tokenInp.value = token;
            if (company) compInp.value  = company;
            if (token || company) setStatus(`Trích được: token ${token ? '✓' : '✗'}  company ${company ? '✓' : '✗'}`, token && company ? 'ok' : 'warn');
            else setStatus('Không tìm thấy token/companycode trong curl.', 'error');
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

            if (!useToken)   { setStatus('Cần có token — thao tác trên trang hoặc paste curl.', 'error'); return; }
            if (!useCompany) { setStatus('Cần có company code.', 'error'); return; }

            btn.disabled = true;
            setStatus('');
            await runExport(useToken, useCompany, setStatus);
            btn.disabled = false;
            refreshBadge();
        };

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
    setInterval(() => { if (!document.getElementById('pm-fab')) createPanel(); }, 3000);

})();
