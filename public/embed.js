/*! TechCatalyst Review Seal — embed.js
 * Usage: <script src="https://seal.techcatalyst.example/embed.js" data-tc-seal="seal_xxxxxxxxxxxxxxxx" async></script>
 * Renders a live, self-refreshing seal in a closed Shadow DOM. All server data is inserted as text, never HTML.
 */
(function () {
  'use strict';
  var SEAL_RE = /^seal_[a-z2-9]{16}$/;
  var REFRESH_MS = 10 * 60 * 1000;

  var CSS =
    ':host{all:initial;display:inline-block}' +
    'a{display:inline-flex;align-items:center;gap:10px;padding:9px 14px 9px 10px;border-radius:10px;border:1px solid var(--ring);' +
    'background:var(--bg);color:var(--fg);text-decoration:none;font:500 12px/1.25 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'min-width:220px;box-sizing:border-box;transition:transform .15s ease,box-shadow .15s ease}' +
    'a:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
    'a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    'svg{flex:none}' +
    '.k{font-size:9.5px;letter-spacing:.12em;font-weight:700;color:var(--accent)}' +
    '.t{font-size:14px;font-weight:700;margin:1px 0}' +
    '.s{opacity:.75;font-size:11px}' +
    '.v{--bg:#0f2a1d;--fg:#e8fff2;--accent:#34d399;--ring:rgba(52,211,153,.5)}' +
    '.w{--bg:#2b2410;--fg:#fff7df;--accent:#fbbf24;--ring:rgba(251,191,36,.5)}' +
    '.b{--bg:#2c1214;--fg:#ffecec;--accent:#f87171;--ring:rgba(248,113,113,.5)}' +
    '.n{--bg:#1c1f26;--fg:#eef1f6;--accent:#94a3b8;--ring:rgba(148,163,184,.45)}';

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function shield(ok) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '30');
    svg.setAttribute('height', '34');
    svg.setAttribute('viewBox', '0 0 30 34');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M15 2l12 4.5v9.2c0 7.8-5.2 13.7-12 16.3C8.2 29.4 3 23.5 3 15.7V6.5z');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    var m = document.createElementNS(NS, 'path');
    m.setAttribute('d', ok ? 'M9.5 16.5l4 4 7-8' : 'M15 10v8M15 22.5v.5');
    m.setAttribute('fill', 'none');
    m.setAttribute('stroke', 'currentColor');
    m.setAttribute('stroke-width', '2.4');
    m.setAttribute('stroke-linecap', 'round');
    m.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    svg.appendChild(m);
    svg.style.color = 'var(--accent)';
    return svg;
  }

  function fmt(ts) {
    try {
      return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function render(root, href, data) {
    var state = data && data.state;
    var cls = state === 'verified' ? 'v' : state === 'under_review' ? 'w' : state === 'not_certified' || !state ? 'n' : 'b';
    var title = (data && data.label) || 'Seal unavailable';
    var sub;
    if (state === 'verified') {
      var r = data.recent_reviews || {};
      sub = 'Last ' + r.verified + '/' + r.considered + ' reviews verified · Valid until ' + fmt(data.certification_expires_at);
    } else if (state === 'domain_mismatch') {
      sub = 'This seal belongs to a different website';
    } else if (data && data.business_name) {
      sub = data.business_name + ' · Click for details';
    } else {
      sub = 'Click to check status';
    }

    var a = el('a', {
      href: href,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: cls,
      'aria-label': 'TechCatalyst: ' + title + '. ' + sub + '. Opens verification page.',
    });
    a.appendChild(shield(state === 'verified'));
    var box = el('span');
    box.appendChild(el('div', { class: 'k' }, 'TECHCATALYST'));
    box.appendChild(el('div', { class: 't' }, title));
    box.appendChild(el('div', { class: 's' }, sub));
    a.appendChild(box);

    while (root.childNodes.length > 1) root.removeChild(root.lastChild);
    root.appendChild(a);
  }

  function mount(script) {
    if (script.getAttribute('data-tc-mounted')) return;
    script.setAttribute('data-tc-mounted', '1');
    var sealId = script.getAttribute('data-tc-seal') || '';
    if (!SEAL_RE.test(sealId)) return;
    var origin;
    try {
      origin = new URL(script.src).origin;
    } catch (e) {
      return;
    }

    var host = el('span', { 'data-tc-seal-host': sealId });
    script.parentNode.insertBefore(host, script.nextSibling);
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    root.appendChild(el('style', null, CSS));
    var href = origin + '/s/' + sealId;
    render(root, href, { state: null, label: 'Checking…' });

    function load() {
      fetch(origin + '/v1/seals/' + sealId, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'strict-origin' })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          render(root, href, d);
        })
        .catch(function () {
          render(root, href, { state: null, label: 'Seal unavailable' });
        });
    }
    load();
    setInterval(function () {
      if (!document.hidden) load();
    }, REFRESH_MS);
  }

  var scripts = document.querySelectorAll('script[data-tc-seal]');
  for (var i = 0; i < scripts.length; i++) mount(scripts[i]);
})();
