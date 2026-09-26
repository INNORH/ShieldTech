/*
 * Tests for the community trust model.
 *
 * These matter more than the usual UI tests. Credibility, decay and rank
 * are the claims the app makes to users about other people, so the rules
 * that produce those claims are pinned down here rather than left to the
 * screen.
 */
'use strict';

var Community = require('./community.js');
var Store = require('./api.js');

var HOUR = 3600000;
var NOW = Date.parse('2026-09-25T12:00:00Z');

var queue = [];
var passed = 0;
var failures = [];

function test(name, fn) {
  queue.push({ name: name, fn: fn });
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

function makeStore(clock) {
  return Store.createStore({
    meta: Store.adapters.memoryMeta(),
    blobs: Store.adapters.memoryBlobs(),
    now: function () { return clock; }
  });
}

/*
 * Test-only dataset. The app itself ships with no invented reports, contacts
 * or trust records, so anything a test needs to assert on is built here
 * instead. It deliberately covers every standing the feed can produce, plus a
 * live and an expired report, so the ranking and stats logic stays exercised.
 */
function fixture() {
  var store = makeStore(NOW);

  store.addPost({
    id: 'fx-live', authorId: 'u-top', authorName: 'Top R.',
    message: 'a report nobody has voted on yet', label: 'scam',
    scan: { risk: 'HIGH', score: 40, signalIds: [] }, entityIds: []
  });
  store.addPost({
    id: 'fx-agreed', authorId: 'u-top', authorName: 'Top R.',
    message: 'almost everyone says this is a scam', label: 'scam',
    scan: { risk: 'HIGH', score: 40, signalIds: [] }, entityIds: []
  });
  store.addPost({
    id: 'fx-contested', authorId: 'u-other', authorName: 'Other P.',
    message: 'people disagree about this one', label: 'scam',
    scan: { risk: 'MEDIUM', score: 20, signalIds: [] }, entityIds: []
  });
  store.addPost({
    id: 'fx-mine', authorId: 'u-me', authorName: 'Me S.',
    message: 'a report by the account under test', label: 'scam',
    scan: { risk: 'HIGH', score: 40, signalIds: [] }, entityIds: []
  });

  /* castVote is (postId, signal, userId) */
  store.castVote('fx-agreed', 'scam', 'u-me');
  store.castVote('fx-agreed', 'scam', 'u-other');
  store.castVote('fx-contested', 'legit', 'u-top');
  store.castVote('fx-contested', 'legit', 'u-me');
  store.castVote('fx-contested', 'scam', 'u-third');

  store.upsertEntity({ kind: 'phone', value: '0811234567', displayName: 'Phone 081 123 4567' });
  store.upsertEntity({ kind: 'domain', value: 'example.test', displayName: 'example.test' });

  store.bumpTrust('u-top', { postsMade: 18, confirmed: 17, disputed: 1, points: 1240 });
  store.bumpTrust('u-other', { postsMade: 4, confirmed: 1, disputed: 3, points: 90 });
  return store;
}

function post(id, over) {
  var base = {
    id: id,
    authorId: 'u-author',
    authorName: 'Someone K.',
    createdAt: new Date(NOW - HOUR).toISOString(),
    message: 'test message',
    label: 'scam',
    scan: { risk: 'HIGH', score: 48, signalIds: [] },
    entityIds: [],
    votes: { scam: 0, legit: 0, reported: 0, metoo: 0 },
    voterIds: { scam: [], legit: [], reported: [], metoo: [] },
    flaggedBy: []
  };
  Object.keys(over || {}).forEach(function (key) { base[key] = over[key]; });
  return base;
}

console.log('JOB SCAM SHIELD - community trust model');
console.log('live window: ' + Community.LIVE_WINDOW_HOURS + 'h, low-trust limit: ' +
  Community.LOW_TRUST_DAILY_LIMIT + '/day');
console.log('');

/* ---------- credibility ---------- */

test('a post with no votes has no credibility ratio', function () {
  equal(Community.credibility(post('p1')).ratio, null);
});

test('zero votes never render as a verdict', function () {
  equal(Community.standing(post('p1')).key, 'unconfirmed');
});

test('"reported" votes do not inflate credibility', function () {
  var p = post('p1', {
    votes: { scam: 0, legit: 0, reported: 40, metoo: 0 },
    voterIds: { scam: [], legit: [], reported: ['a', 'b'], metoo: [] }
  });
  var cred = Community.credibility(p);
  equal(cred.ratio, null, 'reported alone must not create backing');
  equal(Community.standing(p).key, 'unconfirmed', 'still unconfirmed');
});

test('"me too" counts as weak backing', function () {
  var p = post('p1', { votes: { scam: 0, legit: 0, reported: 0, metoo: 3 } });
  equal(Community.credibility(p).agree, 3);
});

test('heavy agreement reads as corroborated', function () {
  var p = post('p1', { votes: { scam: 8, legit: 1, reported: 0, metoo: 0 } });
  equal(Community.standing(p).key, 'corroborated');
});

test('heavy disagreement reads as contested', function () {
  var p = post('p1', { votes: { scam: 2, legit: 7, reported: 0, metoo: 0 } });
  equal(Community.standing(p).key, 'contested');
});

test('a split reads as mixed', function () {
  var p = post('p1', { votes: { scam: 4, legit: 3, reported: 0, metoo: 0 } });
  equal(Community.standing(p).key, 'mixed');
});

test('the community can push back on a report', function () {
  var p = post('p1', { votes: { scam: 2, legit: 7, reported: 0, metoo: 1 } });
  assert(Community.credibility(p).ratio < 0.5, 'a disputed post must not stay top-ranked');
});

/* ---------- decay ---------- */

test('a fresh post is live', function () {
  equal(Community.isLive(post('p1'), NOW), true);
});

test('a post past the live window is not live', function () {
  var old = post('p1', { createdAt: new Date(NOW - 100 * HOUR).toISOString() });
  equal(Community.isLive(old, NOW), false);
});

test('decay fades to zero at the window edge', function () {
  var justNow = post('p1', { createdAt: new Date(NOW).toISOString() });
  var edge = post('p2', {
    createdAt: new Date(NOW - Community.LIVE_WINDOW_HOURS * HOUR).toISOString()
  });
  equal(Community.decay(justNow, NOW), 1, 'a new report is fully live');
  equal(Community.decay(edge, NOW), 0);
  equal(Community.decay(post('p3', { createdAt: new Date(NOW - 36 * HOUR).toISOString() }), NOW), 0.5);
});

test('old reports fall below fresh ones in the feed', function () {
  var fresh = Community.feedScore(post('p1'), NOW);
  var old = Community.feedScore(post('p2', { createdAt: new Date(NOW - 70 * HOUR).toISOString() }), NOW);
  assert(fresh > old, 'decay must reduce feed weight');
});

test('live posts always sort above past posts', function () {
  var posts = [
    post('old', {
      createdAt: new Date(NOW - 200 * HOUR).toISOString(),
      votes: { scam: 30, legit: 0, reported: 0, metoo: 0 }
    }),
    post('new', { votes: { scam: 1, legit: 0, reported: 0, metoo: 0 } })
  ];
  var feed = Community.buildFeed(posts, NOW);
  equal(feed[0].id, 'new', 'a live post outranks a heavily backed dead one');
});

test('credibility outranks recency within the live window', function () {
  var posts = [
    post('loud', {
      createdAt: new Date(NOW - 1 * HOUR).toISOString(),
      votes: { scam: 0, legit: 0, reported: 0, metoo: 0 }
    }),
    post('backed', {
      createdAt: new Date(NOW - 40 * HOUR).toISOString(),
      votes: { scam: 12, legit: 0, reported: 0, metoo: 0 }
    })
  ];
  var feed = Community.buildFeed(posts, NOW);
  equal(feed[0].id, 'backed', 'backing beats being new');
});

/* ---------- rank ---------- */

test('a new account is rank 1', function () {
  equal(Community.rankFor({ userId: 'u', points: 0, postsMade: 0, confirmed: 0, disputed: 0 }), 1);
});

test('rank 5 needs volume and a good hit rate', function () {
  equal(Community.rankFor({ userId: 'u', postsMade: 10, confirmed: 9, disputed: 1 }), 5);
});

test('lots of posts at a poor rate do not reach rank 5', function () {
  equal(Community.rankFor({ userId: 'u', postsMade: 30, confirmed: 12, disputed: 18 }), 2);
});

test('rank label is always present', function () {
  equal(Community.trustLabel({ userId: 'u', postsMade: 10, confirmed: 9, disputed: 1 }), 'Most trusted');
});

test('low trust is capped by rate', function () {
  var trust = { userId: 'u-new', postsMade: 1, confirmed: 0, disputed: 0 };
  var posts = [
    post('a', { authorId: 'u-new', createdAt: new Date(NOW - 2 * HOUR).toISOString() }),
    post('b', { authorId: 'u-new', createdAt: new Date(NOW - 3 * HOUR).toISOString() })
  ];
  var result = Community.canPost(trust, posts, NOW);
  equal(result.ok, false, 'third post in a day should be blocked');
  assert(/today/.test(result.reason), 'the reason should explain itself');
});

test('high trust is not rate limited', function () {
  var trust = { userId: 'u-vet', postsMade: 12, confirmed: 11, disputed: 1 };
  var posts = [];
  for (var i = 0; i < 9; i++) {
    posts.push(post('p' + i, { authorId: 'u-vet', createdAt: new Date(NOW - HOUR).toISOString() }));
  }
  equal(Community.canPost(trust, posts, NOW).ok, true);
});

test('the daily limit resets the next day', function () {
  var trust = { userId: 'u-new', postsMade: 1, confirmed: 0, disputed: 0 };
  var posts = [
    post('a', { authorId: 'u-new', createdAt: new Date(NOW - 30 * HOUR).toISOString() }),
    post('b', { authorId: 'u-new', createdAt: new Date(NOW - 31 * HOUR).toISOString() })
  ];
  equal(Community.canPost(trust, posts, NOW).ok, true);
});

/* ---------- voting rules ---------- */

test('one person cannot vote twice on the same post', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  store.castVote(p.id, 'scam', 'u-voter');
  var after = store.castVote(p.id, 'scam', 'u-voter');
  equal(after.post.votes.scam, 1, 'repeating a vote must not increase the count');
});

