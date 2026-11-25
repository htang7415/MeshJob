# MeshJob 1.0 — Product & Engineering Specification

**Status:** Development baseline · 2026-11-25  
**Product:** Open-source, local-first Chrome extension for job discovery, application autofill and career tracking.  
**Mission:** Find the right job early and complete an accurate application with minimal friction.  
**Principles:** Fast · Lightweight · Intelligent · Reliable · Private · Beautiful.

This specification supersedes earlier design iterations. Requirements use **must**; recommended defaults are configurable unless stated otherwise. All performance targets are acceptance goals, not claims of implemented performance.

## 1. Scope and success

Build a usable end-to-end product: **Discover → Match → Prepare → Autofill → Human Submit → Track → Analyze → Finish Job Search.**

Priority order: (1) discovery latency and recall; (2) autofill speed and correctness; (3) complete application tracking and urgent email notifications; (4) actionable analytics and portability. All are in scope for 1.0. Ship a complete, tested workflow rather than disconnected demos.

- Users independently install and run MeshJob; no MeshJob account, mandatory server, central job database, maintainer API key, paid platform subscription or runtime dependency on the MeshJob GitHub repository.
- Users bring their own Claude API key and optionally connect Gmail. Direct discovery, manual import, deterministic autofill, tracker and export work without AI or Gmail.
- Support arbitrary professions, seniority, locations and visa needs through user preferences. Do not hard-code the owner's profession, US location, or new-grad criteria. Initial validated geography for official visa-history evidence is the US; outside the US use role/company evidence or Unknown. Do not imply comprehensive global source coverage.
- Non-goals: generate/tailor resumes or cover letters, auto-submit applications, bypass CAPTCHA/access controls, auto-send recruiter emails, build a password manager, broad unauthorized scraping, shared accounts, cloud synchronization, vector DB, multi-agent framework, or commercial platform. No always-on guarantee when Chrome or the device is stopped.

## 2. Experience and onboarding

Use four top-level Dashboard tabs in a full browser tab and one application Side Panel. Clicking the extension icon opens the relevant assistant or Dashboard. Use Apple-inspired clarity, deference to content and consistent interactions: system fonts, generous spacing, restrained neutral palette, meaningful status colors, light/dark system themes, accessible focus, keyboard navigation, reduced motion, readable contrast, responsive layouts and subtle transitions. Avoid an AI chat homepage, decorative cards and excessive settings. Keep network/AI work asynchronous, show meaningful progress and allow cancellation; cached local content renders immediately.

| Surface | Primary experience |
|---|---|
| Discover | Newest verified matches, posting/observation time, company, title, location, salary if known, match score, sponsorship evidence, official Apply, Save/Hide; search, filters, source management and refresh |
| Tracker | Searchable/filterable table, status/history, manual edit/add, duplicate warning, urgent Action Required queue, email links, CSV import/export |
| Stats | Application counts, funnel/cohorts, outcomes by role/material/source, discovery and application latency, AI usage/cost |
| Profile | Personal details, preferences, PDFs, answers, integrations, schedule/budget, data and service controls |
| Side Panel | Detect job/form, import, choose PDFs, autofill, progress and exceptions, review and submission evidence; fallback to manual tracking |

Onboarding: enter target titles (free-text and suggested presets), location, level and employment type; choose work arrangement and sponsorship needs; add optional profile/materials; accept or customize bundled source catalog; optionally enable Claude and Gmail. Allow skip and edit later. The default display freshness is 24h; make the window configurable. Do not silently assume a country, sponsorship requirement or citizenship. No mandatory external account for basic use.

Preferences: multi-valued role titles, seniority, employment type, countries/regions/cities, remote/hybrid/on-site, minimum compensation (currency and period), freshness, sponsorship requirement (required/not required/unspecified), optional preferred industries/companies/skills and excluded companies/titles. Advanced preferences hidden by default. The owner's example: US full-time SWE/AI Infra/AI Engineer/MLE/FDE, new grad/entry level, sponsorship opportunity, 24h. Not a global default.

