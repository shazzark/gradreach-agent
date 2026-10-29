# Program record format

Use the dashboard's **Import and assess reviewed program JSON** option to add or update a program. Each included fact requires an HTTPS source URL, the date checked, an excerpt, an uncertainty note, and `"verification": "reviewed"`. Only enter `"uncertainty": ""` when you have no unresolved ambiguity in that fact. Review the university source yourself before setting the verification field; the importer does not fetch or validate the page.

A minimal record can omit facts. Those assessment categories will remain `unclear` until supported facts and evidence are added:

```json
{
  "id": "institution-program-intake",
  "institution": "Institution name",
  "name": "Program name",
  "country": "Country",
  "intake": "Fall 2027"
}
```

Optional facts are stored under `admissions`, `english`, `tuition`, `fundingRoutes`, and `deadline`. Every fact object includes its own `evidence` object:

```json
{
  "admissions": {
    "minimumClassification": "2:2",
    "minimumGpa": { "value": 3.0, "scale": 4.0 },
    "evidence": {
      "sourceUrl": "https://replace-with-the-official-university-host.example/admissions",
      "checkedAt": "2026-10-20T12:00:00.000Z",
      "excerpt": "Replace with the exact relevant official text.",
      "uncertainty": "",
      "verification": "reviewed"
    }
  },
  "english": {
    "acceptedTests": [{ "name": "IELTS Academic", "minimumScore": 6.5 }],
    "evidence": { "sourceUrl": "https://replace-with-the-official-university-host.example/english", "checkedAt": "2026-10-20T12:00:00.000Z", "excerpt": "Replace with official text.", "uncertainty": "", "verification": "reviewed" }
  },
  "tuition": {
    "amount": 12000,
    "currency": "GBP",
    "period": "per academic year",
    "evidence": { "sourceUrl": "https://replace-with-the-official-university-host.example/fees", "checkedAt": "2026-10-20T12:00:00.000Z", "excerpt": "Replace with official text.", "uncertainty": "", "verification": "reviewed" }
  },
  "fundingRoutes": [{
    "type": "scholarship",
    "name": "Scholarship name",
    "applicantEligibility": "unclear",
    "evidence": { "sourceUrl": "https://replace-with-the-official-university-host.example/funding", "checkedAt": "2026-10-20T12:00:00.000Z", "excerpt": "Replace with official text.", "uncertainty": "Eligibility conditions need manual assessment.", "verification": "reviewed" }
  }],
  "deadline": {
    "date": "2027-01-15T23:59:00.000Z",
    "evidence": { "sourceUrl": "https://replace-with-the-official-university-host.example/deadlines", "checkedAt": "2026-10-20T12:00:00.000Z", "excerpt": "Replace with official text.", "uncertainty": "", "verification": "reviewed" }
  }
}
```

Replace all example URLs, excerpts, dates, and values with facts you have checked; the reserved `.example` host in this shape is not a real source. The assessment never converts GPA or currency scales and does not read transcript files. Tuition affordability is compared only when `maxAnnualTuition` and `tuitionCurrency` are set in the private applicant profile and the source amount is annual.
