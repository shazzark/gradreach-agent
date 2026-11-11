# Opportunity discovery source hosts

Reviewed 2026-11-11. Discovery accepts only HTTPS result URLs whose hostname exactly matches a host below or the existing per-country university allowlist in `src/config/official-host-allowlist.ts`. Redirected pages are checked against the same host list before their content is used.

| Type | Host | Official source used to verify the host |
|---|---|---|
| University MSc programs | Existing country-specific allowlist | Evidence and coverage are maintained in [Phase 3 allowlist review](phase-3-allowlist.md). |
| Scholarship | `erasmus-plus.ec.europa.eu` | [Erasmus Mundus Joint Masters](https://erasmus-plus.ec.europa.eu/opportunities/individuals/students/erasmus-mundus-joint-masters) |
| Scholarship | `www2.daad.de` | [DAAD scholarship database](https://www2.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database/) |
| Company graduate and early-career programs | `careers.microsoft.com` | [Microsoft recent graduates careers](https://careers.microsoft.com/v2/global/en/recentgraduate) |

Scholarship and company pages must also state or otherwise confirm the selected country in the official page excerpt. Result titles and provider descriptions are not used as evidence. This list is intentionally small; adding another host requires checking its first-party careers, program, or scholarship page and adding a source reference here.
