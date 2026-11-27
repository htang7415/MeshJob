# MeshJob 1.1 — Product & Engineering Specification

**Status:** Development baseline · 2026-11-27 (1.1 revision: freshness exclusion, Side Panel-first application flow, tracker fields, one-click Gmail, simplified UI)  
**Product:** Open-source, local-first Chrome extension for job discovery, application autofill and career tracking.  
**Mission:** Find the right job early and complete an accurate application with minimal friction.  
**Principles:** Fast · Lightweight · Intelligent · Reliable · Private · Beautiful.

This specification supersedes earlier design iterations. Requirements use **must**; recommended defaults are configurable unless stated otherwise. All performance targets are acceptance goals, not claims of implemented performance.

**Lightweight rule (1.1):** prefer removing a control to adding one. A setting exists only when a sensible default cannot serve most users; everything else is a fixed default or lives under one Advanced group. Do not add frameworks, adapter DSLs or background services to solve a problem a small function solves.

## 1. Scope and success

Build a usable end-to-end product: **Discover → Match → Prepare → Autofill → Human Submit → Track → Analyze → Finish Job Search.**

Priority order: (1) discovery latency and recall; (2) autofill speed and correctness; (3) complete application tracking and urgent email notifications; (4) actionable analytics and portability. All are in scope for 1.0. Ship a complete, tested workflow rather than disconnected demos.

- Users independently install and run MeshJob; no MeshJob account, mandatory server, central job database, maintainer API key, paid platform subscription or runtime dependency on the MeshJob GitHub repository.
- Users bring their own Claude API key and optionally connect Gmail. Direct discovery, manual import, deterministic autofill, tracker and export work without AI or Gmail.
- Support arbitrary professions, seniority, locations and visa needs through user preferences. Do not hard-code the owner's profession, US location, or new-grad criteria. Initial validated geography for official visa-history evidence is the US; outside the US use role/company evidence or Unknown. Do not imply comprehensive global source coverage.
- Non-goals: generate/tailor resumes or cover letters, auto-submit applications, bypass CAPTCHA/access controls, auto-send recruiter emails, build a password manager, broad unauthorized scraping, shared accounts, cloud synchronization, vector DB, multi-agent framework, or commercial platform. No always-on guarantee when Chrome or the device is stopped.
- Removed in 1.1 (migrate stored values on upgrade): Prepare dialog, automatic Workday advance and "Fill to review", Gmail mark-read/modify scope, Gmail recovery query and window settings, AI time slots/rounds/searches-per-round/daily and per-request budgets, retention-day settings, Tracker calendar view, toolbar URL heuristic.

## 2. Experience and onboarding

Two surfaces: a **Side Panel** that works beside the current page, and a **Full view** (Dashboard in a browser tab) for browsing and managing. Keep network/AI work asynchronous, show meaningful progress and allow cancellation; cached local content renders immediately.

**Switching (must be predictable):**
- The toolbar icon always opens the Side Panel; it never guesses the page type. A keyboard command opens it (`_execute_action`) and a second command opens Full view.
- The Side Panel header has one **Full view** control that opens or focuses the Dashboard tab, routed to the current job/application when one exists.
- Opening a job from Full view opens its official URL in a new tab; an open Side Panel follows the active tab.
- The Side Panel follows the active tab and re-renders on tab switch, navigation, SPA route change and form mutation without user action. The supported ATS hosts (Greenhouse, Ashby, Lever, Workday, SmartRecruiters, Workable) and the public job lists MeshJob reads (raw.githubusercontent.com, hn.algolia.com) are install-time host permissions, so the panel follows job pages and forms with no access step; other sites use "Allow on this site" or the toolbar icon. Use `declarativeContent` to highlight the toolbar icon on recognized application pages (no extra host access). No in-page floating widget.

**Side Panel states** (exactly one at a time, derived from the active tab):

| Active tab | Side Panel shows |
|---|---|
| Other page | Home: open actions, top new matches (≤5), recent applications (≤3), Full view |
| Job posting (ATS posting URL or JobPosting data, no form) | Job card: company, title, level, location, posting age, match; Save · Apply; tracked status if any |
| Application form | Autofill view (section 5) |
| No access to the page | One "Allow on this site" action |
| Login / verification | One-line notice; resumes automatically when cleared |

