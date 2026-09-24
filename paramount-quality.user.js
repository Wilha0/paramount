// ==UserScript==
// @name         Paramount+ Qualidade Máxima
// @namespace    https://github.com/wilha0/paramount
// @version      1.1.0
// @description  Faz o Paramount+ tocar sempre na maior resolução disponível (ou limita a uma resolução escolhida). Painel simples: F2.
// @match        https://www.paramountplus.com/*
// @match        https://paramountplus.com/*
// @match        https://*.paramountplus.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=paramountplus.com
// ==/UserScript==

/*
 * COMO FUNCIONA
 * O player do Paramount+ baixa um "manifesto" (DASH .mpd, ou HLS .m3u8) com a
 * lista de todas as resoluções disponíveis e depois escolhe sozinho qual usar
 * (adaptativo), quase sempre começando baixo e demorando para subir.
 *
 * Este script intercepta esse manifesto (fetch e XHR) ANTES do player lê-lo e
 * remove as resoluções que você não quer. No modo "Máxima" o player só enxerga
 * a melhor resolução — então não tem como escolher outra.
 *
 * Detalhes do Paramount+ tratados aqui:
 *   - cada resolução vem num AdaptationSet próprio, então a escolha é feita
 *     por Period (e por família de codec), não por AdaptationSet;
 *   - o manifesto costuma vir do Google DAI (pubads.g.doubleclick.net) com
 *     períodos de anúncio no meio — esses não entram na lista exibida;
 *   - o site bloqueia innerHTML/DOMParser (Trusted Types), então o manifesto
 *     é editado como texto e o painel é montado elemento por elemento.
 *
 * Só escolhe entre as qualidades que o Paramount+ já oferece para a sua
 * conta/navegador: não cria qualidade que não existe.
 *
 * Mudou o modo? Recarregue o vídeo — o manifesto só é lido no início.
 */

