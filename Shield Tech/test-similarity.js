/*
 * Tests for report similarity.
 *
 * The thresholds decide when the app tells someone "this has already been
 * reported", so they are pinned here with real-shaped messages: the same
 * scam forwarded with a new number, a rewritten copy, and genuinely
 * different messages that must stay apart.
 */
'use strict';

var Similarity = require('./similarity.js');
var Rules = require('./rules.js');

var passed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('pass  ' + name);
  } catch (err) {
    failures.push(name + ' -> ' + err.message);
    console.log('FAIL  ' + name + '  (' + err.message + ')');
  }
}

function assert(cond, message) {
  if (!cond) { throw new Error(message || 'assertion failed'); }
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'mismatch') + ': expected ' +
      JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/* A post the way the store shapes it, scanned by the real rule engine. */
function post(id, message, over) {
  var scan = Rules.check(message);
  var base = {
    id: id,
    authorId: 'u-' + id,
    createdAt: '2026-09-25T10:00:00Z',
    message: message,
    label: 'scam',
    scan: { risk: scan.risk, score: scan.score, signalIds: scan.hits.map(function (h) { return h.id; }) },
    entityIds: [],
    removed: false
  };
  Object.keys(over || {}).forEach(function (key) { base[key] = over[key]; });
  return base;
}

var PRASA_A = 'PRASA LEARNERSHIP 2026!! Comment YES to apply. Registration fee R150 payable before you start. WhatsApp only 081 234 5678. Only 20 spots, closing today!';
var PRASA_B = 'PRASA LEARNERSHIP 2026!! Comment YES to apply. Registration fee R250 payable before you start. WhatsApp only 072 987 6543. Only 15 spots, closing tonight!';
var PRASA_REWRITE = 'Learnership at PRASA for 2026. To apply just comment YES below. A registration fee of R150 is payable before you start, apply now on WhatsApp only.';
var ESKOM = 'Eskom is hiring general workers, no experience needed. Send a copy of your ID and banking details to 083 111 2222 to secure your place. Starts Monday.';
var MULE = 'Work from home. Receive payments on behalf of our clients into your own account and forward the money to our account. Earn R800 a day.';
var LEGIT = 'Applications for the 2026 Graduate Programme are open on our careers portal. Reference GP2026-14. Closing date 30 October. No fee is charged at any stage.';

console.log('JOB SCAM SHIELD - report similarity');
console.log('similar at ' + Similarity.SIMILAR_AT + ', duplicate at ' + Similarity.DUPLICATE_AT);
console.log('');

/* ---------- normalisation ---------- */

test('links, numbers, amounts and punctuation are stripped', function () {
  var text = Similarity.normalize('Pay R150 to 081 234 5678 or https://wa.me/27812345678 NOW!!!');
  equal(text, 'pay to or now');
});

test('stopwords and short words are dropped from tokens', function () {
  var words = Similarity.tokens('Hi guys, this is the job for you and your friends');
  equal(words.join(' '), 'job friends');
});

test('jaccard is 1 for identical sets and 0 for disjoint ones', function () {
  equal(Similarity.jaccard(['a', 'b'], ['b', 'a']), 1);
  equal(Similarity.jaccard(['a'], ['b']), 0);
  equal(Similarity.jaccard([], []), 0);
});

/* ---------- pairwise ---------- */

test('the same scam with a new number and amount is a near-duplicate', function () {
  var result = Similarity.compare(
    Similarity.fingerprint(post('a', PRASA_A)),
    Similarity.fingerprint(post('b', PRASA_B))
  );
  assert(result.score >= Similarity.DUPLICATE_AT, 'score was ' + result.score.toFixed(2));
});

test('a rewritten copy of the same scam is still similar', function () {
  var result = Similarity.compare(
    Similarity.fingerprint(post('a', PRASA_A)),
    Similarity.fingerprint(post('b', PRASA_REWRITE))
  );
  assert(result.score >= Similarity.SIMILAR_AT, 'score was ' + result.score.toFixed(2));
  assert(result.score < 1, 'a rewrite is not an exact contact match');
});

test('different scams are not similar', function () {
  var eskom = Similarity.fingerprint(post('a', ESKOM));
  var mule = Similarity.fingerprint(post('b', MULE));
  var prasa = Similarity.fingerprint(post('c', PRASA_A));
  assert(Similarity.compare(eskom, mule).score < Similarity.SIMILAR_AT, 'eskom vs mule');
  assert(Similarity.compare(prasa, mule).score < Similarity.SIMILAR_AT, 'prasa vs mule');
});

