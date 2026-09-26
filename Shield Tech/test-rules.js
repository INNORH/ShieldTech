/*
 * Curated test set — TRL 4 evidence.
 *
 * Every case is a hand-written, realistic South African job message.
 * Scam cases are built from the documented 2026 patterns in the blueprint
 * (DCS "Learnership 2026", PRASA "comment YES to apply", Eskom/SAPS
 * impersonation, "work from home" money-mule recruitment) and from the
 * founder's own job-search experience. Legitimate cases are written to be
 * the hardest kind: real vacancies that a naive rule engine would flag.
 *
 * Run:  node test-rules.js
 */
'use strict';

require('./rules.js');
var ShieldRules = (typeof window !== 'undefined' ? window : global).ShieldRules;

var CASES = [
  {
    id: 's1',
    label: 'DCS learnership - registration fee',
    expect: 'HIGH',
    want: ['advance-fee'],
    text: 'DEPT OF CORRECTIONAL SERVICES: Learnership 2026 programme. ' +
      'Selected candidates must pay a registration fee of R450 to reserve a place. ' +
      'Apply on WhatsApp only, send your CV to this number.'
  },
  {
    id: 's2',
    label: 'PRASA - comment YES bait',
    expect: 'HIGH',
    want: ['comment-yes', 'impersonation'],
    text: 'PRASA VACANCY. Comment YES to apply and tag a friend. ' +
      'No experience needed, guaranteed weekly pay. This is the last chance, apply now.'
  },
  {
    id: 's3',
    label: 'Work from home money mule',
    expect: 'HIGH',
    want: ['middleman-payments', 'unrealistic-pay'],
    text: 'Work from home opportunity. Receive money on behalf of our clients, ' +
      'hold the funds and forward the money to our account. You will earn R4500 per week, ' +
      'guaranteed, with no experience required.'
  },
  {
    id: 's4',
    label: 'Eskom learnership impersonation',
    expect: 'HIGH',
    want: ['impersonation', 'unverifiable-accreditation', 'urgency'],
    text: 'ESKOM LEARNERSHIP 2026. Fully accredited by the SETA, NQF level 2. ' +
      'Only 20 spots available. Closing today, apply now on WhatsApp.'
  },
  {
    id: 's5',
    label: 'Banking details before interview',
    expect: 'HIGH',
    want: ['documents-upfront', 'advance-fee'],
    text: 'INTERNSHIP OPPORTUNITY. Send us a copy of your ID and your banking details ' +
      'to secure the position. Pay the R200 processing fee before your interview.'
  },
  {
    id: 's6',
    label: 'Forwarded viral learnership, mild',
    expect: 'CAUTION',
    want: ['unverifiable-accreditation'],
    text: 'LEARNERSHIP 2026 - Office Administration NQF 3. ' +
      'Certificate on completion. Kindly send your CV to this WhatsApp number.'
  },

  {
    id: 'l1',
    label: 'Legit graduate programme, real company',
    expect: 'LOW',
    text: 'Graduate Programme 2026. Our 2026 graduate intake is open for South African ' +
      'university graduates. Apply on careers.ntlapa.co.za by 28 February. ' +
      'Shortlisting will be based on your academic record and a structured assessment.'
  },
  {
    id: 'l2',
    label: 'Legit internship, proper application route',
    expect: 'LOW',
    text: 'We are looking for a Communications intern to join our Johannesburg team ' +
      'for six months, starting 1 March. Please submit your CV and academic transcript ' +
      'through our careers portal. Interns are paid R8 500 per month.'
  },
  {
    id: 'l3',
    label: 'Legit entry-level, mentions documents and experience',
    expect: 'LOW',
    text: 'Entry Level Sales Assistant, Centurion. Candidates must have at least one ' +
      'year of retail experience. At interview you will be asked for your ID and payslip. ' +
      'Apply in person at our Midrand store or via careers.builtbetter.co.za'
  },
  {
    id: 'l4',
    label: 'Legit learnership via SETA, no money, no WhatsApp',
    expect: 'LOW',
    text: 'We are recruiting learners for a 12-month accredited learnership in logistics, ' +
      'funded by our B-BBEE plan. There is no cost to the learner and a stipend is paid monthly. ' +
      'Apply on the SETA learner portal, reference LRN-2026-014.'
  },
  {
    id: 'l5',
    label: 'Real vacancy, high number of openings',
    expect: 'LOW',
    text: 'We are hiring 40 additional branch tellers across Gauteng for our December intake. ' +
      'Submit applications on our official careers site. Screening and interviews run weekly.'
  },
  {
    id: 'l6',
    label: 'Legit urgent but no scam tells',
    expect: 'LOW',
    text: 'Please note our graduate applications for 2026 close this Friday at 23:59. ' +
      'We receive many applications, so we cannot guarantee a response to every applicant.'
  }
];

