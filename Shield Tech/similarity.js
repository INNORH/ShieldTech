/*
 * Job Scam Shield — report similarity.
 *
 * Waze can say "3 reports here" because every report carries a GPS point.
 * A scam message has no coordinates, so this file gives it some. Scammers
 * rotate phone numbers but reuse the wording, so two reports are treated as
 * the same scam when they share a contact detail, near-identical wording,
 * or the same pattern of rule hits.
 *
 * Similarity is deliberately kept apart from standing. Ten forwards of the
 * same message prove that the message is circulating, not that it is a
 * scam; only votes decide that. This file counts, it never judges.
 *
 * Pure functions, no DOM, so the thresholds can be pinned down in Node.
 */
(function (root) {
  'use strict';

  /* Above this two reports are shown as "similar". */
  var SIMILAR_AT = 0.35;
  /* Above this the composer says "this has already been reported". */
  var DUPLICATE_AT = 0.7;
  /* Shorter messages than this fall back from word-triples to single words. */
  var MIN_SHINGLES = 4;

  var STOPWORDS = {};
  [
    'the', 'and', 'you', 'your', 'for', 'are', 'this', 'that', 'with', 'from',
    'have', 'has', 'all', 'any', 'not', 'please', 'hello', 'dear', 'good',
    'day', 'now', 'will', 'can', 'our', 'out', 'who', 'what', 'when', 'where',
    'how', 'they', 'them', 'their', 'there', 'here', 'was', 'were', 'been',
    'being', 'but', 'his', 'her', 'she', 'him', 'its', 'into', 'than', 'then',
    'too', 'very', 'just', 'also', 'more', 'most', 'some', 'such', 'only',
    'own', 'same', 'other', 'about', 'after', 'before', 'over', 'under',
    'again', 'once', 'each', 'few', 'both', 'per', 'via', 'get', 'got',
    /* greetings and filler that every forwarded message carries */
    'hie', 'guys', 'everyone', 'attention', 'kindly', 'regards', 'thanks',
    'thank', 'morning', 'afternoon', 'evening'
  ].forEach(function (word) { STOPWORDS[word] = true; });

  /* ---------- text ---------- */

  /*
   * Everything that changes between copies of the same scam is stripped:
   * links, numbers, amounts, emoji, punctuation and case. What is left is
   * the template the scammer actually typed.
   */
  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+|www\.\S+|wa\.me\/\S+/g, ' ')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
      .replace(/\br\s?\d[\d\s.,]*/g, ' ')
      .replace(/[+\d][\d\s()-]{5,}\d/g, ' ')
      .replace(/\d+/g, ' ')
      .replace(/[^a-z\u00C0-\u024F\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(text) {
    var out = [];
    normalize(text).split(' ').forEach(function (word) {
      if (word.length >= 3 && !STOPWORDS[word]) { out.push(word); }
    });
    return out;
  }

  function shingles(words, size) {
    var n = size || 3;
    var out = [];
    for (var i = 0; i + n <= words.length; i++) {
      out.push(words.slice(i, i + n).join(' '));
    }
    return out;
  }

  function toSet(list) {
    var set = {};
    (list || []).forEach(function (item) { set[item] = true; });
    return set;
  }

  function jaccard(a, b) {
    var setA = toSet(a);
    var setB = toSet(b);
    var keysA = Object.keys(setA);
    var keysB = Object.keys(setB);
    if (!keysA.length && !keysB.length) { return 0; }
    var shared = 0;
    keysA.forEach(function (key) { if (setB[key]) { shared += 1; } });
    var union = keysA.length + keysB.length - shared;
    return union === 0 ? 0 : shared / union;
  }

  function intersects(a, b) {
    var setB = toSet(b);
    for (var i = 0; i < (a || []).length; i++) {
      if (setB[a[i]]) { return true; }
    }
    return false;
  }

  /* ---------- fingerprint ---------- */

  /*
   * A fingerprint is everything about a report that can be compared without
   * reading it again: its words, its word-triples, the rule ids that fired
   * and the contact details it named.
   */
  function fingerprint(item, entityKeys) {
    var words = tokens(item.message);
    var scan = item.scan || {};
    return {
      id: item.id || null,
      tokens: words,
      shingles: shingles(words, 3),
      signals: (scan.signalIds || []).slice().sort(),
      entities: (entityKeys || item.entityIds || []).slice()
    };
  }

  /*
   * Scores 0..1, highest evidence first:
   *   1.0  same phone number or domain
   *   text near-identical wording (word triples), or word overlap for
   *        very short messages
   *   pattern the same set of rule hits
   */
  function compare(a, b) {
    if (intersects(a.entities, b.entities)) {
      return { score: 1, basis: 'contact', text: 1, pattern: 0 };
    }

    var text;
    var basis;
    if (a.shingles.length >= MIN_SHINGLES && b.shingles.length >= MIN_SHINGLES) {
      text = jaccard(a.shingles, b.shingles);
      basis = 'wording';
      /* rewritten copies keep the words but not the order */
      var loose = jaccard(a.tokens, b.tokens);
      if (loose > text) {
        text = (text + loose) / 2;
      }
    } else {
      text = jaccard(a.tokens, b.tokens);
      basis = 'words';
    }

    var pattern = (a.signals.length && b.signals.length) ? jaccard(a.signals, b.signals) : 0;

    var score = text * 0.75 + pattern * 0.25;
    if (pattern > text && pattern >= 0.99) { basis = 'pattern'; }
    return { score: Math.min(1, score), basis: basis, text: text, pattern: pattern };
  }

  var REASONS = {
    contact: 'Same phone number or website',
    wording: 'Near-identical wording',
    words: 'Uses the same words',
    pattern: 'Same scam pattern'
  };

  function reasonFor(result) {
    if (result.basis === 'contact') { return REASONS.contact; }
    if (result.text >= DUPLICATE_AT) { return REASONS.wording; }
    if (result.pattern >= 0.99 && result.text < SIMILAR_AT) { return REASONS.pattern; }
    return result.text >= SIMILAR_AT ? REASONS.words : REASONS.pattern;
  }

  /* ---------- queries ---------- */

  function optionsFor(opts) {
    var o = opts || {};
    return {
      threshold: typeof o.threshold === 'number' ? o.threshold : SIMILAR_AT,
      entityKeysOf: o.entityKeysOf || function (post) { return post.entityIds || []; },
      include: o.include || function (post) { return !post.removed; }
    };
  }

  /*
   * Reports that look like `target`, best match first. `target` can be a
   * stored post or a draft { message, scan, entityKeys } that has not been
   * posted yet, which is how the composer warns before someone posts a copy.
   */
  function findSimilar(target, posts, opts) {
    var o = optionsFor(opts);
    var mine = fingerprint(target, target.entityKeys || o.entityKeysOf(target));
    var found = [];
    (posts || []).forEach(function (post) {
      if (!post || post.id === target.id || !o.include(post)) { return; }
      var result = compare(mine, fingerprint(post, o.entityKeysOf(post)));
      if (result.score >= o.threshold) {
        found.push({ post: post, score: result.score, basis: result.basis, reason: reasonFor(result) });
      }
    });
    found.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return Date.parse(b.post.createdAt || 0) - Date.parse(a.post.createdAt || 0);
    });
    return found;
  }

  /* { postId: numberOfSimilarReports } for a whole feed in one pass. */
  function countMap(posts, opts) {
    var o = optionsFor(opts);
    var list = (posts || []).filter(o.include);
    var prints = list.map(function (post) { return fingerprint(post, o.entityKeysOf(post)); });
    var counts = {};
    list.forEach(function (post) { counts[post.id] = 0; });
    for (var i = 0; i < prints.length; i++) {
      for (var j = i + 1; j < prints.length; j++) {
        if (compare(prints[i], prints[j]).score >= o.threshold) {
          counts[list[i].id] += 1;
          counts[list[j].id] += 1;
        }
      }
    }
    return counts;
  }

  /*
   * Groups of reports that are the same scam. Union-find over pairwise
   * similarity; a report joins a group if it resembles any member.
   */
  function clusters(posts, opts) {
    var o = optionsFor(opts);
    var list = (posts || []).filter(o.include);
    var prints = list.map(function (post) { return fingerprint(post, o.entityKeysOf(post)); });
    var parent = list.map(function (_, index) { return index; });

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }

    for (var i = 0; i < prints.length; i++) {
      for (var j = i + 1; j < prints.length; j++) {
        if (compare(prints[i], prints[j]).score >= o.threshold) {
          parent[find(i)] = find(j);
        }
      }
    }

    var groups = {};
    list.forEach(function (post, index) {
      var rootIndex = find(index);
      groups[rootIndex] = groups[rootIndex] || [];
      groups[rootIndex].push(post);
    });

    return Object.keys(groups).map(function (key) {
      var members = groups[key].slice().sort(function (a, b) {
        return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
      });
      return { size: members.length, first: members[0], posts: members };
    }).sort(function (a, b) { return b.size - a.size; });
  }

  /* Plain-language line for a "you may be posting a copy" prompt. */
  function duplicateNotice(similar) {
    if (!similar || !similar.length) { return null; }
    var top = similar[0];
    var strong = top.score >= DUPLICATE_AT;
    var n = similar.length;
    return {
      strong: strong,
      count: n,
      top: top,
      title: strong
        ? (n === 1 ? 'This looks like a message someone already reported'
                   : n + ' people already reported a message like this')
        : (n === 1 ? 'One report looks similar to this'
                   : n + ' reports look similar to this'),
      body: strong
        ? 'Adding "Me too" to an existing report is stronger than posting a copy: it raises how much that report is trusted, and it keeps the feed from filling with the same message.'
        : 'Have a look before you post. If one of these is the same scam, back it up with "Me too" instead.'
    };
  }

  var api = {
    SIMILAR_AT: SIMILAR_AT,
    DUPLICATE_AT: DUPLICATE_AT,
    REASONS: REASONS,
    normalize: normalize,
    tokens: tokens,
    shingles: shingles,
    jaccard: jaccard,
    fingerprint: fingerprint,
    compare: compare,
    findSimilar: findSimilar,
    countMap: countMap,
    clusters: clusters,
    duplicateNotice: duplicateNotice
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShieldSimilarity = api;
  }
})(typeof window !== 'undefined'
  ? window
  : (typeof global !== 'undefined' ? global : null));
