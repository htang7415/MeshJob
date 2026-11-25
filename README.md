# MeshJob

MeshJob is a local-first Chrome extension for discovering jobs, preparing applications, and tracking what happens after you submit. Chrome stores your profile, PDFs, and tracker in your browser. Discovery, deterministic autofill, tracking, and exports work without an account, API key, or server.

## Install

1. Download [MeshJob 1.0.1 (ZIP)](install/MeshJob-1.0.1.zip) and extract it to a permanent folder. Keep this folder in place while using the extension.
2. In Chrome 120 or later, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
3. Pin MeshJob and click its toolbar icon. In **Discover**, choose **Set up discovery** or add a board in **Manage sources**. Grant the requested origins for the sources you choose.
4. Add personal details, PDFs, and any verified answers in **Profile**. On an application tab, click the toolbar icon, prepare a draft, select your PDFs, and fill available fields. Review the employer’s page and submit it yourself.
5. Use **Tracker** to follow stages and resolve actions. Use **Search status** in the Dashboard to pause, resume, or finish. Export a backup before uninstalling.

The toolbar opens the Dashboard on general pages and the Side Panel on recognized job URLs. Chrome’s Side Panel picker also opens MeshJob on a generic HTTPS job page. You can enter a draft in Tracker when a form needs manual completion. Chrome manages registration credentials by default.

## Build and test

Use Node.js 22.13 or newer and the checked-in lockfile.

```sh
npm ci
npm run build
npm test
```

Load `dist/` as the unpacked extension. To generate a reproducible ZIP, use a clean output directory and set `MESHJOB_ZIP`. The ZIP has fixed entry timestamps.

```sh
MESHJOB_DIST=./dist-release MESHJOB_ZIP=./MeshJob-1.0.1.zip npm run build
```

The end-to-end suite uses isolated Chromium profiles. It intercepts the employer hosts for all fill and submission fixtures. Set `MESHJOB_TEST_ROOT` to a writable scratch directory. Set `PLAYWRIGHT_BROWSERS_PATH` to a reusable browser cache if your environment has one.

```sh
npx playwright-core install chromium --no-shell
MESHJOB_TEST_ROOT=/path/to/scratch npm run test:e2e
npm run benchmark -- --optional
node scripts/fixture-benchmark.mjs
```

Set `MESHJOB_NATIVE_CHROME=1` and `MESHJOB_BROWSER` to the installed Chrome executable to run the suite via a disposable Chrome DevTools session. `node scripts/chrome-smoke.mjs` uses the same browser path and scratch settings to check an unpacked build, PDF extraction, and offline exports.

`scripts/live-forms.mjs` reads selected public employer pages with a disposable browser. It blocks page writes and enters no data. See [verification and limitations](evidence/VERIFICATION.md) for measured results and release gates. [Specification](MeshJob_SPEC.md)

## Sources and freshness

The bundled catalog includes 31 public employer boards across Greenhouse, Ashby, and Lever. We Work Remotely RSS and three public GitHub new-grad lists are optional. You can add sources from URLs, CSV, or a source pack. Public Careers pages are supported when they expose readable JobPosting data. Workday monitoring needs both Chrome origin access and terms that permit automated checks for the particular tenant. Workday uses the public careers interface, which can change between tenants.

Sources normally check every 10 minutes while Chrome is running and search is Active. **Verified recent** uses original posting evidence and an active official record. **Newly detected** describes appearance between complete board checks. Many postings have no reliable original date, even when they expose an update or re-publication timestamp. Those are listed with the first observation time. Unsupported sites can be tracked manually. [Greenhouse](https://docs.greenhouse.io/job-board.html), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api), [Lever](https://github.com/lever/postings-api), [We Work Remotely RSS](https://weworkremotely.com/remote-job-rss-feed)

## Optional integrations

### Claude

In Profile, set a personal API key. Claude can look for jobs on the web, score eligible descriptions against your profile and existing PDFs, and suggest answers you review before filling. The default monthly app-side limit is $10, with a daily limit, a per-request limit, and at most three web searches in each of six local-time rounds. MeshJob estimates costs and accounts for reservations when a request’s final usage is unknown. Provider billing can differ. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Browser API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)

### Gmail

The standard build has no OAuth client. For your own Gmail-enabled build:

1. Load the extension and note its ID in `chrome://extensions`. Keep the unpacked directory in the same location. For an ID that stays the same across locations, use the public extension key documented by Chrome and provide it as `MESHJOB_EXTENSION_PUBLIC_KEY`. Use the public key only.
2. In your Google Cloud project, enable the Gmail API and configure the OAuth consent screen. If the project is in testing, add your Google account as a test user.
3. Create a **Chrome Extension** OAuth client with the exact extension ID. Build with `MESHJOB_OAUTH_CLIENT_ID=your-id.apps.googleusercontent.com npm run build`, or set both build variables for a stable keyed ID. Reload the same extension and confirm the ID matches the OAuth client.
4. In **Profile → Integrations**, choose **Connect read-only** and grant consent. Use **Sync now** and inspect the last-sync status. Routine mark-read is an optional upgrade. Chrome Identity handles the redirect for this client type.

The restricted Gmail scopes can require Google verification for distribution. Chrome’s account used for authorization should match the Gmail account you open when following mail links. [Chrome OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), [Stable extension IDs](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Data and privacy

MeshJob has no telemetry. Source requests go to the origins you grant. Autofill reads and writes form controls on the active HTTPS tab after you authorize an action. It leaves final submission, consent, and certification to you. PDFs are parsed locally, and only selected files are uploaded to the intended form. Claude receives relevant text and form cues when enabled. Gmail receives a short-excerpt request for incremental messages and, when separately enabled, per-message label updates for confidently linked routine mail. Only minimal tracking evidence is kept. Chrome notifications can show recruiting subject lines.

Permissions used by default cover the toolbar and Side Panel, the active tab and scripted form access, local storage, scheduled checks, and notifications. Specific site origins and Chrome Identity are requested when needed. Chrome stores the key and optional persistent registration password in local plaintext accessible to trusted extension contexts. Prefer Chrome Password Manager with a unique password per site. Credentials and raw mailbox data are excluded from backups.

Tracker exports UTF-8 CSV and can import a CSV with column mapping. MeshJob escapes formula-like cells and cells starting with an apostrophe by adding an apostrophe. Enable **Decode escaped cells** on import only for MeshJob CSVs. The ZIP backup retains checksummed records, answers, preferences and PDF blobs. Restore previews the data and offers merge or replacement. Restored sources require a new enablement choice. Exports contain personal information. [MIT license](LICENSE)
