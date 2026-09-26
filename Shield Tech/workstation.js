/*
 * Work Station — sidebar module UI for Job Scam Shield.
 * Uses only ShieldWorkstationApi. Persists resume id in localStorage.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'workstation:resumeId';
  var SCORE_KEY = 'workstation:score';
  var FILE_KEY = 'workstation:fileName';

  var api = root.ShieldWorkstationApi;
  var rootEl = null;
  var activeTab = 'resume';
  var resumeId = null;
  var score = null;
  var fileName = null;
  var doneMap = {};
  var toastTimer = null;
  var lastFile = null;

  var TABS = [
    { id: 'resume', label: 'My Resume' },
    { id: 'improvements', label: 'Improvements' },
    { id: 'templates', label: 'Templates' },
    { id: 'matches', label: 'Job Matches' }
  ];

  var CAT_LABELS = {
    formatting: 'Formatting',
    keywords: 'Keywords',
    impact: 'Impact',
    contact: 'Contact',
    other: 'Other'
  };

  function qs(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadSession() {
    try {
      resumeId = localStorage.getItem(STORAGE_KEY) || null;
      var raw = localStorage.getItem(SCORE_KEY);
      score = raw != null ? Number(raw) : null;
      fileName = localStorage.getItem(FILE_KEY) || null;
    } catch (e) {
      resumeId = null;
      score = null;
      fileName = null;
    }
  }

  function saveSession(id, sc, name) {
    resumeId = id || null;
    score = id != null && sc != null ? sc : null;
    fileName = id ? (name || fileName) : null;
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id);
        if (sc != null) { localStorage.setItem(SCORE_KEY, String(sc)); }
        if (name) { localStorage.setItem(FILE_KEY, name); }
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SCORE_KEY);
        localStorage.removeItem(FILE_KEY);
      }
    } catch (e) { /* ignore */ }
  }

  function showToast(message, type) {
    var host = qs('#ws-toast', rootEl);
    if (!host) { return; }
    host.hidden = false;
    host.className = 'ws-toast ws-toast--' + (type || 'info');
    host.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.hidden = true; }, 4200);
  }

  function scoreStroke(value) {
    if (value < 50) { return 'var(--ws-score-low)'; }
    if (value < 75) { return 'var(--ws-score-mid)'; }
    return 'var(--ws-score-high)';
  }

  function ringSvg(value) {
    var r = 52;
    var c = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(100, Number(value) || 0));
    var offset = c - (pct / 100) * c;
    return (
      '<svg class="ws-ring" viewBox="0 0 120 120" aria-hidden="true">' +
        '<circle class="ws-ring__track" cx="60" cy="60" r="' + r + '"></circle>' +
        '<circle class="ws-ring__fill" cx="60" cy="60" r="' + r + '"' +
          ' stroke="' + scoreStroke(pct) + '"' +
          ' stroke-dasharray="' + c.toFixed(1) + '"' +
          ' stroke-dashoffset="' + offset.toFixed(1) + '"></circle>' +
      '</svg>'
    );
  }

  function skeleton(n) {
    var html = '<div class="ws-skel" aria-hidden="true">';
    for (var i = 0; i < n; i++) { html += '<div class="ws-skel__row"></div>'; }
    return html + '</div>';
  }

  function emptyState(title, body, ctaLabel, ctaAction) {
    return (
      '<div class="ws-empty">' +
        '<p class="ws-empty__title">' + escapeHtml(title) + '</p>' +
        '<p class="ws-empty__body">' + escapeHtml(body) + '</p>' +
        (ctaLabel
          ? '<button class="btn btn--small" type="button" data-ws-action="' +
            escapeHtml(ctaAction || '') + '">' + escapeHtml(ctaLabel) + '</button>'
          : '') +
      '</div>'
    );
  }

  function renderShell() {
    if (!rootEl) { return; }
    var locked = !resumeId;
    var tabsHtml = TABS.map(function (tab) {
      var disabled = tab.id !== 'resume' && locked;
      return (
        '<button class="ws-tab' +
          (activeTab === tab.id ? ' is-active' : '') +
          (disabled ? ' is-disabled' : '') + '"' +
          ' type="button" role="tab" data-ws-tab="' + tab.id + '"' +
          ' aria-selected="' + (activeTab === tab.id) + '"' +
          ' aria-controls="ws-panel"' +
          (disabled ? ' aria-disabled="true"' : '') + '>' +
          escapeHtml(tab.label) +
        '</button>'
      );
    }).join('');

    rootEl.innerHTML =
      '<header class="page-header ws-head">' +
        '<p class="page-header__eyebrow">Career</p>' +
        '<h1 class="title" id="workstation-heading" tabindex="-1">Work Station</h1>' +
        '<p class="subtitle">Score your CV, improve it, and match partner roles.</p>' +
      '</header>' +
      '<div class="ws-tabs" role="tablist" aria-label="Work Station sections">' + tabsHtml + '</div>' +
      '<div class="ws-panel" id="ws-panel" role="tabpanel"></div>' +
      '<p class="ws-toast" id="ws-toast" role="status" aria-live="polite" hidden></p>' +
      '<dialog class="ws-dialog" id="ws-dialog" aria-labelledby="ws-dialog-title"></dialog>';

    Array.prototype.forEach.call(rootEl.querySelectorAll('[data-ws-tab]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ws-tab');
        if (id !== 'resume' && !resumeId) {
          showToast('Upload a resume first to unlock this tab.', 'warn');
          return;
        }
        activeTab = id;
        renderShell();
      });
    });

    renderPanel();
  }

  function renderPanel() {
    var panel = qs('#ws-panel', rootEl);
    if (!panel) { return; }
    if (activeTab === 'resume') { renderResumeTab(panel); }
    else if (activeTab === 'improvements') { renderSuggestionsTab(panel); }
    else if (activeTab === 'templates') { renderTemplatesTab(panel); }
    else if (activeTab === 'matches') { renderMatchesTab(panel); }
  }

  function wireEmptyActions(panel) {
    Array.prototype.forEach.call(panel.querySelectorAll('[data-ws-action]'), function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-ws-action');
        if (action === 'resume' || action === 'improvements') {
          activeTab = action;
          renderShell();
        } else if (action === 'retry-suggestions') {
          renderSuggestionsTab(panel);
        } else if (action === 'retry-templates') {
          renderTemplatesTab(panel);
        } else if (action === 'retry-matches') {
          renderMatchesTab(panel);
        }
      });
    });
  }

  function clearResume() {
    if (!window.confirm('Remove this resume from Work Station? Your score and unlocked tabs will clear on this device.')) {
      return;
    }
    lastFile = null;
    doneMap = {};
    activeTab = 'resume';
    saveSession(null, null, null);
    showToast('Resume removed.', 'ok');
    renderShell();
  }

  /* ---------- My Resume ---------- */

  function renderResumeTab(panel) {
    var hasResume = !!(resumeId && score != null);
    panel.innerHTML =
      '<section class="card ws-upload-card" aria-labelledby="ws-upload-title">' +
        '<h2 class="title title--small" id="ws-upload-title">' +
          (hasResume ? 'Your resume' : 'Upload your resume') + '</h2>' +
        '<p class="card__hint">' +
          (hasResume
            ? 'Replace it by uploading another file, or remove it below.'
            : 'PDF, DOCX or TXT. Scoring uses the mock API until the backend is live.') +
        '</p>' +
        (hasResume
          ? '<div class="ws-current" role="status">' +
              '<div class="ws-current__meta">' +
                '<span class="ws-current__icon" aria-hidden="true">' +
                  '<svg viewBox="0 0 24 24" focusable="false">' +
                    '<path d="M7 3.5h7.5L19 8v12.5H7z"/>' +
                    '<path d="M14.5 3.5V8H19"/>' +
                  '</svg>' +
                '</span>' +
                '<div>' +
                  '<p class="ws-current__name">' + escapeHtml(fileName || 'Uploaded resume') + '</p>' +
                  '<p class="ws-current__note">Saved on this device · score ' +
                    Math.round(score) + '%</p>' +
                '</div>' +
              '</div>' +
              '<button class="btn-ghost btn--small ws-current__remove" type="button" data-ws-remove>' +
                'Remove</button>' +
            '</div>'
          : '') +
        '<div class="ws-drop" id="ws-drop" tabindex="0" role="button"' +
          ' aria-label="Upload resume. Drop a file or press Enter to choose.">' +
          '<input class="ws-drop__input" id="ws-file" type="file"' +
            ' accept=".pdf,.docx,.txt,application/pdf,text/plain"' +
            ' aria-label="Choose resume file">' +
          '<svg class="ws-drop__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
            '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/>' +
            '<path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"/>' +
          '</svg>' +
          '<p class="ws-drop__label">' +
            (hasResume ? 'Drop a new file to replace it' : 'Drop your resume here') + '</p>' +
          '<p class="ws-drop__meta">or <span class="ws-drop__link">choose a file</span></p>' +
        '</div>' +
        '<div class="ws-progress" id="ws-progress" hidden>' +
          '<div class="ws-progress__bar" id="ws-progress-bar"></div>' +
        '</div>' +
        '<p class="ws-upload-status" id="ws-upload-status" role="status" aria-live="polite"></p>' +
      '</section>' +
      '<div id="ws-score-host"></div>';

    wireUpload(panel);
    if (hasResume) {
      renderScoreCard(qs('#ws-score-host', panel), score, fileName);
    }
  }

  function wireUpload(panel) {
    var drop = qs('#ws-drop', panel);
    var input = qs('#ws-file', panel);

    function acceptFile(file) {
      if (!file) { return; }
      var name = String(file.name || '').toLowerCase();
      if (!/\.(pdf|docx|txt)$/.test(name)) {
        showToast('Only PDF, DOCX or TXT files are accepted.', 'error');
        return;
      }
      lastFile = file;
      runUpload(file);
    }

    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) { acceptFile(input.files[0]); }
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove('is-drag');
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files[0]) {
          acceptFile(e.dataTransfer.files[0]);
        }
      });
    });

    panel.addEventListener('click', function (e) {
      if (e.target.closest('[data-ws-remove]')) {
        clearResume();
        return;
      }
      var btn = e.target.closest('[data-ws-retry]');
      if (btn && lastFile) { runUpload(lastFile); }
    });
  }

  function runUpload(file) {
    if (!api) {
      showToast('Work Station API is not loaded.', 'error');
      return;
    }
    var progress = qs('#ws-progress', rootEl);
    var bar = qs('#ws-progress-bar', rootEl);
    var status = qs('#ws-upload-status', rootEl);
    if (progress) { progress.hidden = false; }
    if (bar) { bar.style.width = '12%'; }
    if (status) { status.textContent = 'Scoring your resume…'; }

    var tick = 12;
    var timer = setInterval(function () {
      tick = Math.min(90, tick + 8);
      if (bar) { bar.style.width = tick + '%'; }
    }, 120);

    api.uploadResume(file).then(function (res) {
      clearInterval(timer);
      if (bar) { bar.style.width = '100%'; }
      saveSession(res.resumeId, res.score, res.fileName);
      showToast('Resume uploaded.', 'ok');
      if (status) {
        status.textContent = (res.fileName || 'Resume') + ' scored.';
      }
      setTimeout(function () {
        if (progress) { progress.hidden = true; }
        renderShell();
      }, 320);
    }).catch(function (err) {
      clearInterval(timer);
      if (progress) { progress.hidden = true; }
      if (status) {
        status.innerHTML =
          escapeHtml((err && err.message) || 'Upload failed.') +
          ' <button class="link-btn" type="button" data-ws-retry>Retry</button>';
      }
      showToast((err && err.message) || 'Upload failed.', 'error');
    });
  }

  function renderScoreCard(host, value, name) {
    if (!host) { return; }
    host.innerHTML =
      '<section class="card ws-score-card" aria-labelledby="ws-score-title">' +
        '<div class="ws-score-card__head">' +
          '<h2 class="title title--small" id="ws-score-title">Resume score</h2>' +
          '<button class="link-btn" type="button" data-ws-remove>Remove resume</button>' +
        '</div>' +
        '<div class="ws-score">' +
          '<div class="ws-score__ring">' +
            ringSvg(value) +
            '<span class="ws-score__num">' + Math.round(value) + '</span>' +
          '</div>' +
          '<div class="ws-score__copy">' +
            '<p class="ws-score__summary">Your resume is ' + Math.round(value) +
              '% optimized for ATS' +
              (name ? ' · ' + escapeHtml(name) : '') + '</p>' +
            '<div class="ws-score__actions">' +
              '<button class="btn btn--small" type="button" data-ws-goto="improvements">' +
                'View Detailed Suggestions</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>';

    var goBtn = host.querySelector('[data-ws-goto]');
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        activeTab = 'improvements';
        renderShell();
      });
    }
    var removeBtn = host.querySelector('[data-ws-remove]');
    if (removeBtn) {
      removeBtn.addEventListener('click', clearResume);
    }
  }

  /* ---------- Improvements ---------- */

  function renderSuggestionsTab(panel) {
    panel.innerHTML = skeleton(3);
    api.getSuggestions(resumeId).then(function (data) {
      var list = (data && data.suggestions) || [];
      if (!list.length) {
        panel.innerHTML = emptyState(
          'No suggestions yet',
          'Upload a resume to get actionable improvements.',
          'Go to My Resume',
          'resume'
        );
        wireEmptyActions(panel);
        return;
      }

      var groups = {};
      list.forEach(function (item) {
        var key = item.category || 'other';
        if (!groups[key]) { groups[key] = []; }
        groups[key].push(item);
      });

      var html = '';
      Object.keys(groups).forEach(function (cat) {
        html += '<section class="ws-group" aria-label="' + escapeHtml(CAT_LABELS[cat] || cat) + '">';
        html += '<h2 class="ws-group__title">' + escapeHtml(CAT_LABELS[cat] || cat) + '</h2>';
        groups[cat].forEach(function (item) {
          var done = !!doneMap[item.id];
          html +=
            '<article class="card ws-sug' + (done ? ' is-done' : '') + '">' +
              '<div class="ws-sug__top">' +
                '<span class="ws-badge ws-badge--' + escapeHtml(item.severity) + '">' +
                  escapeHtml(item.severity) + '</span>' +
                '<label class="ws-check">' +
                  '<input type="checkbox" data-ws-done="' + escapeHtml(item.id) + '"' +
                    (done ? ' checked' : '') + '>' +
                  '<span>Mark as done</span>' +
                '</label>' +
              '</div>' +
              '<p class="ws-sug__msg">' + escapeHtml(item.message) + '</p>' +
              '<p class="ws-sug__tip"><strong>Try this:</strong> ' +
                escapeHtml(item.actionable) + '</p>' +
            '</article>';
        });
        html += '</section>';
      });
      panel.innerHTML = html;

      Array.prototype.forEach.call(panel.querySelectorAll('[data-ws-done]'), function (cb) {
        cb.addEventListener('change', function () {
          doneMap[cb.getAttribute('data-ws-done')] = cb.checked;
          var card = cb.closest('.ws-sug');
          if (card) { card.classList.toggle('is-done', cb.checked); }
        });
      });
    }).catch(function (err) {
      panel.innerHTML = emptyState(
        'Could not load suggestions',
        (err && err.message) || 'Something went wrong.',
        'Retry',
        'retry-suggestions'
      );
      wireEmptyActions(panel);
    });
  }

  /* ---------- Templates ---------- */

  function renderTemplatesTab(panel) {
    panel.innerHTML = skeleton(4);
    api.getTemplates(resumeId).then(function (data) {
      var list = (data && data.templates) || [];
      if (!list.length) {
        panel.innerHTML = emptyState(
          'No templates',
          'Upload a resume to see templates tailored to your path.',
          'Go to My Resume',
          'resume'
        );
        wireEmptyActions(panel);
        return;
      }

      var cats = {};
      list.forEach(function (t) { cats[t.category] = true; });
      var options = Object.keys(cats).sort().map(function (c) {
        return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
      }).join('');

      panel.innerHTML =
        '<div class="ws-filter">' +
          '<label class="label" for="ws-tpl-filter">Category</label>' +
          '<span class="select-wrap">' +
            '<select class="input select" id="ws-tpl-filter">' +
              '<option value="">All</option>' + options +
            '</select>' +
          '</span>' +
        '</div>' +
        '<div class="ws-tpl-grid" id="ws-tpl-grid"></div>';

      var grid = qs('#ws-tpl-grid', panel);
      var filter = qs('#ws-tpl-filter', panel);

      function paint() {
        var cat = filter.value;
        var rows = list.filter(function (t) { return !cat || t.category === cat; });
        if (!rows.length) {
          grid.innerHTML = emptyState('No templates in this category', 'Try another filter.');
          return;
        }
        grid.innerHTML = rows.map(function (t) {
          return (
            '<article class="ws-tpl card">' +
              '<div class="ws-tpl__thumb" aria-hidden="true">' +
                '<span>' + escapeHtml((t.category || '?').charAt(0)) + '</span>' +
              '</div>' +
              '<div class="ws-tpl__body">' +
                '<h3 class="ws-tpl__name">' + escapeHtml(t.name) + '</h3>' +
                '<p class="ws-tpl__cat">' + escapeHtml(t.category) + '</p>' +
                (t.isRecommended
                  ? '<span class="ws-badge ws-badge--rec">Recommended</span>'
                  : '') +
              '</div>' +
              '<div class="ws-tpl__actions">' +
                '<button class="btn-ghost btn-ghost--quiet" type="button" data-ws-preview>Preview</button>' +
                '<button class="btn btn--small" type="button" data-ws-use>Use Template</button>' +
              '</div>' +
            '</article>'
          );
        }).join('');
      }

      filter.addEventListener('change', paint);
      paint();
      panel.addEventListener('click', function (e) {
        if (e.target.closest('[data-ws-use], [data-ws-preview]')) {
          showToast('Template editor is coming soon.', 'info');
        }
      });
    }).catch(function (err) {
      panel.innerHTML = emptyState(
        'Could not load templates',
        (err && err.message) || 'Something went wrong.',
        'Retry',
        'retry-templates'
      );
      wireEmptyActions(panel);
    });
  }

  /* ---------- Job Matches ---------- */

  function renderMatchesTab(panel) {
    panel.innerHTML = skeleton(3);
    api.getJobMatches(resumeId).then(function (data) {
      var list = ((data && data.matches) || []).slice().sort(function (a, b) {
        return b.matchPercentage - a.matchPercentage;
      });
      if (!list.length) {
        panel.innerHTML = emptyState(
          'No matches yet',
          'Improve your CV or check back when more partner roles are posted.',
          'See improvements',
          'improvements'
        );
        wireEmptyActions(panel);
        return;
      }

      panel.innerHTML = '<div class="ws-match-list" id="ws-match-list"></div>';
      var host = qs('#ws-match-list', panel);
      host.innerHTML = list.map(function (m) {
        return (
          '<button class="card ws-match" type="button" data-ws-job="' +
            escapeHtml(m.jobId) + '">' +
            '<div class="ws-match__top">' +
              '<div>' +
                '<h3 class="ws-match__title">' + escapeHtml(m.title) + '</h3>' +
                '<p class="ws-match__meta">' + escapeHtml(m.company) +
                  ' · ' + escapeHtml(m.location) + '</p>' +
              '</div>' +
              '<span class="ws-match__pct">' + Math.round(m.matchPercentage) + '%</span>' +
            '</div>' +
            '<div class="ws-match__bar" aria-hidden="true">' +
              '<span style="width:' + Math.round(m.matchPercentage) + '%"></span>' +
            '</div>' +
            '<p class="ws-match__skills">' +
              '<span class="ws-match__ok">Matched: ' +
                escapeHtml((m.matchedSkills || []).join(', ') || '—') + '</span>' +
              (m.missingSkills && m.missingSkills.length
                ? ' · <span class="ws-match__miss">Missing: ' +
                  escapeHtml(m.missingSkills.join(', ')) + '</span>'
                : '') +
            '</p>' +
          '</button>'
        );
      }).join('');

      Array.prototype.forEach.call(host.querySelectorAll('[data-ws-job]'), function (btn) {
        btn.addEventListener('click', function () {
          openComparison(btn.getAttribute('data-ws-job'), btn);
        });
      });
    }).catch(function (err) {
      panel.innerHTML = emptyState(
        'Could not load matches',
        (err && err.message) || 'Something went wrong.',
        'Retry',
        'retry-matches'
      );
      wireEmptyActions(panel);
    });
  }

  function openComparison(jobId, trigger) {
    var dialog = qs('#ws-dialog', rootEl);
    if (!dialog) { return; }

    dialog.innerHTML =
      '<div class="ws-dialog__inner">' +
        '<header class="ws-dialog__head">' +
          '<h2 class="title title--small" id="ws-dialog-title">Skill comparison</h2>' +
          '<button class="ws-dialog__close" type="button" aria-label="Close" data-ws-close>&times;</button>' +
        '</header>' +
        '<div class="ws-dialog__body">' + skeleton(2) + '</div>' +
      '</div>';

    if (typeof dialog.showModal === 'function') { dialog.showModal(); }
    else { dialog.setAttribute('open', ''); }

    function close() {
      if (typeof dialog.close === 'function') { dialog.close(); }
      else { dialog.removeAttribute('open'); }
      if (trigger) {
        try { trigger.focus(); } catch (e) { /* ignore */ }
      }
    }

    qs('[data-ws-close]', dialog).addEventListener('click', close);
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) { close(); }
    });

    api.getJobComparison(resumeId, jobId).then(function (data) {
      var body = qs('.ws-dialog__body', dialog);
      var match = data.match || {};
      var comparison = data.comparison || [];
      var matched = comparison.filter(function (c) { return c.status === 'matched'; }).length;
      var total = comparison.length || 1;

      body.innerHTML =
        '<p class="ws-dialog__lead"><strong>' + escapeHtml(match.title || 'Role') +
          '</strong> · ' + escapeHtml(match.company || '') + '</p>' +
        '<div class="ws-compare">' +
          '<section>' +
            '<h3 class="ws-compare__h">Your skills</h3>' +
            '<ul class="ws-compare__list">' +
              (data.resumeSkills || []).map(function (s) {
                var hit = comparison.some(function (c) {
                  return c.skill === s && c.status === 'matched';
                });
                return '<li class="' + (hit ? 'is-matched' : '') + '">' +
                  escapeHtml(s) + '</li>';
              }).join('') +
            '</ul>' +
          '</section>' +
          '<section>' +
            '<h3 class="ws-compare__h">Required skills</h3>' +
            '<ul class="ws-compare__list">' +
              comparison.map(function (c) {
                return '<li class="is-' + escapeHtml(c.status) + '">' +
                  escapeHtml(c.skill) + '</li>';
              }).join('') +
            '</ul>' +
          '</section>' +
        '</div>' +
        '<p class="ws-dialog__summary">You match ' + matched + ' out of ' +
          total + ' required skills.</p>' +
        '<button class="btn" type="button" disabled>Apply Now</button>';
    }).catch(function (err) {
      var body = qs('.ws-dialog__body', dialog);
      body.innerHTML = '<p class="ws-empty__body">' +
        escapeHtml((err && err.message) || 'Could not load comparison.') + '</p>';
    });
  }

  function mount() {
    rootEl = document.getElementById('view-workstation');
    if (!rootEl) { return; }
    loadSession();
    renderShell();
  }

  function show() {
    loadSession();
    if (!rootEl) { mount(); }
    else { renderShell(); }
  }

  root.ShieldWorkstation = {
    mount: mount,
    show: show
  };
})(typeof window !== 'undefined' ? window : globalThis);