Separate persistent discovery preferences from temporary view filters. Explicit exclusion only when evidence proves a hard constraint fails; unknown salary/location/level/sponsorship is labeled and retained for review unless a user opts into strict exclusion. Strict verified freshness view does not present unverifiable jobs as newly posted. Title aliases expand recall (e.g. AI Infra → inference/ML systems); allow free-text overrides. No fit score is a probability of hiring.

## 3. Discovery engine (primary differentiator)

### 3.1 Sources and scheduling

| Source | Adapter | Default cadence |
|---|---|---|
| Greenhouse | Public Job Board API, board token | 10 min |
| Ashby | Public Job Posting API, board name | 10 min |
| Lever | Public Postings API, site and regional endpoint | 10 min |
| Workday | Permitted public careers-page interface; tenant/site, full pagination | 10 min where permitted |
| Careers/RSS | RSS/Atom, public JobPosting JSON-LD or supported listing parser | 10 min where permitted |
| GitHub lists | Public Markdown/list and conditional requests, supported layouts | 10 min subject to rate limits |
| Claude Web Search | Preference-directed queries and source URLs | 08:30, 10:30, 12:30, 14:30, 16:30, 18:30 local time |
| User import | Current job/application tab or pasted URL, manual fallback | On demand |
| Gmail | Incremental sync (section 7) | 5 min |

- Direct sources are primary for latency; AI search complements coverage and discovers new employers. Six AI rounds/day, configurable. Use local wall-clock scheduling including DST/timezone changes; no duplicate slot or burst replay after sleep; run one bounded catch-up for overdue direct/email tasks. Missed AI slots are not replayed automatically. Offer manual Search Now subject to budget. All schedules disabled in paused/finished mode.
- Use Chrome alarms + MV3 service worker. Persist checkpoints, scheduler state and next eligible run; recreate alarms on startup/update when active. Stagger source checks, prevent overlapping runs, use bounded concurrency, timeouts, retry/backoff with jitter, Retry-After and conditional requests where supported. Respect terms, source policies and limits; no CAPTCHA bypass, login automation for scraping, or attempts to circumvent blocks. Workday interfaces are not guaranteed stable public APIs. Unsupported sites require manual import or a supported source, not a false success.
- Distinguish last attempt, last successful complete snapshot, next attempt and errors. Never turn an incomplete fetch, failed page or partial pagination into a mass-close or false-new event. Keep last good snapshot. User can disable/remove a source independently. UI exposes stale sources and last successful check; no silent skip.
- Chrome alarms cannot guarantee exact execution during shutdown/sleep or throttling; resume automatically only if search mode is active. No required background server or GitHub Actions collector. CI may use GitHub Actions for builds/tests, not runtime.

### 3.2 Source onboarding and coverage

Ship a versioned, editable local catalog of verified public company boards and supported source presets, with evidence of source URL and access method. Include the following optional new-grad GitHub sources, not mandatory for all professions:

- https://github.com/SimplifyJobs/New-Grad-Positions
- https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md
- https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/NEW_GRAD_USA.md

Include YC/other public sources where permitted and supported; otherwise discover via AI or user import. Do not crawl LinkedIn, Jobright or Simplify private/restricted databases. External links discovered by users or AI are valid leads. Catalog is packaged, not fetched from MeshJob GitHub at runtime. Do not claim catalog completeness; document validated source count and supported ATS.

Source controls: Add URL, paste multiple URLs (one per line), import CSV/source pack, export source list, enable/disable, set interval, test connection. User can paste an official Careers URL, ATS board URL, RSS/Atom URL, or GitHub repo/file; detect platform from URL/page and normalize board identifiers; request origin permissions only when needed; preview company/board and connection status before activation. When detection is ambiguous, request board URL or adapter selection. Deduplicate source IDs. Show source status and last successful check. No arbitrary custom script execution from source packs.

