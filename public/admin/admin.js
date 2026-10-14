(function () {
  'use strict';
  var T = window.TC, h = T.h, api = T.api, toast = T.toast;
  var app = document.getElementById('app');
  var TABS = [['businesses', 'Businesses'], ['queue', 'Review queue'], ['keys', 'Admin keys'], ['audit', 'Audit log']];

  function fail(err) { toast(err.message); }

  function route() {
    var hash = location.hash.replace(/^#/, '') || 'businesses';
    var parts = hash.split('/');
    var tab = parts[0];
    var body = h('div');
    app.replaceChildren(T.tabs(TABS, tab === 'business' ? 'businesses' : tab), body);
    if (tab === 'business' && parts[1]) return businessDetail(body, decodeURIComponent(parts[1]));
    if (tab === 'queue') return queue(body);
    if (tab === 'keys') return adminKeys(body);
    if (tab === 'audit') return auditLog(body);
    return businesses(body);
  }

  // ---------------- Businesses ----------------
  function businesses(root) {
    var form = h('form', { class: 'form', onsubmit: function (e) {
      e.preventDefault();
      var f = e.target.elements;
      api('POST', '/v1/admin/businesses', {
        name: f.name.value, slug: f.slug.value, website: f.website.value, contact_email: f.email.value || undefined,
      }).then(function (r) { toast('Business created'); location.hash = 'business/' + r.id; }).catch(fail);
    } },
      h('div', { class: 'row' },
        h('label', null, 'Business name', h('input', { name: 'name', required: true, maxlength: 120 })),
        h('label', null, 'Public slug', h('input', { name: 'slug', required: true, pattern: '[a-z0-9][a-z0-9-]{1,48}[a-z0-9]', placeholder: 'acme-plumbing' }))),
      h('div', { class: 'row' },
        h('label', null, 'Website (verified domain)', h('input', { name: 'website', required: true, placeholder: 'acmeplumbing.com' })),
        h('label', null, 'Contact email', h('input', { name: 'email', type: 'email' }))),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Register business')));

    var tbody = h('tbody');
    root.append(
      h('section', { class: 'card' }, h('h2', null, 'Certified & registered businesses'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Business', 'Website', 'Certificate', 'Expires', 'Queue'].map(function (x) { return h('th', null, x); }))),
          tbody))),
      h('section', { class: 'card' }, h('h2', null, 'Register a business'),
        h('p', { class: 'muted' }, 'Verify domain ownership before registering (DNS TXT record or email to the domain\'s admin contact). The website domain is what seals are allowed to appear on.'),
        form));

    api('GET', '/v1/admin/businesses').then(function (r) {
      if (!r.businesses.length) tbody.append(h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No businesses yet.')));
      r.businesses.forEach(function (b) {
        tbody.append(h('tr', { class: 'clickable', onclick: function () { location.hash = 'business/' + b.id; } },
          h('td', null, h('strong', null, b.name), h('div', { class: 'muted mono' }, b.slug), b.status === 'suspended' ? h('span', { class: 'tag bad' }, 'suspended') : null),
          h('td', { class: 'mono' }, b.website),
          h('td', null, b.cert_status ? h('span', { class: 'tag ' + (b.cert_status === 'active' ? 'good' : 'bad') }, b.cert_status) : h('span', { class: 'muted' }, 'none')),
          h('td', null, T.date(b.cert_expires_at)),
          h('td', null, b.queue ? h('span', { class: 'tag warn' }, b.queue + ' to review') : '0')));
      });
    }).catch(fail);
  }

  function businessDetail(root, id) {
    api('GET', '/v1/admin/businesses/' + encodeURIComponent(id)).then(function (d) {
      var b = d.business, e = d.eligibility, cert = d.certification;
      var tone = d.state === 'verified' ? 'good' : d.state === 'under_review' || d.state === 'not_certified' ? 'warn' : 'bad';
      var newKey = h('div');

      root.append(
        h('p', null, h('a', { class: 'link-back', href: '#businesses' }, 'All businesses')),
        h('section', { class: 'card status ' + tone },
          h('h1', null, b.name),
          h('p', { class: 'state' }, T.seal(d.state, d.state === 'verified'
            ? 'Last ' + e.verified + '/' + e.considered + ' reviews verified · Valid until ' + T.date(cert && cert.expires_at)
            : 'Live seal state')),
          h('dl', { class: 'facts' },
            fact('Website', b.website), fact('Slug', b.slug), fact('Account', b.status),
            fact('Certificate', cert ? cert.id : '—'), fact('Valid until', T.date(cert && cert.expires_at)),
            fact('Last ' + e.window + ' reviews', e.verified + ' verified / ' + e.considered + ' (' + e.pending + ' in queue)'),
            fact('Bar', Math.round(e.minRatio * 100) + '% · min ' + e.minReviews)),
          h('div', { class: 'queue-actions' },
            h('a', { class: 'btn small', href: '/verify/' + encodeURIComponent(b.slug), target: '_blank', rel: 'noopener' }, 'Public verify page'),
            h('a', { class: 'btn small', href: '#queue/' + encodeURIComponent(b.id) }, 'Review queue'),
            b.status === 'active'
              ? h('button', { class: 'btn small danger', type: 'button', onclick: function () { setBizStatus(b.id, 'suspended'); } }, 'Suspend account')
              : h('button', { class: 'btn small', type: 'button', onclick: function () { setBizStatus(b.id, 'active'); } }, 'Reactivate account'))),

        h('div', { class: 'grid2' },
          certCard(b, d),
          h('section', { class: 'card' }, h('h2', null, 'Business API keys'),
            h('p', { class: 'muted' }, 'Give one key to the business for their portal and integrations. They can rotate their own keys afterwards.'),
            newKey,
            h('form', { class: 'row', onsubmit: function (ev) {
              ev.preventDefault();
              api('POST', '/v1/admin/keys', { role: 'business', business_id: b.id, label: ev.target.elements.label.value, expires_in_days: num(ev.target.elements.exp.value) })
                .then(function (k) { newKey.replaceChildren(T.secretBox(k.token, 'Send to the business over a secure channel.')); }).catch(fail);
            } },
              h('label', null, 'Label', h('input', { name: 'label', required: true, value: 'Owner portal' })),
              h('label', null, 'Expires (days)', h('input', { name: 'exp', type: 'number', min: 1, max: 730, placeholder: 'never' })),
              h('button', { class: 'btn primary', type: 'submit' }, 'Create key')),
            keyTable(d.keys))),

        sealCard(b, d.seals),
        certHistory(d.certifications));
    }).catch(fail);
  }

  function fact(k, v) { return h('div', null, h('dt', null, k), h('dd', null, v)); }
  function num(v) { return v === '' ? undefined : Number(v); }

  function setBizStatus(id, status) {
    var reason = prompt('Reason (recorded in the audit log):');
    if (!reason) return;
    api('PATCH', '/v1/admin/businesses/' + id, { status: status, reason: reason }).then(function () { toast('Updated'); route(); }).catch(fail);
  }

  function certCard(b, d) {
    var cert = d.certification;
    var out = h('div');
    var form = h('form', { class: 'form', onsubmit: function (ev) {
      ev.preventDefault();
      var f = ev.target.elements;
      var body = {
        valid_days: Number(f.days.value), review_window: Number(f.window.value),
        min_verified_ratio: Number(f.ratio.value) / 100, min_reviews: Number(f.min.value),
        notes: f.notes.value || undefined, force: f.force.checked,
      };
      api('POST', '/v1/admin/businesses/' + b.id + '/certifications', body)
        .then(function () { toast('Certificate issued'); route(); })
        .catch(function (err) {
          if (err.data && err.data.eligibility) {
            var el = err.data.eligibility;
            out.replaceChildren(h('div', { class: 'alert bad' }, 'Not eligible: ' + el.verified + ' of the last ' + el.considered + ' reviews are verified (need ' + Math.round(el.minRatio * 100) + '% and at least ' + el.minReviews + ' reviews). Audit the queue first, or override with "force" and a note.'));
          } else fail(err);
        });
    } },
      h('div', { class: 'row' },
        h('label', null, 'Valid for (days)', h('input', { name: 'days', type: 'number', min: 1, max: 397, value: 365, required: true })),
        h('label', null, 'Check last N reviews', h('input', { name: 'window', type: 'number', min: 3, max: 100, value: 10, required: true }))),
      h('div', { class: 'row' },
        h('label', null, 'Min % verified', h('input', { name: 'ratio', type: 'number', min: 50, max: 100, value: 100, required: true })),
        h('label', null, 'Min reviews', h('input', { name: 'min', type: 'number', min: 1, max: 100, value: 5, required: true }))),
      h('label', null, 'Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 })),
      h('label', { class: 'rate' }, h('input', { name: 'force', type: 'checkbox' }), 'Force issue even if not currently eligible'),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, cert ? 'Renew / reissue certificate' : 'Issue certificate')));

    var actions = null;
    if (cert && cert.status !== 'revoked') {
      actions = h('div', { class: 'queue-actions' },
        cert.status === 'active'
          ? h('button', { class: 'btn small', type: 'button', onclick: function () { certStatus(cert.id, 'suspended'); } }, 'Suspend')
          : h('button', { class: 'btn small', type: 'button', onclick: function () { certStatus(cert.id, 'active'); } }, 'Reinstate'),
        h('button', { class: 'btn small danger', type: 'button', onclick: function () { certStatus(cert.id, 'revoked'); } }, 'Revoke'));
    }
    return h('section', { class: 'card' }, h('h2', null, 'Certification'),
      h('p', { class: 'muted' }, 'The seal re-checks the last N reviews live. If fresh reviews fall below the bar, the seal turns amber automatically, even before the certificate expires.'),
      actions, out, form);
  }

  function certStatus(id, status) {
    var reason = prompt('Reason for ' + status + ' (shown on the public verify page):');
    if (!reason) return;
    if (status === 'revoked' && !confirm('Revocation is permanent. Continue?')) return;
    api('POST', '/v1/admin/certifications/' + id + '/status', { status: status, reason: reason }).then(function () { toast('Certificate ' + status); route(); }).catch(fail);
  }

  function keyTable(keys) {
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Key', 'Label', 'Last used', ''].map(function (x) { return h('th', null, x); }))),
      h('tbody', null, keys.map(function (k) {
        return h('tr', null,
          h('td', { class: 'mono' }, k.id),
          h('td', null, k.label, k.expires_at ? h('div', { class: 'muted' }, 'expires ' + T.date(k.expires_at)) : null),
          h('td', null, T.datetime(k.last_used_at)),
          h('td', null, k.revoked_at ? h('span', { class: 'tag bad' }, 'revoked') :
            h('button', { class: 'btn small danger', type: 'button', onclick: function () {
              if (!confirm('Revoke ' + k.id + '? Integrations using it stop immediately.')) return;
              api('DELETE', '/v1/admin/keys/' + k.id).then(function () { toast('Revoked'); route(); }).catch(fail);
            } }, 'Revoke')));
      }))));
  }

  function sealCard(b, seals) {
    var out = h('div');
    return h('section', { class: 'card' }, h('h2', null, 'Seals'),
      h('p', { class: 'muted' }, 'Businesses can create seals for ' + b.website + ' themselves. Use this to bind extra domains after you have verified ownership.'),
      h('form', { class: 'row', onsubmit: function (ev) {
        ev.preventDefault();
        var f = ev.target.elements;
        api('POST', '/v1/admin/businesses/' + b.id + '/seals', {
          domains: f.domains.value.split(/[\s,]+/).filter(Boolean), ownership_note: f.note.value,
        }).then(function () { toast('Seal created'); route(); }).catch(fail);
      } },
        h('label', null, 'Domains (comma separated)', h('input', { name: 'domains', required: true, placeholder: b.website })),
        h('label', null, 'How ownership was verified', h('input', { name: 'note', required: true, placeholder: 'DNS TXT tc-verify=… checked 2026-10-11' })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create seal')),
      out,
      seals.map(function (s) {
        return h('div', { class: 'queue-item' },
          h('div', { class: 'review-head' }, h('code', null, s.id), s.revoked_at ? h('span', { class: 'tag bad' }, 'revoked') : h('span', { class: 'tag good' }, 'active'),
            h('span', { class: 'muted' }, s.allowed_domains.join(', '))),
          s.revoked_at ? null : h('div', { class: 'queue-actions' },
            h('img', { src: '/v1/seals/' + s.id + '/badge.svg', width: 300, height: 64, alt: 'Live seal preview' }),
            h('button', { class: 'btn small danger', type: 'button', onclick: function () {
              if (!confirm('Revoke this seal? It will show "Seal Not Found" everywhere it is embedded.')) return;
              api('DELETE', '/v1/admin/seals/' + s.id).then(function () { toast('Seal revoked'); route(); }).catch(fail);
            } }, 'Revoke seal')));
      }));
  }

  function certHistory(certs) {
    if (!certs.length) return null;
    return h('section', { class: 'card' }, h('h2', null, 'Certificate history'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Certificate', 'Status', 'Issued', 'Expires', 'Policy', 'Reason / notes'].map(function (x) { return h('th', null, x); }))),
        h('tbody', null, certs.map(function (c) {
          return h('tr', null, h('td', { class: 'mono' }, c.id), h('td', null, c.status), h('td', null, T.date(c.issued_at)), h('td', null, T.date(c.expires_at)),
            h('td', null, 'last ' + c.review_window + ', ' + Math.round(c.min_verified_ratio * 100) + '%, min ' + c.min_reviews),
            h('td', null, c.status_reason || c.notes || ''));
        })))));
  }

  // ---------------- Review queue ----------------
  function queue(root) {
    var bizFilter = (location.hash.split('/')[1] || '');
    var list = h('div');
    root.append(h('section', { class: 'card' }, h('h2', null, 'Review queue'),
      h('p', { class: 'muted' }, 'Highest fraud score first. Approving an imported review marks it "audited"; approving an invite review keeps it "verified purchase". Check the original platform listing before approving imports.'),
      list));
    var url = '/v1/admin/reviews?status=queue' + (bizFilter ? '&business_id=' + encodeURIComponent(decodeURIComponent(bizFilter)) : '');
    api('GET', url).then(function (r) {
      if (!r.reviews.length) return list.append(h('p', { class: 'muted' }, 'Queue is empty.'));
      r.reviews.forEach(function (rv) {
        var note = h('input', { placeholder: 'Decision note (optional)', maxlength: 1000 });
        var item = h('div', { class: 'queue-item' },
          h('div', { class: 'review-head' },
            h('strong', null, rv.business_name),
            h('span', { class: 'stars' }, '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating)),
            h('span', { class: 'tag' }, rv.source + (rv.external_id && rv.source !== 'invite' ? ' · ' + rv.external_id : '')),
            h('span', { class: 'tag ' + (rv.fraud_score >= 50 ? 'bad' : rv.fraud_score > 25 ? 'warn' : 'good') }, 'risk ' + rv.fraud_score),
            h('span', { class: 'tag ' + (rv.status === 'held' ? 'bad' : 'warn') }, rv.status),
            h('span', { class: 'muted' }, T.date(rv.reviewed_at))),
          rv.title ? h('strong', null, rv.title) : null,
          h('p', null, rv.body),
          h('div', { class: 'muted' }, '— ' + (rv.author_name || 'anonymous')),
          rv.fraud_flags.length ? h('div', { class: 'flags' }, rv.fraud_flags.map(function (f) { return h('span', { class: 'tag warn mono' }, f); })) : null,
          h('div', { class: 'queue-actions' }, note,
            h('button', { class: 'btn small primary', type: 'button', onclick: function () { decide(rv.id, 'approve', note.value, item); } }, 'Approve'),
            h('button', { class: 'btn small danger', type: 'button', onclick: function () { decide(rv.id, 'reject', note.value, item); } }, 'Reject')));
        list.append(item);
      });
    }).catch(fail);
  }

  function decide(id, decision, note, item) {
    api('POST', '/v1/admin/reviews/' + id + '/decision', { decision: decision, note: note || undefined })
      .then(function () { item.remove(); toast(decision === 'approve' ? 'Approved' : 'Rejected'); }).catch(fail);
  }

  // ---------------- Admin keys ----------------
  function adminKeys(root) {
    var out = h('div');
    var tbody = h('tbody');
    root.append(h('section', { class: 'card' }, h('h2', null, 'API keys'),
      h('p', { class: 'muted' }, 'Admin keys can certify businesses — give one per person, set an expiry, and revoke on departure.'),
      out,
      h('form', { class: 'row', onsubmit: function (ev) {
        ev.preventDefault();
        api('POST', '/v1/admin/keys', { role: 'admin', label: ev.target.elements.label.value, expires_in_days: num(ev.target.elements.exp.value) })
          .then(function (k) { out.replaceChildren(T.secretBox(k.token)); load(); }).catch(fail);
      } },
        h('label', null, 'Label (person / system)', h('input', { name: 'label', required: true })),
        h('label', null, 'Expires (days)', h('input', { name: 'exp', type: 'number', min: 1, max: 730, value: 180 })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create admin key')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Key', 'Role', 'Label', 'Created', 'Last used', ''].map(function (x) { return h('th', null, x); }))), tbody))));
    function load() {
      api('GET', '/v1/admin/keys').then(function (r) {
        tbody.replaceChildren.apply(tbody, r.keys.map(function (k) {
          return h('tr', null, h('td', { class: 'mono' }, k.id), h('td', null, k.role, k.business_id ? h('div', { class: 'muted mono' }, k.business_id) : null),
            h('td', null, k.label), h('td', null, T.date(k.created_at)), h('td', null, T.datetime(k.last_used_at)),
            h('td', null, k.revoked_at ? h('span', { class: 'tag bad' }, 'revoked') : h('button', { class: 'btn small danger', type: 'button', onclick: function () {
              if (!confirm('Revoke ' + k.id + '?')) return;
              api('DELETE', '/v1/admin/keys/' + k.id).then(function () { toast('Revoked'); load(); }).catch(fail);
            } }, 'Revoke')));
        }));
      }).catch(fail);
    }
    load();
  }

  // ---------------- Audit ----------------
  function auditLog(root) {
    var tbody = h('tbody');
    root.append(h('section', { class: 'card' }, h('h2', null, 'Audit log'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['When', 'Actor', 'Action', 'Target', 'Details'].map(function (x) { return h('th', null, x); }))), tbody))));
    api('GET', '/v1/admin/audit').then(function (r) {
      r.entries.forEach(function (e) {
        tbody.append(h('tr', null, h('td', null, T.datetime(e.at)), h('td', { class: 'mono' }, e.actor), h('td', null, e.action), h('td', { class: 'mono' }, e.target || ''),
          h('td', { class: 'mono' }, e.details || '')));
      });
    }).catch(fail);
  }

  document.addEventListener('DOMContentLoaded', function () {
    T.login(app, 'the certification admin', 'admin', function () {
      var lo = document.getElementById('logout');
      lo.classList.remove('hidden');
      lo.addEventListener('click', T.logout);
      window.addEventListener('hashchange', route);
      route();
    });
  });
})();
