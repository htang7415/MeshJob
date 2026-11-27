# MeshJob

MeshJob is a local-first Chrome extension for discovering jobs, preparing applications, and tracking what happens after you submit. Chrome stores your profile, PDFs, and tracker in your browser. Discovery, deterministic autofill, tracking, and exports work without an account, API key, or server.

## Install

1. Download [MeshJob 1.1.0 (ZIP)](install/MeshJob-1.1.0.zip) and extract it to a permanent folder. Keep this folder in place while using the extension.
2. In Chrome 120 or later, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
3. Pin MeshJob and click its toolbar icon. The Side Panel opens; choose **Full view** for the Dashboard. In **Discover**, choose **Set up discovery** to pick roles, recommended boards and access to job application sites.
4. Add your details, PDFs and answers in **Settings**. On an application page, click the toolbar icon and choose **Autofill**. Review the page and submit it yourself.
5. Use **Tracker** to follow stages and actions. Pause or finish the search in **Settings → Job search**. Export a backup before uninstalling.

The toolbar icon always opens the Side Panel (Alt+Shift+M); Alt+Shift+F opens Full view. The icon shows a blue dot on application pages. The Side Panel follows the active tab and shows one of four views: your queue and new jobs on other pages, a job card on postings, the autofill view on forms, or a request for access. Allowing the job application sites during setup lets it follow Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable pages without extra clicks; on other sites choose **Allow on this site**. Chrome Password Manager handles account passwords.

### Update an existing installation

Official releases starting with 1.0.3 share a fixed extension ID. Use the same Chrome profile when updating.