### 3.3 Incremental collection and freshness

Fetch full listing metadata where an API returns all jobs; do not persist every full JD or send it to AI. On first successful complete snapshot, establish a baseline for all active IDs, evaluate recent verified jobs, and avoid marking all existing jobs new. On subsequent successful snapshots detect new, changed, absent and reopened IDs; extract JD for candidates only (some APIs return JD inline: discard noncandidate text). If preferences change, re-filter current compact index and fetch relevant descriptions again. Preserve minimal closed-job tombstones and application links; do not advertise an old or reopened/reposted ID as newly created without proof. An ID reuse with materially different role needs review.

Normalize provider, tenant/site, job ID/requisition, canonical application URL, company, title, location, work mode, employment type, salary (optional), and timestamp evidence. Use provider+tenant+job ID as primary identity; normalized official URL as alternate; merge cross-source records only on reliable identity evidence. Same company/title alone is insufficient. Strip tracking parameters only if known nonessential; preserve meaningful query IDs. Record provenance and earliest observation across sources.

| Timestamp | Meaning |
|---|---|
| posted_at | Original posting timestamp or source-supported time range with precision and evidence |
| first_seen_at | First observation by MeshJob, not posting time |
| last_absent_at | Previous complete successful snapshot in which the exact job was absent |
| updated_at | Source modification time; never substitute for posted_at |
| notified_at | When notification was issued |
| applied_at | Actual submission time or user/confirmation evidence |

If exact original time is unavailable, an uninterrupted complete prior snapshot can bound when a job appeared on that board, not prove its original publication time elsewhere. Present a separate 'Newly detected' label and interval; no false verified 24h claim. Separate verified recent, newly detected and unknown-date items. Relative dates with insufficient precision cannot establish strict age. GitHub commit time/search index time are discovery signals only. Verify original official link and active status before high-confidence display/notification. Preserve evidence fields. AI leads without reliable date/active evidence are reviewable, not verified matches.

### 3.4 Filtering and matching pipeline

Listing metadata → stable identity/diff → cheap title/level/location/time filters → candidate JD and explicit exclusions → Claude match when useful → display/notify. Use a shared predicate engine for direct sources, AI leads and user preferences. Avoid filtering ambiguous titles or missing data too aggressively; held-out recall test required. Search queries are targeted to role synonyms, geography, seniority and fresh official postings; do not ask the model to enumerate unrelated jobs. Existing applications suppressed in Discover by default, visible with explicit toggle; warn before a repeat application. Allow import/track even if outside discovery filters.

Use one AI request per eligible unique JD revision to assess fit and recommend existing materials. Return structured output: skill/experience/seniority/domain subscores 0–100, brief evidence strengths and gaps, confidence, recommended resume ID, optional cover letter ID, visa assessment with evidence refs. Calculate match score in code (40% skills, 30% relevant experience, 20% seniority, 10% domain; provisional rubric validated with held-out roles). Use best supported resume; explicit hard constraints independent of score. No fabricated credentials or overly precise hiring probability. Cache by normalized JD hash + profile/preferences/material revision + rubric/model version; invalidate on substantive change. If AI off/unavailable, display rules-qualified jobs as Unscored and allow manual selection; do not block timely notification for a potentially relevant verified new job waiting on AI.

Sponsorship: distinguish current work authorization/OPT, STEM OPT eligibility/acceptance, future H-1B (when relevant). Current role JD and explicit recruiter/company policy outrank history; resolve conflicts conservatively. USCIS/DOL historical evidence is optional US enrichment, not current-role confirmation. Match employer legal entity carefully; retain source/date. States: Confirmed (role-specific positive evidence), Likely (credible positive evidence), Unknown (insufficient/conflicting evidence), Not Supported (explicit applicable exclusion). Lack of records or startup age/size is never negative evidence. Retain Unknown by default for sponsorship-seeking users. Official dataset snapshots may be imported or bundled when permitted; no maintainer-dependent service. Do not infer legal eligibility.

