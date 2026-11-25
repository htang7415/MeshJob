# MeshJob 1.0 verification

The unpacked extension, repeatable build, source, public-source probes, and sandbox tests are available for owner evaluation. Public release approval remains with the owner. No test application or recruiter message was sent to a real employer.

## Live observations

| Sample | Observed result |
| --- | --- |
| Public board reference probe | 31 of 48 candidate board endpoints returned HTTP 200 in the initial probe. The packaged company catalog contains those 31 boards. |
| Final public snapshots | 35 of 35 sources responded successfully in the final pass. This covered 31 ATS boards, three optional GitHub lists, and one RSS feed. Across the ATS boards, the adapter found all 7,519 of 7,519 eligible public IDs independently parsed from a separate request to each documented API. |
| Snapshot service time | Median 205 ms and P95 1,559 ms across 35 successful adapter checks, concurrency four. An earlier pass recorded a Lever timeout. Those measurements cover requests and parsing. |
| Timestamp coverage | 0 of 7,519 ATS records had a reliable original publication timestamp in the catalog snapshots. Ashby calls its API field the time the job was last published. Greenhouse's updates and other listing signals are retained separately. |
| RSS | We Work Remotely returned 97 attributed records. The Remotive URL returned HTTP 404 during the probe. |
| Public forms | The scanner read controls on all six sampled public forms across Greenhouse, Ashby, and Lever. Four scanned with a GET-only page policy. Both Ashby forms scanned on a repeat that allowed their observed public job-detail GraphQL read queries. Page writes remained blocked and no data was entered. |

The checks used macOS 27.2.1 (26B131), Apple M4, 16 GiB RAM, and Node 25.2.1. Browser measurements used Google Chrome 158.0.8127.37. Earlier observations used Chrome for Testing 159.0.8154.6. Evidence timestamps are UTC. [Initial endpoint probe](reference-baseline.json), [Earlier adapter pass](live-snapshot.json), [Final adapter pass](live-snapshot-final.json), [RSS](live-rss.json), [First form run](live-forms.json), [GET-only repeat](live-forms-final.json), [Ashby public read-query repeat](live-ashby-query.json)

## Browser and build results

- **23 of 23 domain and state checks and 2 of 2 browser tests passed.** The extracted release opened in a fresh Chrome profile with no site grants, credentials, or account. The packaged PDF worker extracted fixture text. In Finished mode, CSV and ZIP exports worked offline, and backup preview verified the exported archive. Finished persisted after reload.
- **Autofill** verified 560 of 560 standard fields, 240 of 240 critical-field assertions, and 80 of 80 selected PDF filenames across 80 intercepted form variants, 20 per ATS family. P95 active fill was 2.7 ms. P95 from ready tab through scanning, saving a draft, filling, and reading the DOM was 428.5 ms. This timed fixture flow excluded site navigation, human review, AI, and employer network work.
- **Workday** reached review in both the checkpoint exercise and the guided Side Panel exercise on the multi-page fixture. Repeated row preparation kept the intended row count. The suite observed zero automatic final submissions and zero outbound application requests. A separate human click produced the only sandbox receipt used to verify Applied.
- **Dashboard** rendered warm local data at P95 49.2 ms over 20 navigations with 3,000 jobs. New extension tabs in an already-running browser rendered at P95 271.6 ms over six loads. This excludes Chrome process startup. Light, dark, narrow-width, reduced-motion, and keyboard smoke checks covered the main results view. The narrow view keeps search visible and collapses advanced filters by default.
- **Reproducibility** was verified with two clean output directories after a fresh lockfile install. Their ZIPs were byte-for-byte identical. The tested archive SHA-256 is `187a9e1ffb5c8d5b066ad9d6ee9ed7d59fd6fde23215ab314612b40a652fb209`. See the README for build, setup, permissions, and OAuth instructions.

[Browser measurements](browser-final.json), [Extracted archive smoke](browser-release.json)

## Other local and fixture checks

- The initial filter retained 64 of 72 labeled positives before tuning and 72 of 72 after alias changes, across 120 authored cases and 12 role families. It retained 87 roles overall, for initial-screen precision of 72 of 87. These cases were used during tuning. The results establish regression coverage for these cases.
- The offline email classifier matched 96 of 96 labeled categories after tuning on the authored set. It alerted on 60 of 60 expected urgent cases, including 12 ambiguous cases, with 60 correct alerts among 60 issued. The corpus contains 108 synthetic messages and no mailbox data. Separate fixtures exercise ambiguous matches, third-party senders, cursor recovery, and the commit-before-modify rule.
- The receipt classifier matched all 128 expectations across valid signatures, generic and conditional copy, visible final controls, and untrusted markers. The browser also exercised a trusted click and receipt on an intercepted form. Opening a draft or clicking a final control without a recognized receipt cannot itself establish Applied.
- Identity fixtures cover duplicate imports and concurrent saves, cross-source aliases, distinct requisitions with the same employer and title, snapshot gaps, and reused IDs. Sponsorship fixtures cover unknowns, text conflicts, historical evidence, and explicit current-role evidence.
- Lifecycle fixtures cover cancellation of an in-flight automatic request, rejection of obsolete-generation commits, notification suppression, and data availability after stopping. CSV and ZIP tests cover formulas, Unicode, quoting, multiline fields, checksums, secrets, PDF content, and application history.
- Claude fixtures exercise request reservation, local caps, and usage reconciliation. They used a mocked endpoint and incurred no provider charges.

[Initial authored metrics](authored-initial.json), [Current authored metrics](authored-current.json), [Domain tests](../test/domain.test.mjs), [Storage and worker tests](../test/state.test.mjs), [Browser suite](../test/browser.e2e.mjs)

## Remaining acceptance work

- **Discovery latency and Recall@24h.** The current run proves live snapshot coverage. It has zero eligible exact publication timestamps and no continuous, independent seven-day observation series. Live posting-to-discovery P50/P95 and verified-new recall are unmeasured.
- **Matching.** No paid Claude calls or independently labeled recommendation study were run. An owner-supplied held-out corpus is needed to measure the initial filter independently and evaluate the 90% recommendation precision target. The reported initial filter precision measures the first pass only.
- **Workday and application forms.** Workday list pagination, row behavior and next/review boundaries are fixture-tested. No tenant with verified permission for automated list checks or a permitted end-to-end test application was supplied. The selected Ashby forms rendered when their public job-detail read queries could complete. Embedded frames, custom widgets, external upload flows, authentication and CAPTCHA can require manual completion. Live fills and live employer submissions remain unverified.
- **Gmail.** No authorized Google OAuth client, test mailbox, or anonymized real-message corpus was available. The Gmail install/consent flow, real linking/classification accuracy, OS notifications from Gmail, and the six-minute live target remain unverified. The default build excludes a client ID. Public use of restricted scopes requires the applicable Google review.
- **Portability and limits.** The browser retains data on this profile. Backups restore public sources disabled until reviewed. Uncompressed ZIP import is bounded at 512 MB. Per-file storage accepts PDFs up to 60 MB, and automatic transfer supports up to 24 MB. A site can reject a supported file. App-side cost estimates can differ from provider billing.
- **Distribution.** The ZIP is ready for unpacked installation and owner evaluation. Chrome Web Store review and public publishing remain open.

The independent corpus harness runs local labeled files without uploading them. A role row contains `job`, `preferences` and a boolean `relevant`. A mail row contains `mail`, `applications`, optional `history`, expected `category`, boolean `urgent`, and expected `applicationId` or null. Use `node scripts/verify-corpus.mjs roles|mail /path/to/labeled.json`.