**Full view** uses a left sidebar (Discover · Tracker · Stats; Settings at the bottom). Selecting a row opens a right-hand inspector instead of a modal; modal sheets are reserved for confirmation and destructive actions.

| Surface | Primary experience |
|---|---|
| Discover | Recent matches with posting age, company, title, location, level, salary if known; Apply primary, Save/Hide secondary; search, preference chips, "Why shown"; sources and refresh in a ⋯ menu; problems surfaced only when present |
| Tracker | Table with default columns Company · Title · Level · Status · Applied · Resume · Source; status board view; Action Required queue; inspector with history, JD, materials; CSV import/export |
| Stats | Application counts, outcomes, breakdown by level/resume/source, discovery-to-application latency, AI usage/cost |
| Settings | Profile, documents, answers, preferences, Claude, Gmail, search status, data. macOS System Settings style rows; one Advanced group |

**Visual design (Apple HIG: clarity, deference, depth):** system font stack (SF on Apple platforms); type scale 13/15/17/22/28 with weights 400/600; neutral gray backgrounds (light #F5F5F7, dark #1C1C1E) with one blue accent and semantic status colors (green progress, orange action, red error only); inset grouped lists with 44px rows and hairline separators; one primary button per view, other actions in ⋯ menus; small inline SVG icons, no emoji; no explanatory paragraphs in the UI (help belongs in README or a tooltip); empty states are one line plus one action. Never display a value that carries no information (e.g. "Unscored", "Sponsorship unknown", healthy-source notices). Light/dark, keyboard navigation, visible focus, reduced motion and readable contrast remain required.

Onboarding: enter target titles (free-text and suggested presets), location, level and employment type; choose work arrangement and sponsorship needs; add optional profile/materials; accept or customize bundled source catalog; optionally enable Claude and Gmail. Allow skip and edit later. The default display freshness is 24h; make the window configurable. Do not silently assume a country, sponsorship requirement or citizenship. No mandatory external account for basic use.

Preferences shown by default: role titles, countries/regions/cities, level, work arrangement, sponsorship requirement (required/not required/unspecified), posting window (24h default). Under "More": excluded title words, excluded companies, maximum years of experience required, minimum compensation (currency and period), employment type. Every stored preference must be editable in the UI. The owner's example: US full-time SWE/AI Infra/AI Engineer/MLE/FDE, new grad/entry level, sponsorship opportunity, 24h. Not a global default.

Levels are one fixed scale used by preferences, jobs and the tracker: **Intern · Entry · Mid · Senior · Staff+ · Manager**. Level is derived from the title (including II/III, Lead, Principal, Staff, Manager, Director, Head of) and, when the title is silent, from the JD's minimum years of experience; unknown stays unknown and is user-editable.

Separate persistent discovery preferences from temporary view filters. Explicit exclusion only when evidence proves a hard constraint fails; unknown salary/level/sponsorship is labeled and retained unless a user opts into strict exclusion. Location is resolved to a country from structured fields first (Lever `country`, Ashby address, JSON-LD), then from bundled region data (state/province codes and names, major cities, "Remote – US" patterns); unresolved locations are unknown. Each Discover row exposes its decision ("Why shown": matched title, unknown fields). Title aliases expand recall; allow free-text overrides. No fit score is a probability of hiring.

## 3. Discovery engine (primary differentiator)

### 3.1 Sources and scheduling

| Source | Adapter | Default cadence |
|---|---|---|
| Greenhouse | Public Job Board API, board token | 10 min |
| Ashby | Public Job Posting API, board name | 10 min |
| Lever | Public Postings API, site and regional endpoint | 10 min |
| Workday | Permitted public careers-page interface; tenant/site | New-job check (first 1–2 pages, newest first) every 10 min; full pagination snapshot every 6 h for closures |
| SmartRecruiters / Workable | Public postings APIs; job descriptions from each job's public detail endpoint | 10 min |
| Careers/RSS | RSS/Atom, public JobPosting JSON-LD or supported listing parser | 10 min where permitted |
| Hacker News "Who is hiring?" | Current monthly thread through the public Algolia API; startups with links, roles, locations and posting times | 60 min |
| GitHub lists | Public Markdown lists and aggregated JSON lists (SimplifyJobs `listings.json`: 1,000+ employers per request, listed date, sponsorship); conditional requests | 10 min (Markdown), 30 min (JSON) |
| Claude Web Search | Preference-directed queries restricted to ATS domains; finds employer boards | Once daily (default 09:00 local) plus manual Search now |
| User import | Current job/application tab or pasted URL, manual fallback | On demand |
| Email | Gmail or Outlook incremental sync, manual Add email (section 7) | 5 min |

- Direct sources are primary for latency; AI search complements coverage by discovering new employers. A Workday new-job check cannot close jobs; only a complete snapshot can. Use local wall-clock scheduling including DST/timezone changes; no duplicate slot or burst replay after sleep; run one bounded catch-up for overdue direct/email tasks. Missed AI slots are not replayed automatically. Offer manual Search Now subject to budget. All schedules disabled in paused/finished mode.
- Use Chrome alarms + MV3 service worker. Persist checkpoints, scheduler state and next eligible run; recreate alarms on startup/update when active. Stagger source checks, prevent overlapping runs, use bounded concurrency, timeouts, retry/backoff with jitter, Retry-After and conditional requests where supported. Respect terms, source policies and limits; no CAPTCHA bypass, login automation for scraping, or attempts to circumvent blocks. Workday interfaces are not guaranteed stable public APIs. Unsupported sites require manual import or a supported source, not a false success.
- Distinguish last attempt, last successful complete snapshot, next attempt and errors. Never turn an incomplete fetch, failed page or partial pagination into a mass-close or false-new event. Keep last good snapshot. User can disable/remove a source independently. UI exposes stale sources and last successful check; no silent skip.
- Chrome alarms cannot guarantee exact execution during shutdown/sleep or throttling; resume automatically only if search mode is active. No required background server or GitHub Actions collector. CI may use GitHub Actions for builds/tests, not runtime.

### 3.2 Source onboarding and coverage

Ship a versioned, editable local catalog of verified public company boards and supported source presets, with evidence of source URL and access method. Include the following optional new-grad GitHub sources, not mandatory for all professions:

- https://github.com/SimplifyJobs/New-Grad-Positions
- https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/NEW_GRAD_USA.md
- https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/NEW_GRAD_USA.md

**Coverage beyond the catalog (1.1).** A bundled catalog cannot list every employer, so coverage grows three ways without a server: (1) aggregated JSON lists cover thousands of employers in one request, and the Hacker News "Who is hiring?" thread covers a few hundred startups each month; both show jobs listed inside the window as Newly detected; (2) MeshJob counts which employers in those lists (job postings or board links) hire for the user's titles and offers the top ones as **Suggested boards** (add one or all; dismissed suggestions stay hidden for 60 days), as does the daily AI search; (3) **Add companies** takes company names and finds each public Ashby, Greenhouse, Lever, SmartRecruiters or Workable board by trying its usual board names. Careers URLs and Workday sites remain addable by URL. The scheduler checks up to 12 due sources per 30-second tick with four in parallel.

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

If exact original time is unavailable, an uninterrupted complete prior snapshot can bound when a job appeared on that board, not prove its original publication time elsewhere. Present a separate 'Newly detected' label and interval; no false verified 24h claim. Relative dates with insufficient precision cannot establish strict age. GitHub commit time/search index time are discovery signals only. Verify original official link and active status before high-confidence display/notification. Preserve evidence fields.

**Proving new vs proving old (1.1).** Evidence that a job is *new* must be strong; evidence that a job is *old* may be any credible earlier timestamp. Record `age_floor` = the earliest of: Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`, Workday `postedOn` lower bound ("Posted 30+ Days Ago" ⇒ ≥30 days), JSON-LD `datePosted`, and `first_seen_at` when the job was present in the source's baseline snapshot. Freshness classes:

| Class | Rule | Default display |
|---|---|---|
| Recent | Official active posting whose original timestamp (`first_published`, `createdAt`, `publishedAt`, verified `datePosted`) is inside the window, not a repost | Shown, alertable |
| Newly detected | Absent in the previous uninterrupted complete snapshot, first seen inside the window, no older evidence | Shown, alertable |
| Older | `age_floor` is before the window, or the job was in the baseline snapshot and the window has passed since baseline with no date | Hidden |
| Unknown | None of the above | Hidden; "Include undated jobs" view toggle |

A **repost** (same company, normalized title and location as a job closed or still active within 30 days) is labeled Reposted, is not Recent and does not alert. Adding a new source must not add its existing backlog to the default Discover view. AI leads are shown only after the official URL is verified active with a date (section 3.5); unverified leads are discarded.

### 3.4 Filtering and matching pipeline

Listing metadata → stable identity/diff → cheap title/level/location/time filters → candidate JD and explicit exclusions → Claude match when useful → display/notify. Use a shared predicate engine for direct sources, AI leads and user preferences. Avoid filtering ambiguous titles or missing data too aggressively; held-out recall test required. Search queries are targeted to role synonyms, geography, seniority and fresh official postings; do not ask the model to enumerate unrelated jobs. Existing applications suppressed in Discover by default, visible with explicit toggle; warn before a repeat application. Allow import/track even if outside discovery filters.

Use one AI request per eligible unique JD revision to assess fit and recommend existing materials. Return structured output: skill/experience/seniority/domain subscores 0–100, brief evidence strengths and gaps, confidence, recommended resume ID, optional cover letter ID, visa assessment with evidence refs. Calculate match score in code (40% skills, 30% relevant experience, 20% seniority, 10% domain; provisional rubric validated with held-out roles). Use best supported resume; explicit hard constraints independent of score. No fabricated credentials or overly precise hiring probability. Cache by normalized JD hash + match-relevant profile facts + match-relevant preferences (titles, level, skills) + material revisions + rubric/model version; editing contact details, posting window or other non-matching fields must not invalidate matches or force source rechecks. If AI off/unavailable, show rules-qualified jobs without a score (no "Unscored" label) and allow manual selection; do not block timely notification for a potentially relevant verified new job waiting on AI.

Sponsorship: distinguish current work authorization/OPT, STEM OPT eligibility/acceptance, future H-1B (when relevant). Current role JD and explicit recruiter/company policy outrank history; resolve conflicts conservatively. USCIS/DOL historical evidence is optional US enrichment, not current-role confirmation. Match employer legal entity carefully; retain source/date. States: Confirmed (role-specific positive evidence), Likely (credible positive evidence), Unknown (insufficient/conflicting evidence), Not Supported (explicit applicable exclusion). Lack of records or startup age/size is never negative evidence. Retain Unknown by default for sponsorship-seeking users. Official dataset snapshots may be imported or bundled when permitted; no maintainer-dependent service. Do not infer legal eligibility.

### 3.5 AI and cost

Use Claude API through a small provider module. Choose current supported lightweight model for matching/field mapping/email classification; configurable model for harder open-ended questions. No required multi-agent orchestration. Methods: searchJobs, evaluateJob, mapFields, draftAnswers, classifyEmail. Request structured outputs from the API (`output_config.format` with JSON schema; enums for option choices) and still validate with Zod; unknown answers are unresolved, never guessed. Use low effort for matching, field mapping and email classification, with `max_tokens` sized so reasoning cannot truncate the result. Put stable profile/material facts first with a cache breakpoint. Search uses explicit caps (default 3 web searches per run, `allowed_domains` limited to supported ATS hosts); its output is employer boards and posting URLs, which MeshJob verifies through the direct adapter or one JSON-LD fetch before display, and offers boards as one-tap sources. Bound fetches, output/context tokens, retries and monthly cost. User-facing settings: API key, monthly budget (default $10), "Match new jobs" and "Daily web search" toggles; model choice is Advanced; per-run limits are fixed internal guards. Estimate/reserve spend before calls and reconcile actual usage including search tools; stop paid calls when budget reached, but continue free discovery and local workflows. App-side cap is not a provider billing guarantee; disclose estimated/unpriced usage and provider controls.

Extract PDF text locally once; send only relevant text or concise profile/material facts and JD excerpts, not raw PDFs, email inbox, passwords or unrelated profile fields. Combine match + material selection; use stable prompt/cache where available, no repeated analysis on identical content. Batch unfamiliar fields on a page. Example planning assumption: 30 daily runs × 3 searches = 90 monthly searches before manual runs; at $0.01/search, tool-only $0.90 plus token charges, leaving budget for matching. Verify model/tool pricing and capabilities at implementation, do not hard-code stale prices; show usage and cost. AI search may return incomplete/stale leads, not a replacement for direct monitoring.

## 4. Profile, PDF materials and answers

Store user-editable contact details, education, work experience, skills, links, work authorization answers and preferences. Sensitive/optional fields are opt-in; never infer demographic or legally significant answers. Resume and cover letter are **PDF only** for 1.0, unlimited by arbitrary count (subject to device quota), with local Blob, filename, type, label/tags, hash, parsed text and revision. Validate MIME/content and handle unextractable/scanned PDFs with manual tags/text; no OCR requirement. User can upload, preview, replace, delete and choose defaults. AI recommends existing IDs; never creates or modifies a document. Upload selected original PDF where accepted; when a site requests cover letter text, use locally extracted text only with preview or user input. Do not send binary to Claude. Preserve applied material names/revisions in history even if later deleted.

**Resume versions (1.1).** Replacing a PDF creates revision n+1. If any application references the previous revision, keep that blob as an archived version (hidden from pickers, openable from the application) so the user can see exactly what was sent; unreferenced old blobs are discarded. Display a version as `label · vN · date`.

Answer bank: store verified question/answer, context (company/role/global), type and revision. Exact or unambiguous reusable answers first; similarity is a suggestion, not authority. Draft factual open-ended answers from user-provided facts only, with human review. Do not invent qualifications or use a generic yes/no for legally distinct questions. No automatic saving of AI drafts as verified answers.

**Learning answers (1.1).** When the user submits a form, MeshJob reads the non-sensitive questions the user answered by hand and offers, in the Side Panel, "Save N answers for next time" with per-item checkboxes. Saved items become verified answers scoped globally. Critical fields (section 5) are saved only when the user ticks them explicitly. Nothing is saved silently, and AI drafts are never saved without the same confirmation.

Registration: in Settings the user presets a registration email and password. On a verified ATS sign-up form (new-password fields only, never a login form) the Side Panel's **Fill sign-up details** fills the email and both password fields; it never overwrites a different email already in the form and never submits. The user submits, and Chrome Password Manager saves the new account. The preset password is stored only in local extension storage readable by trusted extension contexts, unencrypted, and is never sent to AI, logs, analytics or backups; Settings says so and recommends unique passwords. No CAPTCHA bypass or credential entry on unverified origins. No sensitive credential in repository or fixtures.

## 5. Autofill engine (second differentiator)

Generic scanner uses DOM, labels, ARIA, input types, autocomplete, required state and visible controls. Per-ATS handling for Greenhouse, Ashby, Lever, Workday covers dynamic widgets, upload, repeated experience/education rows, page transitions and confirmation patterns. Generic fallback for other sites: best-effort fill with review, not guaranteed. Adapter methods: detect, scan, fill, verify, detectSubmission. Automatic page advancing is removed in 1.1; when the user moves to the next step, the Side Panel detects it and offers "Fill this page".

**Required-field detection:** `required`, `aria-required`, `data-required`, label markers (`*`, `✱`, "(required)"), and, after a validation attempt, `aria-invalid` and adjacent error text. Report counts as "N to fill · M required".

**Autofill view (Side Panel):** header shows company, title, Level, Source and Resume, each editable inline; one primary **Autofill** button; below it a checklist: "Needs you" (required unresolved, each item focuses and scrolls to its field in the page), "Suggestions" (optional AI answers awaiting one-tap approval), "Filled" (collapsed). No separate Prepare dialog.

Flow: detect form → scan → on first Autofill silently create or reuse the application (stage Preparing) with captured company, title, requisition, URL, JD, level and source → map profile/verified answers → fill deterministically → verify DOM values → wait for the DOM to settle, rescan and fill newly revealed fields (at most 3 passes) → list unresolved → optional AI suggestions → stop; the user submits.

**Option matching** (select, radio, combobox), in order: normalized exact → bundled synonyms (country names/ISO codes, US state and Canadian province codes, degree names) → unique Yes/No prefix → unique containing option. If no single option qualifies, leave the field unresolved. Critical fields use the same matcher but only with a verified answer as input.

**AI suggestions:** one batched request for all unresolved non-critical fields; for choice fields the model must return one of the supplied options (enum); grounded only in profile facts and verified answers; shown for approval, never filled unapproved. Use native setters/events as appropriate, MutationObserver with bounded waits, handle dependent selects and dynamic rows. Never overwrite prefilled/manual edits silently. Verify upload filename/acceptance and actual selected values; unsupported file controls require manual upload. No final submit, certification/consent, or account creation click automatically. Stop on login, CAPTCHA, unclear consent, validation error, unknown critical answer or changed page identity. No duplicate experience rows on retry. Show filled/required/unresolved/failed counts and actionable errors. Critical fields (work authorization, sponsorship, legal/EEO/consent) use explicit verified user answers only; unanswered fields remain unresolved. Keep user in control, prevent two concurrent fill operations on same tab.

## 6. Tracker, import, dedup and analytics

Any job discovered outside MeshJob can be saved/imported by current tab, paste URL, or manual entry, including LinkedIn and other platforms. Capture source attribution when available; do not scrape private feeds. On official application page, extract company/title/requisition/URL where possible; allow editing and association with an existing job. Autofill creates Preparing draft, not Applied. If the user submits a recognized form without having used Autofill, the trusted submit click creates the application. Only specific ATS confirmation page/receipt (or user confirmation or matched application email) establishes submitted status. Generic thank-you text and clicking Submit alone are insufficient; after a submit click without a receipt, the Side Panel shows an inline "Submitted? Yes / No" (no dialog) and the application stays Needs Check until answered. Use idempotent events and explicit correction. Do not silently merge same-company different roles.

**Captured fields (1.1)**, all editable:

| Field | Capture rule |
|---|---|
| Resume | Material id, label, revision, filename and hash of the PDF MeshJob uploaded. If the user uploaded a file manually, read the selected filename at submit and match it to a stored material by name/hash; otherwise record the filename as External. Shown as `label · vN` |
| Cover letter | Same rule; optional |
| Level | Job level (section 2 scale) from the discovery record or title/JD derivation; unknown stays blank |
| Source | 1) `MeshJob · <source name>` if the job came from Discover; 2) else the referrer of the first page where the panel saw this job, mapped to a name (LinkedIn, Indeed, Handshake, Simplify, Glassdoor, Google, Wellfound…); 3) else `Company site`. Manual choices include `Referral` with an optional name. Never store an ATS hostname as the source |

Tracker default columns: Company · Title · Level · Status · Applied · Resume · Source. Other fields live in the inspector. Views: table and status board (no calendar).

Application lifecycle: Saved / Preparing / Applied / OA / Interview / Offer / Rejected / Withdrawn / Accepted. Track submission evidence separately (unverified/submitted/confirmed/needs_check) and Action Required separately from stage. Stages are not a strictly linear funnel; OA/interview can repeat or occur out of order. Preserve dated events and derive current stage using verified chronology and user corrections; old confirmation must not regress Interview/Offer; conflicting terminal events go to review. User can correct status and undo mistaken sync; keep audit history.

Stats from actual records/events only: applications per day/week, stage outcomes, interview and offer rates per application cohort, breakdown by level/resume version/source, source unique job and discovery speed, posting-to-discovery / discovery-to-application / active autofill duration (where measured), API usage/cost. Define denominators and sample counts; separate verified timestamps from bounded observations; do not treat unobserved outcome as rejection or infer causal resume performance from small samples. Exclude drafts from submitted application counts; count distinct applications reaching a stage, not duplicate events.

## 7. Gmail integration and urgent notifications

**Connection for any user, account and mailbox (1.1).** Every user connects their own mailbox with their own OAuth app; MeshJob ships no shared client, so there is no shared user cap and no maintainer verification dependency. Sign-in uses `chrome.identity.launchWebAuthFlow` with the user's app, whose redirect URI is `https://<extension id>.chromiumapp.org/`, so any account works, including one that differs from the Chrome profile's, and other Chromium browsers work too. Settings shows **Connect Gmail** and **Connect Outlook**; the first time, one dialog lists three or four steps with direct console links and a copy button for the redirect URI, then **Save and connect** stores the client ID at runtime (no rebuild) and opens the provider's account chooser. MeshJob stores the chosen address and renews the one-hour token silently (`prompt=none`, `login_hint`), asking the user to reconnect only when the provider requires it. **Switch account** starts fresh.

| Mailbox | Method |
|---|---|
| Gmail | Google Web application client, `gmail.readonly`, Gmail API history plus a recruiting query |
| Outlook, Hotmail, Microsoft 365 | Microsoft app registration (any organization and personal accounts, implicit access tokens), Graph `Mail.Read` + `User.Read`, inbox messages received since the cursor, classified locally |
| Any other (Yahoo, iCloud, QQ, 163, IMAP) | Browser extensions cannot open IMAP connections, so: forward recruiting mail to a connected Gmail/Outlook, or **Add email** (paste text or a saved `.eml` file) in Tracker or Settings |

All access is read-only; MeshJob never changes a mailbox. Tokens live in session storage only, never in backups or content scripts. Never require the maintainer's personal credentials.

Read only mail received after the mailbox was connected; older mail is never fetched or classified. Reconnecting the same mailbox keeps its start time; switching accounts starts again at the new connection. Use Gmail incremental history/cursor with bounded recovery (at most 14 days, never before the connection) when the cursor expires, dedup by message ID; never persist the mailbox. The query is built automatically: messages from ATS and assessment/scheduling domains, or mentioning tracked companies, excluding promotions and job-alert senders; no user-editable query. Show last sync and errors. Email links include the connected account so they open in the right mailbox.

Classify confirmations, rejection, status updates, OA, interview/scheduling, recruiter follow-up, offer and unknown. Match using requisition ID, company/domain, role, thread and date; handle third-party assessment/scheduling senders. Company alone cannot identify one of multiple applications. Auto-update only uniquely matched high-confidence evidence; ambiguous cases stay in review. Store minimal evidence (message/thread ID, subject, relevant excerpt, date, classification, link). Treat email and page content as untrusted input; no embedded instructions can trigger arbitrary actions.

Urgent messages: OA, interview, recruiter request, offer, or plausible ambiguous urgent mail must produce a durable Action Required item, original email link, Chrome notification and badge count. Capture deadline/timezone only when explicit; show Unknown otherwise. Keep unread, keep alert until acknowledged/resolved, and distinguish acknowledgment from completing the action. No auto-reply/schedule. If ambiguous, notify anyway and do not guess association. Provide test notification and visible last-sync/permission health. Notifications are best effort; persistent queue is source of truth.

MeshJob never modifies the mailbox: the 1.0 mark-read option and `gmail.modify` scope are removed. Deduplicate processing even if the user marks mail unread. On pause/finish, stop mail reads.

## 8. Service lifecycle and data portability

One Search Status control in Settings: **Active · Paused · Finished**; a non-Active mode also shows a slim banner in Full view. Active runs configured schedules and alerts. Pause stops all automatic source polling, AI searches/analysis, Gmail sync, retries and job/action notifications; retained data remains usable and manual operations require explicit action. Resume preserves checkpoints, performs a bounded reconciliation, labels gap observations accurately, does not flood old jobs or replay missed AI slots. Finishing is a guided action for when a user has secured work: optionally mark accepted application, export data, confirm stop. No obligation to choose an offer or delete data. Finish cancels alarms, timers, retry queue, active jobs/requests where cancellable, pending notifications and badge; invalidate generation/check active flag before starting network requests or committing automatic updates so in-flight results cannot restart services. Already-sent requests may finish/be billed; disclose this limitation. Keep local Dashboard/Tracker/Stats/export available offline. Persist mode across reload, browser restart and extension updates. Finished mode resumes only by explicit user choice; same safe reconciliation as Pause. Optional disconnect Gmail/revoke token and clear Claude key; optional separate irreversible local deletion with confirmation. Do not automatically revoke or delete data. Browser extension uninstall removes local data in typical setups; warn to export first.

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

Index job identity/URL, application job/status/date, event message ID, source ID and scheduling fields; enforce idempotent writes and transactional application/event changes. Active compact job index retained; unmatched full JD not stored; matched JD fixed 30-day retention unless saved/applied; compact closed tombstones retained 180 days (fixed, not a setting); application/history/PDFs retained until user deletes. No HTML archive, whole-mailbox storage or full snapshot history. Handle quota errors without false successful writes. Provide clear-data option and backups; estimate storage from actual bytes.

Security: least privilege: install-time host access only for supported ATS hosts and public job lists, optional host permissions for any other source or tab, no all-site access; verify tab origin before writes. User-owned API key restricted to trusted contexts; local storage is not encrypted by default, disclose risk; no plaintext key in repo, logs, exports or model inputs. Do not send credentials or unnecessary personal data to external APIs. External page/email/model output is untrusted; validate/sanitize, no dynamic code, no arbitrary tool execution or user consent bypass. Disable telemetry by default; no personal data or production secrets in tests. Publish privacy/readme, limitations, permissions, dependency lockfile, license (MIT proposed), reproducible build/install instructions and releases. Test separate fresh user install, no maintainer GitHub/credentials required except optional user-selected external sources. Gmail verification/Chrome Web Store review are distribution gates, not simulated passes.

## 10. Acceptance and goal-driven delivery

Define labeled fixtures, held-out examples and a real-source benchmark before tuning. Report exact numerator/denominator, sample sizes, coverage, environment, errors and unsupported cases. Do not substitute synthetic success for live evidence. Suggested first benchmark: >=30 public boards across four ATS families for >=7 days, independent timestamped observations/reference snapshots; >=20 distinct form variants per ATS in fixtures and representative permitted live read/fill checks; >=100 held-out role/JD examples across multiple professions and levels; >=100 anonymized email examples including urgent and ambiguous messages. Expand if confidence is weak. Do not submit fake applications or send test messages to real recruiters. Use sandbox fixtures and user-authorized genuine flows for submission checks.

| Goal | Target / pass condition |
|---|---|
| Discovery scheduling | 10-min default direct checks, Workday new-job check every 10 min with 6-h full snapshot, one daily AI run; no duplicate run; visible failed runs |
| Direct discovery latency | P50 ≤6 min, P95 ≤15 min on continuously monitored boards with reliable publication evidence and normal availability; report observation bounds separately |
| Recall@24h | ≥95% eligible verified new jobs in monitored sample, independently enumerated |
| Initial filter recall | ≥95% on held-out relevant jobs, including ambiguous titles and missing metadata |
| Recommendation precision | ≥90% human-labeled relevant among evaluated recommendations; report recall too |
| Identity | 0 duplicate display/application records on dedup fixture suite; no false merges of distinct requisitions |
| Sponsorship | 0 false exclusions on labeled unknown/startup/history-conflict cases; no unsupported confirmed claims |
| Autofill | ≥98% correct standard fields, P95 ≤3 s for ready single page standard fields (exclude AI/network, report end-to-end separately) |
| Critical fields | 100% verified-answer correctness in test suite, no fabricated/automatic consent, 0 automatic final submissions |
| Workday | ≥95% of steps in supported multi-page fixtures are filled after the user advances, with no duplicate rows; report blockers |
| Submission | ≥99% classification accuracy on confirmation/nonconfirmation fixtures, no false Applied in critical adversarial fixtures |
| Gmail | ≥98% status classification/linking accuracy on labeled set; 100% urgent recall in test set, report precision; P95 ≤6 min from eligible message availability under normal running conditions |
| Email | Each user connects Gmail or Outlook with their own app (any account, no rebuild); other mailboxes via forwarding or Add email; read-only; only mail after connection; idempotent sync passes |
| Freshness | Adding a board with ≥500 existing jobs adds 0 Older/Unknown jobs to the default Discover view; 0 Reposted jobs alert; every Greenhouse/Lever/Ashby job carries `age_floor` |
| Side Panel | Toolbar always opens the Side Panel; panel state matches the active tab within 1 s of tab switch or navigation on supported ATS hosts without re-clicking |
| Required fields | ≥98% of required fields detected on the fixture suite (including ✱ and "(required)" markers); every "Needs you" item focuses its field |
| Tracking | 100% of fixture submissions create an application with Level, Source (never an ATS hostname) and Resume `label · vN` or External |
| Option matching | Country, state, degree and Yes/No fixtures pass; 0 fills when more than one option qualifies |
| UX | P95 ≤300 ms warm local Dashboard data render on documented reference machine/data set; accessibility/keyboard/light/dark and visual review; report cold load |
| Budget | $10 default monthly app-side cap; editing non-matching profile fields causes 0 re-evaluations; no AI calls on known rejected/unchanged cached jobs; tool cap and fallback tests |
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

Verify current provider interfaces, prices, rate limits, source terms, OAuth publishing requirements and browser compatibility during implementation. Choices made for 1.1: one daily AI search plus manual runs; monthly budget is the only user-facing cost control; preset registration email and password for sign-up forms; no automatic Workday advance; no mailbox writes; no shared OAuth client; toolbar always opens the Side Panel; Full view with sidebar (Discover, Tracker, Stats, Settings); MIT proposed; each user connects email with their own OAuth app. These are design decisions, not claims of completed integration.