test('switching signal moves the vote instead of adding one', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  store.castVote(p.id, 'scam', 'u-voter');
  var after = store.castVote(p.id, 'legit', 'u-voter');
  equal(after.post.votes.scam, 0, 'old signal is withdrawn');
  equal(after.post.votes.legit, 1, 'new signal is recorded');
});

test('you cannot vote on your own report', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-me', authorName: 'Me K.', message: 'x', label: 'scam' });
  var result = store.castVote(p.id, 'scam', 'u-me');
  equal(result.ok, false);
  equal(store.getPost(p.id).votes.scam, 0);
});

test('an unknown signal is rejected', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  equal(store.castVote(p.id, 'nonsense', 'u-voter').ok, false);
});

test('voteBy reports the signal a person cast', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  store.castVote(p.id, 'reported', 'u-voter');
  equal(store.voteBy(store.getPost(p.id), 'u-voter'), 'reported');
  equal(store.voteBy(store.getPost(p.id), 'u-other'), null);
});

/* ---------- entities ---------- */

test('south african phone numbers normalise', function () {
  equal(Community.normalizePhone('081 123 4567'), '0811234567');
  equal(Community.normalizePhone('+27 81 123 4567'), '0811234567');
  equal(Community.normalizePhone('0811234567'), '0811234567');
});

