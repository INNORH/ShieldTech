/*
 * Work Station — mock payloads.
 * Swap off via USE_MOCK in workstation-api.js; do not import this from UI code.
 */
(function (root) {
  'use strict';

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms == null ? 500 : ms);
    });
  }

  /** @typedef {'formatting'|'keywords'|'impact'|'contact'} SuggestionCategory */
  /** @typedef {'high'|'medium'|'low'} SuggestionSeverity */

  /**
   * @typedef {object} Suggestion
   * @property {string} id
   * @property {SuggestionCategory} category
   * @property {SuggestionSeverity} severity
   * @property {string} message
   * @property {string} actionable
   */

  /**
   * @typedef {object} Template
   * @property {string} id
   * @property {string} name
   * @property {string} thumbnailUrl
   * @property {string} category
   * @property {boolean} isRecommended
   */

  /**
   * @typedef {object} JobMatch
   * @property {string} jobId
   * @property {string} title
   * @property {string} company
   * @property {number} matchPercentage
   * @property {string} location
   * @property {string[]} matchedSkills
   * @property {string[]} missingSkills
   */

  /**
   * @typedef {object} JobComparison
   * @property {JobMatch} match
   * @property {string[]} resumeSkills
   * @property {string[]} requiredSkills
   * @property {{ skill: string, status: 'matched'|'missing' }[]} comparison
   */

  var SUGGESTIONS = [
    {
      id: 'sug-1',
      category: 'keywords',
      severity: 'high',
      message: 'Missing ATS keywords for South African learnerships and SETA roles.',
      actionable: 'Add terms like “learnership”, “SETA”, “NQF”, and the tools you already use.'
    },
    {
      id: 'sug-2',
      category: 'impact',
      severity: 'high',
      message: 'Work bullets describe tasks, not results.',
      actionable: 'Rewrite 3 bullets with numbers: “Reduced … by 20%” or “Supported 40+ customers daily”.'
    },
    {
      id: 'sug-3',
      category: 'formatting',
      severity: 'medium',
      message: 'Dense paragraphs make the CV hard to scan on a phone.',
      actionable: 'Use short bullets (one line each) and clear section headings.'
    },
    {
      id: 'sug-4',
      category: 'contact',
      severity: 'low',
      message: 'Contact block is incomplete for recruiters in SA.',
      actionable: 'Add a professional email, city/province, and LinkedIn or phone.'
    }
  ];

  var TEMPLATES = [
    {
      id: 'tpl-corp',
      name: 'Cape Corporate',
      thumbnailUrl: '',
      category: 'Corporate',
      isRecommended: true
    },
    {
      id: 'tpl-tech',
      name: 'Tech Stack Pro',
      thumbnailUrl: '',
      category: 'Technical',
      isRecommended: true
    },
    {
      id: 'tpl-min',
      name: 'Clean Minimal',
      thumbnailUrl: '',
      category: 'Minimal',
      isRecommended: false
    },
    {
      id: 'tpl-creat',
      name: 'Creative Portfolio',
      thumbnailUrl: '',
      category: 'Creative',
      isRecommended: false
    },
    {
      id: 'tpl-entry',
      name: 'First Job Starter',
      thumbnailUrl: '',
      category: 'Corporate',
      isRecommended: false
    },
    {
      id: 'tpl-ops',
      name: 'Ops & Admin Clear',
      thumbnailUrl: '',
      category: 'Minimal',
      isRecommended: false
    }
  ];

  var MATCHES = [
    {
      jobId: 'job-1',
      title: 'Junior IT Support Learnership',
      company: 'Partner · DigiWorks SA',
      matchPercentage: 88,
      location: 'Johannesburg, GP',
      matchedSkills: ['Customer support', 'Windows', 'Ticketing', 'Communication'],
      missingSkills: ['CompTIA A+']
    },
    {
      jobId: 'job-2',
      title: 'Graduate Administrator',
      company: 'Partner · Metro Logistics',
      matchPercentage: 74,
      location: 'Durban, KZN',
      matchedSkills: ['MS Office', 'Scheduling', 'Email'],
      missingSkills: ['SAP', 'Fleet systems']
    },
    {
      jobId: 'job-3',
      title: 'Call Centre Agent',
      company: 'Partner · ConnectServe',
      matchPercentage: 69,
      location: 'Cape Town, WC',
      matchedSkills: ['Communication', 'CRM basics', 'Shift work'],
      missingSkills: ['Bilingual (isiXhosa)']
    },
    {
      jobId: 'job-4',
      title: 'Data Capturer',
      company: 'Partner · CivicData',
      matchPercentage: 55,
      location: 'Pretoria, GP',
      matchedSkills: ['Accuracy', 'Excel'],
      missingSkills: ['SQL', 'Power BI']
    },
    {
      jobId: 'job-5',
      title: 'Junior Developer Intern',
      company: 'Partner · CodeBay',
      matchPercentage: 32,
      location: 'Remote · SA',
      matchedSkills: ['Problem solving'],
      missingSkills: ['JavaScript', 'Git', 'React', 'APIs']
    }
  ];

  var RESUME_SKILLS = [
    'Customer support',
    'Windows',
    'Ticketing',
    'Communication',
    'MS Office',
    'Scheduling',
    'Email',
    'CRM basics',
    'Shift work',
    'Accuracy',
    'Excel',
    'Problem solving'
  ];

  function mockUploadResume(file) {
    return wait(650).then(function () {
      if (!file) {
        return Promise.reject(new Error('No file provided.'));
      }
      var name = String(file.name || 'resume').toLowerCase();
      var ok = /\.(pdf|docx|txt)$/.test(name);
      if (!ok) {
        return Promise.reject(new Error('Only PDF, DOCX or TXT files are accepted.'));
      }
      return {
        resumeId: 'res_' + Date.now().toString(36),
        fileName: file.name || 'resume.pdf',
        score: 65,
        summary: 'Your resume is 65% optimized for ATS'
      };
    });
  }

  function mockGetSuggestions(resumeId) {
    return wait().then(function () {
      if (!resumeId) { return Promise.reject(new Error('Missing resume id.')); }
      return { resumeId: resumeId, suggestions: SUGGESTIONS.slice() };
    });
  }

  function mockGetTemplates(resumeId) {
    return wait().then(function () {
      if (!resumeId) { return Promise.reject(new Error('Missing resume id.')); }
      return { resumeId: resumeId, templates: TEMPLATES.slice() };
    });
  }

  function mockGetJobMatches(resumeId) {
    return wait().then(function () {
      if (!resumeId) { return Promise.reject(new Error('Missing resume id.')); }
      var sorted = MATCHES.slice().sort(function (a, b) {
        return b.matchPercentage - a.matchPercentage;
      });
      return { resumeId: resumeId, matches: sorted };
    });
  }

  function mockGetJobComparison(resumeId, jobId) {
    return wait().then(function () {
      if (!resumeId || !jobId) {
        return Promise.reject(new Error('Missing resume or job id.'));
      }
      var match = null;
      for (var i = 0; i < MATCHES.length; i++) {
        if (MATCHES[i].jobId === jobId) { match = MATCHES[i]; break; }
      }
      if (!match) {
        return Promise.reject(new Error('Job not found.'));
      }
      var required = match.matchedSkills.concat(match.missingSkills);
      var comparison = required.map(function (skill) {
        var hit = RESUME_SKILLS.indexOf(skill) !== -1;
        return { skill: skill, status: hit ? 'matched' : 'missing' };
      });
      return {
        resumeId: resumeId,
        match: match,
        resumeSkills: RESUME_SKILLS.slice(),
        requiredSkills: required,
        comparison: comparison
      };
    });
  }

  root.ShieldWorkstationMock = {
    uploadResume: mockUploadResume,
    getSuggestions: mockGetSuggestions,
    getTemplates: mockGetTemplates,
    getJobMatches: mockGetJobMatches,
    getJobComparison: mockGetJobComparison
  };
})(typeof window !== 'undefined' ? window : globalThis);