### 3.5 AI and cost

Use Claude API through a small provider module. Choose current supported lightweight model for matching/field mapping/email classification; configurable model for harder open-ended questions. No required multi-agent orchestration. Methods: searchJobs, evaluateJob, mapFields, draftAnswers, classifyEmail. Validate structured outputs with Zod; unknown answers are unresolved, never guessed. Search uses explicit caps (default 3 actual web searches/round, 6 rounds/day); bound fetches, output/context tokens, retries, per-run and daily/monthly cost. Default $10/month app-side budget, editable. Estimate/reserve spend before calls and reconcile actual usage including search tools; stop paid calls when budget reached, but continue free discovery and local workflows. App-side cap is not a provider billing guarantee; disclose estimated/unpriced usage and provider controls.

Extract PDF text locally once; send only relevant text or concise profile/material facts and JD excerpts, not raw PDFs, email inbox, passwords or unrelated profile fields. Combine match + material selection; use stable prompt/cache where available, no repeated analysis on identical content. Batch unfamiliar fields on a page. Example planning assumption: 180 rounds × 3 searches = 540 monthly actual searches max scheduled, before manual tasks; at $0.01/search, tool-only $5.40 plus token charges. Verify model/tool pricing and capabilities at implementation, do not hard-code stale prices; show usage and cost. AI search may return incomplete/stale leads, not a replacement for direct monitoring.

## 4. Profile, PDF materials and answers

Store user-editable contact details, education, work experience, skills, links, work authorization answers and preferences. Sensitive/optional fields are opt-in; never infer demographic or legally significant answers. Resume and cover letter are **PDF only** for 1.0, unlimited by arbitrary count (subject to device quota), with local Blob, filename, type, label/tags, hash, parsed text and revision. Validate MIME/content and handle unextractable/scanned PDFs with manual tags/text; no OCR requirement. User can upload, preview, replace, delete and choose defaults. AI recommends existing IDs; never creates or modifies a document. Upload selected original PDF where accepted; when a site requests cover letter text, use locally extracted text only with preview or user input. Do not send binary to Claude. Preserve applied material names/revisions in history even if later deleted.

Answer bank: store verified question/answer, context (company/role/global), type and revision. Exact or unambiguous reusable answers first; similarity is a suggestion, not authority. Draft factual open-ended answers from user-provided facts only, with human review. Do not invent qualifications or use a generic yes/no for legally distinct questions. No automatic saving of AI drafts as verified answers.

Registration: Chrome Password Manager owns login/credential storage by default. Fill configured email on verified registration forms. Support user-triggered password/confirmation fill with an optional reusable password. Default session-only; if user explicitly chooses persistent convenience, allow a separate local-only opt-in setting with clear warning about plaintext and password reuse, never synced or exported. This is not a secure vault; recommend unique browser-generated credentials. Keep access restricted to trusted extension contexts; only deliver value to the explicitly authorized verified registration form, never to AI/logs/analytics, never read Chrome's vault. No automatic registration submission, CAPTCHA bypass, or credential entry on unverified origins. No sensitive credential in repository or fixtures.

## 5. Autofill engine (second differentiator)

Generic scanner uses DOM, labels, ARIA, input types, autocomplete, required state and visible controls. Per-ATS adapters for Greenhouse, Ashby, Lever, Workday handle dynamic widgets, upload, repeated experience/education rows, page transitions and confirmation patterns. Generic fallback for other sites: user-triggered best-effort fill with manual review, not guaranteed. Keep adapter methods small: detect, scan, fill, verify, advance (non-final), detectSubmission.

