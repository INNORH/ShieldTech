/*
 * Job Scam Shield — app shell.
 *
 * Dashboard, checker, community and history. No framework. Three files do
 * the real work: rules.js scores a message, community.js decides what a
 * report is allowed to claim, api.js stores it. This file only renders and
 * routes.
 *
 * Two kinds of storage, deliberately. Your own checks and feedback stay in
 * localStorage because they are private to this device. Community reports
 * go through the store so the same interface can later be served by the
 * FastAPI backend, where anyone can actually see them.
 */
(function () {
  'use strict';

  var AUTH_PAGE = 'auth.html';
  var SESSION_KEY = 'jss_session';
  var VIEW_KEY = 'jss_active_view';
  var CHECKS_KEY = 'jss_checks';
  var FEEDBACK_KEY = 'jss_feedback';
  var ATTENTION_KEY = 'jss_attention_seen';
  var PREFS_KEY = 'jss_prefs';
  var MAX_SAVED = 25;

  var VIEWS = ['dashboard', 'check', 'result', 'community', 'post', 'history', 'workstation', 'analytics', 'settings'];
  var RESTORE_VIEWS = {
    dashboard: true,
    check: true,
    community: true,
    history: true,
    workstation: true,
    analytics: true,
    settings: true
  };

  var SESSION = null;
  var store = null;
  var current = null;
  var feedFilter = 'live';
  var searchQuery = '';
  var composerFiles = null;
  var scanFiles = null;
  var pickedLabel = null;
  var openPostId = null;

  var $ = function (id) { return document.getElementById(id); };

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function announce(message) {
    $('app-status').textContent = message;
  }

  function showBanner(message) {
    var banner = $('app-banner');
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function iconFor(risk) {
    var ring = '<circle cx="12" cy="12" r="8.5"/>';
    if (risk === 'LOW') { return ring + '<path d="m7.8 12.4 2.9 2.9 5.5-6.2"/>'; }
    if (risk === 'CAUTION') { return ring + '<path d="M12 7.4v5.4"/><path d="M12 16.1h.01"/>'; }
    return ring + '<path d="M9.4 9.4 14.6 14.6M14.6 9.4 9.4 14.6"/>';
  }

  function shortName(fullName) {
    var parts = String(fullName || '').trim().split(/\s+/);
    if (!parts[0]) { return 'Someone'; }
    if (parts.length === 1) { return parts[0]; }
    return parts[0] + ' ' + parts[1].charAt(0) + '.';
  }

  /* ---------- verdict copy ---------- */

  var VERDICT = {
    LOW: {
      headline: 'No scam signals found',
      summary: 'Nothing in this message matched the patterns we check for. That is not proof the opportunity is real, so apply through the organisation itself rather than replying.'
    },
    CAUTION: {
      headline: 'Worth checking before you reply',
      summary: 'This message matched some of the patterns seen in South African job scams. It may still be genuine, but do not reply until you have confirmed it independently.'
    },
    HIGH: {
      headline: 'Treat this as a scam until proven otherwise',
      summary: 'This message matched several well-documented scam patterns. Do not reply, do not pay anything, and do not send your documents or banking details.'
    }
  };

  var FEEDBACK_LABEL = { scam: 'It was a scam', legit: 'It was legitimate', wrong: 'Wrong result' };

  /* ---------- private storage ---------- */

  function allChecks() {
    var list = readJson(CHECKS_KEY, []);
    if (!Array.isArray(list)) { return []; }
    return list.filter(function (item) {
      return item && item.userId === (SESSION && SESSION.id);
    });
  }

  function saveCheck(message, result) {
    var list = readJson(CHECKS_KEY, []);
    if (!Array.isArray(list)) { list = []; }
    var entry = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      userId: SESSION ? SESSION.id : null,
      message: message,
      risk: result.risk,
      score: result.score,
      signals: result.reportedHits.map(function (hit) {
        return { id: hit.id, label: hit.label, weight: hit.weight, evidence: hit.evidence };
      }),
      createdAt: new Date().toISOString()
    };
    list.push(entry);
    while (list.length > MAX_SAVED) { list.shift(); }
    writeJson(CHECKS_KEY, list);
    return entry;
  }

  function saveFeedback(checkId, verdict, note) {
    var list = readJson(FEEDBACK_KEY, []);
    if (!Array.isArray(list)) { list = []; }
    list.push({
      id: 'f' + Date.now().toString(36),
      userId: SESSION ? SESSION.id : null,
      checkId: checkId,
      verdict: verdict,
      note: note || '',
      createdAt: new Date().toISOString()
    });
    writeJson(FEEDBACK_KEY, list);
  }

  /* ---------- routing ---------- */

  var VIEW_TITLES = {
    dashboard: 'Dashboard',
    check: 'Scam Scanner',
    result: 'Check result',
    community: 'Community',
    post: 'Report detail',
    history: 'History',
    workstation: 'Work Station',
    analytics: 'Analytics',
    settings: 'Settings'
  };

  function persistView(name) {
    var key = name;
    if (name === 'result') { key = 'check'; }
    if (name === 'post') { key = 'community'; }
    if (!RESTORE_VIEWS[key]) { return; }
    try { localStorage.setItem(VIEW_KEY, key); } catch (e) { /* ignore */ }
  }

  function readSavedView() {
    try {
      var saved = localStorage.getItem(VIEW_KEY);
      if (saved && RESTORE_VIEWS[saved]) { return saved; }
    } catch (e) { /* ignore */ }
    return 'dashboard';
  }

  function showView(name) {
    updateNavCounts();
    VIEWS.forEach(function (view) {
      var node = $('view-' + view);
      if (node) { node.hidden = view !== name; }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav__link'), function (link) {
      var active = link.getAttribute('data-nav') === name ||
        (name === 'result' && link.getAttribute('data-nav') === 'check');
      link.classList.toggle('is-active', active);
      if (active) { link.setAttribute('aria-current', 'page'); }
      else { link.removeAttribute('aria-current'); }
    });
    var title = $('mobilebar-title');
    if (title) { title.textContent = VIEW_TITLES[name] || ''; }
    /* WCAG 2.4.2 Page Titled + 2.4.3 Focus Order: announce where the user landed */
    document.title = 'Job Scam Shield · ' + (VIEW_TITLES[name] || 'App');
    persistView(name);
    closeDrawer();
    var main = $('main');
    if (main && typeof main.scrollTo === 'function') {
      main.scrollTo(0, 0);
    }
    window.scrollTo(0, 0);
    var heading = document.querySelector('#view-' + name + ' h1');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) { heading.setAttribute('tabindex', '-1'); }
      try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
    }
  }

  function go(name) {
    if (name === 'dashboard') { renderDashboard(); }
    if (name === 'community') { renderCommunity(); }
    if (name === 'history') { renderHistory(); }
    if (name === 'analytics') { renderAnalytics(); }
    if (name === 'settings') { renderSettings(); }
    if (name === 'workstation' && window.ShieldWorkstation) {
      ShieldWorkstation.show();
    }
    renderUserChip();
    showView(name);
  }

  /* ---------- sidebar drawer ---------- */

  function drawerOpen() {
    return document.body.classList.contains('nav-open');
  }

  function openDrawer() {
    document.body.classList.add('nav-open');
    var toggle = $('nav-toggle');
    if (toggle) { toggle.setAttribute('aria-expanded', 'true'); }
    var scrim = $('nav-scrim');
    if (scrim) {
      scrim.hidden = false;
      scrim.setAttribute('aria-hidden', 'false');
    }
    /* move focus into the drawer so keyboard and screen-reader users follow it */
    var close = $('nav-close');
    if (close) { close.focus(); }
  }

  function closeDrawer() {
    if (!document.body.classList.contains('nav-open')) { return; }
    var sidebar = $('sidebar');
    var hadFocus = sidebar && sidebar.contains(document.activeElement);
    document.body.classList.remove('nav-open');
    var scrim = $('nav-scrim');
    if (scrim) {
      scrim.hidden = true;
      scrim.setAttribute('aria-hidden', 'true');
    }
    var toggle = $('nav-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      /* never leave focus on an element that has just been hidden */
      if (hadFocus) { toggle.focus(); }
    }
  }

  function updateNavCounts() {
    /* counts are decorative: never let them break navigation */
    try {
      var community = $('nav-count-community');
      if (community) { community.textContent = String(ShieldCommunity.visible(store.listPosts()).length); }
      var history = $('nav-count-history');
      if (history) { history.textContent = String(allChecks().length); }
    } catch (err) { /* leave the badges as they are */ }
  }

  /* ================================================================
     DASHBOARD
     ================================================================ */

  function myTrust() {
    return store.getTrust(SESSION.id);
  }

  function renderTrustChip(trust) {
    var rank = ShieldCommunity.rankFor(trust);
    $('trust-chip').setAttribute('data-rank', String(rank));
    $('trust-rank').textContent = String(rank);
    $('trust-label').textContent = ShieldCommunity.trustLabel(trust);
  }

  function renderUserChip() {
    var nameEl = $('user-chip-name');
    var emailEl = $('user-chip-email');
    if (nameEl) {
      nameEl.textContent = shortName(SESSION && SESSION.fullName) || 'Account';
    }
    if (emailEl) {
      emailEl.textContent = (SESSION && SESSION.email) || '';
    }
  }

  function renderDashboard() {
    var posts = store.listPosts();
    var checks = allChecks();
    var trust = myTrust();
    var stats = ShieldCommunity.dashboardStats(posts, trust);
    var now = new Date();

    renderTrustChip(trust);
    renderUserChip();
    renderDashStats(stats, checks.length);

    var pulseText = stats.liveAlerts + ' live alert' + (stats.liveAlerts === 1 ? '' : 's') +
      ' · your trust: ' + stats.rankLabel;
    var pulse = $('dash-pulse');
    if (pulse) { pulse.textContent = pulseText; }
    var topPulse = $('topbar-pulse');
    if (topPulse) { topPulse.textContent = pulseText; }

    var monthHint = $('dash-month-hint');
    if (monthHint) {
      monthHint.textContent = now.toLocaleString(undefined, { month: 'long', year: 'numeric' }) +
        ' · reports vs scans by day';
    }
    renderMonthChart(buildMonthSeries(posts, checks, now), 'dash-month-chart', 'dash-month-empty');

    renderAttention(posts);
    renderLiveAlerts(posts);
    renderHotContacts();
    renderLastCheck();
  }

  function renderDashStats(stats, scans) {
    var reports = $('stat-reports-value');
    var scansEl = $('stat-scans-value');
    var live = $('stat-live-value');
    var mine = $('stat-mine-value');
    if (reports) { reports.textContent = String(stats.totalReports || 0); }
    if (scansEl) { scansEl.textContent = String(scans || 0); }
    if (live) { live.textContent = String(stats.liveAlerts || 0); }
    if (mine) { mine.textContent = String(stats.myReports || 0); }
  }

  function dayKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function monthDays(now) {
    var y = now.getFullYear();
    var m = now.getMonth();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var days = [];
    for (var d = 1; d <= daysInMonth; d++) {
      days.push(y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    }
    return days;
  }

  function buildMonthSeries(posts, checks, now) {
    var days = monthDays(now);
    var reports = {};
    var scans = {};
    days.forEach(function (key) {
      reports[key] = 0;
      scans[key] = 0;
    });
    (posts || []).forEach(function (post) {
      var key = dayKey(post.createdAt);
      if (Object.prototype.hasOwnProperty.call(reports, key)) { reports[key] += 1; }
    });
    (checks || []).forEach(function (check) {
      var key = dayKey(check.createdAt);
      if (Object.prototype.hasOwnProperty.call(scans, key)) { scans[key] += 1; }
    });
    return days.map(function (key) {
      return {
        key: key,
        day: Number(key.slice(-2)),
        reports: reports[key],
        scans: scans[key]
      };
    });
  }

  function provinceBreakdown(posts) {
    var counts = {};
    var unknown = 0;
    (posts || []).forEach(function (post) {
      var user = window.ShieldAccount && ShieldAccount.findById
        ? ShieldAccount.findById(post.authorId)
        : null;
      var province = user && user.province ? String(user.province).trim() : '';
      if (!province) {
        unknown += 1;
        return;
      }
      counts[province] = (counts[province] || 0) + 1;
    });
    var rows = (window.ShieldAccount && ShieldAccount.PROVINCES
      ? ShieldAccount.PROVINCES.slice()
      : Object.keys(counts)).map(function (name) {
      return { name: name, count: counts[name] || 0 };
    }).filter(function (row) { return row.count > 0; })
      .sort(function (a, b) { return b.count - a.count; });
    if (unknown) {
      rows.push({ name: 'Not set', count: unknown });
    }
    return rows;
  }

  function trendingPatterns(posts) {
    var labelCounts = {};
    var entityMap = {};
    (posts || []).forEach(function (post) {
      var label = post.label || 'scam';
      labelCounts[label] = (labelCounts[label] || 0) + 1;
      (post.entityIds || []).forEach(function (id) {
        entityMap[id] = (entityMap[id] || 0) + 1;
      });
    });

    var entities = store.listEntities();
    var entityRows = entities.map(function (entity) {
      return {
        id: entity.id,
        label: entity.display || entity.value || entity.id,
        kind: entity.kind || 'contact',
        count: entity.reportCount || entityMap[entity.id] || 0
      };
    }).filter(function (row) { return row.count > 0; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 5);

    var labelRows = Object.keys(labelCounts).map(function (key) {
      return {
        key: key,
        label: (ShieldCommunity.LABELS && ShieldCommunity.LABELS[key]) || key,
        count: labelCounts[key]
      };
    }).sort(function (a, b) { return b.count - a.count; })
      .slice(0, 6);

    return { labels: labelRows, entities: entityRows };
  }

  function renderMonthChart(series, chartId, emptyId) {
    var chart = $(chartId || 'an-month-chart');
    var empty = $(emptyId || 'an-month-empty');
    if (!chart) { return; }
    var max = 0;
    series.forEach(function (row) {
      max = Math.max(max, row.reports, row.scans);
    });
    var hasData = max > 0;
    if (empty) { empty.hidden = hasData; }
    if (!hasData) {
      chart.innerHTML = '';
      return;
    }
    var scale = max;
    chart.innerHTML = '<div class="chart__bars">' + series.map(function (row) {
      var rH = Math.round((row.reports / scale) * 100);
      var sH = Math.round((row.scans / scale) * 100);
      var label = row.day % 5 === 1 || row.day === series.length ? String(row.day) : '';
      return '<div class="chart__col" title="Day ' + row.day +
        ': ' + row.reports + ' reports, ' + row.scans + ' scans">' +
        '<div class="chart__stack">' +
        '<span class="chart__bar chart__bar--reports" style="height:' + rH + '%"></span>' +
        '<span class="chart__bar chart__bar--scans" style="height:' + sH + '%"></span>' +
        '</div>' +
        (label ? '<span class="chart__tick">' + label + '</span>' : '<span class="chart__tick chart__tick--blank"></span>') +
        '</div>';
    }).join('') + '</div>';
  }

  function renderProvinceList(rows) {
    var box = $('an-province-list');
    if (!box) { return; }
    if (!rows.length) {
      box.innerHTML = '<p class="empty">No province data yet. Reports show here once reporters set a province.</p>';
      return;
    }
    var max = rows[0].count || 1;
    box.innerHTML = '<ul class="rank-list">' + rows.map(function (row) {
      var width = Math.max(8, Math.round((row.count / max) * 100));
      return '<li class="rank-list__item">' +
        '<div class="rank-list__meta">' +
        '<span class="rank-list__name">' + escapeHtml(row.name) + '</span>' +
        '<span class="rank-list__count">' + row.count + '</span>' +
        '</div>' +
        '<div class="rank-list__track" aria-hidden="true">' +
        '<span class="rank-list__fill" style="width:' + width + '%"></span>' +
        '</div></li>';
    }).join('') + '</ul>';
  }

  function renderTrends(trends) {
    var box = $('an-trends');
    if (!box) { return; }
    var parts = [];
    if (trends.labels.length) {
      parts.push('<div class="trend-block">' +
        '<p class="trend-block__title">Report types</p>' +
        '<ul class="trend-chips">' +
        trends.labels.map(function (row) {
          return '<li class="trend-chip"><span>' + escapeHtml(row.label) +
            '</span><strong>' + row.count + '</strong></li>';
        }).join('') +
        '</ul></div>');
    }
    if (trends.entities.length) {
      parts.push('<div class="trend-block">' +
        '<p class="trend-block__title">Hot contacts &amp; sites</p>' +
        '<ul class="rank-list">' +
        trends.entities.map(function (row) {
          return '<li class="rank-list__item rank-list__item--compact">' +
            '<div class="rank-list__meta">' +
            '<span class="rank-list__name">' + escapeHtml(row.label) + '</span>' +
            '<span class="rank-list__count">' + row.count + '</span>' +
            '</div></li>';
        }).join('') +
        '</ul></div>');
    }
    box.innerHTML = parts.length
      ? parts.join('')
      : '<p class="empty">No community patterns yet. Trends appear as people report messages.</p>';
  }

  function renderAnalytics() {
    var posts = store.listPosts();
    var checks = allChecks();
    var trust = myTrust();
    var stats = ShieldCommunity.dashboardStats(posts, trust);
    var now = new Date();

    if ($('an-reports-value')) { $('an-reports-value').textContent = String(stats.totalReports || 0); }
    if ($('an-scans-value')) { $('an-scans-value').textContent = String(checks.length); }
    if ($('an-live-value')) { $('an-live-value').textContent = String(stats.liveAlerts || 0); }
    if ($('an-mine-value')) { $('an-mine-value').textContent = String(stats.myReports || 0); }

    var monthName = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    var hint = $('an-month-hint');
    if (hint) { hint.textContent = monthName + ' · reports vs scans by day'; }

    var series = buildMonthSeries(posts, checks, now);
    renderMonthChart(series, 'an-month-chart', 'an-month-empty');
    renderProvinceList(provinceBreakdown(posts));
    renderTrends(trendingPatterns(posts));
  }

  function renderLiveAlerts(posts) {
    var feed = ShieldCommunity.buildFeed(posts).filter(function (item) { return item.live; });
    $('dash-live').innerHTML = feed.length
      ? feed.slice(0, 3).map(miniReportHtml).join('')
      : emptyState(
          posts.length
            ? 'Nothing reported in the last ' + ShieldCommunity.LIVE_WINDOW_HOURS + ' hours'
            : 'No reports yet',
          posts.length
            ? 'Older reports are still in Community under All.'
            : 'When someone reports a message, the live ones appear here.',
          'Report a message', 'community', null, 'report');
  }

  function renderHotContacts() {
    var entities = store.listEntities().slice().sort(function (a, b) {
      return (b.reportCount || 0) - (a.reportCount || 0);
    });
    $('dash-watch').innerHTML = entities.length
      ? entities.slice(0, 5).map(watchItemHtml).join('')
      : emptyState(
          'Nothing on the watchlist yet',
          'A number or website is added once a report mentions one. Scanning a message will warn you if it matches.',
          'Scan a message', 'check', null, 'watch');
  }

  function renderLastCheck() {
    var box = $('dash-last');
    if (!box) { return; }
    var checks = allChecks();
    if (!checks.length) {
      box.innerHTML = emptyState(
        'No checks yet',
        'Your last scan will show here so you can reopen it without digging through History.',
        'Scan a message', 'check', null, 'scan');
      return;
    }
    var item = checks[checks.length - 1];
    var when = new Date(item.createdAt).toLocaleString();
    box.innerHTML =
      '<button class="hist-item" type="button" data-check-id="' + escapeHtml(item.id) + '">' +
      '<span class="hist-risk hist-risk--' + item.risk.toLowerCase() + '">' + escapeHtml(item.risk) + '</span>' +
      '<span class="hist-body">' +
      '<span class="hist-text">' + escapeHtml(item.message) + '</span>' +
      '<span class="hist-meta">' + (item.signals || []).length + ' signals · ' + escapeHtml(when) + '</span>' +
      '</span></button>';
  }

  /*
   * Home should surface decisions, not vanity counts. An item appears when
   * one of your reports got new backing, or when your latest scan matches
   * something already in the community.
   */
  function attentionSeen() {
    var map = readJson(ATTENTION_KEY, {});
    return map && typeof map === 'object' ? map : {};
  }

  function writeAttentionSeen(map) {
    writeJson(ATTENTION_KEY, map);
  }

  function mergeSeen(base, extra) {
    var out = {};
    Object.keys(base || {}).forEach(function (key) { out[key] = base[key]; });
    Object.keys(extra || {}).forEach(function (key) { out[key] = extra[key]; });
    return out;
  }

  function renderAttention(posts) {
    var section = $('dash-attention-section');
    var list = $('dash-attention');
    if (!section || !list) { return; }

    var seen = attentionSeen();
    var items = [];
    var nextSeen = {};

    posts.forEach(function (post) {
      if (post.authorId !== SESSION.id || ShieldCommunity.isHidden(post)) { return; }
      var stamp = post.lastActivityAt || post.createdAt;
      nextSeen[post.id] = stamp;
      var last = seen[post.id];
      var votes = post.votes || {};
      var activity = (votes.scam || 0) + (votes.metoo || 0) + (votes.legit || 0) + (votes.reported || 0);
      if (!activity) { return; }
      if (last && last === stamp) { return; }
      var decorated = ShieldCommunity.decorate(post);
      items.push({
        kind: 'report',
        id: post.id,
        title: decorated.standing.label,
        body: 'Your report got new responses. Open it to see what people said.',
        action: 'Open report',
        postId: post.id
      });
    });

    var checks = allChecks();
    if (checks.length) {
      var last = checks[checks.length - 1];
      var entities = ShieldCommunity.extractEntities(last.message || '');
      var watchHits = store.listEntities().filter(function (entity) {
        return entities.some(function (candidate) {
          return candidate.kind === entity.kind && candidate.value === entity.value;
        });
      });
      var similar = similarTo(draftFor(last.message || '', {
        hits: (last.signals || []).map(function (s) { return { id: s.id }; })
      }));
      if (watchHits.length || similar.length) {
        var key = 'check:' + last.id;
        nextSeen[key] = last.createdAt;
        if (seen[key] !== last.createdAt) {
          items.push({
            kind: 'match',
            id: last.id,
            title: 'Your last scan matches community reports',
            body: (watchHits.length ? watchHits.length + ' watchlist hit' + (watchHits.length === 1 ? '' : 's') : '') +
              (watchHits.length && similar.length ? ' · ' : '') +
              (similar.length ? similar.length + ' similar report' + (similar.length === 1 ? '' : 's') : '') +
              '.',
            action: 'Open scan',
            checkId: last.id
          });
        }
      }
    }

    if (!items.length) {
      section.hidden = true;
      list.innerHTML = '';
      writeAttentionSeen(mergeSeen(seen, nextSeen));
      return;
    }

    section.hidden = false;
    list.innerHTML = items.slice(0, 4).map(function (item) {
      var attrs = item.postId
        ? ' data-post-id="' + escapeHtml(item.postId) + '"'
        : ' data-check-id="' + escapeHtml(item.checkId) + '"';
      return '<li class="attention-item">' +
        '<button class="attention-item__btn" type="button"' + attrs + '>' +
        '<span class="attention-item__title">' + escapeHtml(item.title) + '</span>' +
        '<span class="attention-item__body">' + escapeHtml(item.body) + '</span>' +
        '<span class="attention-item__action">' + escapeHtml(item.action) + '</span>' +
        '</button></li>';
    }).join('');
  }

  /*
   * An empty list should read as a deliberate state, not a broken page, so it
   * says what is missing and offers the one action that fills it.
   */
  /*
   * `actionNav` moves to another view. `actionFocus` is for an action that lives
   * in the view you are already in, where navigating would be a no-op.
   * `icon` is a named glyph for empty states (scan, report, watch, history).
   */
  var EMPTY_ICONS = {
    scan: '<circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.3 4.3"/>',
    report: '<path d="M12 3.5 4.8 6.4v5.8c0 4.4 3.1 8.2 7.2 9.3 4.1-1.1 7.2-4.9 7.2-9.3V6.4L12 3.5Z"/><path d="M12 8.5v5M12 16h.01"/>',
    watch: '<path d="M4 6.5h16v11H4z"/><path d="M4 10h16"/>',
    history: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>'
  };

  function emptyState(title, body, actionLabel, actionNav, actionFocus, icon) {
    var glyph = icon && EMPTY_ICONS[icon]
      ? '<span class="empty-state__icon" aria-hidden="true"><svg viewBox="0 0 24 24">' +
        EMPTY_ICONS[icon] + '</svg></span>'
      : '';
    return '<div class="empty-state">' + glyph +
      '<p class="empty-state__title">' + escapeHtml(title) + '</p>' +
      '<p class="empty-state__body">' + escapeHtml(body) + '</p>' +
      (actionLabel
        ? '<button class="btn btn--small" type="button"' +
          (actionNav ? ' data-nav="' + escapeHtml(actionNav) + '"' : '') +
          (actionFocus ? ' data-focus="' + escapeHtml(actionFocus) + '"' : '') +
          '>' + escapeHtml(actionLabel) + '</button>'
        : '') +
      '</div>';
  }

  function watchItemHtml(entity) {
    var icon = entity.kind === 'domain'
      ? '<path d="M4 6.5h16v11H4z"/><path d="M4 10h16"/>'
      : '<path d="M7 3.5h10v17H7z"/><path d="M10.5 17.5h3"/>';
    return '<div class="watch-item">' +
      '<span class="watch-item__icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' +
      '<span class="watch-item__body">' +
      '<span class="watch-item__name">' + escapeHtml(entity.displayName) + '</span>' +
      '<span class="watch-item__meta">' + entity.reportCount + ' report' +
      (entity.reportCount === 1 ? '' : 's') +
      (entity.confirmCount ? ', ' + entity.confirmCount + ' confirmed' : ', none confirmed yet') +
      '</span>' +
      '</span></div>';
  }

  function miniReportHtml(item) {
    return '<button class="mini-report" type="button" data-post-id="' + escapeHtml(item.id) + '">' +
      '<span class="mini-report__top">' +
      '<span class="mini-report__label">' + escapeHtml(item.labelText) + '</span>' +
      '<span class="standing standing--' + item.standing.key + '">' +
      '<span class="standing__dot" aria-hidden="true"></span>' + escapeHtml(item.standing.label) + '</span>' +
      '<span class="mini-report__age">' + escapeHtml(item.age) + '</span>' +
      '</span>' +
      '<span class="mini-report__text">' + escapeHtml(item.message) + '</span>' +
      '</button>';
  }

  /* ================================================================
     COMPOSER
     ================================================================ */

  function renderLabels() {
    var html = Object.keys(ShieldCommunity.LABELS).map(function (key) {
      return '<button class="label-pick" type="button" data-label="' + key + '" aria-pressed="false">' +
        escapeHtml(ShieldCommunity.LABELS[key]) + '</button>';
    }).join('');
    $('labels').innerHTML = html;
  }

  function setLabel(key) {
    pickedLabel = key;
    Array.prototype.forEach.call(document.querySelectorAll('.label-pick'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-label') === key ? 'true' : 'false');
    });
    $('post-status').textContent = key ? '' : 'Choose what this is before posting.';
  }

  /*
   * Runs the same engine the checker uses, so a community post and a check
   * can never disagree about the same message.
   */
  function scanComposer() {
    var text = $('post-message').value.trim();
    var box = $('post-scan');
    if (!text) {
      box.hidden = true;
      renderDuplicatePrompt([]);
      return null;
    }
    if (!window.ShieldRules) { return null; }

    var result = ShieldRules.check(text);
    var badge = $('post-scan-badge');
    badge.className = 'risk risk--' + result.risk.toLowerCase();
    $('post-scan-icon').innerHTML = iconFor(result.risk);
    $('post-scan-level').textContent = result.risk + ' RISK';
    $('post-scan-note').textContent = result.hitCount
      ? 'Our rules found ' + result.hitCount + ' pattern' + (result.hitCount === 1 ? '' : 's') +
        ' here. That is our read, not the community\'s opinion. Say below what actually happened to you.'
      : 'Our rules found nothing obvious here. If it still felt wrong, say so: people report things before our rules learn them.';
    box.hidden = false;

    renderDuplicatePrompt(similarTo(draftFor(text, result)));
    return result;
  }

  /*
   * Waze, when you report a hazard next to an existing pin, asks whether you
   * mean that one. Same idea: if the pasted message already has a report,
   * "Me too" on it is worth more than a second copy in the feed.
   */
  function renderDuplicatePrompt(similar) {
    var box = $('post-similar');
    if (!box) { return; }
    var notice = ShieldSimilarity.duplicateNotice(similar);
    if (!notice) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.className = 'similar' + (notice.strong ? ' similar--strong' : '');
    box.innerHTML =
      '<p class="similar__title">' + escapeHtml(notice.title) + '</p>' +
      '<p class="similar__body">' + escapeHtml(notice.body) + '</p>' +
      '<ul class="similar-list">' + similar.slice(0, 3).map(function (match) {
        return similarItemHtml(match, true);
      }).join('') + '</ul>' +
      '<p class="similar__foot">Not the same thing? Carry on and post yours below.</p>';
    box.hidden = false;
  }

  function clearComposerErrors() {
    $('post-message').classList.remove('is-invalid');
    $('post-message').removeAttribute('aria-invalid');
    $('post-message-error').textContent = '';
    composerFiles.clearError();
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  /*
   * Photos carry GPS coordinates and the name of the device that took them.
   * Handing those to a stranger's browser to look at a screenshot is not
   * something the person pasting the evidence agreed to, so the pixels are
   * re-encoded through a canvas, which drops the metadata block.
   *
   * GIFs are left alone on purpose: re-encoding flattens them to one frame,
   * and losing frames is a worse deal than the metadata risk on a format
   * nobody pastes as evidence.
   */
  function sanitizeImage(file) {
    if (file.type === 'image/gif') {
      return Promise.resolve({ file: file, cleaned: false });
    }
    return loadImage(file).then(function (img) {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext('2d');
      if (!ctx) { throw new Error('no 2d context'); }
      ctx.drawImage(img, 0, 0);
      var type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          if (!blob) { throw new Error('encode failed'); }
          resolve({ file: new File([blob], file.name, { type: type }), cleaned: true });
        }, type, 0.92);
      });
    }).catch(function () {
      /* an image we cannot decode is still evidence, so keep it as it is */
      return { file: file, cleaned: false };
    });
  }

  /*
   * One drop zone, one list of pending files. The composer and the scanner
   * each own an instance, so a screenshot dropped while scanning can be
   * handed to the composer intact when the user decides to post it.
   */
  function createUploader(ids) {
    var zone = $(ids.zone);
    var input = $(ids.input);
    var thumbs = $(ids.thumbs);
    var error = $(ids.error);
    var items = [];
    var pending = [];

    function revoke(item) {
      if (item && item.url && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(item.url);
      }
    }

    function setError(message) {
      error.textContent = message || '';
      zone.classList.toggle('is-invalid', Boolean(message));
    }

    function count() {
      return items.length + ' file' + (items.length === 1 ? '' : 's') + ' attached.';
    }

    function setUploading(on, fileCount) {
      zone.classList.toggle('is-uploading', Boolean(on));
      zone.setAttribute('aria-busy', on ? 'true' : 'false');
      var label = zone.querySelector('.drop__upload-label');
      if (label) {
        label.textContent = on
          ? (fileCount === 1 ? 'Preparing your file' : 'Preparing your files')
          : 'Preparing your file';
      }
    }

    function render(opts) {
      var ready = opts && opts.ready;
      var html = items.map(function (item, index) {
        var inner = item.kind === 'image' && item.url
          ? '<img class="thumb__img" src="' + item.url + '" alt="">'
          : '<span class="thumb__file">PDF</span>';
        return '<li class="thumb' + (ready ? ' is-ready' : '') + '">' +
          '<span class="thumb__box">' + inner + '</span>' +
          '<button class="thumb__remove" type="button" data-remove="' + index + '" aria-label="Remove ' +
          escapeHtml(item.file.name) + '">&times;</button>' +
          '<span class="thumb__name">' + escapeHtml(item.file.name) + '</span>' +
          '</li>';
      }).join('');
      html += pending.map(function (name) {
        return '<li class="thumb is-pending" aria-busy="true">' +
          '<span class="thumb__box"></span>' +
          '<span class="thumb__name">' + escapeHtml(name) + '</span>' +
          '</li>';
      }).join('');
      thumbs.innerHTML = html;
    }

    function add(files) {
      setError('');
      var list = Array.prototype.slice.call(files || []);
      var problem = '';
      var accepted = [];

      list.forEach(function (file) {
        if (items.length + accepted.length >= ShieldCommunity.MAX_ATTACHMENTS) {
          problem = 'You can attach up to ' + ShieldCommunity.MAX_ATTACHMENTS + ' files.';
          return;
        }
        var check = ShieldCommunity.validateAttachment(file);
        if (!check.ok) {
          problem = check.reason + ' (' + file.name + ')';
          return;
        }
        accepted.push(file);
      });

      setError(problem);
      if (!accepted.length) {
        announce(count());
        return;
      }

      pending = accepted.map(function (file) { return file.name; });
      setUploading(true, accepted.length);
      render();
      announce(accepted.length === 1
        ? 'Preparing your file...'
        : 'Preparing ' + accepted.length + ' files...');

      var started = Date.now();
      var minMs = prefersReducedMotion() ? 180 : 650;

      Promise.all(accepted.map(sanitizeImage)).then(function (results) {
        var tooBig = null;
        results.forEach(function (result) {
          var file = result.file;
          /* re-encoding can grow a file, so the limit is checked again */
          if (file.size > ShieldCommunity.MAX_ATTACHMENT_BYTES) {
            tooBig = file.name;
            return;
          }
          items.push({
            file: file,
            kind: ShieldCommunity.attachmentKind(file),
            url: store.objectUrlFor(file)
          });
        });
        if (tooBig) {
          setError(tooBig + ' is over 5MB once its metadata is removed.');
        }

        var wait = Math.max(0, minMs - (Date.now() - started));
        window.setTimeout(function () {
          pending = [];
          setUploading(false, 0);
          render({ ready: true });
          announce(count());
        }, wait);
      }).catch(function () {
        pending = [];
        setUploading(false, 0);
        render();
        setError('That file could not be prepared. Try another image or PDF.');
      });
    }

    function remove(index) {
      revoke(items[index]);
      items.splice(index, 1);
      setError('');
      render();
    }

    function wire() {
      /*
       * The input lives inside the zone, so the click it raises while
       * opening the picker bubbles straight back here. Without the guard
       * each tap would ask for the file twice.
       */
      var opening = false;
      zone.addEventListener('click', function (event) {
        if (zone.classList.contains('is-uploading')) { return; }
        if (event.target === input || opening) { return; }
        opening = true;
        input.click();
        opening = false;
      });
      zone.addEventListener('keydown', function (event) {
        if (zone.classList.contains('is-uploading')) { return; }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          input.click();
        }
      });
      input.addEventListener('change', function () {
        add(input.files);
        input.value = '';
      });

      ['dragenter', 'dragover'].forEach(function (name) {
        zone.addEventListener(name, function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (!zone.classList.contains('is-uploading')) { zone.classList.add('is-over'); }
        });
      });
      ['dragleave', 'dragend'].forEach(function (name) {
        zone.addEventListener(name, function () { zone.classList.remove('is-over'); });
      });
      zone.addEventListener('drop', function (event) {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove('is-over');
        if (zone.classList.contains('is-uploading')) { return; }
        add(event.dataTransfer ? event.dataTransfer.files : null);
      });

      thumbs.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('[data-remove]') : null;
        if (button) { remove(Number(button.getAttribute('data-remove'))); }
      });
    }

    return {
      wire: wire,
      add: add,
      files: function () { return items.slice(); },
      count: function () { return items.length; },
      clearError: function () { setError(''); },
      setError: setError,
      /* hand the files to another uploader without revoking their preview URLs */
      take: function () {
        var out = items;
        items = [];
        pending = [];
        setUploading(false, 0);
        render();
        return out;
      },
      adopt: function (list) {
        (list || []).forEach(function (item) {
          if (items.length < ShieldCommunity.MAX_ATTACHMENTS) { items.push(item); }
          else { revoke(item); }
        });
        render({ ready: true });
      },
      reset: function () {
        items.forEach(revoke);
        items = [];
        pending = [];
        setUploading(false, 0);
        setError('');
        render();
      }
    };
  }

  function resetComposer() {
    composerFiles.reset();
    pickedLabel = null;
    $('post-message').value = '';
    $('post-scan').hidden = true;
    $('post-status').textContent = '';
    renderDuplicatePrompt([]);
    renderLabels();
    clearComposerErrors();
  }

  function publishPost() {
    clearComposerErrors();
    var text = $('post-message').value.trim();

    if (!text) {
      $('post-message').classList.add('is-invalid');
      $('post-message').setAttribute('aria-invalid', 'true');
      $('post-message-error').textContent = 'Paste the message you were sent.';
      $('post-message').focus();
      return;
    }
    if (!pickedLabel) {
      $('post-status').textContent = 'Choose what this is before posting.';
      return;
    }
    if (!window.ShieldRules) {
      showBanner('The check engine did not load. Reload the page and try again.');
      return;
    }

    var trust = myTrust();
    var allowed = ShieldCommunity.canPost(trust, store.listPosts());
    if (!allowed.ok) {
      $('post-status').textContent = allowed.reason;
      return;
    }

    var scan = ShieldRules.check(text);
    var attachments = [];

    /*
     * Blobs are written before the post so a failed upload never leaves a
     * post pointing at attachments that are not there.
     */
    var writes = composerFiles.files().map(function (item, index) {
      var key = 'att_' + Date.now().toString(36) + '_' + index;
      return store.putBlob(key, item.file).then(function () {
        attachments.push({
          id: key,
          kind: item.kind,
          name: item.file.name,
          mime: item.file.type,
          size: item.file.size,
          blobKey: key
        });
      });
    });

    Promise.all(writes).then(function () {
      var entities = ShieldCommunity.extractEntities(text);
      var entityIds = entities.map(function (candidate) {
        var saved = store.upsertEntity(candidate);
        return saved.id;
      });

      var post = store.addPost({
        authorId: SESSION.id,
        authorName: shortName(SESSION.fullName),
        message: text,
        label: pickedLabel,
        scan: {
          risk: scan.risk,
          score: scan.score,
          signalIds: (scan.reportedHits || scan.hits).map(function (h) { return h.id; })
        },
        attachments: attachments,
        entityIds: entityIds
      });

      store.bumpTrust(SESSION.id, { postsMade: 1 });
      renderTrustChip(myTrust());

      resetComposer();
      showBanner('Posted. It will show as unconfirmed until others back it up.');
      feedFilter = 'live';
      go('community');
      openPost(post.id);
    }).catch(function () {
      composerFiles.setError('The attachment could not be saved. Try a smaller file.');
    });
  }

  /* ================================================================
     SIMILARITY (Waze: "3 reports here")
     ================================================================ */

  /*
   * Stored posts hold entity ids; a draft only has the numbers and domains
   * pulled out of its text. Both are compared as "kind|value" keys so a
   * message that has not been posted yet can still be matched against the
   * ones that have.
   */
  function entityKeyIndex() {
    var index = {};
    store.listEntities().forEach(function (entity) {
      index[entity.id] = entity.kind + '|' + entity.value;
    });
    return index;
  }

  function similarityOptions() {
    var index = entityKeyIndex();
    return {
      entityKeysOf: function (post) {
        return (post.entityIds || []).map(function (id) { return index[id]; }).filter(Boolean);
      },
      include: function (post) { return !ShieldCommunity.isHidden(post); }
    };
  }

  function draftFor(message, scan) {
    return {
      message: message,
      scan: { signalIds: (scan && scan.hits ? scan.hits : []).map(function (h) { return h.id; }) },
      entityKeys: ShieldCommunity.extractEntities(message).map(function (e) { return e.kind + '|' + e.value; })
    };
  }

  function similarTo(target) {
    return ShieldSimilarity.findSimilar(target, store.listPosts(), similarityOptions());
  }

  function similarCounts(posts) {
    return ShieldSimilarity.countMap(posts, similarityOptions());
  }

  function similarChip(count) {
    if (!count) { return ''; }
    return '<span class="tag tag--similar" title="Other reports that look like the same scam">' +
      count + ' similar</span>';
  }

  function similarItemHtml(match, withMeToo) {
    var item = ShieldCommunity.decorate(match.post);
    var mine = match.post.authorId === SESSION.id;
    return '<li class="similar-item">' +
      '<button class="mini-report" type="button" data-post-id="' + escapeHtml(item.id) + '">' +
      '<span class="mini-report__top">' +
      '<span class="mini-report__label">' + escapeHtml(item.labelText) + '</span>' +
      '<span class="standing standing--' + item.standing.key + '">' +
      '<span class="standing__dot"></span>' + escapeHtml(item.standing.label) + '</span>' +
      '<span class="mini-report__age">' + escapeHtml(item.age) + '</span>' +
      '</span>' +
      '<span class="mini-report__text">' + escapeHtml(item.message) + '</span>' +
      '<span class="similar-item__why">' + escapeHtml(match.reason) +
      ' &middot; ' + Math.round(match.score * 100) + '% match</span>' +
      '</button>' +
      (withMeToo && !mine
        ? '<button class="btn btn--small btn--metoo" type="button" data-metoo="' + escapeHtml(item.id) + '">' +
          'Me too, same scam</button>'
        : '') +
      '</li>';
  }

  /* ================================================================
     COMMUNITY
     ================================================================ */

  function renderCommunity() {
    var posts = store.listPosts();
    var now = Date.now();

    Array.prototype.forEach.call(document.querySelectorAll('.filter'), function (button) {
      var active = button.getAttribute('data-filter') === feedFilter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    var feed = ShieldCommunity.buildFeed(posts, now);
    var items;

    if (feedFilter === 'live') {
      items = feed.filter(function (item) { return item.live; });
    } else if (feedFilter === 'mine') {
      items = feed.filter(function (item) { return item.authorId === SESSION.id; });
    } else if (feedFilter === 'watch') {
      var watched = {};
      store.listEntities().forEach(function (entity) { watched[entity.id] = true; });
      items = feed.filter(function (item) {
        return (item.entityIds || []).some(function (id) { return watched[id]; });
      });
    } else {
      items = feed;
    }

    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      items = items.filter(function (item) {
        var hay = ((item.message || '') + ' ' + (item.authorName || '') + ' ' +
          (item.label || '') + ' ' + ((item.entityIds || []).join(' '))).toLowerCase();
        return hay.indexOf(q) > -1;
      });
    }

    if (!items.length) {
      if (searchQuery) {
        $('feed').innerHTML = '<p class="empty">No reports match “' + escapeHtml(searchQuery) + '”.</p>';
        return;
      }
      if (store.listPosts().length === 0) {
        $('feed').innerHTML = emptyState(
          'Nobody has reported anything yet',
          'This is a genuinely empty list, not a quiet one. It fills up as job seekers report the messages they were sent.',
          'Write the first report', '', 'post-message', 'report');
        $('post-message').focus();
      } else {
        $('feed').innerHTML = '<p class="empty">' + escapeHtml(emptyMessage(feedFilter)) + '</p>';
      }
      return;
    }

    var counts = similarCounts(posts);
    $('feed').innerHTML = '<div class="feed">' + items.map(function (item) {
      return reportHtml(item, counts[item.id] || 0);
    }).join('') + '</div>';
  }

  function emptyMessage(filter) {
    if (filter === 'live') { return 'No live reports in the last ' + ShieldCommunity.LIVE_WINDOW_HOURS + ' hours. Older reports are under All.'; }
    if (filter === 'mine') { return 'You have not posted anything yet. Use the report box above.'; }
    if (filter === 'watch') { return 'No reports mention a number or site that is on the watchlist.'; }
    return 'No reports yet.';
  }

  function reportHtml(item, similarCount) {
    var mine = item.authorId === SESSION.id;
    var votes = item.credibility;

    var files = '';
    if (item.attachments && item.attachments.length) {
      files = '<ul class="report__files">' + item.attachments.map(function (att) {
        if (att.kind === 'image') {
          return '<li><span class="report__file" data-att="' + escapeHtml(att.blobKey) + '">' +
            '<span>' + escapeHtml(att.name) + '</span></span></li>';
        }
        return '<li><a class="report__file" href="#" data-att="' + escapeHtml(att.blobKey) + '">' +
          escapeHtml(att.name) + '</a></li>';
      }).join('') + '</ul>';
    }

    return '<article class="report' + (item.live ? '' : ' is-past') + '">' +
      '<div class="report__top">' +
      '<span class="tag' + (item.label === 'legit' ? ' tag--legit' : '') + '">' +
      escapeHtml(item.labelText) + '</span>' +
      (item.scan ? '<span class="tag tag--scan">rules: ' + escapeHtml(item.scan.risk) + '</span>' : '') +
      similarChip(similarCount) +
      (mine ? '<span class="tag tag--mine">yours</span>' : '') +
      '<span class="report__author">' + escapeHtml(item.authorName) + '</span>' +
      '<span class="report__age">' + escapeHtml(item.age) + '</span>' +
      '</div>' +
      '<p class="report__text report__text--clamp">' + escapeHtml(item.message) + '</p>' +
      files +
      '<div class="report__foot">' +
      '<span class="standing standing--' + item.standing.key + '">' +
      '<span class="standing__dot"></span>' + escapeHtml(item.standing.label) + '</span>' +
      '<span class="votes">' +
      voteCount('scam', votes.agree) + voteCount('reported', votes.reported) +
      '</span>' +
      '<button class="link-btn" type="button" data-post-id="' + escapeHtml(item.id) + '">Open</button>' +
      '</div></article>';
  }

  function voteCount(kind, n) {
    var path = kind === 'scam'
      ? '<path d="M12 3.5 4.5 6.2v5.2c0 4.1 3 7.7 7.5 9.1 4.5-1.4 7.5-5 7.5-9.1V6.2L12 3.5Z"/>'
      : '<path d="M5 12.5 9.5 17 19 7.5"/>';
    return '<span class="vote-count"><svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>' + n + '</span>';
  }

  function openPost(id) {
    var post = store.getPost(id);
    if (!post) { return; }
    openPostId = id;
    /* opening a report clears its "needs attention" marker */
    if (post.authorId === SESSION.id) {
      var seen = attentionSeen();
      seen[post.id] = post.lastActivityAt || post.createdAt;
      writeAttentionSeen(seen);
    }
    var item = ShieldCommunity.decorate(post);
    var mine = post.authorId === SESSION.id;
    var mineVote = store.voteBy(post, SESSION.id);

    var signalButtons = Object.keys(ShieldCommunity.SIGNAL_COPY).map(function (key) {
      var copy = ShieldCommunity.SIGNAL_COPY[key];
      var count = post.votes[key] || 0;
      return '<button class="signal-btn" type="button" data-signal="' + key + '"' +
        ' aria-pressed="' + (mineVote === key ? 'true' : 'false') + '"' +
        (mine ? ' disabled title="You cannot vote on your own report"' : '') + '>' +
        '<span class="signal-btn__label">' + escapeHtml(copy.label) + '</span>' +
        '<span class="signal-btn__count">' + count + ' so far</span>' +
        '<span class="signal-btn__effect">' + escapeHtml(copy.effect) + '</span>' +
        '</button>';
    }).join('');

    var entities = store.listEntities().filter(function (entity) {
      return (post.entityIds || []).indexOf(entity.id) !== -1;
    });

    var similar = similarTo(post);
    var similarHtml = similar.length
      ? '<section class="detail__section"><h2>' +
        (similar.length === 1 ? 'One similar report' : similar.length + ' similar reports') +
        '</h2>' +
        '<p>Reports that share a contact detail, the same wording or the same scam pattern. ' +
        'Similar means the message is circulating, not that it is confirmed; only votes decide that.</p>' +
        '<ul class="similar-list">' + similar.slice(0, 5).map(function (match) {
          return similarItemHtml(match, false);
        }).join('') + '</ul>' +
        (similar.length > 5 ? '<p class="similar-more">and ' + (similar.length - 5) + ' more.</p>' : '') +
        '</section>'
      : '';

    $('post-detail').innerHTML =
      '<article class="detail">' +
      '<h1 class="title">Report from ' + escapeHtml(item.authorName) + '</h1>' +
      '<div class="report__top">' +
      '<span class="tag' + (post.label === 'legit' ? ' tag--legit' : '') + '">' +
      escapeHtml(item.labelText) + '</span>' +
      (post.scan ? '<span class="tag tag--scan">rules said ' + escapeHtml(post.scan.risk) + '</span>' : '') +
      '<span class="report__author">' + escapeHtml(item.authorName) + '</span>' +
      '<span class="report__age">' + escapeHtml(item.age) + '</span>' +
      '</div>' +
      '<p class="standing standing--' + item.standing.key + '"><span class="standing__dot"></span>' +
      escapeHtml(item.standing.label) + '</p>' +
      '<p class="detail__text">' + escapeHtml(post.message) + '</p>' +
      '<p class="honesty">' + escapeHtml(ShieldCommunity.standing(post).note) +
      ' A community report is a claim by a person, not a verified fact.</p>' +
      '<section class="detail__section">' +
      '<h2>What did you get?</h2>' +
      '<p>Your answer changes how much this report is trusted, and what happens to the money.</p>' +
      '<div class="signal-row">' + signalButtons + '</div>' +
      '</section>' +
      similarHtml +
      (entities.length
        ? '<section class="detail__section"><h2>Now on the watchlist</h2>' +
          '<p>These do not expire. Anyone can check them before replying.</p>' +
          entities.map(watchItemHtml).join('') + '</section>'
        : '') +
      '<div class="flag-row">' +
      '<button class="link-btn" type="button" id="flag-post">Flag this report</button>' +
      '</div>' +
      '</article>';

    go('post');
  }

  function castVote(signal) {
    if (!openPostId) { return; }
    var before = store.getPost(openPostId);
    var result = store.castVote(openPostId, signal, SESSION.id);
    if (!result.ok) {
      showBanner(result.reason);
      return;
    }
    settleStanding(before, result.post);
    showBanner('');
    openPost(openPostId);
    announce('Recorded. Thanks for backing up a real report.');
  }

  /*
   * A vote can tip a report into or out of "corroborated" or "contested".
   * When it does, the author's record and the watchlist rows the report
   * names move with it, so rank and "confirmed" counts are earned by being
   * right, not by posting a lot.
   */
  function settleStanding(before, after) {
    if (!before || !after) { return; }
    var delta = ShieldCommunity.trustDelta(before, after);
    if (delta) {
      store.bumpTrust(after.authorId, delta);
      if (after.authorId === SESSION.id) { renderTrustChip(myTrust()); }
    }
    var confirms = ShieldCommunity.entityConfirmDelta(before, after);
    if (confirms) { store.adjustEntityConfirms(after.entityIds || [], confirms); }
  }

  /* "Me too" on an existing report, offered instead of posting a copy. */
  function backExistingReport(postId) {
    var before = store.getPost(postId);
    if (!before) { return; }
    if (before.authorId === SESSION.id) {
      showBanner('That is your own report, so it is already counted.');
      return;
    }
    var result = store.castVote(postId, 'metoo', SESSION.id);
    if (!result.ok) {
      showBanner(result.reason);
      return;
    }
    settleStanding(before, result.post);
    resetComposer();
    showBanner('Added your "Me too". The existing report is now backed by one more person.');
    openPost(postId);
  }

  /* ---------- community cross-links ---------- */

  function renderCommunityMatches(message) {
    var box = $('community-matches');
    var note = $('community-match-note');
    if (!message) {
      note.textContent = 'No message to match.';
      box.innerHTML = '';
      return;
    }

    var found = ShieldCommunity.extractEntities(message);
    var all = store.listEntities();
    var hits = all.filter(function (entity) {
      return found.some(function (candidate) {
        return candidate.kind === entity.kind && candidate.value === entity.value;
      });
    });

    /*
     * Waze warns you about a hazard ahead whether or not you searched for
     * it. The watchlist catches a known number; the similarity pass catches
     * the same scam sent from a new one.
     */
    var scan = current && current.reportedHits
      ? { hits: current.reportedHits }
      : (window.ShieldRules ? ShieldRules.check(message) : { hits: [] });
    var similar = similarTo(draftFor(message, scan));
    var corroborated = similar.filter(function (match) {
      return ShieldCommunity.standing(match.post).key === 'corroborated';
    }).length;

    if (!hits.length && !similar.length) {
      note.textContent = 'Nothing in this message is on the community watchlist yet, and no report looks like it.';
      box.innerHTML = '';
      return;
    }

    var parts = [];
    if (hits.length) {
      parts.push('The community has already reported ' + hits.length +
        ' of the ' + found.length + ' contact detail' + (found.length === 1 ? '' : 's') + ' in this message.');
    }
    if (similar.length) {
      parts.push((similar.length === 1 ? 'One community report looks' : similar.length + ' community reports look') +
        ' like the same scam' + (corroborated ? ', ' + corroborated + ' of them backed up by others' : '') + '.');
    }
    note.textContent = parts.join(' ');

    box.innerHTML = hits.map(watchItemHtml).join('') +
      (similar.length
        ? '<ul class="similar-list similar-list--flush">' + similar.slice(0, 3).map(function (match) {
            return similarItemHtml(match, false);
          }).join('') + '</ul>'
        : '');
  }

  function shareToCommunity() {
    if (!current) { return; }
    resetComposer();
    $('post-message').value = current.message || '';
    /* screenshots dropped into the scanner travel with the message */
    var carried = scanFiles.take();
    composerFiles.adopt(carried);
    scanComposer();
    go('community');
    $('post-message').focus();
    announce(carried.length
      ? 'The message and ' + carried.length + ' file' + (carried.length === 1 ? '' : 's') +
        ' are ready to post. Add a label, then press post.'
      : 'The message is ready to post. Add a label, then press post.');
  }

  /* ================================================================
     CHECKER (unchanged behaviour)
     ================================================================ */

  function resetFeedbackUi() {
    $('feedback-note').hidden = true;
    $('feedback-thanks').hidden = true;
    $('feedback-text').value = '';
    Array.prototype.forEach.call(document.querySelectorAll('.fb'), function (button) {
      button.setAttribute('aria-pressed', 'false');
    });
  }

  function renderResult(result) {
    $('risk-badge').className = 'risk risk--' + result.risk.toLowerCase();
    $('risk-icon').innerHTML = iconFor(result.risk);
    $('risk-level').textContent = result.risk + ' RISK';
    $('result-heading').textContent = VERDICT[result.risk].headline;
    $('verdict-summary').textContent = VERDICT[result.risk].summary;

    var block = $('signals-block');
    if (result.reportedHits.length) {
      block.hidden = false;
      $('signals').innerHTML = result.reportedHits.map(function (hit) {
        return '<li class="signal">' +
          '<span class="signal__label">' + escapeHtml(hit.label) +
          ' <span class="signal__weight">+' + hit.weight + ' points</span></span>' +
          '<span class="signal__reason">' + escapeHtml(hit.reason) + '</span>' +
          '<span class="signal__meta">Matched: ' + escapeHtml(hit.evidence) + '</span>' +
          '<span class="signal__meta">Source: ' + escapeHtml(hit.source) + '</span>' +
          '</li>';
      }).join('');
    } else {
      block.hidden = true;
      $('signals').innerHTML = '';
    }

    $('next-steps').innerHTML = result.nextSteps.map(function (step) {
      return '<li>' + escapeHtml(step) + '</li>';
    }).join('');
    $('honesty-note').textContent = result.note;

    resetFeedbackUi();
    renderCommunityMatches(current && current.message);
    showView('result');
    announce(result.risk + ' risk. ' + VERDICT[result.risk].headline);
  }

  function deleteCheck(id) {
    if (!id) { return; }
    var list = readJson(CHECKS_KEY, []);
    if (!Array.isArray(list)) { list = []; }
    var next = list.filter(function (item) {
      return !(item && item.id === id && item.userId === (SESSION && SESSION.id));
    });
    if (next.length === list.length) { return; }
    writeJson(CHECKS_KEY, next);

    var seen = attentionSeen();
    if (seen['check:' + id]) {
      delete seen['check:' + id];
      writeAttentionSeen(seen);
    }
    if (current && current.id === id) { current = null; }

    updateNavCounts();
    renderHistory();
    announce('Deleted that check.');
  }

  function renderHistory() {
    var checks = allChecks();
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      checks = checks.filter(function (item) {
        return String(item.message || '').toLowerCase().indexOf(q) > -1 ||
          String(item.risk || '').toLowerCase().indexOf(q) > -1;
      });
    }
    if (!checks.length) {
      if (searchQuery) {
        $('history-list').innerHTML = '<p class="empty">No checks match “' + escapeHtml(searchQuery) + '”.</p>';
        return;
      }
      $('history-list').innerHTML = emptyState(
        'No checks saved yet',
        'Every message you scan is kept on this device so you can look it up again. Nothing leaves your browser.',
        'Scan a message', 'check', null, 'history');
      return;
    }
    $('history-list').innerHTML = checks.slice().reverse().map(function (item) {
      return '<div class="hist-row">' +
        '<button class="hist-item" type="button" data-check-id="' + escapeHtml(item.id) + '">' +
        '<span class="hist-risk hist-risk--' + item.risk.toLowerCase() + '">' + escapeHtml(item.risk) + '</span>' +
        '<span class="hist-body">' +
        '<span class="hist-text">' + escapeHtml(item.message) + '</span>' +
        '<span class="hist-meta">' + (item.signals || []).length + ' signals · ' +
        escapeHtml(new Date(item.createdAt).toLocaleString()) + '</span>' +
        '</span></button>' +
        '<button class="hist-delete" type="button" data-delete-check="' + escapeHtml(item.id) + '"' +
        ' aria-label="Delete check: ' + escapeHtml((item.message || '').slice(0, 60)) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M5 7h14M10 7V5.8A1.2 1.2 0 0 1 11.2 4.5h1.6A1.2 1.2 0 0 1 14 5.8V7m2 0v11.2a1.3 1.3 0 0 1-1.3 1.3H9.3A1.3 1.3 0 0 1 8 18.2V7"/>' +
        '<path d="M10 11v5M14 11v5"/>' +
        '</svg>' +
        '<span>Delete</span></button>' +
        '</div>';
    }).join('');
  }

  function openCheckFromHistory(id) {
    var item = null;
    allChecks().forEach(function (candidate) {
      if (candidate.id === id) { item = candidate; }
    });
    if (!item) { return; }
    var seen = attentionSeen();
    seen['check:' + item.id] = item.createdAt;
    writeAttentionSeen(seen);
    $('message').value = item.message || '';

    /*
     * Storage keeps the compact signal list, so the full verdicts are rebuilt
     * here and written back onto the entry. Without them a reopened result
     * would still show correctly but share a text with nothing in it.
     */
    var fresh = reconstruct(item);
    item.reportedHits = fresh.reportedHits;
    item.nextSteps = fresh.nextSteps;
    item.note = fresh.note;
    current = item;
    renderResult(fresh);
  }

  function reconstruct(saved) {
    var fresh = ShieldRules.check(saved.message || '');
    return {
      risk: saved.risk,
      score: saved.score,
      reportedHits: (saved.signals || []).map(function (hit) {
        var rule = ShieldRules.rules.filter(function (r) { return r.id === hit.id; })[0];
        return {
          id: hit.id,
          label: hit.label,
          reason: rule ? rule.reason : '',
          weight: hit.weight,
          source: rule ? rule.source : '',
          evidence: hit.evidence
        };
      }),
      nextSteps: fresh.nextSteps,
      note: fresh.note
    };
  }

  function runCheck() {
    var text = $('message').value.trim();
    $('message').classList.remove('is-invalid');
    $('message').removeAttribute('aria-invalid');
    $('message-error').textContent = '';
    showBanner('');

    if (!text) {
      $('message').classList.add('is-invalid');
      $('message').setAttribute('aria-invalid', 'true');
      /* the rules read text only, so a screenshot alone cannot be scanned yet */
      $('message-error').textContent = scanFiles.count()
        ? 'We cannot read the text inside a screenshot yet. Paste the message as text too.'
        : 'Paste a message to check.';
      $('message').focus();
      return;
    }
    if (!window.ShieldRules) {
      showBanner('The check engine did not load. Reload the page and try again.');
      return;
    }
    if (scanBusy) { return; }

    showView('check');
    playScanBusy(function () {
      var result = ShieldRules.check(text);
      var entry = saveCheck(text, result);
      entry.reportedHits = result.reportedHits;
      entry.nextSteps = result.nextSteps;
      entry.note = result.note;
      current = entry;
      renderResult(result);
    });
  }

  function prefersReducedMotion() {
    if (document.body.classList.contains('reduce-motion')) { return true; }
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  var scanBusy = false;
  var scanBusyTimer = null;
  var SCAN_TIPS = [
    'Looking for fee asks and fake learnerships',
    'Checking names of big institutions',
    'Watching for WhatsApp-only tricks',
    'Matching numbers already on the watchlist',
    'Almost done'
  ];

  function playScanBusy(done) {
    var panel = $('scan-busy');
    var label = $('scan-busy-label');
    var tip = $('scan-busy-tip');
    var btn = $('run-check');
    var view = $('view-check');
    var reduced = prefersReducedMotion();
    var started = Date.now();
    var tipIndex = 0;
    var minMs = reduced ? 280 : 1100;

    scanBusy = true;
    if (btn) { btn.disabled = true; }
    if (view) { view.classList.add('is-scanning'); }
    if (panel) {
      panel.hidden = false;
      panel.setAttribute('aria-busy', 'true');
    }
    if (label) { label.textContent = 'Scanning the message'; }
    if (tip) { tip.textContent = SCAN_TIPS[0]; }
    announce('Scanning the message.');

    if (scanBusyTimer) { window.clearInterval(scanBusyTimer); }
    if (!reduced) {
      scanBusyTimer = window.setInterval(function () {
        tipIndex = (tipIndex + 1) % SCAN_TIPS.length;
        if (tip) { tip.textContent = SCAN_TIPS[tipIndex]; }
      }, 420);
    }

    window.setTimeout(function () {
      var wait = Math.max(0, minMs - (Date.now() - started));
      window.setTimeout(function () {
        if (scanBusyTimer) {
          window.clearInterval(scanBusyTimer);
          scanBusyTimer = null;
        }
        scanBusy = false;
        if (btn) { btn.disabled = false; }
        if (view) { view.classList.remove('is-scanning'); }
        if (panel) {
          panel.hidden = true;
          panel.setAttribute('aria-busy', 'false');
        }
        done();
      }, wait);
    }, 0);
  }

  function onFeedbackPick(verdict) {
    Array.prototype.forEach.call(document.querySelectorAll('.fb'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-fb') === verdict ? 'true' : 'false');
    });
    if (verdict === 'wrong') {
      $('feedback-note').hidden = false;
      $('feedback-text').focus();
    } else if (current) {
      saveFeedback(current.id, verdict, '');
      $('feedback-thanks').hidden = false;
      announce('Recorded. ' + FEEDBACK_LABEL[verdict]);
    }
  }

  function saveFeedbackNote() {
    if (!current) { return; }
    var note = $('feedback-text').value.trim();
    saveFeedback(current.id, 'wrong', note);
    $('feedback-note').hidden = true;
    $('feedback-thanks').hidden = false;
    $('feedback-text').value = '';
    announce('Recorded.');
  }

  function shareText() {
    if (!current) { return; }
    var lines = [
      'Job Scam Shield — ' + current.risk + ' risk',
      'Message: ' + current.message,
      ''
    ];
    if (current.reportedHits && current.reportedHits.length) {
      lines.push('What the rules flagged:');
      current.reportedHits.forEach(function (hit) {
        lines.push('• ' + hit.label + ' — ' + hit.reason);
      });
      lines.push('');
    }
    if (current.nextSteps) {
      lines.push('What to do next:');
      current.nextSteps.forEach(function (step) { lines.push('• ' + step); });
      lines.push('');
    }
    if (current.note) { lines.push(current.note); }
    var text = lines.join('\n');

    if (navigator.share) {
      navigator.share({ title: 'Job Scam Shield result', text: text }).catch(function () {
        copyText(text);
      });
      return;
    }
    copyText(text);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        announce('Copied the result text.');
      }).catch(function () {
        legacyCopy(text);
      });
      return;
    }
    legacyCopy(text);
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'absolute';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      announce('Copied the result text.');
    } catch (e) {
      announce('Copying was blocked. Select the text above to copy it.');
    }
    document.body.removeChild(area);
  }

  /* ---------- attachment viewing ---------- */

  function openAttachment(key) {
    if (!key) { return; }
    store.getBlob(key).then(function (blob) {
      if (!blob) {
        showBanner('That attachment is no longer available.');
        return;
      }
      var url = store.objectUrlFor(blob);
      if (blob.type === 'application/pdf') {
        /* never render a PDF inline: open it as a download instead */
        var link = document.createElement('a');
        link.href = url;
        link.download = 'attachment.pdf';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        return;
      }
      window.open(url, '_blank', 'noopener');
    }).catch(function () {
      showBanner('That attachment could not be opened.');
    });
  }

  /* ================================================================
     WIRING
     ================================================================ */

  function wireSearch() {
    var root = $('app-search');
    var toggle = $('search-toggle');
    var panel = $('search-panel');
    var input = $('search-input');
    var clear = $('search-clear');
    if (!root || !toggle || !panel || !input || !clear) { return; }

    function syncClear() {
      clear.hidden = !input.value;
    }

    function refreshResults() {
      var active = document.querySelector('.view:not([hidden])');
      var viewId = active ? active.id : '';
      if (viewId === 'view-community' || viewId === 'view-post') {
        renderCommunity();
      } else if (viewId === 'view-history') {
        renderHistory();
      } else if (searchQuery) {
        go('community');
      }
    }

    function applySearch() {
      searchQuery = String(input.value || '').trim();
      syncClear();
      refreshResults();
    }

    function openSearch() {
      root.classList.add('is-open');
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close search');
      window.setTimeout(function () { input.focus(); }, 40);
    }

    function closeSearch() {
      root.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open search');
      input.blur();
      window.setTimeout(function () {
        if (!root.classList.contains('is-open')) { panel.hidden = true; }
      }, 340);
    }

    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      if (root.classList.contains('is-open')) { closeSearch(); }
      else { openSearch(); }
    });

    clear.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      searchQuery = '';
      syncClear();
      input.focus();
      refreshResults();
    });

    input.addEventListener('input', applySearch);

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (input.value) {
          input.value = '';
          searchQuery = '';
          syncClear();
          refreshResults();
        } else {
          closeSearch();
        }
      }
    });

    document.addEventListener('click', function (event) {
      if (!root.classList.contains('is-open')) { return; }
      if (root.contains(event.target)) { return; }
      closeSearch();
    });
  }

  function wire() {
    wireSearch();
    document.addEventListener('click', function (event) {
      var nav = event.target.closest ? event.target.closest('[data-nav]') : null;
      if (nav) {
        var jump = nav.getAttribute('data-filter-jump');
        if (jump) { feedFilter = jump; }
        go(nav.getAttribute('data-nav'));
        return;
      }
      var focusTarget = event.target.closest ? event.target.closest('[data-focus]') : null;
      if (focusTarget) {
        var field = $(focusTarget.getAttribute('data-focus'));
        if (field) { field.focus(); }
        return;
      }
      if (event.target.closest && event.target.closest('#nav-toggle')) {
        if (drawerOpen()) { closeDrawer(); } else { openDrawer(); }
        return;
      }
      if (event.target.closest && event.target.closest('#nav-close')) {
        closeDrawer();
        return;
      }
      if (event.target.closest && event.target.closest('#nav-scrim')) {
        closeDrawer();
        return;
      }
      var opener = event.target.closest ? event.target.closest('[data-post-id]') : null;
      if (opener) {
        openPost(opener.getAttribute('data-post-id'));
        return;
      }
      var filter = event.target.closest ? event.target.closest('[data-filter]') : null;
      if (filter) {
        feedFilter = filter.getAttribute('data-filter');
        renderCommunity();
        return;
      }
      var label = event.target.closest ? event.target.closest('[data-label]') : null;
      if (label) {
        setLabel(label.getAttribute('data-label'));
        return;
      }
      var att = event.target.closest ? event.target.closest('[data-att]') : null;
      if (att) {
        event.preventDefault();
        openAttachment(att.getAttribute('data-att'));
        return;
      }
      var delCheck = event.target.closest ? event.target.closest('[data-delete-check]') : null;
      if (delCheck) {
        event.preventDefault();
        deleteCheck(delCheck.getAttribute('data-delete-check'));
        return;
      }
      var hist = event.target.closest ? event.target.closest('[data-check-id]') : null;
      if (hist) {
        openCheckFromHistory(hist.getAttribute('data-check-id'));
        return;
      }
      var fb = event.target.closest ? event.target.closest('[data-fb]') : null;
      if (fb) {
        onFeedbackPick(fb.getAttribute('data-fb'));
        return;
      }
      var signal = event.target.closest ? event.target.closest('[data-signal]') : null;
      if (signal && !signal.disabled) {
        castVote(signal.getAttribute('data-signal'));
        return;
      }
      var backer = event.target.closest ? event.target.closest('[data-metoo]') : null;
      if (backer) {
        backExistingReport(backer.getAttribute('data-metoo'));
        return;
      }
      if (event.target.id === 'flag-post') {
        var flagged = store.flagPost(openPostId, SESSION.id);
        if (!flagged.ok) {
          showBanner(flagged.reason);
          return;
        }
        if (ShieldCommunity.isHidden(flagged.post)) {
          /* enough people agree: it leaves the feed until someone reviews it */
          showBanner('That report is now hidden from the feed (3 flags).');
          go('community');
          return;
        }
        showBanner('Flagged on this device. After three flags the report is hidden from the feed.');
        return;
      }
    });

    /* ---------- drop zones ---------- */

    composerFiles.wire();
    scanFiles.wire();

    /* the window-level default would navigate away from the page on drop */
    ['dragover', 'drop'].forEach(function (name) {
      window.addEventListener(name, function (event) {
        if (event.target.closest && event.target.closest('.drop')) { return; }
        event.preventDefault();
      });
    });

    /* ---------- drawer ---------- */

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && drawerOpen()) { closeDrawer(); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 960) { closeDrawer(); }
    });

    /* ---------- composer ---------- */

    $('post-message').addEventListener('input', function () {
      $('post-message').classList.remove('is-invalid');
      $('post-message').removeAttribute('aria-invalid');
      $('post-message-error').textContent = '';
      scanComposer();
    });

    $('publish-post').addEventListener('click', publishPost);

    /* ---------- checker ---------- */

    $('run-check').addEventListener('click', runCheck);

    $('message').addEventListener('input', function () {
      $('message').classList.remove('is-invalid');
      $('message').removeAttribute('aria-invalid');
      $('message-error').textContent = '';
      if (!$('app-banner').hidden) { showBanner(''); }
    });

    $('message').addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { runCheck(); }
    });

    $('paste-clipboard').addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showBanner('This browser will not let the page read your clipboard. Paste with Ctrl+V instead.');
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        if (!text) { showBanner('Your clipboard looks empty.'); return; }
        $('message').value = text;
        $('message-error').textContent = '';
        $('message').classList.remove('is-invalid');
        $('message').removeAttribute('aria-invalid');
        showBanner('');
        announce('Pasted from clipboard.');
      }).catch(function () {
        showBanner('Could not read the clipboard. Paste with Ctrl+V instead.');
      });
    });

    $('save-feedback').addEventListener('click', saveFeedbackNote);
    $('share-result').addEventListener('click', shareText);
    $('share-to-community').addEventListener('click', shareToCommunity);

    /* ---------- settings ---------- */

    $('settings-profile-form').addEventListener('submit', saveProfile);
    $('settings-password-form').addEventListener('submit', savePasswordSettings);
    $('set-new-password').addEventListener('input', function () {
      $('set-new-password').classList.remove('is-invalid');
      $('set-new-password').removeAttribute('aria-invalid');
      $('set-new-password-error').textContent = '';
      renderPasswordRules();
    });
    $('set-reduce-motion').addEventListener('change', function (event) {
      setPref('reduceMotion', event.target.checked);
      $('display-status').textContent = event.target.checked
        ? 'Motion reduced for this browser.'
        : 'Motion restored for this browser.';
    });
    $('set-larger-text').addEventListener('change', function (event) {
      setPref('largerText', event.target.checked);
      $('display-status').textContent = event.target.checked
        ? 'Text enlarged for this browser.'
        : 'Text size reset for this browser.';
    });
    $('clear-checks').addEventListener('click', clearMyChecks);
    $('delete-my-reports').addEventListener('click', deleteMyReports);
    $('remove-account').addEventListener('click', removeMyAccount);

    $('sign-out').addEventListener('click', function () {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
      window.location.replace(AUTH_PAGE);
    });

    var trustOpen = $('trust-open');
    if (trustOpen) {
      trustOpen.addEventListener('click', function () {
        feedFilter = 'mine';
        go('community');
        announce('Showing your reports.');
      });
    }
  }

  /* ---------- settings ---------- */

  /*
   * Comfort settings are a device preference rather than part of the account,
   * so they are kept separately and applied as a class on <body>. Reading them
   * on boot is what makes them survive a page change.
   */
  function readPrefs() {
    var prefs = readJson(PREFS_KEY, {});
    return prefs && typeof prefs === 'object' ? prefs : {};
  }

  function applyPrefs() {
    var prefs = readPrefs();
    document.body.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
    document.body.classList.toggle('larger-text', Boolean(prefs.largerText));
  }

  function setPref(name, value) {
    var prefs = readPrefs();
    if (value) { prefs[name] = true; } else { delete prefs[name]; }
    writeJson(PREFS_KEY, prefs);
    applyPrefs();
  }

  function me() {
    return window.ShieldAccount ? window.ShieldAccount.findById(SESSION.id) : null;
  }

  /*
   * account.js reports which field failed using its own key ("fullName",
   * "currentPassword"). These are the matching control ids, so a refusal is
   * shown next to the box that caused it instead of being dropped.
   */
  var FIELD_IDS = {
    fullName: 'set-name',
    email: 'set-email',
    phone: 'set-phone',
    province: 'set-province',
    currentPassword: 'set-current-password',
    newPassword: 'set-new-password',
    confirmPassword: 'set-confirm-password'
  };

  function flagField(key, reason) {
    setFieldError(FIELD_IDS[key] || 'set-name', reason);
  }

  /*
   * The options in the markup are the only list of provinces, so the two
   * cannot drift apart. The blank first option means "not set".
   */
  function provinceList() {
    return Array.prototype.map.call(
      $('set-province').options,
      function (option) { return option.value; }
    ).filter(function (value) { return value !== ''; });
  }

  function setFieldError(id, message) {
    var control = $(id);
    var slot = $(id + '-error');
    if (control) {
      control.classList.toggle('is-invalid', Boolean(message));
      if (message) { control.setAttribute('aria-invalid', 'true'); }
      else { control.removeAttribute('aria-invalid'); }
    }
    if (slot) { slot.textContent = message || ''; }
  }

  function clearProfileErrors() {
    ['set-name', 'set-email', 'set-phone', 'set-province'].forEach(function (id) { setFieldError(id, ''); });
  }

  function clearPasswordErrors() {
    ['set-current-password', 'set-new-password', 'set-confirm-password'].forEach(function (id) {
      setFieldError(id, '');
    });
  }

  /* Mirrors the sign-up page: rules are shown as state, not as an error. */
  function renderPasswordRules() {
    var list = $('set-new-password-rules');
    if (!list) { return; }
    var value = $('set-new-password').value;
    var met = {};
    window.ShieldAccount.PASSWORD_RULES.forEach(function (rule) {
      met[rule.key] = rule.test(value);
    });
    Array.prototype.forEach.call(list.children, function (item) {
      item.classList.toggle('is-met', Boolean(met[item.getAttribute('data-rule')]));
    });
  }

  function renderSettings() {
    var user = me();
    var publicView = window.ShieldAccount.publicUser(user) || {};

    $('set-name').value = publicView.fullName || '';
    $('set-email').value = publicView.email || '';
    $('set-phone').value = publicView.phone || '';
    /* only match a stored value the dropdown actually offers, so old or edited
       records cannot leave the control showing a blank selection */
    $('set-province').value = provinceList().indexOf(publicView.province) > -1 ? publicView.province : '';

    clearProfileErrors();
    clearPasswordErrors();
    $('set-current-password').value = '';
    $('set-new-password').value = '';
    $('set-confirm-password').value = '';
    $('profile-status').textContent = '';
    $('password-status').textContent = '';
    $('data-status').textContent = '';
    renderPasswordRules();

    var prefs = readPrefs();
    $('set-reduce-motion').checked = Boolean(prefs.reduceMotion);
    $('set-larger-text').checked = Boolean(prefs.largerText);

    var mine = store.listPosts().filter(function (post) { return post.authorId === SESSION.id; });
    $('delete-reports-note').textContent = mine.length
      ? 'Removes the ' + mine.length + ' report' + (mine.length === 1 ? '' : 's') +
        ' you posted. Nobody else\'s are touched.'
      : 'You have not posted any reports yet.';
    $('delete-my-reports').disabled = mine.length === 0;
  }

  function saveProfile(event) {
    event.preventDefault();
    clearProfileErrors();
    var status = $('profile-status');
    status.textContent = '';

    window.ShieldAccount.updateProfile(SESSION.id, {
      fullName: $('set-name').value,
      email: $('set-email').value,
      phone: $('set-phone').value,
      province: $('set-province').value
    }).then(function (result) {
      if (!result.ok) {
        flagField(result.field, result.reason);
        status.textContent = 'Nothing was saved.';
        return;
      }
      SESSION.fullName = result.user.fullName;
      SESSION.email = result.user.email;
      renderUserChip();
      renderDashboard();
      status.textContent = 'Saved.';
      showBanner('Your details were updated.');
    });
  }

  function savePasswordSettings(event) {
    event.preventDefault();
    clearPasswordErrors();
    var status = $('password-status');
    status.textContent = '';

    var currentPassword = $('set-current-password').value;
    var newPassword = $('set-new-password').value;
    var confirm = $('set-confirm-password').value;

    if (newPassword !== confirm) {
      setFieldError('set-confirm-password', 'Passwords do not match.');
      status.textContent = 'Nothing was changed.';
      return;
    }

    window.ShieldAccount.changePassword(SESSION.id, currentPassword, newPassword)
      .then(function (result) {
        if (!result.ok) {
          flagField(result.field, result.reason);
          status.textContent = 'Nothing was changed.';
          return;
        }
        $('set-current-password').value = '';
        $('set-new-password').value = '';
        $('set-confirm-password').value = '';
        renderPasswordRules();
        status.textContent = 'Changed. Use it the next time you sign in.';
      });
  }

  function clearMyChecks() {
    var list = readJson(CHECKS_KEY, []);
    if (!Array.isArray(list)) { list = []; }
    var kept = list.filter(function (item) { return !item || item.userId !== SESSION.id; });
    var removed = list.length - kept.length;
    writeJson(CHECKS_KEY, kept);
    updateNavCounts();
    $('data-status').textContent = removed
      ? 'Deleted ' + removed + ' saved check' + (removed === 1 ? '' : 's') + '.'
      : 'You had no saved checks.';
  }

  function deleteMyReports() {
    $('delete-my-reports').disabled = true;
    store.deletePostsByAuthor(SESSION.id).then(function (result) {
      updateNavCounts();
      /* Re-render first: it clears the status line, so the confirmation has to
         be written afterwards or the user is left with no confirmation at all. */
      renderSettings();
      $('data-status').textContent = result.alreadyClean
        ? 'You had no reports to delete.'
        : 'Deleted ' + result.removed + ' report' + (result.removed === 1 ? '' : 's') + '.';
      showBanner('Your reports were deleted.');
    });
  }

  function removeMyAccount() {
    window.ShieldAccount.removeAccount(SESSION.id);
    store.deletePostsByAuthor(SESSION.id).then(function () {
      window.location.replace(AUTH_PAGE);
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    SESSION = readJson(SESSION_KEY, null);
    if (!SESSION || !SESSION.id) {
      window.location.replace(AUTH_PAGE);
      return;
    }

    if (!window.ShieldStore || !window.ShieldCommunity || !window.ShieldRules ||
        !window.ShieldSimilarity || !window.ShieldAccount) {
      document.body.innerHTML = '<p class="empty">Part of the app failed to load. Reload the page.</p>';
      return;
    }

    store = window.ShieldStore.createStore();
    store.purgeFabricatedData();

    composerFiles = createUploader({
      zone: 'drop-zone', input: 'file-input', thumbs: 'thumbs', error: 'file-error'
    });
    scanFiles = createUploader({
      zone: 'scan-drop-zone', input: 'scan-file-input', thumbs: 'scan-thumbs', error: 'scan-file-error'
    });

    renderUserChip();
    applyPrefs();
    renderLabels();
    renderTrustChip(myTrust());
    wire();
    go(readSavedView());
  }

  boot();
})();
