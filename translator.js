// ==UserScript==
// @name         U-tools 번역기
// @namespace    Gray
// @version      0.26.0
// @description  작성된 단어 사전으로 U-tools(우마무스메 공략 툴)의 일본어 스킬명·메뉴·코스 정보를 번역합니다. 최신 스킬은 우마무스메 트레이너스에서 자동 보충합니다.
// @author       별구름
// @match        https://xn--gck1f423k.xn--1bvt37a.tools/*
// @match        https://*.xn--gck1f423k.xn--1bvt37a.tools/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @connect      umamusume-trainers.me
// @updateURL    https://raw.githubusercontent.com/bluenebula0528/uma/main/translator.js
// @downloadURL  https://raw.githubusercontent.com/bluenebula0528/uma/main/translator.js
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------
     * 설정
     * ------------------------------------------------------------------ */
    const DICT_URL = 'https://raw.githubusercontent.com/bluenebula0528/uma/main/dictionary_v2.json';
    const LIVE_URL = 'https://umamusume-trainers.me/graphql';   // 우마무스메 트레이너스 스킬 목록
    const DICT_TTL = 6 * 60 * 60 * 1000;    // 사전 재확인 주기 (6시간)
    const LIVE_TTL = 24 * 60 * 60 * 1000;   // 실시간 스킬 재확인 주기 (24시간)
    const HIDE_TIMEOUT = 1500;               // 첫 번역 전 화면 가림 최대 시간(ms)

    // 사전 섹션 이름 (dictionary.json 의 섹션 순서 = 번역 우선순위)
    const SEC_EXACT = '완전일치 사전';   // 텍스트 전체가 일치할 때만 치환 (한 글자 약어 등)
    const SEC_REGEX = '정규식 사전';     // 텍스트 전체에 대한 정규식 규칙
    const SEC_SKILL = '스킬 사전';       // 실시간 스킬을 보충할 섹션
    const SEC_CHAR = '캐릭터 사전';      // 【약칭】 표기를 자동 생성할 섹션

    const K = { dict: 'ut_dict_v2', live: 'ut_live_v2', liveOn: 'ut_live_on', enabled: 'ut_enabled' };
    const JP_RE = /[぀-ヿㇰ-ㇿ㐀-鿿豈-﫿ｦ-ﾟ]/;
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'SVG', 'TEMPLATE']);
    const ATTRS = ['placeholder', 'title', 'aria-label'];

    const enabled = GM_getValue(K.enabled, true);
    const liveOn = GM_getValue(K.liveOn, true);

    GM_registerMenuCommand(enabled ? '⏸ 번역 끄기' : '▶ 번역 켜기', () => {
        GM_setValue(K.enabled, !enabled); location.reload();
    });
    GM_registerMenuCommand('🔄 사전 즉시 새로고침', () => {
        GM_deleteValue(K.dict); GM_deleteValue(K.live); location.reload();
    });
    GM_registerMenuCommand(liveOn ? '🔗 실시간 스킬 연동 끄기' : '🔗 실시간 스킬 연동 켜기', () => {
        GM_setValue(K.liveOn, !liveOn); location.reload();
    });
    if (!enabled) return;

    /* ------------------------------------------------------------------
     * 네트워크 / 캐시
     * ------------------------------------------------------------------ */
    function request(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest(Object.assign({
                timeout: 15000,
                onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
                onerror: e => reject(e),
                ontimeout: () => reject(new Error('timeout')),
            }, opts));
        });
    }

    async function fetchDictionary() {
        const text = await request({ method: 'GET', url: DICT_URL + '?t=' + Date.now() });
        JSON.parse(text);                          // 형식 검증
        return text;
    }

    async function fetchLiveSkills() {
        const text = await request({
            method: 'POST', url: LIVE_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ query: '{ skills { name { ja ko } } }' }),
        });
        const list = JSON.parse(text).data.skills;
        const out = [];
        for (const s of list) {
            const ja = s && s.name && s.name.ja && s.name.ja.trim();
            const ko = s && s.name && s.name.ko && s.name.ko.trim();
            if (ja && ko && JP_RE.test(ja) && !/[가-힣]/.test(ja)) out.push([ja, ko]);
        }
        return out;
    }

    function readCache(key) {
        try { const v = GM_getValue(key, null); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
    }

    /* ------------------------------------------------------------------
     * 사전 컴파일
     *  - 섹션 순서대로 한 패스씩 적용 (앞 섹션이 우선)
     *  - 각 패스는 "첫 글자 → 후보 목록(긴 것 우선)" 인덱스로 한 번에 스캔
     * ------------------------------------------------------------------ */
    const circleVariants = k => {
        const out = [k];
        if (k.includes('○')) out.push(k.replace(/○/g, '◯'));
        if (k.includes('◯')) out.push(k.replace(/◯/g, '○'));
        return out;
    };

    function makePass(entries) {
        const map = new Map();
        for (const [k, v] of entries) {
            if (!k || typeof v !== 'string') continue;
            for (const kk of circleVariants(k)) if (!map.has(kk)) map.set(kk, v);
        }
        const index = new Map();
        for (const [k, v] of map) {
            let arr = index.get(k[0]);
            if (!arr) index.set(k[0], arr = []);
            arr.push([k, v]);
        }
        for (const arr of index.values()) arr.sort((a, b) => b[0].length - a[0].length);
        return index;
    }

    function compile(dict, live) {
        const exact = new Map();
        const regex = [];
        const passes = [];
        const groups = [];
        const known = new Set();

        const top = Object.entries(dict).filter(([, v]) => typeof v === 'string');
        if (top.length) groups.push(top);

        for (const [name, sec] of Object.entries(dict)) {
            if (!sec || typeof sec !== 'object') continue;
            const entries = Object.entries(sec);
            entries.forEach(([k]) => known.add(k.replace(/◯/g, '○')));

            if (name === SEC_EXACT) {
                for (const [k, v] of entries) for (const kk of circleVariants(k.trim())) exact.set(kk, v);
                continue;
            }
            if (name === SEC_REGEX) {
                for (const [k, v] of entries) { try { regex.push([new RegExp(k), v]); } catch (e) { console.warn('[U-tools 번역기] 잘못된 정규식:', k); } }
                continue;
            }
            if (name === SEC_CHAR) {
                // 通常XX → 【XX】 (스킬 상세 페이지 등의 약칭 표기)
                for (const [k, v] of Object.entries(sec)) {
                    if (k.startsWith('通常') && k.length > 2) entries.push(['【' + k.slice(2) + '】', '【' + v + '】']);
                }
            }
            if (name === SEC_SKILL && live && live.length) {
                for (const [ja, ko] of live) {
                    const nk = ja.replace(/◯/g, '○');
                    if (!known.has(nk)) { entries.push([nk, ko.replace(/◯/g, '○')]); known.add(nk); }
                }
            }
            groups.push(entries);
        }

        // 우선순위 보호: 뒤 섹션의 단어가 앞 섹션 단어에 먼저 잘려 깨지는 경우
        // (예: 스킬 '蒼炎' 때문에 캐릭터 '蒼炎グラス'가 깨짐) 그 단어만 맨 앞 패스로 올림
        const promoted = [];
        for (let i = 0; i < groups.length; i++) {
            const keep = [];
            for (const e of groups[i]) {
                let t = e[0];
                for (const p of passes) t = runPass(t, p);
                // 앞 패스가 일부만 바꿔 일본어가 남는 경우 = 깨짐 → 승격 (완전히 번역되면 중복이므로 그대로 둠)
                if (i > 0 && t !== e[0] && JP_RE.test(t)) promoted.push(e); else keep.push(e);
            }
            passes.push(makePass(keep));
        }
        if (promoted.length) passes.unshift(makePass(promoted));
        return { exact, regex, passes };
    }

    function runPass(text, index) {
        let out = null, last = 0;
        const len = text.length;
        for (let i = 0; i < len;) {
            const arr = index.get(text[i]);
            if (arr !== undefined) {
                let hit = null;
                for (let j = 0; j < arr.length; j++) {
                    if (text.startsWith(arr[j][0], i)) { hit = arr[j]; break; }
                }
                if (hit !== null) {
                    if (out === null) out = [];
                    out.push(text.slice(last, i), hit[1]);
                    i += hit[0].length;
                    last = i;
                    continue;
                }
            }
            i++;
        }
        if (out === null) return text;
        out.push(text.slice(last));
        return out.join('');
    }

    // 번역 후 남은 조사·구두점 다듬기 (양쪽이 한글일 때만)
    function polish(s) {
        return s
            .replace(/([가-힣A-Za-z0-9）)\]】」』%]) ?の ?(?=[가-힣A-Za-z【「『])/g, '$1의 ')
            .replace(/([가-힣）)])、 ?(?=[가-힣A-Za-z0-9])/g, '$1, ')
            .replace(/ {2,}/g, ' ');
    }

    let C = null;                    // 컴파일된 사전
    let memo = new Map();            // 번역 결과 캐시

    function translate(text) {
        if (!JP_RE.test(text)) return text;
        const cached = memo.get(text);
        if (cached !== undefined) return cached;

        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
        let core = m[2], result;
        const ex = C.exact.get(core);
        if (ex !== undefined) {
            result = ex;
        } else {
            for (const [re, rep] of C.regex) {
                if (re.test(core)) { core = core.replace(re, rep); break; }
            }
            for (const p of C.passes) {
                if (!JP_RE.test(core)) break;
                core = runPass(core, p);
            }
            result = core === m[2] ? core : polish(core);
        }
        const out = m[1] + result + m[3];
        if (memo.size > 30000) memo = new Map();
        memo.set(text, out);
        return out;
    }

    /* ------------------------------------------------------------------
     * DOM 적용
     * ------------------------------------------------------------------ */
    let done = new WeakMap();        // 노드 → 마지막으로 기록한 번역 결과 (재처리 방지)

    function skipElement(el) {
        return SKIP_TAGS.has(el.tagName) || el.isContentEditable;
    }

    function doText(node) {
        const v = node.nodeValue;
        if (!v || done.get(node) === v) return;
        const p = node.parentNode;
        if (p && p.nodeType === 1 && skipElement(p)) return;
        const t = translate(v);
        if (t !== v) node.nodeValue = t;
        done.set(node, t);
    }

    function doAttrs(el) {
        for (const a of ATTRS) {
            const v = el.getAttribute(a);
            if (v && JP_RE.test(v)) { const t = translate(v); if (t !== v) el.setAttribute(a, t); }
        }
        if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && JP_RE.test(el.value)) {
            el.value = translate(el.value);
        }
        if (el.tagName === 'IFRAME') hookIframe(el);
    }

    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) { if (skipElement(root)) return; doAttrs(root); }
        const w = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: n => (n.nodeType === 1 && skipElement(n)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        let n;
        while ((n = w.nextNode())) {
            if (n.nodeType === 3) doText(n); else doAttrs(n);
        }
    }

    const observed = new WeakSet();

    function attach(doc) {
        if (!doc || observed.has(doc)) return;
        observed.add(doc);
        walk(doc.documentElement);
        new MutationObserver(records => {
            for (const r of records) {
                if (r.type === 'childList') {
                    for (const n of r.addedNodes) walk(n);
                } else if (r.type === 'characterData') {
                    doText(r.target);
                } else if (r.type === 'attributes') {
                    const v = r.target.getAttribute(r.attributeName);
                    if (v && JP_RE.test(v)) r.target.setAttribute(r.attributeName, translate(v));
                }
            }
        }).observe(doc.documentElement, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ATTRS,
        });
    }

    function hookIframe(f) {
        if (f._utHooked) return;
        f._utHooked = true;
        const go = () => { try { if (f.contentDocument && f.contentDocument.documentElement) attach(f.contentDocument); } catch (e) { /* 교차 출처 iframe */ } };
        f.addEventListener('load', go);
        go();
    }

    /* ------------------------------------------------------------------
     * 첫 렌더링 깜빡임 방지 (캐시된 사전이 있을 때만, 최대 HIDE_TIMEOUT)
     * ------------------------------------------------------------------ */
    let hideStyle = null;
    function hide() {
        hideStyle = document.createElement('style');
        hideStyle.textContent = 'body{visibility:hidden !important}';
        (document.head || document.documentElement).appendChild(hideStyle);
        setTimeout(reveal, HIDE_TIMEOUT);
    }
    function reveal() { if (hideStyle) { hideStyle.remove(); hideStyle = null; } }

    /* ------------------------------------------------------------------
     * 시작
     * ------------------------------------------------------------------ */
    let dictText = null, liveList = null, started = false;

    function rebuild() {
        try {
            C = compile(JSON.parse(dictText), liveOn ? liveList : null);
            memo = new Map();
            done = new WeakMap();
        } catch (e) {
            console.error('[U-tools 번역기] 사전 컴파일 실패', e);
        }
    }

    function start() {
        if (started || !C) return;
        started = true;
        const run = () => {
            const t0 = performance.now();
            attach(document);
            reveal();
            console.log('[U-tools 번역기] 번역 완료 ' + Math.round(performance.now() - t0) + 'ms');
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
        else run();
    }

    function retranslateAll() {
        if (!started) { start(); return; }
        const docs = [document];
        document.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { } });
        docs.forEach(d => walk(d.documentElement));
    }

    const dictCache = readCache(K.dict);
    const liveCache = readCache(K.live);
    if (dictCache && dictCache.text) dictText = dictCache.text;
    if (liveCache && Array.isArray(liveCache.list)) liveList = liveCache.list;

    if (dictText) {
        rebuild();
        hide();
        start();
    }

    // 사전: 캐시가 없거나 오래되었으면 다시 받기
    if (!dictCache || Date.now() - (dictCache.ts || 0) > DICT_TTL) {
        fetchDictionary().then(text => {
            GM_setValue(K.dict, { ts: Date.now(), text });
            if (text !== dictText) { dictText = text; rebuild(); retranslateAll(); }
        }).catch(err => {
            console.error('[U-tools 번역기] 사전 로드 실패', err);
            reveal();
        });
    }

    // 실시간 스킬: 사전에 없는 최신 스킬을 트레이너스에서 보충
    if (liveOn && (!liveCache || Date.now() - (liveCache.ts || 0) > LIVE_TTL)) {
        fetchLiveSkills().then(list => {
            GM_setValue(K.live, { ts: Date.now(), list });
            const changed = JSON.stringify(list) !== JSON.stringify(liveList);
            liveList = list;
            if (changed && dictText) { rebuild(); retranslateAll(); }
        }).catch(err => console.warn('[U-tools 번역기] 실시간 스킬 로드 실패 (사전만 사용)', err));
    }
})();