Flow: detect job/form → import/upsert draft → select PDFs → scan → map profile/verified answers → fill deterministically → verify actual DOM values/validation → batch unresolved questions for optional AI → preview/confirm → advance non-final pages if enabled → stop at review/submit. Use native setters/events as appropriate, MutationObserver with bounded waits, handle dependent selects and dynamic rows. Never overwrite prefilled/manual edits silently. Verify upload filename/acceptance and actual selected values; unsupported file controls require manual upload. No final submit, certification/consent, or account creation click automatically. Stop on login, CAPTCHA, unclear consent, validation error, unknown critical answer or changed page identity. Cancel/resume Workday by checkpoint, not blind retries. No duplicate experience rows on retry. Show filled/required/unresolved/failed counts and actionable errors. Critical fields (work authorization, sponsorship, legal/EEO/consent) use explicit verified user answers only; unanswered fields remain unresolved. Keep user in control, prevent two concurrent fill operations on same tab.

## 6. Tracker, import, dedup and analytics

Any job discovered outside MeshJob can be saved/imported by current tab, paste URL, or manual entry, including LinkedIn and other platforms. Capture source attribution when available; do not scrape private feeds. On official application page, extract company/title/requisition/URL where possible; allow editing and association with an existing job. Autofill creates Preparing draft, not Applied. Only specific ATS confirmation page/receipt (or user confirmation or matched application email) establishes submitted status. Generic thank-you text and clicking Submit alone are insufficient. Use idempotent events and explicit correction; if confirmation missing, Needs Check. Do not silently merge same-company different roles. Track actual PDFs used or Unknown if user uploaded externally.

Application lifecycle: Saved / Preparing / Applied / OA / Interview / Offer / Rejected / Withdrawn / Accepted. Track submission evidence separately (unverified/submitted/confirmed/needs_check) and Action Required separately from stage. Stages are not a strictly linear funnel; OA/interview can repeat or occur out of order. Preserve dated events and derive current stage using verified chronology and user corrections; old confirmation must not regress Interview/Offer; conflicting terminal events go to review. User can correct status and undo mistaken sync; keep audit history.

Stats from actual records/events only: applications per day/week, stage outcomes, interview and offer rates per application cohort, breakdown by role/material/source, source unique job and discovery speed, posting-to-discovery / discovery-to-application / active autofill duration (where measured), API usage/cost. Define denominators and sample counts; separate verified timestamps from bounded observations; do not treat unobserved outcome as rejection or infer causal resume performance from small samples. Exclude drafts from submitted application counts; count distinct applications reaching a stage, not duplicate events.

## 7. Gmail integration and urgent notifications

Optional OAuth with minimum necessary scopes: read-only for tracking; explicit upgrade to modify for marking read. No mailbox access until consent. Use Gmail incremental history/cursor with bounded recovery when cursor expires, narrow recruitment queries and dedup by message ID; never persist entire mailbox. Provide configurable sync scope and last sync/errors. Public release may require Google OAuth verification, including restricted-scope review; support user-owned OAuth client setup where feasible, document extension ID/redirect configuration, validate actual install flow, and leave Gmail optional if approval unavailable. Never require maintainer's personal credentials. Tokens not in backups or content scripts.

Classify confirmations, rejection, status updates, OA, interview/scheduling, recruiter follow-up, offer and unknown. Match using requisition ID, company/domain, role, thread and date; handle third-party assessment/scheduling senders. Company alone cannot identify one of multiple applications. Auto-update only uniquely matched high-confidence evidence; ambiguous cases stay in review. Store minimal evidence (message/thread ID, subject, relevant excerpt, date, classification, link). Treat email and page content as untrusted input; no embedded instructions can trigger arbitrary actions.

Urgent messages: OA, interview, recruiter request, offer, or plausible ambiguous urgent mail must produce a durable Action Required item, original email link, Chrome notification and badge count. Capture deadline/timezone only when explicit; show Unknown otherwise. Keep unread, keep alert until acknowledged/resolved, and distinguish acknowledgment from completing the action. No auto-reply/schedule. If ambiguous, notify anyway and do not guess association. Provide test notification and visible last-sync/permission health. Notifications are best effort; persistent queue is source of truth.