- **Update with a ZIP.** With **Developer mode** on, drop the release ZIP onto `chrome://extensions`. Desktop Chrome extracts it to a folder it manages. [Chromium ZIP installer](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/extensions/api/developer_private/developer_private_functions.cc#1091)
- **Keep your current folder.** Extract the ZIP and replace the files in the folder Chrome already loads, including `manifest.json`. The new version takes effect the next time you quit and reopen Chrome. For an immediate update, click **Reload** on the installed MeshJob card.

Versions through 1.0.2 used directory-based IDs. Chrome treats copies loaded from different folders as separate extensions, each with its own local records. To switch to the fixed ID:

1. Open each old copy that contains data and choose **Profile → Local data → Download backup ZIP**. Save the files separately. You can turn off the old copies in `chrome://extensions` after exporting.
2. Extract and load the current release in a permanent folder. In the new copy, choose **Settings → Data → Import backup ZIP** and preview the backup from the old copy whose profile and preferences you want to keep. In a fresh installation, use **Replace all local records** to restore that backup.
3. If the other copy has records you want, import its backup using **Merge new records into this profile**. Verify the Tracker, Settings, and documents in the new copy before removing the old cards.

Restored sources start disabled. Re-enable the sources you want and reconnect optional integrations in the new copy. [Chrome extension IDs](https://developer.chrome.com/docs/extensions/reference/manifest/key)

### Autofill and tracking

1. Open the application and click the toolbar icon. MeshJob reads the form and shows how many fields and required fields it found.
2. Choose **Autofill**. MeshJob creates the Tracker entry, fills what your profile and saved answers support, waits for follow-up questions to appear, and fills again. **Needs you** lists what is left; choosing an item jumps to that field.
3. Check the company, title, **Level**, **Source** and **Resume** at the top of the panel and edit any of them inline.
4. Submit on the page. A recognized receipt marks the application Applied; otherwise the panel asks **Submitted? Yes / No**. MeshJob then offers to save answers you typed by hand for next time.
5. On Workday, move to the next step on the page and choose **Fill this page**.

Applications record the level, where you found the job (MeshJob, the referring site, or Company site), and the resume label and version. Replacing a PDF keeps the copy an application was sent with.

## Build and test

Use Node.js 22.13 or newer and the checked-in lockfile.

```sh
npm ci
npm run build
npm test
```

Load `dist/` as the unpacked extension. To generate a reproducible ZIP, use a clean output directory and set `MESHJOB_ZIP`. The ZIP has fixed entry timestamps.

```sh
MESHJOB_DIST=./dist-release MESHJOB_ZIP=./MeshJob-1.1.0.zip npm run build
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

The bundled catalog includes 31 public employer boards across Greenhouse, Ashby, and Lever. SmartRecruiters and Workable boards can be added by URL, including their job descriptions for matching. We Work Remotely RSS and three public GitHub new-grad lists are optional. Public Careers pages are supported when they expose readable JobPosting data. Workday monitoring needs both Chrome origin access and terms that permit automated checks for the particular tenant.

Sources are checked every 10 minutes while Chrome is running and search is Active. Workday reads only its newest pages between complete snapshots every six hours. Discover shows **New** jobs (an original posting time inside your window) and **Newly detected** jobs (absent from the previous complete check). Any earlier evidence hides a job as older: Greenhouse `first_published`, Lever `createdAt`, Ashby `publishedAt`, SmartRecruiters `releasedDate`, Workday and Workable age labels, or MeshJob having seen it before the window. A newly added board therefore adds none of its backlog. Same-role relistings are treated as reposts. Undated jobs appear only with **Include jobs without a posting date**. [Greenhouse](https://docs.greenhouse.io/job-board.html), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api), [Lever](https://github.com/lever/postings-api), [We Work Remotely RSS](https://weworkremotely.com/remote-job-rss-feed)

## Optional integrations

### Claude

In **Settings → Claude**, set a personal API key and a monthly budget (default $10). **Match new jobs** scores new matching jobs against your profile and resumes. **Daily web search** looks for employers hiring for your roles once a day; MeshJob verifies each posting through the employer's ATS API, drops anything it cannot verify, and suggests unknown boards in Discover. In the Side Panel, **Suggest answers** proposes values for remaining fields from your profile and saved answers, limited to the page's own options; nothing is filled until you select it. Requests use structured outputs and low effort. Provider billing can differ from MeshJob's estimates. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Gmail

Gmail access is read-only (`gmail.readonly`); MeshJob never changes your mailbox. Any Gmail account works, including one that is not the account signed in to Chrome: **Settings → Gmail → Connect Gmail** opens Google's account chooser. MeshJob renews access in the background and asks you to reconnect only when Google requires it. **Switch account** moves to another mailbox.

If your build includes a shared MeshJob client, **Connect Gmail** is all you need. Otherwise choose **Set up Gmail** and create your own client once, with no rebuild needed:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the Gmail API.
2. Configure the OAuth consent screen as **External**, add the `gmail.readonly` scope, and **publish** the app. In Testing mode Google ends access after 7 days.
3. Create an OAuth client ID of type **Web application**. Add the redirect URI shown in **Settings → Gmail → Advanced** (`https://<extension id>.chromiumapp.org/`).
4. Paste the client ID in MeshJob and choose **Connect Gmail**.

Maintainers can ship a shared client by putting a Web application client ID in `scripts/oauth-client-id.txt` (or `MESHJOB_OAUTH_CLIENT_ID`) before building; its redirect URI uses MeshJob's fixed extension ID. Until Google verifies the restricted Gmail scope, the consent screen says the app is unverified and an unverified project serves at most 100 accounts in total; beyond that, users add their own client as above. [Chrome launchWebAuthFlow](https://developer.chrome.com/docs/extensions/reference/api/identity#method-launchWebAuthFlow), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Unverified apps](https://support.google.com/cloud/answer/7454865)

## Data and privacy

MeshJob has no telemetry. Source requests go to the origins you grant. Autofill reads and writes form controls on the active HTTPS tab after you authorize an action. It leaves final submission, consent, and certification to you. PDFs are parsed locally, and only selected files are uploaded to the intended form. Claude receives relevant text and form cues when enabled. Gmail receives read-only requests for message headers and short excerpts. Only minimal tracking evidence is kept. Chrome notifications can show recruiting subject lines.

Permissions used by default cover the toolbar and Side Panel, the active tab and scripted form access, local storage, scheduled checks, notifications, and URL rules that highlight the toolbar icon on application pages. Specific site origins and Chrome Identity are requested when needed. Chrome stores the Claude key in local plaintext accessible to trusted extension contexts. MeshJob does not store account passwords. Prefer Chrome Password Manager with a unique password per site. Credentials and raw mailbox data are excluded from backups.

Tracker exports UTF-8 CSV and can import a CSV with column mapping. MeshJob escapes formula-like cells and cells starting with an apostrophe by adding an apostrophe. Enable **Decode escaped cells** on import only for MeshJob CSVs. The ZIP backup retains checksummed records, answers, preferences and PDF blobs. Restore previews the data and offers merge or replacement. Restored sources require a new enablement choice. Exports contain personal information. [MIT license](LICENSE)