test('short or malformed numbers are not entities', function () {
  equal(Community.normalizePhone('12345'), null);
  equal(Community.normalizePhone('2026'), null);
});

test('domains normalise and drop www and paths', function () {
  equal(Community.normalizeDomain('https://www.BrightPath.co.za/jobs'), 'brightpath.co.za');
});

test('file extensions are not treated as domains', function () {
  var found = Community.extractEntities('See the attached cv.pdf and logo.png');
  equal(found.length, 0, 'extensions must not become watchlist domains');
});

test('a wa.me link yields the number', function () {
  var found = Community.extractEntities('WhatsApp us: https://wa.me/27811234567');
  var phone = found.filter(function (e) { return e.kind === 'phone'; })[0];
  assert(phone, 'expected a phone entity');
  equal(phone.value, '0811234567');
});

test('a loose number in text is caught', function () {
  var found = Community.extractEntities('Call 082 555 1234 today');
  assert(found.filter(function (e) { return e.value === '0825551234'; }).length === 1);
});

test('link shorteners are not treated as scam domains', function () {
  var found = Community.extractEntities('Apply now: https://wa.me/27811234567 or https://bit.ly/3xYz');
  var domains = found.filter(function (e) { return e.kind === 'domain'; });
  equal(domains.length, 0, 'neutral platforms must stay off the watchlist');
  assert(found.filter(function (e) { return e.value === '0811234567'; }).length === 1,
    'the number is still captured');
});

test('a real domain alongside a shortener is still captured', function () {
  var found = Community.extractEntities('Visit careers.brightpath.co.za or bit.ly/3xYz');
  var domains = found.filter(function (e) { return e.kind === 'domain'; });
  equal(domains.length, 1);
  equal(domains[0].value, 'careers.brightpath.co.za');
});

test('entities are de-duplicated', function () {
  var found = Community.extractEntities('wa.me/27811234567 or 081 123 4567 or wa.me/27811234567');
  equal(found.length, 1);
});

test('the same number merges into one watchlist record', function () {
  var store = makeStore(NOW);
  store.upsertEntity({ kind: 'phone', value: '0811234567', displayName: 'Phone 081 123 4567' });
  store.upsertEntity({ kind: 'phone', value: '0811234567', displayName: 'Phone 081 123 4567' });
  var all = store.listEntities().filter(function (e) { return e.value === '0811234567'; });
  equal(all.length, 1, 'one record');
  equal(all[0].reportCount, 2, 'two reports on it');
});

/* ---------- attachments ---------- */

test('images and pdfs are accepted', function () {
  equal(Community.validateAttachment({ name: 'shot.jpg', type: 'image/jpeg', size: 1000 }).ok, true);
  equal(Community.validateAttachment({ name: 'form.pdf', type: 'application/pdf', size: 1000 }).ok, true);
});

test('executables are refused', function () {
  var result = Community.validateAttachment({ name: 'payload.exe', type: 'application/octet-stream', size: 1000 });
  equal(result.ok, false);
  assert(/images and PDF/i.test(result.reason), 'reason should name what is allowed');
});

test('oversized files are refused', function () {
  var result = Community.validateAttachment({ name: 'big.png', type: 'image/png', size: 6 * 1024 * 1024 });
  equal(result.ok, false);
  assert(/5MB/.test(result.reason));
});

