// Shared portal helpers. All DOM is built with textContent — never innerHTML with data.
(function () {
  'use strict';

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    kids.flat(Infinity).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.message || data.error || 'Request failed (' + r.status + ')');
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) {
      t = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3500);
  }

  function date(ts) {
    return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  }
  function datetime(ts) {
    return ts ? new Date(ts * 1000).toLocaleString() : '—';
  }

  var STATE = {
    verified: ['Reviews Verified', 'good'],
    under_review: ['Under Review', 'warn'],
    expired: ['Expired', 'bad'],
    suspended: ['Suspended', 'bad'],
    revoked: ['Revoked', 'bad'],
    not_certified: ['Not Certified', 'warn'],
  };
  function stateTag(s) {
    var m = STATE[s] || [s || '—', ''];
    return h('span', { class: 'tag ' + m[1] }, m[0]);
  }

  var SEAL_TITLE = {
    verified: 'Reviews Verified', under_review: 'Verification Under Review', expired: 'Certification Expired',
    suspended: 'Certification Suspended', revoked: 'Certification Revoked', not_certified: 'Not Certified',
  };
  /** The live seal as shoppers see it (same look as embed.js). */
  function seal(state, sub) {
    var NS = 'http://www.w3.org/2000/svg';
    var cls = state === 'verified' ? 'v' : state === 'under_review' ? 'w' : state === 'not_certified' || !state ? 'n' : 'b';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'seal-icon');
    svg.setAttribute('width', '30');
    svg.setAttribute('height', '34');
    svg.setAttribute('viewBox', '0 0 30 34');
    svg.setAttribute('aria-hidden', 'true');
    [['', 'M15 2l12 4.5v9.2c0 7.8-5.2 13.7-12 16.3C8.2 29.4 3 23.5 3 15.7V6.5z'],
     ['seal-mark', state === 'verified' ? 'M9.5 16.5l4 4 7-8' : 'M15 10v8M15 22.5v.5']].forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      if (d[0]) p.setAttribute('class', d[0]);
      p.setAttribute('d', d[1]);
      svg.appendChild(p);
    });
    return h('span', { class: 'seal ' + cls }, svg,
      h('span', null, h('span', { class: 'seal-k' }, 'TECHCATALYST'), h('span', { class: 'seal-t' }, SEAL_TITLE[state] || 'Seal unavailable'), h('span', { class: 'seal-s' }, sub || '')));
  }

  /** Shows a newly minted secret exactly once. */
  function secretBox(token, note) {
    return h('div', { class: 'alert warn' },
      h('strong', null, 'Copy this now — it will not be shown again.'),
      h('div', { class: 'secret', style: null }, token),
      note ? h('p', { class: 'muted' }, note) : null,
      h('button', { class: 'btn small', type: 'button', onclick: function () { navigator.clipboard.writeText(token).then(function () { toast('Copied'); }); } }, 'Copy'));
  }

  /** Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines in fields). */
  function parseCsv(text) {
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { f += '"'; i++; } else q = false;
        } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
        row = [];
      } else f += ch;
    }
    row.push(f);
    if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
    return rows;
  }

  function login(root, title, expectRole, onReady) {
    function show() {
      root.replaceChildren(
        h('section', { class: 'card login' },
          h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
          h('h1', null, 'Sign in to ' + title),
          h('p', { class: 'muted' }, 'Paste your API key. It is exchanged for a secure session cookie and never stored in the browser.'),
          h('form', { class: 'form', onsubmit: function (e) {
            e.preventDefault();
            var key = e.target.elements.key.value.trim();
            var btn = e.target.querySelector('button');
            btn.disabled = true;
            api('POST', '/v1/auth/session', { api_key: key }).then(function (me) {
              e.target.reset();
              if (me.role !== expectRole) {
                return api('DELETE', '/v1/auth/session').then(function () { throw new Error('This key is for the ' + me.role + ' portal.'); });
              }
              onReady(me);
            }).catch(function (err) { toast(err.message); }).finally(function () { btn.disabled = false; });
          } },
            h('label', null, 'API key', h('input', { name: 'key', type: 'password', autocomplete: 'off', required: true, placeholder: 'tck_key_…' })),
            h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'))));
    }
    api('GET', '/v1/auth/me').then(function (me) {
      if (me.role === expectRole) onReady(me);
      else show();
    }).catch(show);
  }

  function logout() {
    api('DELETE', '/v1/auth/session').finally(function () { location.reload(); });
  }

  function tabs(names, current) {
    return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, names.map(function (n) {
      return h('a', { href: '#' + n[0], 'aria-current': n[0] === current ? 'page' : null }, n[1]);
    }));
  }

  window.TC = { h: h, api: api, toast: toast, date: date, datetime: datetime, stateTag: stateTag, seal: seal, secretBox: secretBox, parseCsv: parseCsv, login: login, logout: logout, tabs: tabs };
})();