(function () {
    'use strict';

    const VERSION = '1.1.0';
    const TAG = '[P+ Qualidade]';
    console.log(TAG, 'ativo', VERSION);

    /* ── preferências ──────────────────────────────────────────── */
    const Store = {
        get(k, d) {
            try { const v = localStorage.getItem('pqc_' + k); return v === null ? d : JSON.parse(v); }
            catch { return d; }
        },
        set(k, v) { try { localStorage.setItem('pqc_' + k, JSON.stringify(v)); } catch { /* ignore */ } }
    };
    // 'max' | 'auto' | número (altura máxima, ex.: 720)
    const getMode = () => Store.get('mode', 'max');

    /* ── estado + diagnóstico ──────────────────────────────────── */
    const State = { kind: null, ladder: [], kept: [], modeUsed: null, hits: 0, sig: '' };
    const Diag = { requests: [], manifests: [], errors: [] };
    let onChange = () => {};

    function logError(where, e) {
        const msg = where + ': ' + (e && e.message || e);
        console.warn(TAG, msg, e);
        if (Diag.errors.length < 20) Diag.errors.push(msg);
    }

    // Guarda só host + caminho (sem query string, que carrega tokens).
    function noteRequest(url, via) {
        try {
            if (!/\.(mpd|m3u8|m4s|m4v|mp4|ts)(\?|#|$)|manifest|smil/i.test(url)) return;
            const u = new URL(url, location.href);
            const entry = via + ' ' + u.host + u.pathname;
            if (Diag.requests.includes(entry)) return;
            Diag.requests.push(entry);
            if (Diag.requests.length > 40) Diag.requests.shift();
        } catch { /* ignore */ }
    }

    /* ── utilidades ────────────────────────────────────────────── */
    const isManifestUrl = u => /\.(mpd|m3u8)(\?|#|$)/i.test(u || '');
    const isManifestType = t => /dash\+xml|mpegurl/i.test(t || '');

    function supported(mime, codecs) {
        if (!codecs) return true;
        const MS = window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource;
        if (!MS || typeof MS.isTypeSupported !== 'function') return true;
        try { return MS.isTypeSupported(`${mime || 'video/mp4'}; codecs="${codecs}"`); }
        catch { return true; }
    }

    function codecFamily(c) {
        c = String(c || '').toLowerCase();
        if (/(^|,|\s)(dvh1|dvhe|dva1|dvav)/.test(c)) return 'Dolby Vision';
        if (/(^|,|\s)(hvc1|hev1)/.test(c)) return 'HEVC';
        if (/(^|,|\s)av01/.test(c)) return 'AV1';
        if (/(^|,|\s)vp0?9/.test(c)) return 'VP9';
        if (/(^|,|\s)(avc1|avc3)/.test(c)) return 'H.264';
        return c ? c.split('.')[0] : '';
    }

    const byQuality = (a, b) => b.height - a.height || b.bandwidth - a.bandwidth;

    function pick(cands, mode) {
        const s = cands.slice().sort(byQuality);
        if (mode === 'max') return s[0];
        const cap = Number(mode);
        return s.find(r => r.height <= cap) || s[s.length - 1];
    }

    function label(r, withCodec) {
        if (!r) return '-';
        let s = r.height ? r.height + 'p' : '?';
        if (r.bandwidth) s += ' · ' + (r.bandwidth / 1e6).toFixed(1) + ' Mbps';
        const fam = withCodec && codecFamily(r.codecs);
        if (fam) s += ' · ' + fam;
        return s;
    }

    const strip = r => ({ width: r.width, height: r.height, bandwidth: r.bandwidth, codecs: r.codecs });

    function uniqSorted(list) {
        const seen = new Set(), out = [];
        for (const r of list) {
            const k = r.width + 'x' + r.height + '@' + r.bandwidth + '|' + r.codecs;
            if (!seen.has(k)) { seen.add(k); out.push(r); }
        }
        return out.sort(byQuality);
    }

    function record(kind, ladder, kept, mode) {
        const l = uniqSorted(ladder);
        if (!l.length) return;
        State.kind = kind;
        State.ladder = l;
        State.kept = uniqSorted(kept);
        State.modeUsed = mode;
        State.hits++;
        const sig = kind + '|' + mode + '|' + l.map(r => r.height + '@' + r.bandwidth).join(',') +
            '|' + State.kept.map(r => r.height + '@' + r.bandwidth).join(',');
        const isNew = sig !== State.sig;
        State.sig = sig;
        try { onChange(isNew); } catch (e) { logError('ui', e); }
    }

    /* ── DASH (.mpd), editado como texto ───────────────────────── */
    // Elementos do MPD que nunca se aninham neles mesmos (Period,
    // AdaptationSet, Representation), então dá para recortar por regex.
    function blocks(text, name) {
        const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:[\\w-]+:)?${name}\\s*>)`, 'g');
        const out = [];
        let m;
        while ((m = re.exec(text))) out.push({ s: m[0], i: m.index });
        return out;
    }
    function attrs(block) {
        const open = (block.match(/^<[^>]*>/) || [''])[0];
        const out = {}, re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(open))) out[m[1].replace(/^.*:/, '')] = m[2];
        return out;
    }
    const splice = (s, i, len, ins) => s.slice(0, i) + ins + s.slice(i + len);
    const AD_PERIOD = /(?:^|[-_])(?:pre|mid|post)[-_]?roll(?:[-_]|$)|(?:^|[-_])ad(?:vertisement)?(?:[-_]|$)/i;

    function rewriteDash(text, mode) {
        let periods = blocks(text, 'Period');
        if (!periods.length) periods = [{ s: text, i: 0, whole: true }];

        const ladder = [], kept = [];
        let out = text, changed = false;

        // De trás para frente: os índices dos blocos anteriores continuam válidos.
        for (let pi = periods.length - 1; pi >= 0; pi--) {
            const P = periods[pi];
            const pid = P.whole ? '' : (attrs(P.s).id || '');
            const isAd = AD_PERIOD.test(pid);
            const sets = blocks(P.s, 'AdaptationSet');

            const video = [];
            for (const as of sets) {
                if (/trickmode|thumbnail/i.test(as.s)) continue;   // miniaturas da barra de busca
                const aa = attrs(as.s);
                for (const r of blocks(as.s, 'Representation')) {
                    const ra = attrs(r.s);
                    const mime = ra.mimeType || aa.mimeType || '';
                    const ct = ra.contentType || aa.contentType || '';
                    const codecs = ra.codecs || aa.codecs || '';
                    const height = +(ra.height || aa.height || 0);
                    if (/^(image|audio|text)$/.test(ct) || /^(image|audio|text|application)\//.test(mime)) continue;
                    if (/^(mp4a|ec-3|ac-3|opus|stpp|wvtt)/i.test(codecs)) continue;
                    if (!(ct === 'video' || /^video\//.test(mime) || height > 0)) continue;
                    video.push({
                        as, r, mime: mime || 'video/mp4', codecs, height,
                        width: +(ra.width || aa.width || 0),
                        bandwidth: +(ra.bandwidth || 0)
                    });
                }
            }
            if (!video.length) continue;
            if (!isAd) ladder.push(...video.map(strip));
            if (mode === 'auto') continue;

            // A melhor de cada família de codec: o player continua escolhendo
            // o codec, mas só tem uma resolução em cada um.
            const groups = new Map();
            for (const v of video) {
                if (!v.height || !supported(v.mime, v.codecs)) continue;
                const k = codecFamily(v.codecs);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(v);
            }
            if (!groups.size) continue;                          // nada decodificável? não mexe
            const keep = new Set([...groups.values()].map(g => pick(g, mode)));
            if (!isAd) kept.push(...[...keep].map(strip));

            let ps = P.s;
            for (let ai = sets.length - 1; ai >= 0; ai--) {
                const as = sets[ai];
                const drop = video.filter(v => v.as === as && !keep.has(v));
                if (!drop.length) continue;
                let s = as.s;
                for (const v of drop.sort((a, b) => b.r.i - a.r.i)) s = splice(s, v.r.i, v.r.s.length, '');
                if (!/<(?:[\w-]+:)?Representation\b/.test(s)) s = '';   // grupo ficou vazio
                ps = splice(ps, as.i, as.s.length, s);
                changed = true;
            }
            out = P.whole ? ps : splice(out, P.i, P.s.length, ps);
        }

        record('DASH', ladder, kept, mode);
        return changed ? out : text;
    }

    /* ── HLS (.m3u8 master) ────────────────────────────────────── */
    function hlsAttrs(s) {
        const out = {}, re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let m;
        while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
        return out;
    }

    function rewriteHls(text, mode) {
        const lines = text.split(/\r?\n/);
        const vars = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
            let j = i + 1;
            while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
            const a = hlsAttrs(lines[i].slice(18));
            const [w, h] = String(a.RESOLUTION || '').split('x').map(Number);
            vars.push({
                i, j,
                width: w || 0, height: h || 0,
                bandwidth: +a.BANDWIDTH || 0,
                codecs: a.CODECS || '',
                key: [codecFamily(a.CODECS), a.AUDIO, a['VIDEO-RANGE']].join('|')
            });
        }
        const ladder = vars.filter(v => v.height).map(strip);

        const ok = vars.filter(v => v.height && supported('video/mp4', v.codecs));
        if (mode === 'auto' || !ok.length) { record('HLS', ladder, [], mode); return text; }

        const target = pick(ok, mode).height;
        // Na resolução escolhida, mantém o maior bitrate de cada combinação codec/áudio.
        const bestByKey = new Map();
        for (const v of ok) {
            if (v.height !== target) continue;
            const cur = bestByKey.get(v.key);
            if (!cur || v.bandwidth > cur.bandwidth) bestByKey.set(v.key, v);
        }
        const keep = new Set(bestByKey.values());
        const drop = new Set();
        for (const v of vars) {
            if (keep.has(v)) continue;
            drop.add(v.i);
            if (v.j < lines.length) drop.add(v.j);
        }

        record('HLS', ladder, [...keep].map(strip), mode);
        return drop.size ? lines.filter((_, n) => !drop.has(n)).join('\n') : text;
    }

    function rewrite(text, url) {
        if (typeof text !== 'string' || !text) return text;
        const mode = getMode();
        try {
            let kind = null, out = text;
            if (/<(?:[\w-]+:)?MPD[\s>]/.test(text)) { kind = 'DASH'; out = rewriteDash(text, mode); }
            else if (text.includes('#EXT-X-STREAM-INF')) { kind = 'HLS'; out = rewriteHls(text, mode); }
            if (kind) {
                let where = '';
                try { const u = new URL(url, location.href); where = u.host + u.pathname; } catch { /* ignore */ }
                Diag.manifests.push(`${kind} ${out === text ? 'intacto' : 'filtrado'} ${where}`);
                if (Diag.manifests.length > 15) Diag.manifests.shift();
            }
            return out;
        } catch (e) {
            logError('manifesto', e);
        }
        return text;
    }

    /* ── interceptação: fetch ──────────────────────────────────── */
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
        window.fetch = function (input) {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            noteRequest(url, 'fetch');
            return origFetch.apply(this, arguments).then(async resp => {
                try {
                    const ct = resp.headers.get('content-type');
                    if (!resp.ok || !(isManifestUrl(url) || isManifestUrl(resp.url) || isManifestType(ct))) return resp;
                    const text = await resp.clone().text();
                    const out = rewrite(text, resp.url || url);
                    if (out === text) return resp;
                    const h = new Headers(resp.headers);
                    h.delete('content-length');
                    h.delete('content-encoding');
                    const r = new Response(out, { status: resp.status, statusText: resp.statusText, headers: h });
                    // O player resolve os links relativos dos segmentos pela URL final.
                    try {
                        Object.defineProperty(r, 'url', { value: resp.url });
                        Object.defineProperty(r, 'redirected', { value: resp.redirected });
                    } catch { /* ignore */ }
                    return r;
                } catch (e) {
                    logError('fetch', e);
                    return resp;
                }
            });
        };
    }

    /* ── interceptação: XMLHttpRequest ─────────────────────────── */
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    const dText = XP && Object.getOwnPropertyDescriptor(XP, 'responseText');
    const dResp = XP && Object.getOwnPropertyDescriptor(XP, 'response');
    if (XP && dText && dText.get && dResp && dResp.get) {
        const origOpen = XP.open;
        XP.open = function (method, url) {
            this.__pqcUrl = String(url);
            this.__pqcRes = undefined;
            noteRequest(this.__pqcUrl, 'xhr');
            return origOpen.apply(this, arguments);
        };

        // Resultado em cache: null = não é manifesto (ou não mudou).
        const filtered = xhr => {
            if (xhr.__pqcRes !== undefined) return xhr.__pqcRes;
            if (xhr.readyState !== 4) return null;
            let res = null;
            try {
                const url = xhr.responseURL || xhr.__pqcUrl;
                const ct = xhr.getResponseHeader('content-type');
                const rt = xhr.responseType;
                if (xhr.status >= 200 && xhr.status < 300 &&
                    (isManifestUrl(xhr.__pqcUrl) || isManifestUrl(url) || isManifestType(ct))) {
                    let text = null;
                    if (rt === '' || rt === 'text') text = dText.get.call(xhr);
                    else if (rt === 'arraybuffer') text = new TextDecoder().decode(dResp.get.call(xhr));
                    if (text != null) {
                        const out = rewrite(text, url);
                        if (out !== text) {
                            res = { text: out, buf: rt === 'arraybuffer' ? new TextEncoder().encode(out).buffer : null };
                        }
                    }
                }
            } catch (e) { logError('xhr', e); }
            xhr.__pqcRes = res;
            return res;
        };

        Object.defineProperty(XP, 'responseText', {
            configurable: true, enumerable: dText.enumerable,
            get() {
                const rt = this.responseType;
                const r = (rt === '' || rt === 'text') ? filtered(this) : null;
                return r ? r.text : dText.get.call(this);
            }
        });
        Object.defineProperty(XP, 'response', {
            configurable: true, enumerable: dResp.enumerable,
            get() {
                const r = filtered(this);
                return r ? (r.buf || r.text) : dResp.get.call(this);
            }
        });
    }

    /* ── vídeo ─────────────────────────────────────────────────── */
    let lastShadowScan = 0, shadowVideos = [];
    function allVideos() {
        const vids = [...document.querySelectorAll('video')];
        if (vids.length) return vids;
        // O player pode estar dentro de um shadow DOM.
        const now = Date.now();
        if (now - lastShadowScan > 3000) {
            lastShadowScan = now;
            shadowVideos = [];
            const walk = root => {
                for (const el of root.querySelectorAll('*')) {
                    if (!el.shadowRoot) continue;
                    shadowVideos.push(...el.shadowRoot.querySelectorAll('video'));
                    walk(el.shadowRoot);
                }
            };
            try { walk(document); } catch { /* ignore */ }
        }
        return shadowVideos.filter(v => v.isConnected);
    }
    function mainVideo() {
        let best = null, top = -1;
        for (const v of allVideos()) {
            const r = v.getBoundingClientRect();
            const s = r.width * r.height + (v.paused ? 0 : 1e7);
            if (s > top) { top = s; best = v; }
        }
        return best;
    }

    function diagnostics() {
        const v = mainVideo();
        return {
            versao: VERSION,
            pagina: location.host + location.pathname,
            modo: getMode(),
            navegador: navigator.userAgent,
            video: v ? { tamanho: v.videoWidth + 'x' + v.videoHeight, duracao: v.duration, pausado: v.paused } : null,
            videos: allVideos().length,
            manifestos: Diag.manifests,
            escada: State.ladder.map(r => label(r, true)),
            travado: State.kept.map(r => label(r, true)),
            requisicoes: Diag.requests,
            erros: Diag.errors
        };
    }

    // Para depuração no console: __pqc.diag()
    window.__pqc = { State, Diag, rewrite, getMode, diag: diagnostics };

    /* ── painel (sem innerHTML: o site usa Trusted Types) ──────── */
    function el(tag, props, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else e.setAttribute(k, v);
        }
        for (const c of kids) if (c != null) e.append(c);
        return e;
    }

    const CSS = `
.pqc{position:fixed;top:20px;right:20px;width:290px;background:rgba(12,12,16,.96);color:#fff;
 font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;border-radius:12px;
 z-index:2147483000;box-shadow:0 10px 34px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.12);
 transition:opacity .25s;user-select:none;overflow:hidden;text-align:left}
.pqc.min .pqc-bd{display:none}
.pqc-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;
 background:#0064ff;font-weight:700;cursor:move}
.pqc-hd .pqc-res{background:rgba(0,0,0,.28);padding:1px 7px;border-radius:5px;font-size:11px;margin-left:6px}
.pqc-cb{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:4px;
 background:rgba(255,255,255,.2);border-radius:5px;cursor:pointer;font-size:13px}
.pqc-cb:hover{background:rgba(255,255,255,.4)}
.pqc-bd{padding:12px}
.pqc-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;color:#c8c8c8;font-size:12px}
.pqc-v{color:#fff;background:rgba(255,255,255,.12);padding:2px 8px;border-radius:10px;font-size:11px;white-space:nowrap}
.pqc-v.ok{background:rgba(90,220,120,.22);color:#8f8}
.pqc-v.warn{background:rgba(255,190,70,.2);color:#ffc861}
.pqc-sel{width:100%;margin:8px 0 6px;padding:8px;background:rgba(255,255,255,.08);color:#fff;
 border:1px solid rgba(255,255,255,.18);border-radius:8px;font-size:12px;cursor:pointer}
.pqc-sel option{background:#141418}
.pqc-btn{width:100%;margin-top:6px;padding:8px;background:#fff;color:#000;border:0;border-radius:8px;
 font-weight:700;font-size:12px;cursor:pointer}
.pqc-btn.hide{display:none}
.pqc-btn.sec{background:rgba(255,255,255,.08);color:#ccc;border:1px solid rgba(255,255,255,.18);font-weight:600}
.pqc-n{font-size:11px;color:#8a8a8a;margin-top:6px;line-height:1.45}
.pqc-lad{font-size:11px;color:#9a9a9a;margin-top:2px;word-break:break-word}
.pqc-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:8px 16px;background:rgba(0,0,0,.92);
 color:#fff;border-radius:30px;font:13px -apple-system,'Segoe UI',sans-serif;z-index:2147483001;
 border:1px solid rgba(255,255,255,.3);pointer-events:none;animation:pqcf 2.8s ease forwards}
@keyframes pqcf{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}`;

    function toast(msg) {
        if (!document.body) return;
        const t = el('div', { class: 'pqc-toast', text: msg });
        document.body.append(t);
        setTimeout(() => t.remove(), 2900);
    }

    function modeText(m) {
        return m === 'max' ? 'Máxima' : m === 'auto' ? 'Automática' : 'Até ' + m + 'p';
    }

    function initUI() {
        (document.head || document.documentElement).append(el('style', { text: CSS }));

        const ui = {};
        const row = (name, id) => el('div', { class: 'pqc-row' }, el('span', { text: name }), ui[id] = el('span', { class: 'pqc-v', text: '-' }));

        const p = el('div', { class: 'pqc' },
            el('div', { class: 'pqc-hd' },
                el('div', null, '📺 Qualidade', ui.hdRes = el('span', { class: 'pqc-res', text: '-' })),
                ui.btns = el('div', null,
                    ui.min = el('span', { class: 'pqc-cb', title: 'Minimizar', text: '−' }),
                    ui.x = el('span', { class: 'pqc-cb', title: 'Fechar · F2 reabre', text: '✕' }))),
            el('div', { class: 'pqc-bd' },
                row('Tocando agora', 'now'),
                row('Melhor disponível', 'max'),
                row('Travado em', 'kept'),
                ui.lad = el('div', { class: 'pqc-lad' }),
                ui.sel = el('select', { class: 'pqc-sel' }),
                ui.reload = el('button', { class: 'pqc-btn hide', text: '↻ Recarregar para aplicar' }),
                ui.note = el('div', { class: 'pqc-n' }),
                ui.diag = el('button', { class: 'pqc-btn sec', text: '📋 Copiar diagnóstico' }),
                el('div', { class: 'pqc-n', text: 'F2 mostra/oculta o painel. v' + VERSION })));
        document.body.append(p);

        const pos = Store.get('pos', null);
        if (pos && pos.l) { p.style.left = pos.l; p.style.top = pos.t; p.style.right = 'auto'; }
        if (Store.get('min', false)) { p.classList.add('min'); ui.min.textContent = '□'; }

        /* arrastar pelo cabeçalho */
        const hd = p.firstChild;
        let drag = null;
        ui.btns.addEventListener('pointerdown', e => e.stopPropagation());
        hd.addEventListener('pointerdown', e => {
            const r = p.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
            try { hd.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        hd.addEventListener('pointermove', e => {
            if (!drag) return;
            p.style.left = (drag.l + e.clientX - drag.x) + 'px';
            p.style.top = (drag.t + e.clientY - drag.y) + 'px';
            p.style.right = 'auto';
        });
        hd.addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            Store.set('pos', { l: p.style.left, t: p.style.top });
        });

        ui.min.addEventListener('click', () => {
            const min = p.classList.toggle('min');
            ui.min.textContent = min ? '□' : '−';
            Store.set('min', min);
        });
        ui.x.addEventListener('click', () => { p.style.display = 'none'; });

        let dim;
        const dimLater = ms => { clearTimeout(dim); dim = setTimeout(() => { if (!p.matches(':hover')) p.style.opacity = '.35'; }, ms); };
        p.addEventListener('mouseenter', () => { clearTimeout(dim); p.style.opacity = '1'; });
        p.addEventListener('mouseleave', () => dimLater(3000));
        dimLater(5000);

        window.addEventListener('keydown', e => {
            if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            e.stopPropagation();
            p.style.display = p.style.display === 'none' ? '' : 'none';
            p.style.opacity = '1';
            dimLater(5000);
        }, true);

        /* seletor de modo */
        let selSig = '';
        const buildSelect = () => {
            const heights = [...new Set(State.ladder.map(r => r.height).filter(Boolean))];
            const caps = heights.length ? heights.slice(1) : [1080, 720, 480];
            const m = String(getMode());
            const sig = caps.join(',') + '|' + m;
            if (sig === selSig || document.activeElement === ui.sel) return;
            selSig = sig;
            if (m !== 'max' && m !== 'auto' && !caps.includes(Number(m))) caps.push(Number(m));
            ui.sel.textContent = '';
            ui.sel.append(new Option('Máxima (recomendado)', 'max'));
            for (const h of caps) ui.sel.append(new Option('Até ' + h + 'p', String(h)));
            ui.sel.append(new Option('Automática (padrão do site)', 'auto'));
            ui.sel.value = m;
        };
        ui.sel.addEventListener('change', () => {
            const v = ui.sel.value;
            Store.set('mode', v === 'max' || v === 'auto' ? v : Number(v));
            update();
            toast('Modo: ' + modeText(getMode()) + ' — recarregue o vídeo');
        });
        ui.reload.addEventListener('click', () => location.reload());

        ui.diag.addEventListener('click', async () => {
            const json = JSON.stringify(diagnostics(), null, 2);
            console.log(TAG, 'diagnóstico\n' + json);
            try { await navigator.clipboard.writeText(json); toast('📋 Diagnóstico copiado — cole na conversa'); }
            catch { toast('Não consegui copiar — está no console (F12)'); }
        });

        /* atualização */
        const set = (e, txt, cls) => {
            if (e.textContent !== txt) e.textContent = txt;
            if (cls !== undefined) { e.classList.remove('ok', 'warn'); if (cls) e.classList.add(cls); }
        };

        function update() {
            buildSelect();
            const v = mainVideo();
            const top = State.ladder[0];
            const kept = State.kept[0];
            const h = v && v.videoHeight;

            // Qual altura consideramos "a meta": o que foi travado, ou o topo da escada.
            const goal = kept ? kept.height : (top ? top.height : 0);
            const cls = !h || !goal ? '' : (h >= goal - 8 ? 'ok' : 'warn');
            set(ui.now, h ? `${v.videoWidth}×${h}` : '-', cls);
            set(ui.hdRes, h ? h + 'p' : '-');
            set(ui.max, top ? label(top) : '-');
            set(ui.kept, State.modeUsed === 'auto' ? 'não (automático)' : (kept ? label(kept, true) : '-'));

            const heights = [...new Set(State.ladder.map(r => r.height).filter(Boolean))];
            set(ui.lad, heights.length ? `Níveis (${State.kind}): ` + heights.map(x => x + 'p').join(', ') : '');

            const pending = State.hits > 0 && State.modeUsed !== getMode();
            ui.reload.classList.toggle('hide', !pending);

            let note;
            if (!State.hits) {
                note = v ? 'Vídeo encontrado, mas o manifesto não foi interceptado. Recarregue a página ' +
                           '(F5) com o vídeo aberto. Se continuar, clique em "Copiar diagnóstico" e mande.'
                         : 'Script ativo. Abra um filme ou episódio.';
            } else if (pending) {
                note = 'Novo modo salvo. Ele vale a partir do próximo vídeo — ou recarregue agora.';
            } else if (cls === 'warn') {
                note = 'O player ainda não chegou na resolução travada (pode levar alguns segundos). ' +
                       'Se o vídeo travar ou der erro, escolha uma resolução menor.';
            } else {
                note = 'Sua escolha vale para todos os vídeos automaticamente.';
            }
            set(ui.note, note);
        }

        onChange = isNew => {
            update();
            if (isNew && State.modeUsed !== 'auto' && State.kept[0]) {
                toast('🔒 Paramount+ em ' + label(State.kept[0]));
            }
        };
        update();
        setInterval(() => { try { update(); } catch (e) { logError('ui', e); } }, 1000);
        toast('📺 Qualidade P+ ativo — F2 abre o painel');
    }

    const boot = () => { try { initUI(); } catch (e) { logError('painel', e); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