test('attachment kind distinguishes images from documents', function () {
  equal(Community.attachmentKind({ type: 'image/png' }), 'image');
  equal(Community.attachmentKind({ type: 'application/pdf' }), 'file');
});

/* ---------- clearing the invented data older builds left behind ---------- */

test('a profile from an older build has its invented data swept away', function () {
  var meta = Store.adapters.memoryMeta();
  var store = Store.createStore({
    meta: meta, blobs: Store.adapters.memoryBlobs(),
    now: function () { return NOW; }
  });

  /* Write the shape the old shipped seed used, by hand. */
  meta.set('jss_community_posts', JSON.stringify([
    { id: 'sp-1', authorId: 'u-nandi', authorName: 'Nandi K.', message: 'invented one', sample: true, entityIds: ['en-1'] },
    { id: 'sp-2', authorId: 'u-thabo', authorName: 'Thabo B.', message: 'invented two', sample: true, entityIds: ['en-1', 'en-2'] },
    { id: 'p-real0001', authorId: 'u-real', authorName: 'Real P.', message: 'a report a person actually wrote', entityIds: ['en-1', 'en-2'] }
  ]));
  meta.set('jss_community_entities', JSON.stringify([
    { id: 'en-1', kind: 'phone', value: '0810000001', displayName: '081 000 0001', reportCount: 2, confirmCount: 3, sample: true },
    { id: 'en-2', kind: 'domain', value: 'brightpath.example', displayName: 'brightpath.example', reportCount: 1, confirmCount: 0 }
  ]));
  meta.set('jss_community_trust', JSON.stringify([
    { userId: 'u-nandi', points: 40, postsMade: 1, confirmed: 0, disputed: 0 },
    { userId: 'u-thabo', points: 25, postsMade: 1, confirmed: 0, disputed: 0 },
    { userId: 'u-real', points: 10, postsMade: 1, confirmed: 0, disputed: 0 }
  ]));
  meta.set('jss_community_flags', JSON.stringify([
    { postId: 'sp-1', userId: 'u-real' }, { postId: 'p-real0001', userId: 'u-nandi' }
  ]));

  var result = store.purgeFabricatedData();
  equal(result.removed, 2, 'both invented reports were removed');
  equal(result.alreadyClean, false, 'the sweep did real work');

  var posts = store.listPosts();
  equal(posts.length, 1, 'only the genuine report is left');
  equal(posts[0].id, 'p-real0001', 'the genuine report survived');
  equal(posts[0].entityIds.length, 1, 'its reference to the invented row was dropped');
  equal(posts[0].entityIds[0], 'en-2', 'and it kept the row that is genuinely its own');

  var entities = store.listEntities();
  equal(entities.length, 1, 'the invented watchlist row is gone');
  equal(entities[0].id, 'en-2', 'the real watchlist row survived');

  var trust = store.listTrust();
  equal(trust.length, 1, 'trust for people who never reported is gone');
  equal(trust[0].userId, 'u-real', 'the real reporter keeps their trust');

  equal(meta.get('jss_community_flags'), null, 'the unused legacy flags key is cleared');
});

test('a watchlist row no real report points at is dropped', function () {
  var meta = Store.adapters.memoryMeta();
  var store = Store.createStore({
    meta: meta, blobs: Store.adapters.memoryBlobs(),
    now: function () { return NOW; }
  });
  meta.set('jss_community_posts', JSON.stringify([
    { id: 'p-real0001', authorId: 'u-real', authorName: 'Real P.', message: 'a genuine report', entityIds: [] }
  ]));
  meta.set('jss_community_entities', JSON.stringify([
    { id: 'en-orphan', kind: 'phone', value: '0810000001', displayName: '081 000 0001', reportCount: 4, confirmCount: 9 }
  ]));
  meta.set('jss_community_trust', JSON.stringify([]));

  store.purgeFabricatedData();
  equal(store.listEntities().length, 0, 'an unreferenced row is not evidence of anything');
  equal(store.listPosts().length, 1, 'and the real report is untouched');
});

test('report counts are rebuilt from the real reports, not inherited', function () {
  var meta = Store.adapters.memoryMeta();
  var store = Store.createStore({
    meta: meta, blobs: Store.adapters.memoryBlobs(),
    now: function () { return NOW; }
  });

  meta.set('jss_community_posts', JSON.stringify([
    { id: 'sp-1', authorId: 'u-nandi', authorName: 'Nandi K.', message: 'invented', sample: true, entityIds: ['en-1'] },
    { id: 'sp-2', authorId: 'u-thabo', authorName: 'Thabo B.', message: 'invented too', sample: true, entityIds: ['en-1'] },
    { id: 'p-real0001', authorId: 'u-real', authorName: 'Real P.', message: 'a genuine report', entityIds: ['en-1', 'en-2'] }
  ]));
  meta.set('jss_community_entities', JSON.stringify([
    { id: 'en-1', kind: 'phone', value: '0810000001', displayName: '081 000 0001', reportCount: 2, confirmCount: 0, sample: true },
    { id: 'en-2', kind: 'domain', value: 'brightpath.example', displayName: 'brightpath.example', reportCount: 1, confirmCount: 0 }
  ]));
  meta.set('jss_community_trust', JSON.stringify([]));

  store.purgeFabricatedData();

  var entities = store.listEntities();
  equal(entities.length, 1, 'the invented entity is gone');
  equal(entities[0].id, 'en-2', 'only the real entity is left');
  equal(entities[0].reportCount, 1, 'its count reflects the one real report, not the invented ones');
});

