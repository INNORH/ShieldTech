/*
 * Job Scam Shield — community logic.
 *
 * The rules that decide what a report is allowed to claim. Deliberately
 * separate from both the store (api.js) and the screen (app.js) so the
 * whole trust model can be tested without a DOM.
 *
 * The guiding rule of the whole feature: no single person gets to state
 * something as fact. A report with no supporting votes says exactly that.
 * Everything below follows from that.
 */
(function (root) {
  'use strict';

  /* A report is "live" for this long, then it moves to the past. */
  var LIVE_WINDOW_HOURS = 72;

  var SIGNALS = ['scam', 'legit', 'reported', 'metoo'];

  /* Upload limits, enforced on the client and mirrored by the API later. */
  var MAX_ATTACHMENTS = 3;
  var MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  var ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  var ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf'];

  var LOW_TRUST_RANK = 2;
  var LOW_TRUST_DAILY_LIMIT = 2;

  /* This many people flagging a post hides it until a moderator looks. */
  var HIDE_AT_FLAGS = 3;

  var LABELS = {
    scam: 'Scam',
    impersonation: 'Impersonation',
    'recruitment-fee': 'Recruitment fee',
    'money-mule': 'Money mule',
    phishing: 'Phishing',
    caution: 'Looks wrong',
    legit: 'Looks legitimate'
  };

  var SIGNAL_COPY = {
    scam: { label: 'Also a scam', effect: 'raises how much this report is trusted' },
    legit: { label: 'I got a real offer', effect: 'counts against this report' },
    reported: { label: 'Already reported it', effect: 'does not change trust, it tracks action taken' },
    metoo: { label: 'Me too', effect: 'a weaker confirm than a first-hand report' }
  };

  var RANKS = {
    1: 'New',
    2: 'Learning',
    3: 'Established',
    4: 'Trusted',
    5: 'Most trusted'
  };

  /* ---------- time ---------- */

  function ms(value) {
    return typeof value === 'number' ? value : Date.parse(value);
  }

  function ageMs(post, nowMs) {
    return Math.max(0, (nowMs === undefined ? Date.now() : nowMs) - ms(post.createdAt));
  }

  /*
   * Waze asks drivers passing a report "still there?", and a yes resets its
   * clock. Here a "scam" or "me too" vote is that yes: the live window is
   * measured from the last confirmation, not from the original post, so a
   * scam that keeps circulating stays live for as long as people keep
   * meeting it. Disputes and "already reported" do not extend anything.
   */
  function lastSeenMs(post) {
    var created = ms(post.createdAt);
    var confirmed = post.lastConfirmedAt ? ms(post.lastConfirmedAt) : 0;
    return Math.max(created || 0, confirmed || 0);
  }

  function sinceSeenMs(post, nowMs) {
    return Math.max(0, (nowMs === undefined ? Date.now() : nowMs) - lastSeenMs(post));
  }

  function isLive(post, nowMs) {
    return sinceSeenMs(post, nowMs) < LIVE_WINDOW_HOURS * 3600000;
  }

  /*
   * Linear fade across the live window. Waze fades a report out rather than
   * snapping it away, so a report ages out gradually instead of vanishing
   * at a hard edge and looking like a glitch.
   */
  function decay(post, nowMs) {
    var window = LIVE_WINDOW_HOURS * 3600000;
    var age = sinceSeenMs(post, nowMs);
    if (age >= window) { return 0; }
    return 1 - (age / window);
  }

  function ageLabel(post, nowMs) {
    var hours = ageMs(post, nowMs) / 3600000;
    if (hours < 1) { return 'just now'; }
    if (hours < 24) { return Math.round(hours) + 'h ago'; }
    var days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : days + 'd ago';
  }

  /* ---------- credibility ---------- */

  /*
   * "reported" is deliberately excluded. It records that someone took the
   * report to WhatsApp or a platform, which is the outcome we want, but it
   * is not evidence that the report is true. Letting it inflate credibility
   * would mean a post could look well supported by people who simply
   * forwarded it rather than people who were actually affected.
   */
  function credibility(post) {
    var votes = post.votes || {};
    var agree = (votes.scam || 0) + (votes.metoo || 0);
    var disagree = votes.legit || 0;
    var total = agree + disagree;
    return {
      agree: agree,
      disagree: disagree,
      total: total,
      reported: votes.reported || 0,
      metoo: votes.metoo || 0,
      ratio: total === 0 ? null : agree / total
    };
  }

  /*
   * Three states, and no fourth. There is deliberately no "confirmed scam"
   * badge, because a crowd of strangers is not an authority, and printing
   * one would be the exact overclaim this app exists to avoid.
   */
  function standing(post) {
    var cred = credibility(post);
    var isLegit = (post.label || '') === 'legit';
    if (cred.total === 0) {
      return { key: 'unconfirmed', label: 'Unconfirmed', note: 'Nobody has backed this up yet.', ratio: null };
    }
    if (cred.ratio >= 0.75) {
      return {
        key: 'corroborated',
        label: isLegit ? 'Many agree this looks legitimate' : 'Many agree this is a scam',
        note: cred.agree + (isLegit
          ? ' people backed the claim that this looked legitimate.'
          : ' people agreed this looks like a scam.'),
        ratio: cred.ratio
      };
    }
    if (cred.ratio <= 0.4) {
      return {
        key: 'contested',
        label: 'People disagree',
        note: isLegit
          ? cred.disagree + ' said it was actually a scam.'
          : cred.disagree + ' said they had a real offer.',
        ratio: cred.ratio
      };
    }
    return { key: 'mixed', label: 'Views are mixed', note: 'The community is split on this one.', ratio: cred.ratio };
  }

  function verdictWords(post) {
    if ((post.label || '') === 'legit') {
      return 'reported as legitimate';
    }
    return 'reported as a scam';
  }

  /*
   * What a change in standing means for the person who wrote the report.
   * Entering "corroborated" earns a confirm, entering "contested" earns a
   * dispute, and leaving either takes it back, so the author's record always
   * mirrors where their reports stand right now rather than where they once
   * were. This is the Waze points loop: rank is earned by being right.
   */
  function trustDelta(before, after) {
    var was = standing(before).key;
    var now = standing(after).key;
    if (was === now) { return null; }
    var delta = {};
    if (was === 'corroborated') { delta.confirmed = -1; }
    if (now === 'corroborated') { delta.confirmed = (delta.confirmed || 0) + 1; }
    if (was === 'contested') { delta.disputed = -1; }
    if (now === 'contested') { delta.disputed = (delta.disputed || 0) + 1; }
    return Object.keys(delta).length ? delta : null;
  }

  /* The same transition, for the watchlist rows the report points at. */
  function entityConfirmDelta(before, after) {
    var was = standing(before).key === 'corroborated';
    var now = standing(after).key === 'corroborated';
    if (was === now) { return 0; }
    return now ? 1 : -1;
  }

  /* ---------- moderation ---------- */

  function isHidden(post) {
    if (!post) { return true; }
    if (post.removed) { return true; }
    return (post.flaggedBy || []).length >= HIDE_AT_FLAGS;
  }

  function visible(posts) {
    return (posts || []).filter(function (post) { return !isHidden(post); });
  }

  /* ---------- trust ---------- */

  function rankFor(trust) {
    if (!trust || !trust.postsMade) { return 1; }
    var judged = (trust.confirmed || 0) + (trust.disputed || 0);
    var rate = judged === 0 ? 0 : (trust.confirmed || 0) / judged;
    if (trust.postsMade >= 10 && rate >= 0.8) { return 5; }
    if (trust.postsMade >= 6 && rate >= 0.7) { return 4; }
    if (trust.postsMade >= 4 && rate >= 0.6) { return 3; }
    if (trust.postsMade >= 2) { return 2; }
    return 1;
  }

  function trustLabel(trust) {
    return RANKS[rankFor(trust)];
  }

  function isLowTrust(trust) {
    return rankFor(trust) <= LOW_TRUST_RANK;
  }

  function startOfDay(nowMs) {
    var d = new Date(nowMs === undefined ? Date.now() : nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /*
   * Rate limiting the bottom of the trust scale is the whole reason rank is
   * worth anything. A new account can still report, but not fast enough to
   * flood a feed before anyone has confirmed or disputed it.
   */
  function canPost(trust, posts, nowMs) {
    var stamp = nowMs === undefined ? Date.now() : nowMs;
    var mine = (posts || []).filter(function (post) {
      return post.authorId === (trust && trust.userId);
    });
    if (!isLowTrust(trust)) {
      return { ok: true, remaining: null };
    }
    var since = startOfDay(stamp);
    var today = mine.filter(function (post) {
      return ms(post.createdAt) >= since;
    }).length;
    if (today >= LOW_TRUST_DAILY_LIMIT) {
      return {
        ok: false,
        reason: 'You have used your ' + LOW_TRUST_DAILY_LIMIT + ' reports for today. New accounts report less so the feed stays useful.'
      };
    }
    return { ok: true, remaining: LOW_TRUST_DAILY_LIMIT - today };
  }

  /* ---------- entity extraction ---------- */

  /*
   * South African mobiles are ten digits: a leading 0 then nine more.
   * Internationally the same number arrives as +27 and drops the 0, so
   * both forms collapse to the local one and the watchlist does not end up
   * holding the same person twice under two keys.
   */
  function normalizePhone(raw) {
    var digits = String(raw).replace(/[^\d]/g, '');
    if (digits.length === 10 && digits.charAt(0) === '0') { return digits; }
    if (digits.length === 11 && digits.slice(0, 2) === '27') { return '0' + digits.slice(2); }
    return null;
  }

  function prettyPhone(digits) {
    return digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');
  }

  function normalizeDomain(raw) {
    var value = String(raw).toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0]
      .trim();
    if (!value || value.indexOf('.') === -1 || /\s/.test(value)) { return null; }
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) { return null; }
    return value;
  }

  /*
   * Domains that are infrastructure rather than identity. Nobody is a
   * scammer for sending a wa.me link, and putting WhatsApp itself on the
   * watchlist would bury the numbers that actually matter.
   */
  var NEUTRAL_DOMAINS = [
    'wa.me', 'api.whatsapp.com', 'whatsapp.com', 't.me', 'telegram.me',
    'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'cutt.ly',
    'urlz.fr', 'shorturl.at', 'rebrand.ly', 'rb.gy'
  ];

  function isNeutralDomain(value) {
    for (var i = 0; i < NEUTRAL_DOMAINS.length; i++) {
      if (value === NEUTRAL_DOMAINS[i]) { return true; }
      if (value.slice(-(NEUTRAL_DOMAINS[i].length + 1)) === '.' + NEUTRAL_DOMAINS[i]) {
        return true;
      }
    }
    return false;
  }

  /*
   * Pulls the things worth remembering out of a pasted message: numbers to
   * block, domains to avoid, and company names to look up. This is what
   * turns a pile of individual reports into a permanent watchlist.
   */
  function extractEntities(message) {
    var text = String(message || '');
    var found = [];
    var seen = {};

    function push(kind, value, displayName) {
      var key = kind + '|' + value;
      if (seen[key]) { return; }
      seen[key] = true;
      found.push({ kind: kind, value: value, displayName: displayName || value });
    }

    var waLinks = text.match(/wa\.me\/(\d+)/gi) || [];
    waLinks.forEach(function (hit) {
      var digits = normalizePhone(hit.replace(/[^0-9]/g, ''));
      if (digits) { push('phone', digits, 'WhatsApp ' + prettyPhone(digits)); }
    });

    var loose = text.match(/(?:\+27|0)\s?\d(?:[\s-]?\d){8}/g) || [];
    loose.forEach(function (hit) {
      var digits = normalizePhone(hit);
      if (digits) { push('phone', digits, 'Phone ' + prettyPhone(digits)); }
    });

    var domains = text.match(/\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b/gi) || [];
    domains.forEach(function (hit) {
      var value = normalizeDomain(hit);
      if (!value) { return; }
      if (isNeutralDomain(value)) { return; }
      if (/\.(png|jpe?g|gif|webp|pdf|docx?)$/.test(value)) { return; }
      push('domain', value, value);
    });

    return found;
  }

  /* ---------- attachments ---------- */

  function extensionOf(name) {
    var match = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? match[0] : '';
  }

  /*
   * Checked before anything is written. Rejecting on the client keeps the
   * obvious junk out; the server repeats every one of these checks because
   * a client check is advice, not enforcement.
   */
  function validateAttachment(file) {
    if (!file) { return { ok: false, reason: 'That file could not be read.' }; }
    if (ALLOWED_MIME.indexOf(file.type) === -1 && ALLOWED_EXT.indexOf(extensionOf(file.name)) === -1) {
      return { ok: false, reason: 'Only images and PDF files are allowed.' };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'Files must be 5MB or smaller.' };
    }
    return { ok: true };
  }

  function attachmentKind(file) {
    return file.type === 'application/pdf' ? 'file' : 'image';
  }

  /* ---------- feed ---------- */

  /*
   * Ordering is credibility first, then freshness, with decay pulling both
   * down over time. A well-backed report outranks a loud new one, which is
   * the opposite of a chronological firehose and the reason the feed stays
   * usable.
   */
  function feedScore(post, nowMs) {
    var cred = credibility(post);
    var backing = cred.ratio === null ? 0.15 : cred.ratio;
    var volume = Math.min(1, cred.total / 10);
    var recency = decay(post, nowMs);
    return backing * 0.6 + volume * 0.15 + recency * 0.25;
  }

  function decorate(post, nowMs) {
    var cred = credibility(post);
    var st = standing(post);
    return {
      id: post.id,
      authorId: post.authorId,
      authorName: post.authorName,
      message: post.message,
      label: post.label,
      labelText: LABELS[post.label] || 'Report',
      scan: post.scan,
      attachments: post.attachments || [],
      entityIds: post.entityIds || [],
      createdAt: post.createdAt,
      age: ageLabel(post, nowMs),
      isLive: isLive(post, nowMs),
      live: isLive(post, nowMs),
      credibility: cred,
      standing: st,
      flagged: (post.flaggedBy || []).length,
      hidden: isHidden(post),
      score: feedScore(post, nowMs)
    };
  }

  function buildFeed(posts, nowMs) {
    return visible(posts).map(function (post) {
      return decorate(post, nowMs);
    }).sort(function (a, b) {
      if (a.live !== b.live) { return a.live ? -1 : 1; }
      if (b.score !== a.score) { return b.score - a.score; }
      return ms(b.createdAt) - ms(a.createdAt);
    });
  }

  function liveCount(posts, nowMs) {
    return visible(posts).filter(function (post) { return isLive(post, nowMs); }).length;
  }

  /* ---------- counters ---------- */

  function userVoteCount(posts, userId) {
    var counted = 0;
    (posts || []).forEach(function (post) {
      var voterIds = post.voterIds || {};
      for (var i = 0; i < SIGNALS.length; i++) {
        if ((voterIds[SIGNALS[i]] || []).indexOf(userId) !== -1) {
          counted += 1;
          return;
        }
      }
    });
    return counted;
  }

  function dashboardStats(posts, trust, nowMs) {
    var userId = trust && trust.userId;
    var mine = (posts || []).filter(function (post) { return post.authorId === userId; });
    return {
      liveAlerts: liveCount(posts || [], nowMs),
      totalReports: (posts || []).length,
      myReports: mine.length,
      rank: rankFor(trust),
      rankLabel: trustLabel(trust),
      votesCast: userVoteCount(posts, userId)
    };
  }

  var api = {
    LIVE_WINDOW_HOURS: LIVE_WINDOW_HOURS,
    MAX_ATTACHMENTS: MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES: MAX_ATTACHMENT_BYTES,
    LOW_TRUST_RANK: LOW_TRUST_RANK,
    LOW_TRUST_DAILY_LIMIT: LOW_TRUST_DAILY_LIMIT,
    HIDE_AT_FLAGS: HIDE_AT_FLAGS,
    LABELS: LABELS,
    SIGNAL_COPY: SIGNAL_COPY,
    RANKS: RANKS,
    ageMs: ageMs,
    ageLabel: ageLabel,
    lastSeenMs: lastSeenMs,
    sinceSeenMs: sinceSeenMs,
    isLive: isLive,
    decay: decay,
    credibility: credibility,
    standing: standing,
    verdictWords: verdictWords,
    trustDelta: trustDelta,
    entityConfirmDelta: entityConfirmDelta,
    isHidden: isHidden,
    visible: visible,
    rankFor: rankFor,
    trustLabel: trustLabel,
    userVoteCount: userVoteCount,
    isLowTrust: isLowTrust,
    canPost: canPost,
    normalizePhone: normalizePhone,
    prettyPhone: prettyPhone,
    normalizeDomain: normalizeDomain,
    extractEntities: extractEntities,
    validateAttachment: validateAttachment,
    attachmentKind: attachmentKind,
    extensionOf: extensionOf,
    feedScore: feedScore,
    decorate: decorate,
    buildFeed: buildFeed,
    liveCount: liveCount,
    dashboardStats: dashboardStats
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShieldCommunity = api;
  }
})(typeof window !== 'undefined'
  ? window
  : (typeof global !== 'undefined' ? global : null));
