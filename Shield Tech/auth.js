(function () {
  'use strict';

  /*
   * Accounts, sessions and password storage live in account.js so the settings
   * screen edits the same records through the same code. This file is only the
   * sign-in and registration form behaviour.
   */
  var Account = window.ShieldAccount;
  if (!Account) {
    document.body.innerHTML = '<p class="empty">Part of the app failed to load. Reload the page.</p>';
    return;
  }

  var DASHBOARD = 'app.html';
  var EMAIL_RE = Account.EMAIL_RE;
  var MIN_NAME = Account.MIN_NAME;
  var MIN_PASSWORD = 8;
  var FLIP_MS = 700;
  var REDIRECT_MS = 900;

  var PASSWORD_RULES = Account.PASSWORD_RULES;

  function listSentence(items) {
    if (items.length < 2) {
      return items.join('');
    }
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function unmetPasswordRules(value) {
    return Account.unmetPasswordRules(value);
  }

  function updatePasswordChips(form, name) {
    var list = document.getElementById('reg-password-rules');
    if (!list) {
      return;
    }
    var value = fieldValue(form, name);
    var met = {};
    PASSWORD_RULES.forEach(function (rule) {
      met[rule.key] = rule.test(value);
    });
    Array.prototype.forEach.call(list.children, function (item) {
      item.classList.toggle('is-met', Boolean(met[item.getAttribute('data-rule')]));
    });
  }

  var LIVE_UI = {
    password: [updatePasswordChips]
  };

  var RULES = {
    'login-form': {
      email: function (value) {
        return EMAIL_RE.test(value.trim()) ? '' : 'Enter a valid email address.';
      },
      password: function (value) {
        return value.length ? '' : 'Enter your password.';
      }
    },
    'register-form': {
      firstName: function (value) {
        return value.trim().length >= MIN_NAME ? '' : 'Enter your first name.';
      },
      lastName: function (value) {
        return value.trim().length >= MIN_NAME ? '' : 'Enter your last name.';
      },
      email: function (value) {
        return EMAIL_RE.test(value.trim()) ? '' : 'Enter a valid email address.';
      },
      province: function (value) {
        return value.trim() ? '' : 'Choose your province.';
      },
      password: function (value) {
        if (!value.length) {
          return 'Enter a password.';
        }
        var missing = unmetPasswordRules(value).map(function (rule) {
          return rule.label;
        });
        return missing.length ? 'Password needs ' + listSentence(missing) + '.' : '';
      },
      confirmPassword: function (value, form) {
        var password = field(form, 'password').value;
        if (!password) {
          return '';
        }
        if (!value.length) {
          return 'Repeat your password.';
        }
        return value === password ? '' : 'Passwords do not match.';
      }
    }
  };

  var DEPENDS_ON = {
    password: ['confirmPassword']
  };

  var flipper = document.getElementById('flipper');
  var loginFace = document.getElementById('login-face');
  var registerFace = document.getElementById('register-face');
  var statusRegion = document.getElementById('form-status');

  var loginForm = document.getElementById('login-form');
  var loginButton = document.getElementById('login-submit');
  var registerForm = document.getElementById('register-form');
  var registerButton = document.getElementById('register-submit');

  var showingRegister = false;
  var pulseTimer = null;
  var clipTimer = null;

  function readSession() {
    return Account.readSession();
  }

  function writeSession(user) {
    Account.writeSession(user);
  }

  function announce(message) {
    statusRegion.textContent = message;
  }

  function field(form, name) {
    return form.elements[name];
  }

  function fieldValue(form, name) {
    return field(form, name).value;
  }

  function setFieldError(form, name, message) {
    var control = field(form, name);
    var slot = control ? document.getElementById(control.id + '-error') : null;
    if (control) {
      control.classList.toggle('is-invalid', Boolean(message));
      if (message) {
        control.setAttribute('aria-invalid', 'true');
      } else {
        control.removeAttribute('aria-invalid');
      }
    }
    if (slot) {
      slot.textContent = message || '';
    }
  }

  function setBanner(form, message) {
    var banner = form.querySelector('.banner');
    if (!banner) {
      return;
    }
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function clearFormErrors(form) {
    var names = Object.keys(RULES[form.id] || {});
    names.forEach(function (name) {
      setFieldError(form, name, '');
    });
    setBanner(form, '');
  }

  function runRule(form, name) {
    var message = RULES[form.id][name](fieldValue(form, name), form);
    setFieldError(form, name, message);
    return message;
  }

  function validateForm(form) {
    form.dataset.submitted = 'true';
    var firstInvalid = null;
    Object.keys(RULES[form.id]).forEach(function (name) {
      if (runRule(form, name) && !firstInvalid) {
        firstInvalid = field(form, name);
      }
    });
    return firstInvalid;
  }

  function isLive(form) {
    return form.dataset.submitted === 'true';
  }

  function wireLiveValidation(form) {
    var rules = RULES[form.id] || {};

    form.addEventListener('input', function () {
      if (!form.querySelector('.banner').hidden) {
        setBanner(form, '');
      }
    });

    Object.keys(rules).forEach(function (name) {
      var control = field(form, name);

      control.addEventListener('blur', function () {
        setFieldError(form, name, '');
      });

      control.addEventListener('input', function () {
        (LIVE_UI[name] || []).forEach(function (update) {
          update(form, name);
        });
        if (!isLive(form)) {
          return;
        }
        runRule(form, name);
        (DEPENDS_ON[name] || []).forEach(function (dependent) {
          runRule(form, dependent);
        });
      });
    });
  }

  function setBusy(form, button, label) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
  }

  function clearBusy(form, button) {
    button.textContent = button.dataset.idleLabel || button.textContent;
    button.disabled = false;
    form.removeAttribute('aria-busy');
  }

  function firstEmptyControl(face) {
    var controls = Array.prototype.slice.call(face.querySelectorAll('input, select, textarea'));
    var editable = controls.filter(function (control) {
      return control.type !== 'checkbox' && control.type !== 'radio';
    });
    var pool = editable.length ? editable : controls;
    return pool.find(function (control) {
      return !control.value;
    }) || pool[0];
  }

  function measureCards(options) {
    var loginCard = document.querySelector('.face--login .card');
    var registerCard = document.querySelector('.face--register .card');
    if (!loginCard || !registerCard) {
      return;
    }
    /* Clear idle clips so both cards report their natural height. */
    loginFace.classList.remove('is-clipped');
    registerFace.classList.remove('is-clipped');
    flipper.style.setProperty('--card-login', loginCard.offsetHeight + 'px');
    flipper.style.setProperty('--card-register', registerCard.offsetHeight + 'px');
    if (!options || !options.keepOpen) {
      clipIdleFace();
    }
  }

  function clipIdleFace() {
    loginFace.classList.toggle('is-clipped', showingRegister);
    registerFace.classList.toggle('is-clipped', !showingRegister);
  }

  function pulse() {
    flipper.classList.remove('pulsing');
    void flipper.offsetWidth;
    flipper.classList.add('pulsing');
    window.clearTimeout(pulseTimer);
    pulseTimer = window.setTimeout(function () {
      flipper.classList.remove('pulsing');
    }, FLIP_MS);
  }

  function setShowingRegister(next, focusTarget) {
    window.clearTimeout(clipTimer);
    /* Unclip both faces for the 3D flip, then re-clip the idle one after. */
    loginFace.classList.remove('is-clipped');
    registerFace.classList.remove('is-clipped');

    showingRegister = next;
    flipper.classList.toggle('flipped', showingRegister);
    measureCards({ keepOpen: true });

    var activeFace = showingRegister ? registerFace : loginFace;
    var idleFace = showingRegister ? loginFace : registerFace;

    idleFace.setAttribute('inert', '');
    idleFace.setAttribute('aria-hidden', 'true');
    activeFace.removeAttribute('inert');
    activeFace.removeAttribute('aria-hidden');

    document.title = showingRegister
      ? 'Job Scam Shield · Create an account'
      : 'Job Scam Shield · Sign in';

    pulse();
    announce(
      showingRegister
        ? 'Register form is now showing. Create your account.'
        : 'Login form is now showing. Sign in to check a message.'
    );

    var target = focusTarget || firstEmptyControl(activeFace);
    if (target) {
      target.focus();
    }

    clipTimer = window.setTimeout(clipIdleFace, FLIP_MS);
  }

  function wirePasswordToggles() {
    var toggles = document.querySelectorAll('[data-pw-toggle]');
    Array.prototype.forEach.call(toggles, function (button) {
      button.addEventListener('click', function () {
        var control = document.getElementById(button.getAttribute('data-pw-toggle'));
        if (!control) {
          return;
        }
        var revealed = control.type === 'text';
        control.type = revealed ? 'password' : 'text';
        button.setAttribute('aria-pressed', String(!revealed));
        button.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
      });
    });
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest ? event.target.closest('[data-flip]') : null;
    if (!trigger) {
      return;
    }
    event.preventDefault();
    var wantsRegister = trigger.getAttribute('data-flip') === 'register';
    if (wantsRegister === showingRegister) {
      return;
    }
    setShowingRegister(wantsRegister, wantsRegister ? field(registerForm, 'firstName') : field(loginForm, 'email'));
  });

  registerForm.addEventListener('submit', function (event) {
    event.preventDefault();
    clearFormErrors(registerForm);

    var firstName = fieldValue(registerForm, 'firstName').trim().replace(/\s+/g, ' ');
    var lastName = fieldValue(registerForm, 'lastName').trim().replace(/\s+/g, ' ');
    var email = fieldValue(registerForm, 'email').trim().toLowerCase();
    var province = fieldValue(registerForm, 'province').trim();
    var password = fieldValue(registerForm, 'password');
    var confirm = fieldValue(registerForm, 'confirmPassword');

    var firstInvalid = validateForm(registerForm);
    if (firstInvalid) {
      announce('Check the highlighted fields and try again.');
      firstInvalid.focus();
      return;
    }

    if (Account.findByEmail(email)) {
      setBanner(registerForm, 'That email is already registered.');
      announce('That email is already registered.');
      field(registerForm, 'email').focus();
      return;
    }

    setBusy(registerForm, registerButton, 'Creating account...');

    Account.createUser({
      fullName: firstName + ' ' + lastName,
      email: email,
      province: province,
      password: password
    })
      .then(function (user) {
        writeSession(user);

        registerButton.dataset.idleLabel = 'Account created';
        registerButton.textContent = 'Account created';
        registerButton.classList.add('is-done');
        announce('Account created. Taking you to your dashboard.');

        window.setTimeout(function () {
          window.location.replace(DASHBOARD);
        }, REDIRECT_MS);
      })
      .catch(function () {
        clearBusy(registerForm, registerButton);
        setBanner(registerForm, 'Something went wrong. Please try again.');
        announce('Something went wrong. Please try again.');
      });
  });

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    clearFormErrors(loginForm);

    var email = fieldValue(loginForm, 'email').trim().toLowerCase();
    var password = fieldValue(loginForm, 'password');

    var firstInvalid = validateForm(loginForm);
    if (firstInvalid) {
      announce('Check the highlighted fields and try again.');
      firstInvalid.focus();
      return;
    }

    var genericError = 'Incorrect email or password.';
    var user = Account.findByEmail(email);

    function reject() {
      clearBusy(loginForm, loginButton);
      setBanner(loginForm, genericError);
      announce(genericError);
      field(loginForm, 'password').value = '';
      field(loginForm, 'password').focus();
    }

    if (!user || typeof user.passwordHash !== 'string') {
      reject();
      return;
    }

    setBusy(loginForm, loginButton, 'Signing in...');

    Account.verifyPassword(user, password)
      .then(function () {
        writeSession(user);
        loginButton.dataset.idleLabel = 'Welcome back';
        loginButton.textContent = 'Welcome back';
        announce('Signed in. Taking you to your dashboard.');
        window.setTimeout(function () {
          window.location.replace(DASHBOARD);
        }, REDIRECT_MS);
      })
      .catch(reject);
  });

  wireLiveValidation(loginForm);
  wireLiveValidation(registerForm);
  wirePasswordToggles();

  measureCards();
  window.addEventListener('resize', measureCards);
  window.addEventListener('load', measureCards);

  if (readSession()) {
    window.location.replace(DASHBOARD);
  }
})();