test('a genuine report never has its watchlist rows deleted', function () {
  var store = makeStore(NOW);
  var phone = store.upsertEntity({ kind: 'phone', value: '0815555555', displayName: '081 555 5555' });
  var site = store.upsertEntity({ kind: 'domain', value: 'brightpath.example', displayName: 'brightpath.example' });
  store.addPost({
    authorId: 'u-real', authorName: 'Real P.',
    message: 'send your CV to 081 555 5555 or visit brightpath.example',
    label: 'scam', entityIds: [phone.id, site.id]
  });
  store.bumpTrust('u-real', { postsMade: 1, points: 10 });
  store.purgeFabricatedData();
  equal(store.listPosts().length, 1, 'the real report survived the sweep');
  equal(store.listEntities().length, 2, 'both real watchlist rows survived');
  equal(store.listEntities()[0].reportCount, 1, 'and its count is the real one');
  equal(store.listTrust().length, 1, 'real trust survives');
  equal(store.listTrust()[0].postsMade, 1, 'with the posts the person actually made');
});

test('the sweep is a no-op on a clean profile', function () {
  var store = makeStore(NOW);
  var result = store.purgeFabricatedData();
  equal(result.removed, 0, 'nothing to remove');
  equal(result.alreadyClean, true, 'and it says so');
});

/* ---------- deleting your own data ---------- */

/*
 * Settings offers "delete my reports". It must never become "delete
 * everyone's reports", so the blast radius is pinned down here.
 */
function seedTwoPeople(store) {
  var shared = store.upsertEntity({ kind: 'phone', value: '0815555555', displayName: '081 555 5555' });
  var onlyMine = store.upsertEntity({ kind: 'domain', value: 'mine.example', displayName: 'mine.example' });
  var onlyTheirs = store.upsertEntity({ kind: 'domain', value: 'theirs.example', displayName: 'theirs.example' });
  store.addPost({
    authorId: 'u-mine', authorName: 'Mine M.',
    message: 'mine.example and 081 555 5555', label: 'scam',
    entityIds: [shared.id, onlyMine.id]
  });
  store.addPost({
    authorId: 'u-theirs', authorName: 'Theirs T.',
    message: 'theirs.example and 081 555 5555', label: 'scam',
    entityIds: [shared.id, onlyTheirs.id]
  });
  store.bumpTrust('u-mine', { postsMade: 1, points: 10 });
  store.bumpTrust('u-theirs', { postsMade: 1, points: 10 });
  return { shared: shared.id, onlyMine: onlyMine.id, onlyTheirs: onlyTheirs.id };
}

test('deleting your reports leaves other people\'s alone', function () {
  var store = makeStore(NOW);
  seedTwoPeople(store);

  return store.deletePostsByAuthor('u-mine').then(function (result) {
    equal(result.removed, 1, 'exactly my one report went');
    equal(result.alreadyClean, false, 'and it says it did work');

    var posts = store.listPosts();
    equal(posts.length, 1, 'one report remains');
    equal(posts[0].authorId, 'u-theirs', 'and it is not mine');
  });
});

test('deleting your reports drops your trust record', function () {
  var store = makeStore(NOW);
  seedTwoPeople(store);
  return store.deletePostsByAuthor('u-mine').then(function () {
    var trust = store.listTrust();
    equal(trust.length, 1, 'only the other person keeps a record');
    equal(trust[0].userId, 'u-theirs', 'and it is theirs');
  });
});

test('deleting your reports keeps watchlist rows other people still use', function () {
  var store = makeStore(NOW);
  var ids = seedTwoPeople(store);
  store.deletePostsByAuthor('u-mine');

  var entities = store.listEntities();
  var byId = {};
  entities.forEach(function (e) { byId[e.id] = e; });

  assert(byId[ids.shared], 'the number they both reported is still on the watchlist');
  equal(byId[ids.shared].reportCount, 1, 'its count dropped to the one real report');
  assert(!byId[ids.onlyMine], 'a row only my report used is not evidence any more');
  assert(byId[ids.onlyTheirs], 'their row is untouched');
  equal(byId[ids.onlyTheirs].reportCount, 1, 'and its count is still right');
});

