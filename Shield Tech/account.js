/*
 * Accounts, sessions and password storage.
 *
 * This is the only place that knows how a password is turned into what we
 * store, and the only place that writes the account list. Both the sign-in
 * page and the settings screen go through it, so a change to how credentials
 * are handled cannot drift between the two.
 *
 * Everything here lives in this browser's own storage. That is a deliberate
 * limitation of the prototype, not a security design: anyone with access to
 * the device can read or edit these records. Real deployments need a server
 * that holds the credentials and never sends the hash to the browser.
 */
(function (root) {
  'use strict';

  var USERS_KEY = 'jss_users';
  var SESSION_KEY = 'jss_session';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var MIN_NAME = 2;

  /*
   * A closed list, because province is only a label for reports. Free text
   * would let typos and invented places become "locations" nobody can filter.
   * The settings dropdown offers exactly these; the account test asserts the
   * two stay in step.
   */
  var PROVINCES = [
    'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
    'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'
  ];

  var PASSWORD_RULES = [
    { key: 'length', label: '8+ characters', test: function (v) { return v.length >= 8; } },
    { key: 'upper', label: '1 uppercase', test: function (v) { return /[A-Z]/.test(v); } },
    { key: 'number', label: '1 number', test: function (v) { return /[0-9]/.test(v); } },
    { key: 'symbol', label: '1 symbol', test: function (v) { return /[^A-Za-z0-9]/.test(v); } }
  ];

  /* Private browsing can refuse writes, so a failed save is not lost outright. */
  var memoryFallback = new Map();

  var store = {
    get: function (key) {
      try {
        var raw = root.localStorage.getItem(key);
        return raw === null && memoryFallback.has(key) ? memoryFallback.get(key) : raw;
      } catch (error) {
        return memoryFallback.has(key) ? memoryFallback.get(key) : null;
      }
    },
    set: function (key, value) {
      try {
        root.localStorage.setItem(key, value);
      } catch (error) {
        memoryFallback.set(key, value);
      }
    },
    remove: function (key) {
      try {
        root.localStorage.removeItem(key);
      } catch (error) { /* ignore */ }
      memoryFallback.delete(key);
    }
  };

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function randomSalt() {
    if (root.crypto && root.crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return toHex(bytes);
    }
    return 'salt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  /*
   * A real digest when the browser offers one, and an obviously marked
   * fallback when it does not. The 'weak:' prefix is deliberate: if this ever
   * shows up in a stored record we want it to be recognisable rather than
   * quietly pass for a real hash.
   */
  function weakDigest(text) {
    var a = 0x811c9dc5;
    var b = 0x9e3779b9;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b + code + i, 0x85ebca6b) >>> 0;
    }
    return 'weak:' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  function hashPassword(password, salt) {
    var salted = salt + '|' + password;
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      return subtle.digest('SHA-256', new TextEncoder().encode(salted))
        .then(function (buffer) { return 'sha256$' + toHex(new Uint8Array(buffer)); })
        .catch(function () { return weakDigest(salted); });
    }
    return Promise.resolve(weakDigest(salted));
  }

  function createId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    return 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function listUsers() {
    try {
      var parsed = JSON.parse(store.get(USERS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeUsers(users) {
    store.set(USERS_KEY, JSON.stringify(users));
  }

  function findById(id) {
    var found = null;
    listUsers().forEach(function (user) {
      if (user.id === id) { found = user; }
    });
    return found;
  }

  function findByEmail(email) {
    var wanted = String(email || '').trim().toLowerCase();
    var found = null;
    listUsers().forEach(function (user) {
      if (String(user.email || '').toLowerCase() === wanted) { found = user; }
    });
    return found;
  }

  /* What the rest of the app is allowed to see about a person. */
  function publicUser(user) {
    if (!user) { return null; }
    return {
      id: user.id,
      fullName: user.fullName || '',
      firstName: String(user.fullName || '').split(' ')[0] || '',
      lastName: String(user.fullName || '').split(' ').slice(1).join(' '),
      email: user.email || '',
      phone: user.phone || '',
      province: user.province || '',
      createdAt: user.createdAt || ''
    };
  }

  function readSession() {
    try {
      var parsed = JSON.parse(store.get(SESSION_KEY) || 'null');
      return parsed && parsed.email ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function writeSession(user) {
    store.set(SESSION_KEY, JSON.stringify({
      id: user.id, fullName: user.fullName, email: user.email
    }));
  }

  function clearSession() {
    store.remove(SESSION_KEY);
  }

  function createUser(details) {
    var salt = randomSalt();
    return hashPassword(details.password, salt).then(function (digest) {
      var user = {
        id: createId(),
        fullName: details.fullName,
        email: details.email,
        phone: details.phone || '',
        province: details.province || '',
        passwordHash: salt + '$' + digest,
        createdAt: new Date().toISOString()
      };
      var users = listUsers();
      users.push(user);
      writeUsers(users);
      return user;
    });
  }

  function verifyPassword(user, password) {
    if (!user || typeof user.passwordHash !== 'string') {
      return Promise.reject(new Error('No account to check.'));
    }
    var parts = user.passwordHash.split('$');
    var salt = parts[0];
    var expected = parts.slice(1).join('$');
    return hashPassword(password, salt).then(function (digest) {
      if (digest !== expected) { throw new Error('That password is not right.'); }
      return publicUser(user);
    });
  }

  function splitName(fullName) {
    var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') };
  }

  /*
   * Edits the signed-in person's own details. Refuses an email that belongs to
   * somebody else, because two accounts sharing an address would quietly
   * break the "that email is already registered" rule on the sign-in page.
   */
  function updateProfile(userId, patch) {
    /*
     * Read the list once and keep the reference to the record inside it. Mutating a
     * record from one read and then saving a *second* read would silently drop the
     * change, because each read parses a fresh copy out of storage.
     */
    var users = listUsers();
    var user = null;
    users.forEach(function (candidate) {
      if (candidate.id === userId) { user = candidate; }
    });
    if (!user) { return Promise.resolve({ ok: false, reason: 'That account no longer exists.' }); }

    var name = String(patch.fullName === undefined ? user.fullName : patch.fullName).trim();
    if (name.split(/\s+/).filter(Boolean).length < 2 || name.length < MIN_NAME * 2) {
      return Promise.resolve({ ok: false, field: 'fullName', reason: 'Enter your first and last name.' });
    }

    var email = String(patch.email === undefined ? user.email : patch.email).trim();
    if (!EMAIL_RE.test(email)) {
      return Promise.resolve({ ok: false, field: 'email', reason: 'Enter a valid email address.' });
    }
    var clash = findByEmail(email);
    if (clash && clash.id !== userId) {
      return Promise.resolve({ ok: false, field: 'email', reason: 'That email is already registered.' });
    }

    var phone = String(patch.phone === undefined ? (user.phone || '') : patch.phone).trim();
    if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) {
      return Promise.resolve({ ok: false, field: 'phone', reason: 'Enter a phone number using digits, spaces, + or - only.' });
    }

    /*
     * A province the user is editing has to be a real one. A value already in
     * the record is treated differently: an older or hand-edited value must
     * not block an unrelated edit, it just falls back to "not set" because the
     * dropdown has nothing to show for it.
     */
    var storedProvince = String(user.province || '').trim();
    var province;
    if (patch.province === undefined) {
      province = PROVINCES.indexOf(storedProvince) > -1 ? storedProvince : '';
    } else {
      province = String(patch.province).trim();
      if (province && PROVINCES.indexOf(province) === -1) {
        return Promise.resolve({ ok: false, field: 'province', reason: 'Choose a province from the list.' });
      }
    }

    user.fullName = name;
    user.email = email;
    user.phone = phone;
    user.province = province;
    writeUsers(users);

    /* The session carries a copy of the name and email, so it has to follow. */
    var session = readSession();
    if (session && session.id === userId) { writeSession(user); }

    return Promise.resolve({ ok: true, user: publicUser(user) });
  }

  function unmetPasswordRules(value) {
    return PASSWORD_RULES.filter(function (rule) { return !rule.test(value); });
  }

  /*
   * A password change always needs the current one, so a borrowed unlocked
   * device cannot be used to lock the real owner out of their own account.
   */
  function changePassword(userId, currentPassword, newPassword) {
    var users = listUsers();
    var user = null;
    users.forEach(function (candidate) {
      if (candidate.id === userId) { user = candidate; }
    });
    if (!user) { return Promise.resolve({ ok: false, reason: 'That account no longer exists.' }); }

    var unmet = unmetPasswordRules(newPassword);
    if (unmet.length) {
      return Promise.resolve({
        ok: false,
        field: 'newPassword',
        reason: 'Your new password needs ' + unmet.map(function (r) { return r.label; }).join(', ') + '.'
      });
    }
    if (newPassword === currentPassword) {
      return Promise.resolve({ ok: false, field: 'newPassword', reason: 'Choose a password you have not used here before.' });
    }

    return verifyPassword(user, currentPassword).then(function () {
      var salt = randomSalt();
      return hashPassword(newPassword, salt).then(function (digest) {
        user.passwordHash = salt + '$' + digest;
        writeUsers(users);
        return { ok: true };
      });
    }).catch(function (error) {
      return { ok: false, field: 'currentPassword', reason: error.message || 'That password is not right.' };
    });
  }

  /* Removes the account record and ends the session. Reports are handled separately. */
  function removeAccount(userId) {
    var users = listUsers().filter(function (user) { return user.id !== userId; });
    writeUsers(users);
    var session = readSession();
    if (session && session.id === userId) { clearSession(); }
    return { ok: true };
  }

  var api = {
    KEYS: { users: USERS_KEY, session: SESSION_KEY },
    EMAIL_RE: EMAIL_RE,
    MIN_NAME: MIN_NAME,
    PASSWORD_RULES: PASSWORD_RULES,
    PROVINCES: PROVINCES,
    listUsers: listUsers,
    writeUsers: writeUsers,
    findById: findById,
    findByEmail: findByEmail,
    publicUser: publicUser,
    readSession: readSession,
    writeSession: writeSession,
    clearSession: clearSession,
    createUser: createUser,
    verifyPassword: verifyPassword,
    updateProfile: updateProfile,
    changePassword: changePassword,
    removeAccount: removeAccount,
    splitName: splitName,
    unmetPasswordRules: unmetPasswordRules,
    hashPassword: hashPassword,
    createId: createId
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShieldAccount = api;
  }
})(typeof window !== 'undefined'
  ? window
  : (typeof global !== 'undefined' ? global : null));
