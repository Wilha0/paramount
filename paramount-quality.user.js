// ==UserScript==
// @name         Paramount+ Qualidade Máxima
// @namespace    https://github.com/wilha0/paramount
// @version      1.0.0
// @description  Faz o Paramount+ tocar sempre na maior resolução disponível (ou limita a uma resolução escolhida). Painel simples: F2.
// @match        https://www.paramountplus.com/*
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
 * Não depende da biblioteca interna do player, por isso é simples e resistente
 * a atualizações do site. Só escolhe entre as qualidades que o Paramount+ já
 * oferece para a sua conta/navegador: não cria qualidade que não existe.
 *
 * Mudou o modo? Recarregue o vídeo — o manifesto só é lido no início.
 */

(function () {
    'use strict';

    const TAG = '[P+ Qualidade]';

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

    /* ── estado (o que o último manifesto ofereceu) ────────────── */
    const State = { kind: null, ladder: [], kept: [], modeUsed: null, hits: 0, sig: '' };
    let onChange = () => {};

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

    const byQuality = (a, b) => b.height - a.height || b.bandwidth - a.bandwidth;

    function pick(cands, mode) {
        const s = cands.slice().sort(byQuality);
        if (mode === 'max') return s[0];
        const cap = Number(mode);
        return s.find(r => r.height <= cap) || s[s.length - 1];
    }

    function codecName(c) {
        c = String(c || '').toLowerCase();
        if (/^(dvh1|dvhe|dva1|dvav)/.test(c)) return 'Dolby Vision';
        if (/^(hvc1|hev1)/.test(c)) return 'HEVC';
        if (/^av01/.test(c)) return 'AV1';
        if (/^vp0?9/.test(c)) return 'VP9';
        if (/^(avc1|avc3)/.test(c)) return 'H.264';
        return c.split('.')[0];
    }

    function label(r, withCodec) {
        if (!r) return '-';
        let s = r.height ? r.height + 'p' : '?';
        if (r.bandwidth) s += ' · ' + (r.bandwidth / 1e6).toFixed(1) + ' Mbps';
        if (withCodec && r.codecs) s += ' · ' + codecName(r.codecs);
        return s;
    }

    function record(kind, ladder, kept, mode) {
        const uniq = (list) => {
            const seen = new Set(), out = [];
            for (const r of list) {
                const k = r.width + 'x' + r.height + '@' + r.bandwidth + '|' + r.codecs;
                if (!seen.has(k)) { seen.add(k); out.push(r); }
            }
            return out.sort(byQuality);
        };
        const l = uniq(ladder);
        if (!l.length) return;
        State.kind = kind;
        State.ladder = l;
        State.kept = uniq(kept);
        State.modeUsed = mode;
        State.hits++;
        const sig = kind + '|' + mode + '|' + l.map(r => r.height + '@' + r.bandwidth).join(',') +
            '|' + State.kept.map(r => r.height + '@' + r.bandwidth).join(',');
        const isNew = sig !== State.sig;
        State.sig = sig;
        try { onChange(isNew); } catch { /* ignore */ }
    }

    /* ── DASH (.mpd) ───────────────────────────────────────────── */
    function rewriteDash(text, mode) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) return text;

        const ladder = [], kept = [];
        let changed = false;

        for (const as of [...doc.getElementsByTagNameNS('*', 'AdaptationSet')]) {
            const kids = [...as.children];
            const repEls = kids.filter(e => e.localName === 'Representation');
            if (!repEls.length) continue;

            // Miniaturas da barra de busca (trick play) não são vídeo de verdade.
            const trick = kids.some(e => /Property$/.test(e.localName) &&
                /trickmode|thumbnail/i.test(e.getAttribute('schemeIdUri') || ''));
            if (trick) continue;

            const asMime = as.getAttribute('mimeType') || '';
            const ct = as.getAttribute('contentType') || '';
            const reps = repEls.map(el => ({
                el,
                mime: el.getAttribute('mimeType') || asMime,
                codecs: el.getAttribute('codecs') || as.getAttribute('codecs') || '',
                width: +(el.getAttribute('width') || as.getAttribute('width') || 0),
                height: +(el.getAttribute('height') || as.getAttribute('height') || 0),
                bandwidth: +(el.getAttribute('bandwidth') || 0)
            }));

            const image = ct === 'image' || /^image\//.test(asMime) || reps.some(r => /^image\//.test(r.mime));
            const video = !image && (ct === 'video' || /^video\//.test(asMime) ||
                reps.some(r => /^video\//.test(r.mime) || r.height > 0));
            if (!video) continue;

            const plain = reps.map(({ el, ...r }) => r);
            ladder.push(...plain);
            if (mode === 'auto') continue;

            const ok = reps.filter(r => r.height > 0 && supported(r.mime, r.codecs));
            if (!ok.length) continue;              // nada decodificável? não mexe
            const best = pick(ok, mode);
            kept.push(plain[reps.indexOf(best)]);
            for (const r of reps) {
                if (r !== best) { r.el.remove(); changed = true; }
            }
        }

        record('DASH', ladder, kept, mode);
        return changed ? new XMLSerializer().serializeToString(doc) : text;
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
                key: [a.CODECS, a.AUDIO, a['VIDEO-RANGE']].join('|')
            });
        }
        const strip = v => ({ width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs });
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

    function rewrite(text) {
        if (typeof text !== 'string' || !text) return text;
        const mode = getMode();
        try {
            if (/<MPD[\s>]/.test(text)) return rewriteDash(text, mode);
            if (text.includes('#EXT-X-STREAM-INF')) return rewriteHls(text, mode);
        } catch (e) {
            console.warn(TAG, 'falha ao filtrar manifesto', e);
        }
        return text;
    }

    /* ── interceptação: fetch ──────────────────────────────────── */
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
        window.fetch = function (input) {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            return origFetch.apply(this, arguments).then(async resp => {
                try {
                    const ct = resp.headers.get('content-type');
                    if (!resp.ok || !(isManifestUrl(url) || isManifestUrl(resp.url) || isManifestType(ct))) return resp;
                    const text = await resp.clone().text();
                    const out = rewrite(text);
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
                    console.warn(TAG, e);
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
                        const out = rewrite(text);
                        if (out !== text) {
                            res = { text: out, buf: rt === 'arraybuffer' ? new TextEncoder().encode(out).buffer : null };
                        }
                    }
                }
            } catch (e) { console.warn(TAG, e); }
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

    // Para depuração no console: __pqc.State
    window.__pqc = { State, rewrite, getMode };

    /* ── painel ────────────────────────────────────────────────── */
    function mainVideo() {
        let best = null, top = -1;
        for (const v of document.querySelectorAll('video')) {
            const r = v.getBoundingClientRect();
            const s = r.width * r.height + (v.paused ? 0 : 1e7);
            if (s > top) { top = s; best = v; }
        }
        return best;
    }

    const CSS = `
.pqc{position:fixed;top:20px;right:20px;width:280px;background:rgba(12,12,16,.96);color:#fff;
 font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;border-radius:12px;
 z-index:2147483000;box-shadow:0 10px 34px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.12);
 transition:opacity .25s;user-select:none;overflow:hidden}
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
 font-weight:700;font-size:12px;cursor:pointer;display:none}
.pqc-btn.show{display:block}
.pqc-n{font-size:11px;color:#8a8a8a;margin-top:6px;line-height:1.45}
.pqc-lad{font-size:11px;color:#9a9a9a;margin-top:2px;word-break:break-word}
.pqc-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:8px 16px;background:rgba(0,0,0,.92);
 color:#fff;border-radius:30px;font:13px -apple-system,'Segoe UI',sans-serif;z-index:2147483001;
 border:1px solid rgba(255,255,255,.3);pointer-events:none;animation:pqcf 2.6s ease forwards}
@keyframes pqcf{0%{opacity:0}10%{opacity:1}80%{opacity:1}100%{opacity:0}}`;

    function toast(msg) {
        if (!document.body) return;
        const el = document.createElement('div');
        el.className = 'pqc-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2700);
    }

    function modeText(m) {
        return m === 'max' ? 'Máxima' : m === 'auto' ? 'Automática' : 'Até ' + m + 'p';
    }

    function initUI() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const p = document.createElement('div');
        p.className = 'pqc';
        p.style.display = 'none';
        p.innerHTML = `
<div class="pqc-hd"><div>📺 Qualidade<span class="pqc-res" id="pqcHdRes">-</span></div>
 <div><span class="pqc-cb" id="pqcMin" title="Minimizar">−</span><span class="pqc-cb" id="pqcX" title="Fechar · F2 reabre">✕</span></div></div>
<div class="pqc-bd">
 <div class="pqc-row"><span>Tocando agora</span><span class="pqc-v" id="pqcNow">-</span></div>
 <div class="pqc-row"><span>Melhor disponível</span><span class="pqc-v" id="pqcMax">-</span></div>
 <div class="pqc-row"><span>Travado em</span><span class="pqc-v" id="pqcKept">-</span></div>
 <div class="pqc-lad" id="pqcLad"></div>
 <select class="pqc-sel" id="pqcSel"></select>
 <button class="pqc-btn" id="pqcReload">↻ Recarregar para aplicar</button>
 <div class="pqc-n" id="pqcNote"></div>
 <div class="pqc-n">F2 mostra/oculta o painel.</div>
</div>`;
        document.body.appendChild(p);
        const $ = id => p.querySelector('#' + id);

        const pos = Store.get('pos', null);
        if (pos && pos.l) { p.style.left = pos.l; p.style.top = pos.t; p.style.right = 'auto'; }
        if (Store.get('min', false)) { p.classList.add('min'); $('pqcMin').textContent = '□'; }

        /* arrastar pelo cabeçalho */
        let drag = null;
        $('pqcMin').parentElement.addEventListener('pointerdown', e => e.stopPropagation());
        p.querySelector('.pqc-hd').addEventListener('pointerdown', e => {
            const r = p.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
            e.currentTarget.setPointerCapture(e.pointerId);
        });
        p.querySelector('.pqc-hd').addEventListener('pointermove', e => {
            if (!drag) return;
            p.style.left = (drag.l + e.clientX - drag.x) + 'px';
            p.style.top = (drag.t + e.clientY - drag.y) + 'px';
            p.style.right = 'auto';
        });
        p.querySelector('.pqc-hd').addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            Store.set('pos', { l: p.style.left, t: p.style.top });
        });

        $('pqcMin').addEventListener('click', () => {
            const min = p.classList.toggle('min');
            $('pqcMin').textContent = min ? '□' : '−';
            Store.set('min', min);
        });
        $('pqcX').addEventListener('click', () => { p.style.display = 'none'; Store.set('hidden', true); });

        let dim;
        p.addEventListener('mouseenter', () => { clearTimeout(dim); p.style.opacity = '1'; });
        p.addEventListener('mouseleave', () => { dim = setTimeout(() => { p.style.opacity = '.35'; }, 3000); });

        document.addEventListener('keydown', e => {
            if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            const show = p.style.display === 'none';
            p.style.display = show ? '' : 'none';
            p.style.opacity = '1';
            Store.set('hidden', !show);
        }, true);

        /* seletor de modo */
        const sel = $('pqcSel');
        let selSig = '';
        const buildSelect = () => {
            const heights = [...new Set(State.ladder.map(r => r.height).filter(Boolean))];
            const caps = heights.length ? heights.slice(1) : [1080, 720, 480];
            const m = String(getMode());
            const sig = caps.join(',') + '|' + m;
            if (sig === selSig || document.activeElement === sel) return;
            selSig = sig;
            if (m !== 'max' && m !== 'auto' && !caps.includes(Number(m))) caps.push(Number(m));
            sel.innerHTML =
                '<option value="max">Máxima (recomendado)</option>' +
                caps.map(h => `<option value="${h}">Até ${h}p</option>`).join('') +
                '<option value="auto">Automática (padrão do site)</option>';
            sel.value = m;
        };
        sel.addEventListener('change', () => {
            const v = sel.value;
            Store.set('mode', v === 'max' || v === 'auto' ? v : Number(v));
            update();
            toast('Modo: ' + modeText(getMode()) + ' — recarregue o vídeo');
        });
        $('pqcReload').addEventListener('click', () => location.reload());

        /* atualização */
        const set = (id, txt, cls) => {
            const el = $(id);
            if (el.textContent !== txt) el.textContent = txt;
            if (cls !== undefined) { el.classList.remove('ok', 'warn'); if (cls) el.classList.add(cls); }
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
            set('pqcNow', h ? `${v.videoWidth}×${h}` : '-', cls);
            set('pqcHdRes', h ? h + 'p' : '-');
            set('pqcMax', top ? label(top) : '-');
            set('pqcKept', State.modeUsed === 'auto' ? 'não (automático)' : (kept ? label(kept, true) : '-'));

            const heights = [...new Set(State.ladder.map(r => r.height).filter(Boolean))];
            set('pqcLad', heights.length ? `Níveis (${State.kind}): ` + heights.map(x => x + 'p').join(', ') : '');

            const pending = State.hits > 0 && State.modeUsed !== getMode();
            $('pqcReload').classList.toggle('show', pending);

            let note;
            if (!State.hits) {
                note = v ? 'Nenhum manifesto interceptado ainda. Recarregue a página com o vídeo aberto.'
                         : 'Abra um filme ou episódio.';
            } else if (pending) {
                note = 'Novo modo salvo. Ele vale a partir do próximo vídeo — ou recarregue agora.';
            } else if (cls === 'warn') {
                note = 'O player ainda não chegou na resolução travada (pode levar alguns segundos). ' +
                       'Se o vídeo travar ou der erro, escolha uma resolução menor.';
            } else {
                note = 'Sua escolha vale para todos os vídeos automaticamente.';
            }
            set('pqcNote', note);

            // Aparece sozinho quando há vídeo, a menos que você tenha fechado.
            if (p.style.display === 'none' && !Store.get('hidden', false) && (State.hits || (v && v.duration > 60))) {
                p.style.display = '';
                dim = setTimeout(() => { if (!p.matches(':hover')) p.style.opacity = '.35'; }, 4000);
            }
        }

        onChange = isNew => {
            update();
            if (isNew && State.modeUsed !== 'auto' && State.kept[0]) {
                toast('🔒 Paramount+ em ' + label(State.kept[0]));
            }
        };
        update();
        setInterval(update, 1000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
    else initUI();
})();
