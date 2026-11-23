# MPI MDM Dashboard

A fully client-side HTML/CSS/JS dashboard for Master Data Management (MDM) reporting. 

## Always-visible data on Vercel (publish via git)

Both pages load published data automatically when they open:

| File | Shown on |
|---|---|
| `reports/latest.csv` | Metrics page and Data Quality page |
| `reports/dq_latest.csv` (optional) | Data Quality page (used before `latest.csv`) |

To update: replace the file (keep the same name), then `git add reports && git commit -m "Update data" && git push`.
Vercel redeploys in about a minute and everyone sees the new data. Files uploaded to S3 take priority.
The dashboard pages have no upload button; all uploads, the file list and deletes are on `upload.html`, opened by clicking the **MPI DASHBOARD** title 3 times within 1.5 s (no visible link; the page needs `UPLOAD_KEY`).

## Shared, persistent data with the Node server

```
node server.js        # then open http://localhost:3000
```

Uploads are saved on the server in `data/` and reload automatically for everyone who opens the link
(other people on your network use `http://<your-PC-IP>:3000`). To share beyond your network, deploy this
folder to any Node host (Render, Railway, a VM) and point `DATA_DIR` at a persistent disk.
Without the server (Live Server / file://), data stays in the current browser only.

## S3 storage (`s3://hike-mpi/uploads/mdm/` and `uploads/dq/`)

Same setup as the JHP dashboard: `api/csv-url.js` is a Vercel serverless function and the only code that talks to S3.
The bucket stays private and the browser never gets an S3 link.

| | |
|---|---|
| **Read** | Metrics page shows the newest CSV in `uploads/mdm/`; Data Quality shows the newest in `uploads/dq/` (then `uploads/mdm/`). Falls back to `reports/*.csv`. |
| **Upload / list / delete** | `upload.html`: click the dashboard title 3 times quickly. Needs `UPLOAD_KEY`. Uploads go browser → S3 with a 2-minute signed form (CSV only, ≤ 4 MB, stored as `<timestamp>_<random>_<name>.csv`). Delete cannot be undone unless bucket versioning is on. |

**Environment variables** (`.env` locally, and Vercel → Settings → Environment Variables, then redeploy):
`S3_BUCKET=hike-mpi`, `S3_REGION=ap-south-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `UPLOAD_KEY`, optional `DASHBOARD_KEY` (viewing password).

**Local:** `npm install` once, then `npm run dev` and open http://localhost:3000. Live Server (:5500) has no API and only shows `reports/`.

**AWS (once):** IAM policy for the `VercelS3` user:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListUploadFolders", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::hike-mpi",
      "Condition": { "StringLike": { "s3:prefix": ["uploads/mdm/*", "uploads/dq/*"] } } },
    { "Sid": "ReadWriteDeleteUploadFiles", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::hike-mpi/uploads/mdm/*", "arn:aws:s3:::hike-mpi/uploads/dq/*"] }
  ]
}
```
Bucket CORS (needed for uploads only): `AllowedOrigins` = your Vercel URL and `http://localhost:3000`, `AllowedMethods` = `POST`, `AllowedHeaders` = `*`.

## How to run in VS Code

### Option 1 — Live Server (recommended)
1. Open the `mdm-dashboard` folder in VS Code
2. Install the **Live Server** extension (by Ritwick Dey)
3. Right-click `index.html` → **Open with Live Server**
4. Browser opens at `http://127.0.0.1:5500`

### Option 2 — Direct browser open
1. Open `index.html` directly in Chrome or Firefox
   - Note: Chrome may block `sessionStorage` between pages on file:// — use Live Server for best results

---

## Project structure

```
mdm-dashboard/
├── index.html              ← MDM Metrics & Trends page
├── pages/
│   └── data-quality.html  ← Data Quality analysis page
├── css/
│   └── style.css          ← All styles
├── js/
│   ├── main.js            ← Metrics page logic
│   └── data-quality.js    ← Data Quality page logic
├── sample_mdm_data.csv    ← Sample CSV for testing
└── README.md
```

---

## CSV format

Upload a CSV file with **exactly** these column headers (case-insensitive):

| Column | Type | Description |
|---|---|---|
| `source_id` | string | Unique source identifier (e.g. SRC-0001) |
| `source_name` | string | Human-readable source name |
| `source_records` | integer | Total records from this source |
| `golden_records` | integer | Merged/deduplicated golden records |
| `singleton_rate` | float (0–100) | % of golden records that are singletons |
| `potential_matches` | integer | Records flagged as potential duplicates |
| `week` | string | Reporting week (e.g. 2024-W01) |
| `status` | string | Updated / Jump / No change |
| `resource_type` | string | Patient / Practitioner / Organization |
| `singleton_records` | integer | Raw count of singleton golden records for this row |

**Singleton Rate KPI:** calculated as sum of `singleton_records` ÷ sum of `golden_records` × 100 (the per-row Singleton % in the table is derived the same way). The `singleton_rate` percentage column is still accepted but is no longer used in these calculations.

### Validation rules applied
- All 10 columns must be present
- `source_records`, `golden_records`, `potential_matches` must be numeric integers
- `singleton_rate` must be numeric and between 0 and 100
- `golden_records` cannot exceed `source_records`
- `status` must be one of: Updated, Jump, No change (or empty)
- `resource_type` must be Patient, Practitioner or Organization (other values are flagged as warnings on the Data Quality page)
- `singleton_records` must be a non-negative integer and cannot exceed `golden_records` (error)
- Duplicate `source_id + week` combinations are flagged as warnings

### MDM weekly report format (e.g. `JHP_MDM_Report_YYYYMMDD.csv`)
The native MDM export is also accepted and mapped automatically by `js/mdm-format.js`:

| Standard column | Mapped from |
|---|---|
| `source_id` | `resource_type` + `source` (e.g. `Patient-Magellan`; prefixed with `client` if the file has several clients) |
| `source_name` | `client resource_type — source` |
| `source_records` | `source_recs` |
| `golden_records` | `golden_recs` |
| `singleton_rate` | `singleton_pct` |
| `potential_matches` | `potential_matches` (blank on per-source rows → 0; reported on the `ALL` row) |
| `week` | `snapshot_date (period)` |
| `status` | derived from week-over-week change in source records (>5% = Jump, 0 = No change, else Updated); blank for a source's first week in the file |

Rows with `source = ALL` are per-resource-type totals. Headline KPIs and trend charts use them
instead of summing per-source rows (golden records are shared across sources, so a plain sum
would double-count). The source-volume bar chart uses the per-source rows only.

---

## Pages

### MDM Metrics & Trends (`index.html`)
- Report generation panel (Daily / Weekly / Monthly specs)
- CSV upload with drag-and-drop
- Resource type filter (Patient / Practitioner / Organization) — KPIs, charts and the table show one type at a time
- 5 KPI headline cards
- Source vs Golden records trend chart
- Top 10 source records bar chart
- Potential match ratio line chart with alert threshold
- Paginated, searchable, sortable all-sources table

### Data Quality (`pages/data-quality.html`)
- Reuses uploaded data via sessionStorage (or re-upload)
- Quality score KPI cards
- Column completeness bars
- Validation rule check panel (10 rules)
- Row-level issues table (filterable by severity)
- Numeric field statistics table

---

## Sample data

Use `sample_mdm_data.csv` to test — it has 14 sources × 3 weeks = 42 rows, all valid. Sources are split across the three resource types (5 Patient, 5 Practitioner, 4 Organization per week).