function run() {
  var pass = 0;
  var failures = [];

  console.log('JOB SCAM SHIELD - rule engine test set');
  console.log('thresholds: HIGH >= ' + ShieldRules.thresholds.HIGH_AT +
    ', CAUTION >= ' + ShieldRules.thresholds.CAUTION_AT);
  console.log('cases: ' + CASES.length + '\n');

  CASES.forEach(function (testCase) {
    var result = ShieldRules.check(testCase.text);
    var gotIds = result.hits.map(function (hit) { return hit.id; });
    var problems = [];

    if (result.risk !== testCase.expect) {
      problems.push('expected ' + testCase.expect + ', got ' + result.risk +
        ' (score ' + result.score + ')');
    }
    if (testCase.want) {
      testCase.want.forEach(function (id) {
        if (gotIds.indexOf(id) === -1) {
          problems.push('expected signal "' + id + '" did not fire');
        }
      });
    }
    if (!testCase.want) {
      var falsePositives = result.reportedHits.map(function (hit) { return hit.id; });
      if (falsePositives.length) {
        problems.push('FALSE POSITIVE on legit posting: ' + falsePositives.join(', '));
      }
    }
    if (result.risk === 'LOW' && result.reportedHits.length) {
      problems.push('LOW verdict must not report any signals to the user');
    }

    if (problems.length) {
      failures.push(testCase.id + ' (' + testCase.label + '): ' + problems.join('; '));
      console.log('FAIL  ' + testCase.id.padEnd(4) + testCase.label);
      problems.forEach(function (p) { console.log('        ' + p); });
      console.log('        fired: ' + (gotIds.join(', ') || 'none') +
        ' | score ' + result.score + ' | risk ' + result.risk);
    } else {
      pass++;
      console.log('pass  ' + testCase.id.padEnd(4) + testCase.label +
        '  ->  ' + result.risk + ' (score ' + result.score + ', ' +
        result.hitCount + ' signal' + (result.hitCount === 1 ? '' : 's') + ')');
    }
  });

  var scams = CASES.filter(function (c) { return c.id.charAt(0) === 's'; });
  var legits = CASES.filter(function (c) { return c.id.charAt(0) === 'l'; });

  console.log('\n---');
  console.log('passed:      ' + pass + '/' + CASES.length);
  console.log('scam cases:  ' + scams.length + ' (target: all flagged CAUTION or higher)');
  console.log('legit cases: ' + legits.length + ' (target: all LOW, zero false positives)');
  console.log('false-positive rate on legit postings: ' +
    (legits.filter(function (c) {
      return ShieldRules.check(c.text).risk !== 'LOW';
    }).length / legits.length * 100).toFixed(1) + '%');
  console.log('recalled on scam postings: ' +
    (scams.filter(function (c) {
      return ShieldRules.check(c.text).risk !== 'LOW';
    }).length / scams.length * 100).toFixed(1) + '%');

  console.log(failures.length ? '\nFAILURES:\n' + failures.join('\n') : '\nALL GREEN');
  process.exit(failures.length ? 1 : 0);
}

run();