test('deleting reports you never posted changes nothing', function () {
  var store = makeStore(NOW);
  seedTwoPeople(store);
  return store.deletePostsByAuthor('u-nobody').then(function (result) {
    equal(result.removed, 0, 'nothing was removed');
    equal(result.alreadyClean, true, 'and it says so rather than claiming success');
    equal(store.listPosts().length, 2, 'both reports are still there');
    equal(store.listEntities().length, 3, 'and every watchlist row survived');
  });
});

test('deleting your reports twice is a no-op, not an error', function () {
  var store = makeStore(NOW);
  seedTwoPeople(store);
  return store.deletePostsByAuthor('u-mine')
    .then(function () { return store.deletePostsByAuthor('u-mine'); })
    .then(function (again) {
      equal(again.removed, 0, 'the second attempt removes nothing');
      equal(again.alreadyClean, true, 'and admits there was nothing to do');
      equal(store.listPosts().length, 1, 'the other person\'s report is still intact');
    });
});

test('deleting your reports takes the flags on them with them', function () {
  var store = makeStore(NOW);
  seedTwoPeople(store);
  var mine = store.listPosts().filter(function (p) { return p.authorId === 'u-mine'; })[0];
  var theirs = store.listPosts().filter(function (p) { return p.authorId === 'u-theirs'; })[0];

  store.flagPost(mine.id, 'u-theirs');
  store.flagPost(theirs.id, 'u-mine');
  var flagged = store.listPosts().filter(function (p) { return (p.flaggedBy || []).length; });
  equal(flagged.length, 2, 'both reports carry a flag');

  return store.deletePostsByAuthor('u-mine').then(function () {
    var left = store.listPosts()[0];
    equal(left.id, theirs.id, 'their report is the one that survived');
    equal((left.flaggedBy || []).length, 1, 'its own flag is still counted');
    equal(left.flaggedBy[0], 'u-mine', 'a vote left on a surviving report is not collateral damage');
  });
});

test('deleting your reports clears only your own legacy flags', function () {
  var meta = Store.adapters.memoryMeta();
  var store = Store.createStore({
    meta: meta, blobs: Store.adapters.memoryBlobs(),
    now: function () { return NOW; }
  });
  seedTwoPeople(store);
  meta.set('jss_community_flags', JSON.stringify([
    { postId: 'p-old', userId: 'u-mine' },
    { postId: 'p-old2', userId: 'u-theirs' }
  ]));

  return store.deletePostsByAuthor('u-mine').then(function () {
    var left = JSON.parse(meta.get('jss_community_flags'));
    equal(left.length, 1, 'one legacy flag left');
    equal(left[0].userId, 'u-theirs', 'and it belongs to the other person');
  });
});

test('the legacy flags key is removed once the last one is gone', function () {
  var meta = Store.adapters.memoryMeta();
  var store = Store.createStore({
    meta: meta, blobs: Store.adapters.memoryBlobs(),
    now: function () { return NOW; }
  });
  seedTwoPeople(store);
  meta.set('jss_community_flags', JSON.stringify([{ postId: 'p-old', userId: 'u-mine' }]));

  return store.deletePostsByAuthor('u-mine').then(function () {
    equal(meta.get('jss_community_flags'), null, 'the abandoned key is not left behind to rot');
  });
});

/* ---------- dataset integrity ---------- */

test('a brand new store invents nothing', function () {
  var store = makeStore(NOW);
  equal(store.listPosts().length, 0, 'no reports without a user');
  equal(store.listEntities().length, 0, 'no watchlist entries without a report');
  equal(store.listTrust().length, 0, 'no trust records without a reporter');
  equal(store.getTrust('u-nobody').postsMade, 0, 'an unknown account starts at zero');
});

test('the dataset loads and every post has a valid shape', function () {
  var store = fixture();
  var posts = store.listPosts();
  assert(posts.length >= 4, 'expected the test dataset');
  posts.forEach(function (p) {
    assert(p.id && p.authorId && p.authorName, 'post ' + p.id + ' missing identity');
    assert(typeof p.message === 'string' && p.message.length > 5, 'post ' + p.id + ' missing message');
    assert(Community.LABELS[p.label], 'post ' + p.id + ' has unknown label ' + p.label);
    assert(p.votes && p.voterIds, 'post ' + p.id + ' missing votes');
  });
});

test('every author has a trust record', function () {
  var store = fixture();
  store.listPosts().forEach(function (p) {
    var trust = store.getTrust(p.authorId);
    equal(trust.userId, p.authorId, 'no trust record for ' + p.authorId);
  });
});

test('watchlist entries only appear with a report', function () {
  var store = fixture();
  store.listEntities().forEach(function (e) {
    assert(e.firstSeen, 'an entity must record when it was first seen');
    assert(e.reportCount >= 1, 'an entity must be backed by at least one report');
  });
});

test('the dataset contains a contested report', function () {
  var store = fixture();
  var contested = store.listPosts().map(function (p) {
    return Community.standing(p);
  }).filter(function (s) { return s.key === 'contested'; });
  assert(contested.length >= 1, 'a dataset with no pushback cannot exercise the contested state');
});

