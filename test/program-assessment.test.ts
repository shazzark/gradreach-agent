import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assessProgram, parseProgramRecord, type OfficialEvidence, type ProgramRecord } from '../src/domain/program-assessment.ts';
import { parseApplicantProfile } from '../src/domain/applicant-profile.ts';

const profile = parseApplicantProfile(JSON.parse(await readFile(new URL('../private.profile.example.json', import.meta.url), 'utf8')));
profile.applicant.degree.classification = 'Second Class Lower (2:2)';
profile.applicant.degree.gpa = 3.1;
profile.applicant.degree.gpaScale = 4;
profile.applicant.target.intake = 'Fall 2027';
profile.applicant.englishEvidence.testStatus = 'complete';
profile.applicant.englishEvidence.testName = 'IELTS Academic';
profile.applicant.englishEvidence.score = '7.0';

const evidence: OfficialEvidence = {
  sourceUrl: 'https://university.example.edu/graduate/requirements',
  checkedAt: '2026-10-01T12:00:00.000Z',
  excerpt: 'Synthetic official requirements excerpt.',
  uncertainty: '',
  verification: 'reviewed',
};

function program(overrides: Partial<ProgramRecord> = {}): ProgramRecord {
  return {
    id: 'msc-example', institution: 'Example University', name: 'MSc Example', country: 'Exampleland', intake: 'Fall 2027',
    admissions: { minimumClassification: '2:2', minimumGpa: { value: 3, scale: 4 }, evidence },
    english: { acceptedTests: [{ name: 'IELTS Academic', minimumScore: 6.5 }], evidence },
    tuition: { amount: 12000, currency: 'GBP', period: 'per academic year', evidence },
    fundingRoutes: [{ type: 'scholarship', name: 'Example scholarship', evidence }],
    deadline: { date: '2027-01-15T00:00:00.000Z', evidence },
    ...overrides,
  };
}

test('assesses explicit, source-backed program facts without inferring funding eligibility or affordability', () => {
  const result = assessProgram({ program: program(), profile, assessedAt: '2026-10-20T00:00:00.000Z' });

  assert.equal(result.admissions.outcome, 'eligible');
  assert.equal(result.english.outcome, 'eligible');
  assert.equal(result.intake.outcome, 'eligible');
  assert.equal(result.deadline.outcome, 'eligible');
  assert.equal(result.funding.outcome, 'unclear');
  assert.equal(result.tuition.outcome, 'unclear');
  assert.equal(result.overall, 'unclear');
  assert.ok(result.admissions.evidence.every((item) => item.sourceUrl.startsWith('https://') && item.checkedAt));
});

test('marks a documented GPA shortfall ineligible but does not convert between grading scales', () => {
  const belowMinimum = assessProgram({
    program: program({ admissions: { minimumGpa: { value: 3.2, scale: 4 }, evidence } }), profile,
    assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(belowMinimum.admissions.outcome, 'ineligible');

  const otherScale = assessProgram({
    program: program({ admissions: { minimumGpa: { value: 80, scale: 100 }, evidence } }), profile,
    assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(otherScale.admissions.outcome, 'unclear');
  assert.match(otherScale.admissions.reasons.join(' '), /no conversion was inferred/i);
});

test('rejects missing, insecure, or future-dated evidence as unclear', () => {
  const result = assessProgram({
    program: program({ admissions: { minimumClassification: '2:2', evidence: { ...evidence, sourceUrl: 'http://university.example.edu/rules' } } }),
    profile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(result.admissions.outcome, 'unclear');

  const future = assessProgram({
    program: program({ english: { acceptedTests: [{ name: 'IELTS Academic', minimumScore: 6.5 }], evidence: { ...evidence, checkedAt: '2027-01-01T00:00:00.000Z' } } }),
    profile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(future.english.outcome, 'unclear');
});

test('leaves assessment unclear when the source fact contains unresolved uncertainty', () => {
  const result = assessProgram({
    program: program({ admissions: { minimumClassification: '2:2', evidence: { ...evidence, uncertainty: 'The page does not say whether this applies to international applicants.' } } }),
    profile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(result.admissions.outcome, 'unclear');
});

test('compares annual tuition only when the profile has a matching budget and currency', () => {
  const budgetProfile = structuredClone(profile);
  budgetProfile.applicant.target.maxAnnualTuition = 15000;
  budgetProfile.applicant.target.tuitionCurrency = 'GBP';
  const withinBudget = assessProgram({ program: program(), profile: budgetProfile, assessedAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(withinBudget.tuition.outcome, 'eligible');

  const overBudget = assessProgram({
    program: program({ tuition: { amount: 16000, currency: 'GBP', period: 'per academic year', evidence } }),
    profile: budgetProfile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(overBudget.tuition.outcome, 'ineligible');

  const differentCurrency = assessProgram({
    program: program({ tuition: { amount: 12000, currency: 'EUR', period: 'per academic year', evidence } }),
    profile: budgetProfile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(differentCurrency.tuition.outcome, 'unclear');
  assert.match(differentCurrency.tuition.reasons.join(' '), /no exchange-rate conversion was inferred/i);
});

test('keeps GPA and tuition unknown when the profile omits its grading scale or annual budget', () => {
  const incompleteProfile = structuredClone(profile);
  incompleteProfile.applicant.degree.gpaScale = null;
  incompleteProfile.applicant.target.maxAnnualTuition = null;
  incompleteProfile.applicant.target.tuitionCurrency = '';

  const result = assessProgram({
    program: program(), profile: incompleteProfile, assessedAt: '2026-10-20T00:00:00.000Z',
  });

  assert.equal(result.admissions.outcome, 'unclear');
  assert.match(result.admissions.reasons.join(' '), /GPA or grading scale is not provided/i);
  assert.equal(result.tuition.outcome, 'unclear');
  assert.match(result.tuition.reasons.join(' '), /annual budget or currency is not configured/i);
});

test('marks a known incompatible funding preference and passed deadline ineligible', () => {
  const result = assessProgram({
    program: program({
      fundingRoutes: [{ type: 'self-funded', name: 'Self-funded route', evidence }],
      deadline: { date: '2026-01-15T00:00:00.000Z', evidence },
    }), profile, assessedAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(result.funding.outcome, 'ineligible');
  assert.equal(result.deadline.outcome, 'ineligible');
  assert.equal(result.overall, 'ineligible');
});

test('program JSON import requires reviewed HTTPS evidence for each entered fact', () => {
  const imported = parseProgramRecord({
    id: 'imported-program', institution: 'Example University', name: 'MSc Example', country: 'Exampleland', intake: 'Fall 2027',
    admissions: { minimumClassification: '2:2', evidence },
  });
  assert.equal(imported.admissions?.minimumClassification, '2:2');
  assert.throws(() => parseProgramRecord({
    id: 'unsafe-program', institution: 'Example University', name: 'MSc Example', country: 'Exampleland', intake: 'Fall 2027',
    deadline: { date: '2027-01-15', evidence: { ...evidence, verification: 'unreviewed' } },
  }), /verification must be reviewed/);
  assert.throws(() => parseProgramRecord({
    id: 'unsafe-program', institution: 'Example University', name: 'MSc Example', country: 'Exampleland', intake: 'Fall 2027',
    tuition: { amount: 10000, currency: 'GBP', period: 'year', evidence: { ...evidence, sourceUrl: 'http://university.example.edu/fees' } },
  }), /must be an HTTPS URL/);
});
