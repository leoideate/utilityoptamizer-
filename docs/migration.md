# Migrating existing customers

A one-off import of the customers Utility Optimizer had before the CRM. It reads the master sheet and the folder of signed supplier PDFs. Each sheet row becomes an existing customer with a won deal and a live (or ended) contract, and each PDF is attached to its deal. Both steps run from a terminal and write nothing until you add `--commit`. Running a step again is safe: rows and PDFs that were already imported are skipped.

## Before you start

- **Back up the database.** Imported deals are permanent, like every opportunity.
- **Add every salesperson as a user** under **Users & roles**, using the same name as the sheet's *Sales Agent Name* column (capitals don't matter). Rows whose agent has no matching user are imported unassigned.
- **Either sheet layout works.** The original master sheet (one tab per supplier) and the aligned export (`Business name, Trading name, Country, Contact person, Contact number, Contact number (+353), Email, MPRN/GPRN, Supplier, Utility type, Product type, Contract start, Expiry date, Contract term (years), Contract status, Sales agent`). With a *Supplier* column, each row's supplier comes from it; the +353 number is preferred over the local one; a missing contract start is fine (the expiry date keys the row).
- **Check the suppliers.** Each tab's name is its supplier ("Flogas", "Bord Gais"; old Bord Gáis spellings are recognised). A tab called *Worldpay* imports card-payment customers. Suppliers the CRM doesn't have are reported; add them under **Administration**, or pass `--create-suppliers`.
- **Run from a machine with the repository** (`npm install` done). Point `apps/api/.env` at the database you're importing into. To attach PDFs, Redis must be running too, because each upload is queued for a virus scan.

## On the live CRM: Administration → Import customers

Administrators can run the import from the CRM itself, with nothing installed and no database password on anyone's computer:

1. **Back up the database** (Render → the database → Backups), and add any missing salespeople under **Users & roles**.
2. Open **Administration → Import customers**, choose the sheet and click **Run dry run**. It runs on the server in the background (a thousand rows take about a minute) and changes nothing.
3. Read the report: counts, statuses, skipped rows and why, rows with warnings. **Download report** gives every row as a CSV.
4. For each sales agent name the CRM doesn't know, choose the user it is (a first-name match such as "Abdullah Liaqat" → "Abdullah" is pre-filled), choose **Add as a new salesperson** and enter their work email, or leave it unassigned. New salespeople are created as Salesperson users when you import, with a random password: set one under **Users & roles → Reset password** when they start signing in.
5. Click **Import** and confirm. The import also runs in the background (a few minutes); the page shows the result. Running it again skips rows already imported.

Runs and their copy of the sheet are kept for 90 days, then deleted by the retention job. Signed PDFs are still attached with the script below.

## 1. Customers and contracts (from a terminal)

```bash
npm run migrate:customers -w @uo/api -- "C:\path\UOL - Master sheet.xlsx"
```

This dry run prints a summary and writes `apps/api/migration-out/customers-report.csv`, one line per row. The report folder is gitignored because it holds customer details. Check:

- **Statuses.** Rows whose *Contract Status* looks cancelled, rejected, lost, withdrawn, duplicate or error are imported as **lost deals** (at Submitted, lost reason "Master sheet status: …", a cancelled contract with the meter, no renewal and no meter task), so their history is in the CRM. *Clawback* is imported as an *ended* contract (history, no renewal). Every other status (Accepted, Ready for Invoice, Under Investigation…) is imported; a contract whose expiry date has passed is *ended*, any other *live*. The sheet's own status is shown on the deal and in the Customers list's *Contract status* column.
- **Missing or non-standard MPRN/GPRN.** A row with no meter number is still imported (as electricity if nothing says which fuel); a row with no utility type takes its fuel from the meter number's length (7 digits or fewer: gas) and gets a task to check it; with `--allow-format-exceptions`, so is one whose number isn't in the standard format. Each such deal gets a high-priority task for the first administrator ("Add the missing GPRN…" / "Check the GPRN…", due in a week), and after a committed run every administrator gets one notification with the count.
- **Skipped rows.** Each has its reason, for example:
  - a missing name;
  - a badly formatted MPRN/GPRN without `--allow-format-exceptions` (the admin page ticks it by default);
  - a dual fuel row (split it into one row per meter);
  - a row that matches more than one existing customer (merge them first).
  
  Fix the sheet and run again. To import meter numbers that really don't follow the standard format, add `--allow-format-exceptions`; each one is then recorded with a reason.
- **Repeated rows.** A row with the same meter, dates and status as an earlier row is imported as its own record, with a warning naming the earlier row.
- **Customer column.** It shows whether the row creates a new customer or reuses one. A customer is reused when it matches exactly one existing customer by email, phone, or name and Eircode. Several rows for the same business share one customer.
- **Renewals.** The summary counts live contracts that end within 120 days. The renewal job opens renewal deals for them at its next 07:00 run.

When the report looks right:

```bash
npm run migrate:customers -w @uo/api -- "C:\path\UOL - Master sheet.xlsx" --commit
```

Each imported deal is at **Live / Won**, with lead source *Master sheet import*. Its supply site, meter point and contract come from the row: supplier, product, term, start date, and expiry (or start date plus term). The sheet's other columns are kept in a note on the deal's timeline: status, sign date, connection type, the two comment columns, email date, posted by, reviewer and review date. Every import is in the audit log as `migration.import`.

## 2. Signed PDFs

```bash
npm run migrate:documents -w @uo/api -- "C:\path\Signed forms"
```

The folder is searched recursively. Each PDF is matched to an imported deal by the MPRN or GPRN found in its form fields, its page text or its file name. If none of those match, it is matched by the customer's business name appearing in the PDF or file name. The dry run writes two files:

- `migration-out/pdf-report.csv`: what happens to every PDF.
- `migration-out/pdf-review.csv`: PDFs with no match, or with several. Fill in the **Match** column with a deal number (`UO-000123`) or the MPRN/GPRN, then pass the file back:

```bash
npm run migrate:documents -w @uo/api -- "C:\path\Signed forms" --matches apps/api/migration-out/pdf-review.csv --commit
```

Each matched PDF is added to its deal's Documents tab as a *Supplier application form* and virus-scanned. A PDF that's already uploaded anywhere in the CRM is skipped.

## After the import

The **Customers** list shows the sheet's columns, taken from each customer's latest contract: business and trading name, contact person, contact number, email, MPRN/GPRN, supplier, utility, product, start date, expiry, status and sales agent. You can search it by MPRN or GPRN.