test('the dataset contains an unconfirmed report', function () {
  var store = fixture();
  var unconfirmed = store.listPosts().filter(function (p) {
    return Community.standing(p).key === 'unconfirmed';
  });
  assert(unconfirmed.length >= 1, 'the "unconfirmed" state needs a case');
});

/* ---------- feed + stats ---------- */

test('the feed decorates posts for the screen', function () {
  var store = fixture();
  var feed = Community.buildFeed(store.listPosts(), NOW);
  assert(feed.length >= 4);
  feed.forEach(function (item) {
    assert(item.labelText, 'label text missing');
    assert(item.age, 'age label missing');
    assert(item.standing && item.standing.key, 'standing missing');
  });
});

test('live alert count respects the window', function () {
  /* addPost always stamps the current time, so a report that has aged out is
     built directly to test the window itself. */
  var posts = [
    post('fresh', { createdAt: new Date(NOW - 2 * HOUR).toISOString() }),
    post('recent', { createdAt: new Date(NOW - 60 * HOUR).toISOString() }),
    post('stale', { createdAt: new Date(NOW - 96 * HOUR).toISOString() })
  ];
  equal(Community.liveCount(posts, NOW), 2, 'only reports inside the window count as live');
  equal(Community.liveCount([], NOW), 0, 'an empty community has no live alerts');
});

test('dashboard stats report rank and totals', function () {
  var store = fixture();
  var trust = store.getTrust('u-top');
  var stats = Community.dashboardStats(store.listPosts(), trust, NOW);
  equal(stats.rank, 5);
  equal(stats.rankLabel, 'Most trusted');
  assert(stats.totalReports >= 4);
  assert(stats.myReports >= 1);
});

test('votes cast counts one per post per person', function () {
  var posts = [post('a', {
    votes: { scam: 2, legit: 0, reported: 1, metoo: 0 },
    voterIds: { scam: ['u-x', 'u-y'], legit: [], reported: ['u-x'], metoo: [] }
  })];
  equal(Community.userVoteCount(posts, 'u-x'), 1, 'u-x voted scam and reported, counts once');
  equal(Community.userVoteCount(posts, 'u-y'), 1);
  equal(Community.userVoteCount(posts, 'u-none'), 0);
});

/* ---------- round trip ---------- */

test('a posted report survives a reload from the store', function () {
  // one shared adapter stands in for storage that outlives the session
  var meta = Store.adapters.memoryMeta();
  var blobs = Store.adapters.memoryBlobs();
  var first = Store.createStore({ meta: meta, blobs: blobs, now: function () { return NOW; } });
  var added = first.addPost({
    authorId: 'u-jabu',
    authorName: 'Jabu N.',
    message: 'Pay R900 for a place. WhatsApp only.',
    label: 'recruitment-fee',
    scan: { risk: 'HIGH', score: 30, signalIds: ['advance-fee'] }
  });

  var reloaded = Store.createStore({ meta: meta, blobs: blobs, now: function () { return NOW; } });
  var found = reloaded.listPosts().filter(function (p) { return p.id === added.id; })[0];
  assert(found, 'the new report should persist');
  equal(found.label, 'recruitment-fee');
  equal(found.votes.scam, 0, 'a new report starts unbacked');
  equal(Community.standing(found).key, 'unconfirmed');
});

test('a vote survives a reload', function () {
  var meta = Store.adapters.memoryMeta();
  var blobs = Store.adapters.memoryBlobs();
  var first = Store.createStore({ meta: meta, blobs: blobs, now: function () { return NOW; } });
  var p = first.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  first.castVote(p.id, 'scam', 'u-voter');

  var reloaded = Store.createStore({ meta: meta, blobs: blobs, now: function () { return NOW; } });
  equal(reloaded.getPost(p.id).votes.scam, 1);
});

test('blobs round trip through the store', function () {
  var store = makeStore(NOW);
  return store.putBlob('k1', { name: 'shot.png', size: 12 }).then(function () {
    return store.getBlob('k1');
  }).then(function (found) {
    equal(found.size, 12);
  });
});

/* ---------- confirmations keep a report alive (Waze "still there?") ---------- */

test('a confirming vote restarts the live window', function () {
  var old = post('p1', {
    createdAt: new Date(NOW - 100 * HOUR).toISOString(),
    lastConfirmedAt: new Date(NOW - 2 * HOUR).toISOString()
  });
  equal(Community.isLive(old, NOW), true, 'confirmed two hours ago, so still live');
  assert(Community.decay(old, NOW) > 0.9, 'decay is measured from the confirmation');
});

test('a dispute does not extend a report', function () {
  var store = makeStore(NOW);
  var p = store.addPost({ authorId: 'u-a', authorName: 'A K.', message: 'x', label: 'scam' });
  store.castVote(p.id, 'legit', 'u-voter');
  equal(store.getPost(p.id).lastConfirmedAt, undefined, 'legit is not a confirmation');
  store.castVote(p.id, 'reported', 'u-other');
  equal(store.getPost(p.id).lastConfirmedAt, undefined, 'reported is not a confirmation');
  store.castVote(p.id, 'metoo', 'u-third');
  assert(store.getPost(p.id).lastConfirmedAt, 'me too is a confirmation');
});