Optional mark-read setting (off by default): only clear UNREAD for confidently matched routine confirmation/rejection after local event and state transaction commits; use per-message modification, not whole-thread. Never auto-read actionable/ambiguous mail or a message with unresolved requested action. If modify fails, keep event and retry safely; if uncertain, leave unread. Deduplicate processing even if user marks unread later. Do not change unrelated labels. On pause/finish, stop mail reads and writes.

## 8. Service lifecycle and data portability

One prominent Search Status control in Dashboard/Profile: **Active · Paused · Finished**. Active runs configured schedules and alerts. Pause stops all automatic source polling, AI searches/analysis, Gmail sync, retries and job/action notifications; retained data remains usable and manual operations require explicit action. Resume preserves checkpoints, performs a bounded reconciliation, labels gap observations accurately, does not flood old jobs or replay missed AI slots. Finishing is a guided action for when a user has secured work: optionally mark accepted application, export data, confirm stop. No obligation to choose an offer or delete data. Finish cancels alarms, timers, retry queue, active jobs/requests where cancellable, pending notifications and badge; invalidate generation/check active flag before starting network requests or committing automatic updates so in-flight results cannot restart services. Already-sent requests may finish/be billed; disclose this limitation. Keep local Dashboard/Tracker/Stats/export available offline. Persist mode across reload, browser restart and extension updates. Finished mode resumes only by explicit user choice; same safe reconciliation as Pause. Optional disconnect Gmail/revoke token, clear Claude key and remove password; optional separate irreversible local deletion with confirmation. Do not automatically revoke or delete data. Browser extension uninstall removes local data in typical setups; warn to export first.

CSV export: all or current filtered application records, full event history, matched jobs and source list; UTF-8, header row, ISO 8601 timestamps, stable enums/IDs, proper CSV quoting, protect against spreadsheet formula injection. Provide explicit round-trip policy for escaped values. Import Notion/other CSV via header mapping and preview; preserve IDs/dates where available, validate and report rejected rows, deduplicate without destructive overwrite. Source packs contain public source configuration only. Suggested stable application headers:

```csv
application_id,company,job_title,job_id,job_url,role_category,seniority,location,work_mode,employment_type,sponsorship_status,priority,source,posted_at,first_seen_at,applied_at,resume_name,cover_letter_name,status,status_updated_at,notes
```

Full local backup: versioned ZIP/JSON manifest with records, events, sources, preferences, verified answers and PDF blobs; no API keys, OAuth credentials, passwords or raw mailbox. Validate schema/version/checksums, preview import and merge/replace explicitly; preserve referential integrity. Warn exports contain personal data, store only on user-chosen device, and offer easy access to export before stopping/uninstalling. Import/export tests include Unicode, quotes, newlines, formula-like cells and duplicate records.

## 9. Architecture and interfaces

Single repository, single extension, single local database. Recommended stack: WXT + Manifest V3, TypeScript, React, Tailwind or lightweight CSS, IndexedDB/Dexie, Zod, Vitest, Playwright, Chrome Side Panel/Alarms/Notifications/Identity APIs. Use a small number of UI components, not a large custom design system. Runtime modules: discovery, intelligence, autofill, tracking; shared storage, typed message contracts and lifecycle/budget helpers. Service worker handles network, credentials, schedules, state commits; content scripts only page detection and user-authorized form operations; Dashboard/Side Panel use local typed services. MV3 service worker can terminate: persist work checkpoints, idempotency keys, slot claims and state transitions; no reliance on permanent globals or long timers. No remote executable code; use packaged scripts and safe text rendering. No need for backend, framework-driven agent graph, event bus or microservices.

Minimal boundaries (illustrative, refine types to satisfy tests):

