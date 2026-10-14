(function () {
  'use strict';
  var T = window.TC, h = T.h, api = T.api, toast = T.toast;
  var app = document.getElementById('app');
  var TABS = [['overview', 'Overview'], ['seal', 'Seal & embed'], ['invite', 'Invite customers'], ['import', 'Import reviews'], ['reviews', 'Reviews'], ['keys', 'API keys']];
  var me = null;

  function fail(err) { toast(err.message); }

  function route() {
    var tab = location.hash.replace(/^#/, '') || 'overview';
    var body = h('div');
    app.replaceChildren(T.tabs(TABS, tab), body);
    ({ seal: seal, invite: invite, import: importer, reviews: reviews, keys: keys }[tab] || overview)(body);
  }

  function fact(k, v) { return h('div', null, h('dt', null, k), h('dd', null, v)); }

  // ---------------- Overview ----------------
  function overview(root) {
    api('GET', '/v1/business/me').then(function (d) {
      me = d;
      var e = d.eligibility, cert = d.certification;
      var tone = d.state === 'verified' ? 'good' : d.state === 'under_review' || d.state === 'not_certified' ? 'warn' : 'bad';
      var advice = {
        verified: 'Your seal shows as verified. Keep inviting customers after each purchase so recent reviews stay verified.',
        under_review: 'Some of your most recent reviews are not verified yet, so your seal shows amber. Invite customers through TechCatalyst, or wait for our analysts to audit imported reviews.',
        expired: 'Your certificate expired. Contact TechCatalyst to renew.',
        suspended: 'Your certification is suspended. Contact TechCatalyst.',
        revoked: 'Your certification was revoked.',
        not_certified: 'You are registered but not certified yet. Send review invitations or import your existing reviews so our analysts can audit them.',
      }[d.state];
      root.append(
        h('section', { class: 'card status ' + tone },
          h('h1', null, d.business.name),
          h('p', { class: 'state' }, T.seal(d.state, d.state === 'verified'
            ? 'Last ' + e.verified + '/' + e.considered + ' reviews verified · Valid until ' + T.date(cert && cert.expires_at)
            : 'Your seal right now')),
          h('p', null, advice),
          h('dl', { class: 'facts' },
            fact('Certificate', cert ? cert.id : '—'),
            fact('Valid until', T.date(cert && cert.expires_at)),
            fact('Last ' + e.window + ' reviews verified', e.verified + ' / ' + e.considered),
            fact('Awaiting audit', String(e.pending)),
            fact('Required', Math.round(e.minRatio * 100) + '% of at least ' + e.minReviews))),
        h('section', { class: 'card' }, h('h2', null, 'Public verification page'),
          h('p', { class: 'muted' }, 'Every seal links here. Customers can confirm your status, expiry date and most recent verified reviews.'),
          h('a', { class: 'btn', href: '/verify/' + encodeURIComponent(d.business.slug), target: '_blank', rel: 'noopener' }, 'Open verify page')));
    }).catch(fail);
  }

  // ---------------- Seal ----------------
  function seal(root) {
    var out = h('div');
    var list = h('div');
    root.append(
      h('section', { class: 'card' }, h('h2', null, 'Create a seal'),
        h('p', { class: 'muted' }, 'A seal is bound to your domain. If someone copies it onto another site, it displays "Not Valid On This Site" and the verify page warns visitors.'),
        h('form', { class: 'row', onsubmit: function (ev) {
          ev.preventDefault();
          api('POST', '/v1/business/seals', { domains: ev.target.elements.domains.value.split(/[\s,]+/).filter(Boolean) })
            .then(function () { toast('Seal created'); load(); }).catch(fail);
        } },
          h('label', null, 'Domains (your registered website or its subdomains)', h('input', { name: 'domains', required: true, placeholder: 'example.com, shop.example.com' })),
          h('button', { class: 'btn primary', type: 'submit' }, 'Create seal')),
        out),
      list);
    function load() {
      api('GET', '/v1/business/seals').then(function (r) {
        list.replaceChildren.apply(list, r.seals.length ? r.seals.map(sealItem) : [h('p', { class: 'muted' }, 'No seals yet.')]);
      }).catch(fail);
    }
    function sealItem(s) {
      var origin = location.origin;
      var script = '<script src="' + origin + '/embed.js" data-tc-seal="' + s.id + '" async></script>';
      var img = '<a href="' + origin + '/s/' + s.id + '" target="_blank" rel="noopener"><img src="' + origin + '/v1/seals/' + s.id + '/badge.svg" width="300" height="64" alt="TechCatalyst review verification seal"></a>';
      return h('section', { class: 'card' },
        h('div', { class: 'review-head' }, h('code', null, s.id), s.revoked_at ? h('span', { class: 'tag bad' }, 'revoked') : h('span', { class: 'tag good' }, 'active'),
          h('span', { class: 'muted' }, s.allowed_domains.join(', '))),
        s.revoked_at ? null : [
          h('h3', null, 'Live preview'),
          h('img', { src: '/v1/seals/' + s.id + '/badge.svg', width: 300, height: 64, alt: 'Seal preview' }),
          h('h3', null, 'Recommended: live script (auto-refreshes, domain-checked)'),
          h('pre', { class: 'snippet' }, script), copyBtn(script),
          h('h3', null, 'No-JavaScript fallback (image)'),
          h('pre', { class: 'snippet' }, img), copyBtn(img),
          h('div', { class: 'queue-actions' }, h('button', { class: 'btn small danger', type: 'button', onclick: function () {
            if (!confirm('Revoke this seal? Pages that embed it will show "Seal Not Found".')) return;
            api('DELETE', '/v1/business/seals/' + s.id).then(function () { toast('Seal revoked'); load(); }).catch(fail);
          } }, 'Revoke seal'))]);
    }
    load();
  }

  function copyBtn(text) {
    return h('button', { class: 'btn small', type: 'button', onclick: function () { navigator.clipboard.writeText(text).then(function () { toast('Copied'); }); } }, 'Copy');
  }

  // ---------------- Invitations ----------------
  function invite(root) {
    var out = h('div');
    var hist = h('tbody');
    root.append(
      h('section', { class: 'card' }, h('h2', null, 'Invite customers to review'),
        h('p', { class: 'muted' }, 'Invited reviews are tied to a real order, which earns them a "Verified purchase" mark. Paste one order per line: order reference, customer email, optional name. Each link works once.'),
        h('form', { class: 'form', onsubmit: function (ev) {
          ev.preventDefault();
          var rows = T.parseCsv(ev.target.elements.csv.value);
          if (rows.length && /order/i.test(rows[0][0])) rows.shift();
          var orders = rows.map(function (r) { return { order_ref: (r[0] || '').trim(), email: (r[1] || '').trim(), customer_name: (r[2] || '').trim() || undefined }; });
          if (!orders.length) return toast('Nothing to send');
          if (orders.length > 100) return toast('Up to 100 orders per batch');
          api('POST', '/v1/business/invitations', { orders: orders }).then(function (r) {
            ev.target.reset();
            out.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
              h('thead', null, h('tr', null, ['Order', 'Result', 'Review link (send to customer)'].map(function (x) { return h('th', null, x); }))),
              h('tbody', null, r.invitations.map(function (i) {
                return h('tr', null, h('td', null, i.order_ref), h('td', null, i.status), h('td', { class: 'mono' }, i.link || (i.status === 'emailed' ? 'Emailed by TechCatalyst' : '')));
              })))));
            loadHist();
          }).catch(fail);
        } },
          h('label', null, 'Orders (CSV)', h('textarea', { name: 'csv', rows: 6, required: true, placeholder: 'A-1001, maria@example.com, Maria G.\nA-1002, sam@example.com' })),
          h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Create invitations'))),
        out,
        h('p', { class: 'muted' }, 'Automate this: POST /v1/business/invitations with your API key from your checkout or CRM after each completed order.')),
      h('section', { class: 'card' }, h('h2', null, 'Recent invitations'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Order', 'Customer', 'Created', 'Expires', 'Status'].map(function (x) { return h('th', null, x); }))), hist))));
    function loadHist() {
      api('GET', '/v1/business/invitations').then(function (r) {
        hist.replaceChildren.apply(hist, r.invitations.map(function (i) {
          var st = i.used_at ? h('span', { class: 'tag good' }, 'reviewed') : i.expires_at * 1000 < Date.now() ? h('span', { class: 'tag' }, 'expired') : h('span', { class: 'tag warn' }, i.sent_at ? 'emailed' : 'open');
          return h('tr', null, h('td', null, i.order_ref), h('td', null, i.customer_name || '—'), h('td', null, T.date(i.created_at)), h('td', null, T.date(i.expires_at)), h('td', null, st));
        }));
      }).catch(fail);
    }
    loadHist();
  }

  // ---------------- Import ----------------
  function importer(root) {
    var out = h('div');
    root.append(h('section', { class: 'card' }, h('h2', null, 'Import existing reviews'),
      h('p', { class: 'muted' }, 'Bring in reviews from Google, Yelp, Facebook or a spreadsheet. Imported reviews go to a TechCatalyst analyst, who checks them against the original listing before they count toward your seal.'),
      h('p', { class: 'muted' }, 'CSV columns: source, external_id, rating (1-5), date (YYYY-MM-DD), author, title, body. Header row optional.'),
      h('form', { class: 'form', onsubmit: function (ev) {
        ev.preventDefault();
        var rows = T.parseCsv(ev.target.elements.csv.value);
        if (rows.length && /source/i.test(rows[0][0])) rows.shift();
        var bad = [];
        var list = rows.map(function (r, i) {
          var ts = Date.parse((r[3] || '').trim());
          var item = {
            source: (r[0] || '').trim().toLowerCase(), external_id: (r[1] || '').trim(), rating: parseInt(r[2], 10),
            reviewed_at: Math.floor(ts / 1000), author_name: (r[4] || '').trim() || undefined, title: (r[5] || '').trim() || undefined, body: (r[6] || '').trim(),
          };
          if (!item.external_id || !(item.rating >= 1 && item.rating <= 5) || isNaN(ts) || !item.body) bad.push(i + 1);
          return item;
        });
        if (bad.length) return toast('Check rows: ' + bad.slice(0, 8).join(', '));
        if (!list.length) return toast('Nothing to import');
        if (list.length > 200) return toast('Up to 200 reviews per batch');
        api('POST', '/v1/business/reviews/import', { reviews: list }).then(function (r) {
          ev.target.reset();
          out.replaceChildren(h('div', { class: 'alert good' }, r.inserted + ' imported for audit' + (r.duplicates ? ', ' + r.duplicates + ' already imported' : '') + '.'));
        }).catch(fail);
      } },
        h('label', null, 'Reviews (CSV)', h('textarea', { name: 'csv', rows: 8, required: true, placeholder: 'google,ChZDSUhNMG9nS0VJQ0FnSUR,5,2026-09-30,Dana K.,Fast fix,"Came same day and fixed the leak."' })),
        h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Import for audit'))),
      out));
  }

  // ---------------- Reviews ----------------
  function reviews(root) {
    var list = h('ul', { class: 'reviews' });
    root.append(h('section', { class: 'card' }, h('h2', null, 'Your reviews'), list));
    var tone = { approved: 'good', pending: 'warn', held: 'warn', rejected: 'bad' };
    api('GET', '/v1/business/reviews').then(function (r) {
      if (!r.reviews.length) return list.append(h('li', { class: 'muted' }, 'No reviews yet.'));
      r.reviews.forEach(function (rv) {
        list.append(h('li', { class: 'review' },
          h('div', { class: 'review-head' }, h('span', { class: 'stars' }, '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating)),
            h('span', { class: 'tag ' + (tone[rv.status] || '') }, rv.status === 'held' ? 'in audit' : rv.status),
            rv.verification !== 'none' ? h('span', { class: 'tag good' }, rv.verification === 'transaction' ? 'verified purchase' : 'audited') : null,
            h('span', { class: 'muted' }, rv.source + ' · ' + T.date(rv.reviewed_at))),
          rv.title ? h('strong', null, rv.title) : null, h('p', null, rv.body), h('span', { class: 'muted' }, '— ' + (rv.author_name || 'anonymous'))));
      });
    }).catch(fail);
  }

  // ---------------- Keys ----------------
  function keys(root) {
    var out = h('div');
    var tbody = h('tbody');
    root.append(h('section', { class: 'card' }, h('h2', null, 'API keys'),
      h('p', { class: 'muted' }, 'Use a separate key for each integration (checkout, CRM) so you can revoke one without breaking the others. To rotate: create a new key, switch your integration, then revoke the old one.'),
      out,
      h('form', { class: 'row', onsubmit: function (ev) {
        ev.preventDefault();
        var exp = ev.target.elements.exp.value;
        api('POST', '/v1/business/keys', { label: ev.target.elements.label.value, expires_in_days: exp ? Number(exp) : undefined })
          .then(function (k) { ev.target.reset(); out.replaceChildren(T.secretBox(k.token)); load(); }).catch(fail);
      } },
        h('label', null, 'Label', h('input', { name: 'label', required: true, placeholder: 'Shopify checkout' })),
        h('label', null, 'Expires (days)', h('input', { name: 'exp', type: 'number', min: 1, max: 730, placeholder: 'never' })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create key')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Key', 'Label', 'Created', 'Last used', ''].map(function (x) { return h('th', null, x); }))), tbody))));
    function load() {
      api('GET', '/v1/business/keys').then(function (r) {
        tbody.replaceChildren.apply(tbody, r.keys.map(function (k) {
          var action = k.revoked_at ? h('span', { class: 'tag bad' }, 'revoked')
            : k.id === r.current ? h('span', { class: 'tag' }, 'this session')
            : h('button', { class: 'btn small danger', type: 'button', onclick: function () {
              if (!confirm('Revoke ' + k.id + '?')) return;
              api('DELETE', '/v1/business/keys/' + k.id).then(function () { toast('Revoked'); load(); }).catch(fail);
            } }, 'Revoke');
          return h('tr', null, h('td', { class: 'mono' }, k.id), h('td', null, k.label), h('td', null, T.date(k.created_at)), h('td', null, T.datetime(k.last_used_at)), h('td', null, action));
        }));
      }).catch(fail);
    }
    load();
  }

  document.addEventListener('DOMContentLoaded', function () {
    T.login(app, 'the business portal', 'business', function () {
      var lo = document.getElementById('logout');
      lo.classList.remove('hidden');
      lo.addEventListener('click', T.logout);
      window.addEventListener('hashchange', route);
      route();
    });
  });
})();
