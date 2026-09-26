/*
 * Job Scam Shield — rule engine.
 *
 * Runs in the browser so the checker works instantly and survives a dead
 * network. The target architecture moves this scoring server-side (FastAPI)
 * so the logic can't be read or edited by the user; that is the security
 * step, and it is deliberately NOT claimed as live here.
 *
 * Every rule carries a source, so any single line of the engine can be
 * defended against evidence rather than vibes.
 */
(function (root) {
  'use strict';

  var HIGH_AT = 25;
  var CAUTION_AT = 10;

  /*
   * Each rule:
   *   id       stable key
   *   label    short name for the chip list
   *   reason   the plain-language "why", shown to the user
   *   weight   severity contribution
   *   critical if true, this rule alone forces a HIGH result
   *   source   where the pattern is documented
   *   test     function(message) -> matched text or null
   */
  var RULES = [
    {
      id: 'advance-fee',
      label: 'Asks you to pay before you start',
      reason: 'Real employers, SETAs and learnerships do not charge a fee, levy or deposit before you can start work or training. An upfront payment request is the single strongest scam signal we check for.',
      weight: 30,
      critical: true,
      source: 'DCS "Learnership 2026" fake-post alerts (2026); SA scam-tracker weekly bulletins (2025-2026)',
      test: function (text) {
        return match(text, [
          /\b(?:registration|admin(?:istrative)?|course|training|service|processing|security|placement|screening|medical)\s*fee\b/i,
          /\b(?:pay|payable|send|deposit|transfer)\s+(?:us\s+)?r\s?\d/i,
          /\br\s?\d[\d\s.]*\s*(?:is\s+)?(?:due|required|needed)\b/i,
          /\b(?:once|before)\s+(?:payment|you\s+(?:can|start))\b/i,
          /\bfee\s+of\s+r\s?\d/i,
          /\bno\s+payment\s+(?:will\s+be\s+)?required\s+(?:to|for)\s+employ\b/i
        ]);
      }
    },
    {
      id: 'middleman-payments',
      label: 'Wants you to handle other people\'s money',
      reason: 'Being asked to receive, hold or forward money on someone else\'s behalf is how job scams launder funds. Legitimate employers never route payroll or supplier payments through the personal account or wallet of a new hire.',
      weight: 30,
      critical: true,
      source: 'SA scam-tracker weekly bulletins on "work from home" money-mule recruitment (2025-2026)',
      test: function (text) {
        return match(text, [
          /\b(?:receive|accept|collect|hold)\s+(?:the\s+|customer'?s?\s+|other\s+)?(?:money|payments?|funds?)\s+(?:on|for)\s+(?:our|their|his|her|a|behalf)/i,
          /\b(?:be|act\s+as)\s+a\s+middle\s?man\b/i,
          /\bforward\s+(?:the\s+)?(?:money|payment|funds)\s+to/i,
          /\b(?:send|transfer)\s+(?:the\s+)?money\s+(?:to\s+)?(?:my|our)\s+(?:account|wallet)/i,
          /\buse\s+your\s+(?:own\s+)?(?:bank\s+)?account\s+to\s+(?:receive|make\s+payments?)/i
        ]);
      }
    },
    {
      id: 'comment-yes',
      label: 'Engagement bait instead of an application process',
      reason: '"Comment YES to apply" style posts measure reach, not applicants. Confirmed in a 2026 PRASA impersonation post that did not match PRASA\'s real hiring process. Legitimate employers ask for an application, not a public comment.',
      weight: 15,
      source: 'PRASA impersonation post, "comment YES to apply", debunked February 2026',
      test: function (text) {
        return match(text, [
          /\b(?:comment|reply|respond|type|send|say|write)\s*"?\s*yes\b/i,
          /\bcomment\s+(?:yes|interested|interested\s+below)\b/i,
          /\bdouble\s+tap\s+(?:yes|interested)\b/i,
          /\btag\s+(?:a\s+)?friend[s]?\s+(?:below|to\s+apply)\b/i,
          /\bcomment\s+(?:below|here)\s+to\s+apply\b/i
        ]);
      }
    },
    {
      id: 'documents-upfront',
      label: 'Wants your documents or banking details early',
      reason: 'Sending an ID, passport, proof of payment or full banking details before an interview is not part of any normal hiring process. South African employers and SETAs collect personal documents only after an offer and through a secure channel.',
      weight: 20,
      source: 'Standard SA hiring practice; "why does it want documents this early?" from the founder\'s own job search (Blueprint 6)',
      test: function (text) {
        return match(text, [
          /\b(?:banking|bank)\s+details\b/i,
          /\b(?:copy|photo|scan)\s+of\s+(?:your\s+)?(?:id|identity|passport|smart\s*card|bank\s+statement|salary\s+slip|certificate)/i,
          /\bproof\s+of\s+payment\b/i,
          /\b(?:id|identity|passport)\s+(?:number|copy)\b/i,
          /\bsend\s+(?:me\s+)?(?:your\s+)?(?:id|passport|documents?|banking\s+details)\b/i
        ]);
      }
    },
    {
      id: 'impersonation',
      label: 'Uses the name of a big institution',
      reason: 'Fake learnerships in 2026 repeatedly impersonated Eskom, PRASA, SAPS and the Department of Correctional Services. A message naming a major institution proves nothing — real employers apply for accreditation, verify on the institution\'s own domain, and never recruit through an unsolicited WhatsApp message.',
      weight: 20,
      source: 'DCS, Eskom, PRASA and SAPS impersonation alerts reported across 2026',
      test: function (text) {
        return match(text, [
          /\b(?:eskom|prasa|saps|sanlam|absa|nedbank|standard\s+bank|sasol|transnet|south\s+african\s+airways|denel|gov\.za)\b/i,
          /\bdepartment\s+of\s+(?:employment|correctional\s+services|labour|higher\s+education)\b/i,
          /\bnational\s+(?:energy|water|railway)\b/i,
          /\bsouth\s+african\s+police\b/i
        ]);
      }
    },
    {
      id: 'whatsapp-only',
      label: 'Only reachable on WhatsApp, with no real application route',
      reason: 'Genuine employers publish a role on a job board, a company careers page and a company email domain. A "job" that exists only as a forwarded WhatsApp message has no verifiable trail behind it.',
      weight: 10,
      source: 'Blueprint 4 — WhatsApp carries genuine leads and scams through the same channel, with no verified identity',
      test: function (text) {
        return match(text, [
          /\bwhatsapp\s+only\b/i,
          /\bapply\s+(?:only\s+)?(?:on|via|through)\s+(?:our\s+|this\s+)?whatsapp\b/i,
          /\b(?:send|forward)\s+your\s+(?:cv|resume)\s+to\s+(?:this\s+)?(?:whatsapp\s+)?(?:number|line)\b/i,
          /\bno\s+(?:email|website|web\s?site|office)\s*[.,]?\s*(?:apply|contact)?/i,
          /\bthis\s+(?:is\s+)?the\s+only\s+(?:number|line|contact)\b/i
        ]);
      }
    },
    {
      id: 'urgency',
      label: 'Creates pressure to decide fast',
      reason: 'Scam messages manufacture urgency so you reply before you think. A real vacancy stays open for days, and recruiters do not count down the closing time in a forwarded WhatsApp message.',
      weight: 12,
      source: 'Blueprint 2 — "there\'s rarely time, data, or a second device free to research it properly before replying"',
      test: function (text) {
        return match(text, [
          /\b(?:only|just)\s+\d+\s+(?:spots?|places?|slots?|openings?|seats?|vacancies)\b/i,
          /\b(?:closing|closes|closes?)\s+(?:today|tonight|this\s+week|immediately)\b/i,
          /\bapply\s+now\b/i,
          /\b(?:hurry|quick|last\s+chance|before\s+(?:it|they)\s+clos)/i,
          /\b(?:starting|starts?)\s+(?:tomorrow|monday|next\s+week)\b/i,
          /\bthis\s+(?:is\s+)?(?:your\s+)?last\s+(?:chance|warning)\b/i,
          /\bno\s+time\s+to\s+waste\b/i
        ]);
      }
    },
    {
      id: 'unrealistic-pay',
      label: 'Pay or promise that is too good to be true',
      reason: 'Guaranteed income, no experience needed, and very high or daily-paid rates are the standard packaging of a scam. Genuine entry-level and learnership roles in South Africa advertise realistic, banded salaries.',
      weight: 15,
      source: 'SA scam-tracker weekly bulletins on "work from home" and "no experience needed" postings',
      test: function (text) {
        return match(text, [
          /\bguarantee[ds]?\s+(?:income|salary|job|weekly\s+pay|r\s?\d)/i,
          /\b(?:no|zero)\s+experience\s+(?:needed|required)\b/i,
          /\b(?:earn|make|get)\s+r\s?\d[\d\s.]*\s*(?:a|per)\s+(?:day|week|month)/i,
          /\br\s?\d{2,3}[\d\s.,]*\s*(?:per|a)\s+(?:day|week|month)\b/i,
          /\bguaranteed\s+job\b/i,
          /\bearn\s+\$\d[\d\s.,]*\s*(?:a|per)\s+(?:day|week)/i
        ]);
      }
    },
    {
      id: 'unverifiable-accreditation',
      label: 'Claims an accreditation you cannot check',
      reason: 'A learnership or programme that names a SETA, NQF level or awarding body but gives you no verifiable registration number, or asks you to trust a logo alone, cannot be confirmed. Ask the SETA directly, on a number you find yourself.',
      weight: 8,
      source: 'Blueprint 6 — "Is this programme actually SETA-accredited?" from the founder\'s own job search',
      test: function (text) {
        return match(text, [
          /\b(?:seta|nqf\s+level|khula|apprenticeship|learnership)\b/i,
          /\b(?:fully|fully\s+)?accredit(?:ed|ation)\b/i,
          /\b(?:certificate|qualification)\s+(?:on|upon)\s+completion\b/i
        ]);
      }
    }
  ];

  function match(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      var found = text.match(patterns[i]);
      if (found) {
        return found[0];
      }
    }
    return null;
  }

  function verdictFor(score, hits) {
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].critical) {
        return 'HIGH';
      }
    }
    if (score >= HIGH_AT) {
      return 'HIGH';
    }
    if (score >= CAUTION_AT) {
      return 'CAUTION';
    }
    return 'LOW';
  }

  var NEXT_STEPS = {
    HIGH: [
      'Do not reply, and do not send any documents, money or banking details.',
      'Report the message to WhatsApp: long-press the message, then Report. Report it to the platform hosting the post as well.',
      'If the message used the name of a real employer or government department, report it to that organisation through the contact details on its own official website.'
    ],
    CAUTION: [
      'Do not reply yet, and never send money, an ID copy or banking details to check an opportunity.',
      'Find the organisation yourself on its official website or a job board, and apply through that channel instead of replying.',
      'If they name a SETA, learnership or programme, look it up on the SETA\'s own site and confirm your details with them directly.'
    ],
    LOW: [
      'Nothing obvious was flagged, but that is not proof the opportunity is real.',
      'Still apply through the organisation\'s own website or a job board rather than replying to the message.',
      'Never pay a fee, send banking details, or hand over an ID copy before a formal interview and a written offer.'
    ]
  };

  function check(message) {
    var text = String(message || '');
    var hits = [];
    var score = 0;

    for (var i = 0; i < RULES.length; i++) {
      var rule = RULES[i];
      var evidence = rule.test(text);
      if (evidence) {
        score += rule.weight;
        hits.push({
          id: rule.id,
          label: rule.label,
          reason: rule.reason,
          weight: rule.weight,
          critical: Boolean(rule.critical),
          source: rule.source,
          evidence: evidence
        });
      }
    }

    var risk = verdictFor(score, hits);

    /*
     * A rule can match while still totalling less than the caution
     * threshold. Surfacing those would put a warning on a perfectly
     * ordinary learnership posting, which is exactly the false positive
     * that makes people stop trusting the tool. So the tool only speaks
     * when the total is worth hearing.
     */
    var reported = risk === 'LOW' ? [] : hits;

    return {
      risk: risk,
      score: score,
      hits: hits,
      reportedHits: reported,
      hitCount: reported.length,
      nextSteps: NEXT_STEPS[risk],
      engine: 'rule-engine-v1',
      note: 'Rule-based checks only. This is not a background check and cannot confirm that an employer exists.'
    };
  }

  var api = {
    check: check,
    rules: RULES,
    thresholds: { HIGH_AT: HIGH_AT, CAUTION_AT: CAUTION_AT }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShieldRules = api;
  }
})(typeof window !== 'undefined'
  ? window
  : (typeof global !== 'undefined' ? global : null));