```ts
interface JobSource {
  detect(url: string): Promise<SourceConfig | null>;
  collect(source: SourceConfig, cursor?: string): Promise<Snapshot>;
}
interface IntelligenceProvider {
  searchJobs(query: SearchQuery): Promise<JobLead[]>;
  evaluateJob(input: MatchInput): Promise<JobMatch>;
  mapFields(input: FieldInput): Promise<FieldMapping[]>;
  draftAnswers(input: AnswerInput): Promise<DraftAnswer[]>;
  classifyEmail(input: EmailInput): Promise<EmailClassification>;
}
interface FormAdapter {
  detect(): boolean;
  scan(): Promise<FormField[]>;
  fill(plan: FillPlan): Promise<FillResult>;
  verify(plan: FillPlan): Promise<Verification>;
  advance(): Promise<StepResult>; // non-final only
  detectSubmission(): SubmissionEvidence | null;
}
```

Core IndexedDB collections (logical, not mandatory separate tables for every concept):

| Collection | Required content |
|---|---|
| profile/settings | personal facts, preferences, schedules, mode, budget, revisions |
| sources | normalized URL/provider/tenant, status, cadence, cursor, last complete snapshot/check, failure |
| jobs | identity/aliases, compact listing, timestamp evidence, sources, optional JD/hash, match result, availability |
| materials | type, original PDF Blob, filename, labels, hash, extracted text, revision |
| answers | verified question/answer, scope, revision |
| applications | job reference, status, submission confidence, material revision/name, notes, dates |
| events | unique event ID, app/message/source refs, stage transition, evidence, time, urgency/acknowledgment |
| runtime/usage | persistent task/checkpoint keys, model/tool usage, price version, budget state |

Index job identity/URL, application job/status/date, event message ID, source ID and scheduling fields; enforce idempotent writes and transactional application/event changes. Active compact job index retained; unmatched full JD not stored; matched JD default 30-day retention unless saved/applied; compact closed tombstones retained with configurable cleanup; application/history/PDFs retained until user deletes. No HTML archive, whole-mailbox storage or full snapshot history. Handle quota errors without false successful writes. Provide clear-data option and backups; estimate storage from actual bytes.

Security: least privilege, optional host permissions per source/tab, no default all-site access when avoidable; verify tab origin before writes. User-owned API key restricted to trusted contexts; local storage is not encrypted by default, disclose risk; no plaintext key in repo, logs, exports or model inputs. Do not send credentials or unnecessary personal data to external APIs. External page/email/model output is untrusted; validate/sanitize, no dynamic code, no arbitrary tool execution or user consent bypass. Disable telemetry by default; no personal data or production secrets in tests. Publish privacy/readme, limitations, permissions, dependency lockfile, license (MIT proposed), reproducible build/install instructions and releases. Test separate fresh user install, no maintainer GitHub/credentials required except optional user-selected external sources. Gmail verification/Chrome Web Store review are distribution gates, not simulated passes.

## 10. Acceptance and goal-driven delivery

Define labeled fixtures, held-out examples and a real-source benchmark before tuning. Report exact numerator/denominator, sample sizes, coverage, environment, errors and unsupported cases. Do not substitute synthetic success for live evidence. Suggested first benchmark: >=30 public boards across four ATS families for >=7 days, independent timestamped observations/reference snapshots; >=20 distinct form variants per ATS in fixtures and representative permitted live read/fill checks; >=100 held-out role/JD examples across multiple professions and levels; >=100 anonymized email examples including urgent and ambiguous messages. Expand if confidence is weak. Do not submit fake applications or send test messages to real recruiters. Use sandbox fixtures and user-authorized genuine flows for submission checks.

