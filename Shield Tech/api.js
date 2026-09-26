/*
 * Job Scam Shield — community data store.
 *
 * This is the seam where the app stops being a private tool. Everything
 * above it (community.js, app.js) is written against the interface below
 * and never touches storage directly, so the FastAPI + SQLite version can
 * replace the body of createStore without changing a single view.
 *
 * WHY TWO ADAPTERS
 * Post metadata is small JSON, so it lives in localStorage. Attachments
 * are not: localStorage caps at roughly 5MB per origin and a single phone
 * photo base64-encoded already costs more than that. Blobs therefore go to
 * IndexedDB, which has room for hundreds of megabytes. Keeping them apart
 * is what makes drag-and-drop uploads possible at all.
 *
 * In Node there is no localStorage and no IndexedDB, so the defaults fall
 * back to in-memory adapters and the test suite can exercise the real store
 * logic rather than a mock of it.
 */
(function (root) {
  'use strict';

  var POSTS_KEY = 'jss_community_posts';
  var ENTITIES_KEY = 'jss_community_entities';
  var TRUST_KEY = 'jss_community_trust';
  /* Flags live on each post; older builds also wrote this key, always empty. */
  var LEGACY_FLAGS_KEY = 'jss_community_flags';

  var SIGNALS = ['scam', 'legit', 'reported', 'metoo'];

  /* ---------- storage adapters ---------- */

  function memoryMeta() {
    var map = {};
    return {
      name: 'memory',
      get: function (key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      set: function (key, value) { map[key] = value; },
      remove: function (key) { delete map[key]; }
    };
  }

  function localStorageMeta() {
    return {
      name: 'localStorage',
      get: function (key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
      },
      set: function (key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* quota or private mode */ }
      },
      remove: function (key) {
        try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
      }
    };
  }

  function memoryBlobs() {
    var map = {};
    return {
      name: 'memory',
      put: function (key, blob) { map[key] = blob; return Promise.resolve(key); },
      get: function (key) { return Promise.resolve(map[key] || null); },
      del: function (key) { delete map[key]; return Promise.resolve(); },
      clear: function () { map = {}; return Promise.resolve(); }
    };
  }

  function indexedDbBlobs() {
    var handle = null;

    function open() {
      if (handle) { return handle; }
      handle = new Promise(function (resolve, reject) {
        var req = indexedDB.open('jss_blobs', 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('blobs')) {
            db.createObjectStore('blobs');
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return handle;
    }

    return {
      name: 'indexedDB',
      put: function (key, blob) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').put(blob, key);
            t.oncomplete = function () { resolve(key); };
            t.onerror = function () { reject(t.error); };
          });
        });
      },
      get: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction('blobs', 'readonly');
            var req = t.objectStore('blobs').get(key);
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { reject(req.error); };
          });
        });
      },
      del: function (key) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').delete(key);
            t.oncomplete = function () { resolve(); };
            t.onerror = function () { reject(t.error); };
          });
        });
      },
      clear: function () {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction('blobs', 'readwrite');
            t.objectStore('blobs').clear();
            t.oncomplete = function () { resolve(); };
            t.onerror = function () { reject(t.error); };
          });
        });
      }
    };
  }

  function defaultAdapters() {
    var hasLocal = typeof localStorage !== 'undefined';
    var hasIdb = typeof indexedDB !== 'undefined';
    return {
      meta: hasLocal ? localStorageMeta() : memoryMeta(),
      blobs: hasIdb ? indexedDbBlobs() : memoryBlobs()
    };
  }

  function newTrust(userId) {
    return { userId: userId, postsMade: 0, confirmed: 0, disputed: 0 };
  }

  /* ---------- the store ---------- */

  function createStore(options) {
    var opts = options || {};
    var adapters = defaultAdapters();
    var meta = opts.meta || adapters.meta;
    var blobs = opts.blobs || adapters.blobs;
    var now = opts.now || function () { return Date.now(); };

    function read(key, fallback) {
      var raw = meta.get(key);
      if (!raw) { return fallback; }
      try {
        var parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (e) {
        return fallback;
      }
    }

    function write(key, value) {
      meta.set(key, JSON.stringify(value));
      return value;
    }

    function uid(prefix) {
      return prefix + now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    var store = {
      adapterNames: { meta: meta.name, blobs: blobs.name },
      signals: SIGNALS.slice(),

      /* ---- posts ---- */

      listPosts: function () {
        var posts = read(POSTS_KEY, []);
        return Array.isArray(posts) ? posts : [];
      },

      getPost: function (id) {
        var found = null;
        this.listPosts().forEach(function (post) {
          if (post.id === id) { found = post; }
        });
        return found;
      },

      addPost: function (draft) {
        var posts = this.listPosts();
        var stamp = new Date(now()).toISOString();
        var post = {
          id: draft.id || uid('p'),
          authorId: draft.authorId,
          authorName: draft.authorName,
          createdAt: stamp,
          lastActivityAt: stamp,
          message: draft.message || '',
          label: draft.label,
          scan: draft.scan || null,
          attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
          entityIds: Array.isArray(draft.entityIds) ? draft.entityIds : [],
          votes: { scam: 0, legit: 0, reported: 0, metoo: 0 },
          voterIds: { scam: [], legit: [], reported: [], metoo: [] },
          flaggedBy: [],
          removed: false
        };
        posts.push(post);
        write(POSTS_KEY, posts);
        return post;
      },

      /*
       * One signal per person per post. Switching signal moves the vote
       * rather than adding a second one, otherwise one user could confirm
       * and dispute the same post at once and credibility would stop
       * meaning anything.
       */
      castVote: function (postId, signal, userId) {
        if (SIGNALS.indexOf(signal) === -1) {
          return { ok: false, reason: 'Unknown signal.' };
        }
        var posts = this.listPosts();
        var post = null;
        posts.forEach(function (candidate) {
          if (candidate.id === postId) { post = candidate; }
        });
        if (!post) { return { ok: false, reason: 'That report no longer exists.' }; }
        if (post.authorId === userId) {
          return { ok: false, reason: 'You cannot vote on your own report.' };
        }

        post.votes = post.votes || {};
        post.voterIds = post.voterIds || {};
        SIGNALS.forEach(function (name) {
          post.voterIds[name] = (post.voterIds[name] || []).filter(function (id) {
            return id !== userId;
          });
        });

        post.voterIds[signal].push(userId);

        /*
         * Counts are re-derived from the voter lists rather than nudged up
         * and down. Keeping two copies of the same fact in step by hand is
         * how a tally drifts away from the people who actually voted.
         */
        SIGNALS.forEach(function (name) {
          post.votes[name] = post.voterIds[name].length;
        });

        var stamp = new Date(now()).toISOString();
        post.lastActivityAt = stamp;
        /* a confirmation is Waze's "still there?": it restarts the live window */
        if (signal === 'scam' || signal === 'metoo') {
          post.lastConfirmedAt = stamp;
        }

        write(POSTS_KEY, posts);
        return { ok: true, post: post, signal: signal };
      },

      voteBy: function (post, userId) {
        var voterIds = (post && post.voterIds) || {};
        for (var i = 0; i < SIGNALS.length; i++) {
          if ((voterIds[SIGNALS[i]] || []).indexOf(userId) !== -1) {
            return SIGNALS[i];
          }
        }
        return null;
      },

      flagPost: function (postId, userId) {
        var posts = this.listPosts();
        var post = null;
        posts.forEach(function (candidate) {
          if (candidate.id === postId) { post = candidate; }
        });
        if (!post) { return { ok: false, reason: 'That report no longer exists.' }; }
        post.flaggedBy = post.flaggedBy || [];
        if (post.flaggedBy.indexOf(userId) === -1) {
          post.flaggedBy.push(userId);
        }
        write(POSTS_KEY, posts);
        return { ok: true, post: post };
      },

      /* ---- entities ---- */

      listEntities: function () {
        var entities = read(ENTITIES_KEY, []);
        return Array.isArray(entities) ? entities : [];
      },

      /*
       * Merging on the normalised value is the Waze behaviour: five people
       * reporting the same number produce one record with five reports on
       * it, not five separate entries that all look equally weighty.
       */
      upsertEntity: function (candidate) {
        var entities = this.listEntities();
        var found = null;
        entities.forEach(function (entity) {
          if (entity.kind === candidate.kind && entity.value === candidate.value) {
            found = entity;
          }
        });
        if (found) {
          found.reportCount = (found.reportCount || 0) + 1;
          write(ENTITIES_KEY, entities);
          return found;
        }
        var entity = {
          id: uid('en'),
          kind: candidate.kind,
          value: candidate.value,
          displayName: candidate.displayName || candidate.value,
          firstSeen: new Date(now()).toISOString(),
          reportCount: 1,
          confirmCount: 0
        };
        entities.push(entity);
        write(ENTITIES_KEY, entities);
        return entity;
      },

      /*
       * Moves confirmCount on every listed row by `delta`, floored at zero.
       * Called when a report's standing changes, so the watchlist says how
       * many corroborated reports name a number rather than how many
       * mentions it has.
       */
      adjustEntityConfirms: function (ids, delta) {
        if (!delta || !ids || !ids.length) { return []; }
        var wanted = {};
        ids.forEach(function (id) { wanted[id] = true; });
        var entities = this.listEntities();
        var touched = [];
        entities.forEach(function (entity) {
          if (!wanted[entity.id]) { return; }
          entity.confirmCount = Math.max(0, (entity.confirmCount || 0) + delta);
          touched.push(entity);
        });
        if (touched.length) { write(ENTITIES_KEY, entities); }
        return touched;
      },

      /* ---- trust ---- */

      listTrust: function () {
        var trust = read(TRUST_KEY, []);
        return Array.isArray(trust) ? trust : [];
      },

      getTrust: function (userId) {
        var found = null;
        this.listTrust().forEach(function (record) {
          if (record.userId === userId) { found = record; }
        });
        return found || newTrust(userId);
      },

      bumpTrust: function (userId, patch) {
        var trust = this.listTrust();
        var record = null;
        trust.forEach(function (candidate) {
          if (candidate.userId === userId) { record = candidate; }
        });
        if (!record) {
          record = newTrust(userId);
          trust.push(record);
        }
        Object.keys(patch).forEach(function (key) {
          record[key] = (record[key] || 0) + patch[key];
        });
        write(TRUST_KEY, trust);
        return record;
      },

      /* ---- attachments ---- */

      putBlob: function (key, blob) {
        return blobs.put(key, blob);
      },

      getBlob: function (key) {
        return blobs.get(key);
      },

      objectUrlFor: function (blob) {
        if (!blob || typeof URL === 'undefined' || !URL.createObjectURL) {
          return null;
        }
        return URL.createObjectURL(blob);
      },

      /* ---- lifecycle ---- */

      /*
       * Earlier builds shipped invented reports, watchlist rows and trust
       * scores so the screens were not empty on a first visit. Deleting the
       * seed code stops new browsers seeing them, but anyone who already ran
       * an older build still has that fiction sitting in their own storage.
       * This sweeps it out once, by the marker those records carried, and
       * never touches anything a real person reported.
       */
      purgeFabricatedData: function () {
        var posts = this.listPosts();
        var entities = this.listEntities();
        var trust = this.listTrust();
        meta.remove(LEGACY_FLAGS_KEY);

        var isFake = function (record) {
          return !!record && record.sample === true;
        };

        var keptPosts = posts.filter(function (post) { return !isFake(post); });
        var fakeAuthors = {};
        posts.forEach(function (post) {
          if (isFake(post) && post.authorId) { fakeAuthors[post.authorId] = true; }
        });

        /*
         * A watchlist row is only meaningful if a real report points at it.
         * Older builds also left rows behind that no surviving report
         * references, so anything unreferenced is dropped as well rather
         * than trusting the marker alone.
         */
        var referenced = {};
        keptPosts.forEach(function (post) {
          (post.entityIds || []).forEach(function (id) { referenced[id] = true; });
        });
        var keptEntities = entities.filter(function (entity) {
          return !isFake(entity) && referenced[entity.id] === true;
        });
        var liveEntityIds = {};
        keptEntities.forEach(function (entity) { liveEntityIds[entity.id] = true; });

        /* Counts were built up by the invented reports, so recount honestly. */
        keptEntities.forEach(function (entity) { entity.reportCount = 0; });
        keptPosts.forEach(function (post) {
          post.entityIds = (post.entityIds || []).filter(function (id) { return liveEntityIds[id]; });
          post.entityIds.forEach(function (id) {
            keptEntities.forEach(function (entity) {
              if (entity.id === id) { entity.reportCount = (entity.reportCount || 0) + 1; }
            });
          });
        });

        var keptTrust = trust.filter(function (record) { return !fakeAuthors[record.userId]; });

        var removed = posts.length - keptPosts.length;
        var staleEntities = entities.length - keptEntities.length;
        var staleTrust = trust.length - keptTrust.length;
        if (!removed && !staleEntities && !staleTrust) {
          return { removed: 0, entities: 0, trust: 0, alreadyClean: true };
        }

        write(POSTS_KEY, keptPosts);
        write(ENTITIES_KEY, keptEntities);
        write(TRUST_KEY, keptTrust);
        return { removed: removed, entities: staleEntities, trust: staleTrust, alreadyClean: false };
      },

      /*
       * Removes one person's reports and nothing else. Deliberately not
       * reset(): a person asking to delete their own data must never take
       * everyone else's reports, watchlist or votes with them.
       *
       * Their attachments go too, and any watchlist row left with no report
       * pointing at it is dropped, because a row nothing references is not
       * evidence of anything.
       */
      deletePostsByAuthor: function (userId) {
        var posts = this.listPosts();
        var mine = posts.filter(function (post) { return post.authorId === userId; });
        if (!mine.length) {
          return Promise.resolve({ removed: 0, attachments: 0, alreadyClean: true });
        }

        var droppedIds = {};
        mine.forEach(function (post) { droppedIds[post.id] = true; });

        var keptPosts = posts.filter(function (post) { return !droppedIds[post.id]; });
        var referenced = {};
        keptPosts.forEach(function (post) {
          (post.entityIds || []).forEach(function (id) { referenced[id] = true; });
        });
        var keptEntities = this.listEntities().filter(function (entity) {
          return referenced[entity.id] === true;
        });
        var liveIds = {};
        keptEntities.forEach(function (entity) { liveIds[entity.id] = true; });
        keptEntities.forEach(function (entity) { entity.reportCount = 0; });
        keptPosts.forEach(function (post) {
          post.entityIds = (post.entityIds || []).filter(function (id) { return liveIds[id]; });
          post.entityIds.forEach(function (id) {
            keptEntities.forEach(function (entity) {
              if (entity.id === id) { entity.reportCount = (entity.reportCount || 0) + 1; }
            });
          });
        });

        var keptTrust = this.listTrust().filter(function (record) { return record.userId !== userId; });

        write(POSTS_KEY, keptPosts);
        write(ENTITIES_KEY, keptEntities);
        write(TRUST_KEY, keptTrust);

        /*
         * Older builds kept flags in their own list. Drop only this person's
         * entries, so removing your account cannot take someone else's flag
         * with it, and drop the key outright once nothing is left in it.
         */
        var legacy = meta.get(LEGACY_FLAGS_KEY);
        if (legacy) {
          try {
            var parsed = JSON.parse(legacy);
            if (Array.isArray(parsed)) {
              var keptLegacy = parsed.filter(function (row) {
                return !row || row.userId !== userId;
              });
              if (keptLegacy.length) { meta.set(LEGACY_FLAGS_KEY, JSON.stringify(keptLegacy)); }
              else { meta.remove(LEGACY_FLAGS_KEY); }
            }
          } catch (error) {
            meta.remove(LEGACY_FLAGS_KEY);
          }
        }

        var blobKeys = [];
        mine.forEach(function (post) {
          (post.attachments || []).forEach(function (att) {
            if (att.blobKey) { blobKeys.push(att.blobKey); }
          });
        });

        return blobKeys.reduce(function (chain, key) {
          return chain.then(function () { return blobs.del(key); });
        }, Promise.resolve()).then(function () {
          return { removed: mine.length, attachments: blobKeys.length, alreadyClean: false };
        });
      },

      reset: function () {
        meta.remove(POSTS_KEY);
        meta.remove(ENTITIES_KEY);
        meta.remove(TRUST_KEY);
        meta.remove(LEGACY_FLAGS_KEY);
        return blobs.clear();
      }
    };

    return store;
  }

  var api = {
    createStore: createStore,
    adapters: { memoryMeta: memoryMeta, localStorageMeta: localStorageMeta, memoryBlobs: memoryBlobs, indexedDbBlobs: indexedDbBlobs },
    SIGNALS: SIGNALS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShieldStore = api;
  }
})(typeof window !== 'undefined'
  ? window
  : (typeof global !== 'undefined' ? global : null));
