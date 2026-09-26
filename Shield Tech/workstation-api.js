/*
 * Work Station — single API seam.
 * Backend: set USE_MOCK = false and point BASE_URL at the real server.
 * Components must only call ShieldWorkstationApi — never fetch() directly.
 */
(function (root) {
  'use strict';

  var USE_MOCK = true;
  var BASE_URL = '/api';

  function request(path, options) {
    options = options || {};
    var headers = options.headers ? Object.assign({}, options.headers) : {};
    var token = null;
    try { token = localStorage.getItem('token'); } catch (e) { token = null; }
    if (token) { headers.Authorization = 'Bearer ' + token; }

    var body = options.body;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body && !isForm && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      if (typeof body !== 'string') { body = JSON.stringify(body); }
    }

    return fetch(BASE_URL + path, {
      method: options.method || 'GET',
      headers: headers,
      body: body
    }).then(function (res) {
      return res.json().catch(function () {
        return {};
      }).then(function (payload) {
        if (!res.ok) {
          var msg = (payload && payload.error) || ('Request failed (' + res.status + ')');
          var err = new Error(msg);
          err.code = payload && payload.code;
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    });
  }

  var mock = root.ShieldWorkstationMock;

  /**
   * POST /api/resumes
   * Body: FormData { resume: File }
   * Response: { resumeId, fileName, score, summary }
   */
  function uploadResume(file) {
    if (USE_MOCK) { return mock.uploadResume(file); }
    var form = new FormData();
    form.append('resume', file);
    return request('/resumes', { method: 'POST', body: form });
  }

  /**
   * GET /api/resumes/:id/suggestions
   * Response: { resumeId, suggestions: Suggestion[] }
   */
  function getSuggestions(resumeId) {
    if (USE_MOCK) { return mock.getSuggestions(resumeId); }
    return request('/resumes/' + encodeURIComponent(resumeId) + '/suggestions');
  }

  /**
   * GET /api/resumes/:id/templates
   * Response: { resumeId, templates: Template[] }
   */
  function getTemplates(resumeId) {
    if (USE_MOCK) { return mock.getTemplates(resumeId); }
    return request('/resumes/' + encodeURIComponent(resumeId) + '/templates');
  }

  /**
   * GET /api/resumes/:id/matches
   * Response: { resumeId, matches: JobMatch[] }
   */
  function getJobMatches(resumeId) {
    if (USE_MOCK) { return mock.getJobMatches(resumeId); }
    return request('/resumes/' + encodeURIComponent(resumeId) + '/matches');
  }

  /**
   * GET /api/resumes/:id/matches/:jobId
   * Response: JobComparison
   */
  function getJobComparison(resumeId, jobId) {
    if (USE_MOCK) { return mock.getJobComparison(resumeId, jobId); }
    return request(
      '/resumes/' + encodeURIComponent(resumeId) +
      '/matches/' + encodeURIComponent(jobId)
    );
  }

  root.ShieldWorkstationApi = {
    USE_MOCK: USE_MOCK,
    BASE_URL: BASE_URL,
    uploadResume: uploadResume,
    getSuggestions: getSuggestions,
    getTemplates: getTemplates,
    getJobMatches: getJobMatches,
    getJobComparison: getJobComparison
  };
})(typeof window !== 'undefined' ? window : globalThis);