| Goal | Target / pass condition |
|---|---|
| Discovery scheduling | 10-min default direct checks and six local AI slots; no duplicate slot; visible missed/failed runs |
| Direct discovery latency | P50 ≤6 min, P95 ≤15 min on continuously monitored boards with reliable publication evidence and normal availability; report observation bounds separately |
| Recall@24h | ≥95% eligible verified new jobs in monitored sample, independently enumerated |
| Initial filter recall | ≥95% on held-out relevant jobs, including ambiguous titles and missing metadata |
| Recommendation precision | ≥90% human-labeled relevant among evaluated recommendations; report recall too |
| Identity | 0 duplicate display/application records on dedup fixture suite; no false merges of distinct requisitions |
| Sponsorship | 0 false exclusions on labeled unknown/startup/history-conflict cases; no unsupported confirmed claims |
| Autofill | ≥98% correct standard fields, P95 ≤3 s for ready single page standard fields (exclude AI/network, report end-to-end separately) |
| Critical fields | 100% verified-answer correctness in test suite, no fabricated/automatic consent, 0 automatic final submissions |
| Workday | ≥95% supported multi-page fixture/validated scenarios complete to review without avoidable manual steps; report blockers |
| Submission | ≥99% classification accuracy on confirmation/nonconfirmation fixtures, no false Applied in critical adversarial fixtures |
| Gmail | ≥98% status classification/linking accuracy on labeled set; 100% urgent recall in test set, report precision; P95 ≤6 min from eligible message availability under normal running conditions |
| Gmail safety | No automatic mark-read for actionable/ambiguous messages; commit-before-modify and idempotence pass |
| UX | P95 ≤300 ms warm local Dashboard data render on documented reference machine/data set; accessibility/keyboard/light/dark and visual review; report cold load |
| Budget | $10 default monthly app-side cap; no AI calls on known rejected/unchanged cached jobs; tool cap and fallback tests |
| Lifecycle | Pause/Finish prevent new automatic requests/notifications after transition; restart/update preserves mode; resume no stale flood; exports available offline |
| Portability/security | Fresh independent installation, user-configured sources, optional BYOK/Gmail, CSV and full backup round-trip, permission/secret isolation tests |

Define latency against independent ground truth, not the same collector timestamp. Recall denominator excludes noneligible jobs by predeclared criteria only; show outages separately rather than hiding them. P95 targets apply to supported, ready conditions; report unqualified full-session time and missed checks as well. All percentages are initial targets, not guarantees for every company or user.

Execution plan: implement one goal-driven 1.0 mission with parallelizable workstreams: (A) shared schema/UI/lifecycle + source ingestion; (B) matching/materials + autofill adapters; (C) tracker/email/notifications + stats/export; (D) integrated security/UX/release verification. Integrate via small typed contracts. Iterate against the end-to-end acceptance suite, not per-company feature PRs. Build a minimal implementation first, then expand only to pass requirements. No premature abstractions or unrelated features. Keep concise README, this spec and test/benchmark evidence; do not duplicate requirements in multiple docs. Final report: build/install, tests and benchmark metrics with sample sizes, supported vs unsupported ATS/source cases, API cost measurements, open blockers and release readiness. Never claim PASS without evidence; record inaccessible live tests and do not fake Gmail approval or application submission. Owner review is required for genuine applications and public release.

## 11. Implementation references and decisions to validate

- Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
- Ashby public posting API: https://developers.ashbyhq.com/docs/public-job-posting-api
- Lever postings API: https://github.com/lever/postings-api
- Chrome extensions alarms, storage, identity and side panel: https://developer.chrome.com/docs/extensions/reference/api/
- Gmail API: https://developers.google.com/workspace/gmail/api
- Claude API docs: https://platform.claude.com/docs/
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- US visa history: https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub and https://www.dol.gov/agencies/eta/foreign-labor/performance

Verify current provider interfaces, prices, rate limits, source terms, OAuth publishing requirements and browser compatibility during implementation. Choices made for 1.0: six daily search slots inclusive of 18:30; configurable budget/caps; optional persistent password with explicit risk consent, session-only default; no mandatory background collector; four Dashboard pages; MIT proposed; Gmail remains optional until independent OAuth setup is verified. These are design decisions, not claims of completed integration.
