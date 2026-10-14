// Landing page: interactive seal demo. Purely illustrative; makes no network requests.
(function () {
  'use strict';
  var DAY = 864e5;
  var BUSINESS = 'Harbor & Pine Coffee';
  var HOME = 'harborandpine.example';
  var COPY_SITE = 'harbor-pine-deals.example';

  function fmt(ms, long) {
    return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: long ? 'long' : 'short', day: 'numeric' });
  }
  var validUntil = Date.now() + 280 * DAY;
  var expiredOn = Date.now() - 12 * DAY;

  var STATES = {
    verified: {
      cls: 'v', ok: true, title: 'Reviews Verified',
      sub: 'Last 10/10 reviews verified · Valid until ' + fmt(validUntil),
      note: 'The certificate is active and <b>all 10</b> of the most recent reviews come from verified customers.',
    },
    under_review: {
      cls: 'w', title: 'Verification Under Review', sub: BUSINESS + ' · Click for details',
      note: 'Three new reviews arrived without verification, so <b>7 of the last 10</b> fall short of the bar. The seal turned amber on its own; nobody had to flip a switch.',
    },
    expired: {
      cls: 'b', title: 'Certification Expired', sub: BUSINESS + ' · Click for details',
      note: 'The certificate passed its expiry date on <b>' + fmt(expiredOn) + '</b> without being renewed, so the seal no longer shows as verified.',
    },
    revoked: {
      cls: 'b', title: 'Certification Revoked', sub: BUSINESS + ' · Click for details',
      note: 'TechCatalyst confirmed a complaint and revoked the certificate. The change reached <b>every embedded seal within 30 seconds</b>.',
    },
    copied: {
      cls: 'b', title: 'Not Valid On This Site', sub: 'This seal belongs to a different website', domain: COPY_SITE,
      note: 'The seal was pasted onto <b>' + COPY_SITE + '</b>, a site it was never issued for. It notices where it is running and says so.',
    },
  };

  var q = function (sel) { return document.querySelector(sel); };
  var slot = q('[data-demo-seal]');
  if (!slot) return;
  var seal = slot.querySelector('.seal');
  var mark = slot.querySelector('.seal-mark');
  var title = q('[data-demo-title]');
  var sub = q('[data-demo-sub]');
  var note = q('[data-demo-note]');
  var address = q('[data-demo-address]');
  var domain = q('[data-demo-domain]');
  var buttons = document.querySelectorAll('.states button');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timer;

  function apply(key) {
    var s = STATES[key];
    seal.className = 'seal ' + s.cls;
    mark.setAttribute('d', s.ok ? 'M9.5 16.5l4 4 7-8' : 'M15 10v8M15 22.5v.5');
    title.textContent = s.title;
    sub.textContent = s.sub;
    domain.textContent = s.domain || HOME;
    address.classList.toggle('mismatch', !!s.domain);
    note.innerHTML = s.note; // static strings defined above
  }

  function show(key) {
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-state') === key));
    }
    clearTimeout(timer);
    if (reduce) return apply(key);
    slot.classList.remove('checking');
    void slot.offsetWidth; // restart the sweep
    slot.classList.add('checking');
    timer = setTimeout(function () { apply(key); }, 220);
    setTimeout(function () { slot.classList.remove('checking'); }, 720);
  }

  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () { show(this.getAttribute('data-state')); });
  }
  apply('verified');

  var exp = document.querySelectorAll('[data-demo-expiry]');
  for (var j = 0; j < exp.length; j++) exp[j].textContent = fmt(validUntil);
  var expLong = q('[data-demo-expiry-long]');
  if (expLong) expLong.textContent = fmt(validUntil, true);

  if (/^https?:$/.test(location.protocol)) {
    var o = document.querySelectorAll('[data-origin]');
    for (var k = 0; k < o.length; k++) o[k].textContent = location.origin;
  }
})();
