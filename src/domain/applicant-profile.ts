export interface ApplicantProfile {
  applicant: {
    fullName: string;
    email: string;
    phone: string;
    nationality: string;
    currentLocation: string;
    degree: {
      title: string;
      institution: string;
      country: string;
      graduationYear: number | null;
      classification: string;
      gpa: number | null;
      gpaScale: number | null;
      gradingScaleDocument: string;
    };
    target: {
      degreeLevel: 'masters';
      intake: string;
      fields: string[];
      researchInterests: string[];
      countries: string[];
      fundingTypes: string[];
      maxAnnualTuition: number | null;
      tuitionCurrency: string;
      timezone: string;
    };
    englishEvidence: {
      testStatus: string;
      testName: string;
      score: string;
      testDate: string;
      mediumOfInstructionLetter: string;
    };
    documents: {
      academicCvPath: string;
      transcriptPath: string;
      portfolioUrl: string;
      githubUrl: string;
      projectUrls: string[];
    };
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new Error(`${label}.${key} must be a string`);
  return value;
}

function nullableNumberField(source: Record<string, unknown>, key: string, label: string): number | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number or null`);
  }
  return value;
}

function stringArrayField(source: Record<string, unknown>, key: string, label: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label}.${key} must be an array of strings`);
  }
  return value;
}

function countryArrayField(source: Record<string, unknown>, key: string, label: string): string[] {
  const countries = stringArrayField(source, key, label);
  const normalized = countries.map((country) => country.trim().toLocaleLowerCase('en'));
  if (countries.some((country) => !country.trim())) {
    throw new Error(`${label}.${key} entries must not be empty`);
  }
  if (countries.some((country, index) => country !== country.trim()) || new Set(normalized).size !== countries.length) {
    throw new Error(`${label}.${key} entries must be trimmed and unique`);
  }
  return countries;
}

/** Validates local profile JSON at runtime; TypeScript types alone do not validate file contents. */
export function parseApplicantProfile(value: unknown): ApplicantProfile {
  const root = record(value, 'profile');
  const applicant = record(root.applicant, 'profile.applicant');
  const degree = record(applicant.degree, 'profile.applicant.degree');
  const target = record(applicant.target, 'profile.applicant.target');
  const englishEvidence = record(applicant.englishEvidence, 'profile.applicant.englishEvidence');
  const documents = record(applicant.documents, 'profile.applicant.documents');

  const degreeLevel = stringField(target, 'degreeLevel', 'profile.applicant.target');
  if (degreeLevel !== 'masters') throw new Error('profile.applicant.target.degreeLevel must be masters');
  const timezone = stringField(target, 'timezone', 'profile.applicant.target');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('profile.applicant.target.timezone must be a valid IANA timezone');
  }
  const maxAnnualTuition = target.maxAnnualTuition === undefined ? null : nullableNumberField(target, 'maxAnnualTuition', 'profile.applicant.target');
  const tuitionCurrency = target.tuitionCurrency === undefined ? '' : stringField(target, 'tuitionCurrency', 'profile.applicant.target');
  if (maxAnnualTuition !== null && maxAnnualTuition < 0) throw new Error('profile.applicant.target.maxAnnualTuition must not be negative');
  if (maxAnnualTuition !== null && !tuitionCurrency.trim()) throw new Error('profile.applicant.target.tuitionCurrency is required when maxAnnualTuition is set');

  return {
    applicant: {
      fullName: stringField(applicant, 'fullName', 'profile.applicant'),
      email: stringField(applicant, 'email', 'profile.applicant'),
      phone: stringField(applicant, 'phone', 'profile.applicant'),
      nationality: stringField(applicant, 'nationality', 'profile.applicant'),
      currentLocation: stringField(applicant, 'currentLocation', 'profile.applicant'),
      degree: {
        title: stringField(degree, 'title', 'profile.applicant.degree'),
        institution: stringField(degree, 'institution', 'profile.applicant.degree'),
        country: stringField(degree, 'country', 'profile.applicant.degree'),
        graduationYear: nullableNumberField(degree, 'graduationYear', 'profile.applicant.degree'),
        classification: stringField(degree, 'classification', 'profile.applicant.degree'),
        gpa: nullableNumberField(degree, 'gpa', 'profile.applicant.degree'),
        gpaScale: nullableNumberField(degree, 'gpaScale', 'profile.applicant.degree'),
        gradingScaleDocument: stringField(degree, 'gradingScaleDocument', 'profile.applicant.degree'),
      },
      target: {
        degreeLevel,
        intake: stringField(target, 'intake', 'profile.applicant.target'),
        fields: stringArrayField(target, 'fields', 'profile.applicant.target'),
        researchInterests: stringArrayField(target, 'researchInterests', 'profile.applicant.target'),
        countries: countryArrayField(target, 'countries', 'profile.applicant.target'),
        fundingTypes: stringArrayField(target, 'fundingTypes', 'profile.applicant.target'),
        // Older private profiles remain readable and simply leave affordability unresolved.
        maxAnnualTuition,
        tuitionCurrency,
        timezone,
      },
      englishEvidence: {
        testStatus: stringField(englishEvidence, 'testStatus', 'profile.applicant.englishEvidence'),
        testName: stringField(englishEvidence, 'testName', 'profile.applicant.englishEvidence'),
        score: stringField(englishEvidence, 'score', 'profile.applicant.englishEvidence'),
        testDate: stringField(englishEvidence, 'testDate', 'profile.applicant.englishEvidence'),
        mediumOfInstructionLetter: stringField(englishEvidence, 'mediumOfInstructionLetter', 'profile.applicant.englishEvidence'),
      },
      documents: {
        academicCvPath: stringField(documents, 'academicCvPath', 'profile.applicant.documents'),
        transcriptPath: stringField(documents, 'transcriptPath', 'profile.applicant.documents'),
        portfolioUrl: stringField(documents, 'portfolioUrl', 'profile.applicant.documents'),
        githubUrl: stringField(documents, 'githubUrl', 'profile.applicant.documents'),
        projectUrls: stringArrayField(documents, 'projectUrls', 'profile.applicant.documents'),
      },
    },
  };
}

