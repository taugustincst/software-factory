---
name: synthetic-data
description: Generate realistic but clearly synthetic test data (patients, members, providers, encounters, people) that can never be mistaken for real PHI or PII. Use when writing fixtures, seed data, demos, or sandbox datasets.
---

# Synthetic data

Real people's data never goes into code, fixtures, screenshots or prompts. Use generated data that is obviously synthetic to a reviewer and to automated scanners.

Identifiers:

- **SSN:** area 900-999 only (`9XX-XX-XXXX`), which the SSA never issues. The factory guard hook blocks other SSN-shaped values.
- **MRN / member IDs:** prefix `TEST-` or `SYN-`, e.g. `SYN-000123`.
- **Phone:** `555-01XX` numbers (reserved for fiction), e.g. `(916) 555-0142`.
- **Email:** `@example.com`, `@example.org` (reserved by RFC 2606).
- **Names:** a fixed list of fictional names; never pull from real rosters.
- **Dates of birth:** generated, and shift every fixture date by a random offset if derived from any real dataset.
- **Addresses:** real city/state for realism, street `123 Example St`; ZIP of the city's real prefix + `00`.
- **Clinical codes:** real ICD-10, CPT, LOINC, RxNorm codes are fine (they are public vocabularies); combine them randomly so no record mirrors a real patient.

Generation:

- Seed the random generator so fixtures are reproducible (`faker.seed(42)`, `Faker.seed(42)`).
- Keep fixtures small and purpose-built for each test; share generators, not giant JSON blobs.
- Label datasets: a `synthetic: true` field or a `README` stating the data is fabricated.