test('a legitimate posting is not similar to any scam', function () {
  var legit = Similarity.fingerprint(post('l', LEGIT));
  [PRASA_A, ESKOM, MULE].forEach(function (text, index) {
    var score = Similarity.compare(legit, Similarity.fingerprint(post('s' + index, text))).score;
    assert(score < Similarity.SIMILAR_AT, 'legit vs scam ' + index + ' scored ' + score.toFixed(2));
  });
});

test('a shared phone number is a match regardless of wording', function () {
  var a = Similarity.fingerprint(post('a', ESKOM, { entityIds: ['en-1'] }));
  var b = Similarity.fingerprint(post('b', MULE, { entityIds: ['en-1', 'en-2'] }));
  var result = Similarity.compare(a, b);
  equal(result.score, 1);
  equal(result.basis, 'contact');
});

test('entity keys can come from outside the post', function () {
  var a = Similarity.fingerprint({ message: ESKOM }, ['phone|0831112222']);
  var b = Similarity.fingerprint({ message: MULE }, ['phone|0831112222']);
  equal(Similarity.compare(a, b).score, 1);
});

/* ---------- queries ---------- */

test('findSimilar returns the best match first with a reason', function () {
  var posts = [post('b', PRASA_B), post('r', PRASA_REWRITE), post('e', ESKOM), post('m', MULE)];
  var found = Similarity.findSimilar(post('a', PRASA_A), posts);
  equal(found.length, 2, 'two PRASA copies, nothing else');
  equal(found[0].post.id, 'b', 'the closest copy comes first');
  equal(found[0].reason, Similarity.REASONS.wording);
  assert(found[1].reason, 'every match explains itself');
});

test('findSimilar never returns the post itself', function () {
  var a = post('a', PRASA_A);
  equal(Similarity.findSimilar(a, [a, post('b', PRASA_B)]).length, 1);
});

test('removed posts are left out', function () {
  var found = Similarity.findSimilar(post('a', PRASA_A), [post('b', PRASA_B, { removed: true })]);
  equal(found.length, 0);
});

test('a draft that has not been posted can be matched', function () {
  var draft = { message: PRASA_B, scan: { signalIds: ['comment-yes', 'advance-fee'] }, entityKeys: [] };
  var found = Similarity.findSimilar(draft, [post('a', PRASA_A), post('e', ESKOM)]);
  equal(found.length, 1);
  equal(found[0].post.id, 'a');
});

test('countMap counts similar reports for every post in one pass', function () {
  var posts = [post('a', PRASA_A), post('b', PRASA_B), post('r', PRASA_REWRITE), post('e', ESKOM)];
  var counts = Similarity.countMap(posts);
  equal(counts.a, 2);
  equal(counts.b, 2);
  equal(counts.r, 2);
  equal(counts.e, 0);
});

test('clusters group one scam campaign together', function () {
  var posts = [post('a', PRASA_A), post('e', ESKOM), post('b', PRASA_B), post('m', MULE), post('r', PRASA_REWRITE)];
  var groups = Similarity.clusters(posts);
  equal(groups.length, 3, 'PRASA campaign, Eskom, mule');
  equal(groups[0].size, 3, 'the largest group is the PRASA campaign');
  equal(groups[0].first.id, 'a', 'the first report in a cluster is the oldest');
});

/* ---------- composer notice ---------- */

test('a strong match produces an "already reported" notice', function () {
  var found = Similarity.findSimilar(post('a', PRASA_A), [post('b', PRASA_B)]);
  var notice = Similarity.duplicateNotice(found);
  equal(notice.strong, true);
  assert(/already reported/i.test(notice.title), notice.title);
  assert(/me too/i.test(notice.body), 'the notice should steer people to Me too');
});

test('a weak match produces a softer notice', function () {
  var found = Similarity.findSimilar(post('a', PRASA_A), [post('r', PRASA_REWRITE)]);
  var notice = Similarity.duplicateNotice(found);
  equal(notice.strong, false);
  assert(/similar/i.test(notice.title), notice.title);
});

test('no match means no notice', function () {
  equal(Similarity.duplicateNotice([]), null);
});

/* ---------- report ---------- */

console.log('');
console.log('---');
console.log('passed:      ' + passed + '/' + (passed + failures.length));
if (failures.length) {
  console.log('');
  console.log('FAILURES');
  failures.forEach(function (f) { console.log('  ' + f); });
  process.exitCode = 1;
} else {
  console.log('ALL GREEN');
}