test('the age label still reflects when the report was written', function () {
  var old = post('p1', {
    createdAt: new Date(NOW - 50 * HOUR).toISOString(),
    lastConfirmedAt: new Date(NOW - 1 * HOUR).toISOString()
  });
  equal(Community.ageLabel(old, NOW), '2d ago');
});

/* ---------- standing feeds back into trust ---------- */

test('becoming corroborated earns the author a confirm', function () {
  var before = post('p1', { votes: { scam: 0, legit: 0, reported: 0, metoo: 0 } });
  var after = post('p1', { votes: { scam: 3, legit: 0, reported: 0, metoo: 0 } });
  var delta = Community.trustDelta(before, after);
  equal(delta.confirmed, 1);
  equal(delta.disputed, undefined);
});

test('becoming contested earns the author a dispute', function () {
  var before = post('p1', { votes: { scam: 0, legit: 0, reported: 0, metoo: 0 } });
  var after = post('p1', { votes: { scam: 0, legit: 3, reported: 0, metoo: 0 } });
  equal(Community.trustDelta(before, after).disputed, 1);
});

test('swinging from corroborated to contested moves both counters', function () {
  var before = post('p1', { votes: { scam: 3, legit: 0, reported: 0, metoo: 0 } });
  var after = post('p1', { votes: { scam: 3, legit: 6, reported: 0, metoo: 0 } });
  var delta = Community.trustDelta(before, after);
  equal(delta.confirmed, -1);
  equal(delta.disputed, 1);
});

test('no change in standing means no trust change', function () {
  var before = post('p1', { votes: { scam: 3, legit: 0, reported: 0, metoo: 0 } });
  var after = post('p1', { votes: { scam: 4, legit: 0, reported: 0, metoo: 0 } });
  equal(Community.trustDelta(before, after), null);
});

test('ranks above 2 are reachable once confirms are recorded', function () {
  var store = makeStore(NOW);
  store.bumpTrust('u-a', { postsMade: 4 });
  equal(Community.rankFor(store.getTrust('u-a')), 2, 'volume alone is rank 2');
  store.bumpTrust('u-a', { confirmed: 3 });
  equal(Community.rankFor(store.getTrust('u-a')), 3, 'confirmed reports lift the rank');
});

test('watchlist confirms follow the report standing', function () {
  var store = makeStore(NOW);
  var phone = store.upsertEntity({ kind: 'phone', value: '0811234567', displayName: '081 123 4567' });
  var before = post('p1', { entityIds: [phone.id], votes: { scam: 0, legit: 0, reported: 0, metoo: 0 } });
  var after = post('p1', { entityIds: [phone.id], votes: { scam: 3, legit: 0, reported: 0, metoo: 0 } });
  var delta = Community.entityConfirmDelta(before, after);
  equal(delta, 1);
  store.adjustEntityConfirms(after.entityIds, delta);
  equal(store.listEntities()[0].confirmCount, 1);
  store.adjustEntityConfirms(after.entityIds, -1);
  store.adjustEntityConfirms(after.entityIds, -1);
  equal(store.listEntities()[0].confirmCount, 0, 'never below zero');
});

/* ---------- flags hide a post ---------- */

test('a post with enough flags is hidden from the feed', function () {
  var flagged = post('bad', { flaggedBy: ['a', 'b', 'c'] });
  var fine = post('ok');
  equal(Community.isHidden(flagged), true);
  equal(Community.isHidden(fine), false);
  var feed = Community.buildFeed([flagged, fine], NOW);
  equal(feed.length, 1);
  equal(feed[0].id, 'ok');
});

test('hidden posts do not count as live alerts', function () {
  var posts = [post('bad', { flaggedBy: ['a', 'b', 'c'] }), post('ok')];
  equal(Community.liveCount(posts, NOW), 1);
});

test('a removed post is hidden regardless of flags', function () {
  equal(Community.isHidden(post('gone', { removed: true })), true);
});

/* ---------- runner ---------- */

(function run() {
  var index = 0;

  function next() {
    if (index >= queue.length) {
      return report();
    }
    var item = queue[index++];
    return Promise.resolve()
      .then(item.fn)
      .then(function () {
        passed += 1;
        console.log('pass  ' + item.name);
      })
      .catch(function (err) {
        failures.push(item.name + ' -> ' + err.message);
        console.log('FAIL  ' + item.name + '  (' + err.message + ')');
      })
      .then(next);
  }

  function report() {
    console.log('');
    console.log('---');
    console.log('passed:      ' + passed + '/' + queue.length);
    if (failures.length) {
      console.log('');
      console.log('FAILURES');
      failures.forEach(function (f) { console.log('  ' + f); });
      process.exitCode = 1;
    } else {
      console.log('ALL GREEN');
    }
  }

  next();
})();
