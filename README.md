# Friends Self Help Group — Savings and Group Management System

Embu, Kenya · For us and the society · Est. 2024

Full-stack system for a Kenyan savings group: React + TypeScript + Tailwind front end, Node/Express API, PostgreSQL, Safaricom Daraja M-Pesa (STK Push + Paybill/Till C2B).
One Render web service serves the API and the built web app; one Render Postgres database holds the data.

## What is included
- **Homepage, login, member portal**: overview with separate Savings and Fines cards, M-Pesa payment prompts, statements, receipts, meetings and apologies, withdrawals, notifications, documents, "I paid another way" proof upload, PDF/Excel statement.
- **Admin portal** for the officials: members, payments and verification queue, fines, meetings and attendance, withdrawals (multi-level approval), income and expenditure, monthly reconciliation (discrepancy checks, approval, period locking), 16 reports (screen/PDF/Excel), historical imports, settings and rule versions, officials, announcements, documents, audit trail.
- **Records & documents**: the group's official register for the certificate of registration, constitution, minutes, resolutions, policies and compliance documents. Versioned (new versions supersede, never overwrite), archived with a reason, never deleted, with renewal-date alerts on the dashboard.
- **Exports**: membership register as CSV, Excel or PDF (National IDs are never exported); the secretary's exports are also filed as dated records. Every report also downloads as CSV.
- **Import as is, comply later**: members can be imported or registered with only a name. Missing or invalid National IDs and phone numbers are kept (as supplied) and flagged as pending compliance, then completed from the member's page. Members pending compliance cannot request withdrawals, and a portal login is created as soon as a phone or email exists.
- **Member ledger (the group's sheet)** (pages still exist but are no longer in the menu): the members-by-months sheet is the model. *Admin > Member ledger* shows every member and month (Cont and Fine columns, meeting absence penalties, savings, fines paid, arrears). **Load Excel sheet** imports `Friends_group_1.xlsx` as opening data (members as is, pending compliance; contributions and fines as historical ledger entries; meeting penalties; the Coop account-opening expense) after a preview with warnings and a check of the sheet's own totals. Fine cells follow the sheet's convention: positive = paid, negative = unpaid. **Every cell is editable** by the treasurer, chairperson and super admin: a reason is required, the ledger gets a correcting entry (nothing is overwritten) and the audit trail keeps the old and new values. **Export Excel** gives the same grid with the logo.
- **Manual payment entry (administrator only)**: on *Member ledger*, the super admin can record a payment for any member with the amount, the month paid and the pasted M-Pesa message. The M-Pesa code is read from the message and can be recorded once only. If the member has a live obligation for that month it goes through the normal payment engine and a receipt is issued; otherwise it is added to the member ledger for that month. No other role can do this, and every entry is audited and listed.
- **Invoices and payments (administrator)**: the administrator raises what a member owes for a month (monthly contribution, late fine, missing-meeting fine, for one member or, for contributions, all members). Amounts default to the group rules and can be changed. A posted payment says what it is for (everything owed, contributions only, or penalties only) and clears the member's open invoices **earliest to latest**; money beyond that pays future months in advance, a whole month at a time (up to 36). A preview shows exactly where the money goes, and an amount that cannot clear whole invoices is refused (no partial payments). Each member's profile and the *Member payments* page show how much they owe the group now, split into contributions and penalties. Savings and fines stay in separate ledgers; the M-Pesa code can be used once.
- **Member profile and Member payments**: opening a member shows total contributions, penalties accrued, paid and outstanding, savings balance, contributions month by month, penalties, payments entered by hand, and an individual financial report (PDF, Excel, CSV). The *Member payments* menu lists every member with these totals; click a member for the full report. The administrator can record a payment (amount, month, M-Pesa message) from the profile or from this page.
- **Group sheet**: *Admin > Group sheet* keeps the group's own Excel file as an official, versioned record and shows it exactly as it is (every cell, merged headings, colours, dates and numbers, all sheets). Download it back to Excel at any time; uploading an updated file keeps the previous version. Nothing is interpreted, so what you see is what the file says. The secretary uploads; treasurer and chairperson can view.
- **Branding**: the official logo appears top-left in the app and on every PDF/Excel export, and as a watermark on every page.
- **Rules enforced by the server**: KSh 1,500/month, deadline the 10th, one KSh 200 late fine per overdue month, KSh 5,000 unexcused-absence fine, no partial months, oldest month cleared first, savings and fines in separate append-only ledgers, corrections only by reversal.

## Deploy on Render (paid plans)
1. Push this folder to a GitHub repository (never commit `.env`).
2. Render dashboard: **New > Blueprint**, select the repository. `render.yaml` creates `savings-db` (Postgres `basic-1gb`, paid, with backups) and `savings-system` (web, `starter`, always on).
3. Fill the secrets when prompted:
   - `FIELD_ENCRYPTION_KEY`: run `openssl rand -hex 32`. **Keep a copy**; without it stored National IDs cannot be read.
   - `APP_BASE_URL`: the https URL of the service (or your custom domain).
   - `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`: first super admin (min 10 characters; changed at first login).
   - `GROUP_NAME`.
   - Daraja: `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` (plus `MPESA_TILL` and `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` if you collect on a Till).
   - Optional SMS: `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` (Africa's Talking).
4. Deploy. `preDeployCommand` applies migrations and creates the first admin if no users exist.
5. Sign in as the super admin, open **Settings > System & M-Pesa** and click **Register Paybill (C2B) URLs** once Daraja credentials are set. Callback URLs contain the auto-generated `MPESA_CALLBACK_SECRET`.
6. To go live with M-Pesa, set `MPESA_ENV=production` and use production credentials.

## Local development
```
cp .env.example .env
createdb savings_dev
npm install
npm run migrate && npm run seed
npm run dev:server     # API on :8080
npm run dev:client     # web app on :5173 (proxies /api)
npm test               # needs a savings_test database (TEST_DATABASE_URL)
```

## National IDs while there is no FIELD_ENCRYPTION_KEY
Members can be registered and their profiles completed without the key. National IDs saved in that period are stored unencrypted (marked `plain:`). Once you set `FIELD_ENCRYPTION_KEY` on Render, run `npm run rekey` once (Render shell) to encrypt them. Until then, treat the database as holding readable IDs.

## Fresh start for record keeping
`CONFIRM_ERASE_RECORDS=yes npm run reset-records` (run in the Render web service Shell, or locally) keeps every member exactly as is (profiles, status, photos, logins) and clears everything recorded for them: contributions, invoices, fines, payments, withdrawals, attendance, payment proofs, statement and reconciliation data, notifications, and data loaded from the group sheet. It keeps staff accounts, rules and settings, the records register, other meetings, income, other expenditure and the audit trail, and restarts receipt/fine numbering from 1. It cannot be undone, so take a database backup first. Without the confirmation variable it does nothing.

## Operating notes
- A daily job (every 6 hours, idempotent) generates the month's obligations, accrues late fines, sends reminders and flushes the SMS outbox.
- Approved months are locked in the database; only the chairperson/super admin can reopen one, with a recorded reason.
- Roles: super_admin, chairperson, treasurer, secretary, member. Permissions are enforced on the server, not only hidden in the UI.
- Export month-end reports (PDF/Excel) for the committee's records in addition to Render's database backups.

## Overpayments and dates
A payment clears what the member owes, earliest invoice first, whole invoices only. Anything left over is recorded as an overpayment: a credit held on the member's account (append-only credit ledger). It is not pushed into future months automatically. The administrator applies it from "Apply credit" (Member payments page or a member's profile) to penalties, contributions (including future months) or everything owed, oldest first. All dates are shown and typed as dd/mm/yyyy, including reports and exports.

## Correcting mistakes (administrator)
Every correction needs a reason and keeps the old and new values in the audit trail; nothing is deleted. Fines: date, month, wording, amount (while unpaid) from the member's profile or the Fines page. Contribution invoices (unpaid): month, due date, amount. Payments entered by hand: date and message, or Reverse payment (the invoices it cleared open again, any overpayment credit it created is taken back, and the same M-Pesa code can be entered again correctly). Meetings: title, date and time, venue, agenda. Member details and registration date: Edit details on the profile.

## Payments, invoices list and clearing fines
Recording a payment no longer asks what it is for: it clears the member's invoices oldest first, whatever their type; any remainder is held as overpayment credit. Each member's profile has an "Invoices posted" tab listing every invoice (contributions and fines) with its month, amount, status and paid date. Months are written mm/yyyy everywhere. The administrator can clear outstanding fines to post them afresh: "Clear outstanding fines" on a member's Penalties tab, or "Clear all outstanding fines" on the Fines page (reversed with a reason, never deleted; paid fines are kept).

## Approving what a payment pays, and date style
Posting a payment records the money (amount, date, M-Pesa message and code) against the member and pays nothing by itself. The money waits as "received, not yet allocated". The administrator then opens "Allocate payment" and ticks which open invoices it settles (contributions, late fines, meeting fines, plus optional future months). Whole invoices only; what is not used stays on that payment. The payment keeps the day the money was received, so late-payment rules use that date. A wrong allocation can be undone (invoices open again, money returns to the payment); a wrong payment can be reversed. Dates are written with the month in words: 16/October/2026, and pickers choose day, month name and year.

## Statements

- **Individual statement** (Reports → Member report, and the member's own statement): an *Account summary* with total invoices, paid, unpaid and the balance left in the member's account (money received but not yet allocated), then the full invoice list, payments received (with what is still unallocated), contributions and fines. Optional From/To limit invoices and payments to a period.
- **Group statement** (Reports → Group statement): choose any period (From/To, or the quick buttons). It is a complete statement, not a summary: the period summary, every member's account, all invoices, all payments received, allocations approved by the administrator, the fines register, the savings ledger, withdrawals, other income, expenditure, and meetings with attendance. Available as PDF, Excel (one sheet per section, dates as `16/October/2026`) and CSV.

## Next of Kin & Beneficiary Nomination Form

- Every member fills in the form once, under **My profile & next of kin** in the portal: member details, up to 5 beneficiaries (shares must total 100%), primary and backup next of kin, a guardian/trustee when any beneficiary is under 18, and a witness (18+). Missing ID, phone, email or residence are saved to the member's profile.
- A **review and confirm** step comes before submission (the member ticks the declaration and signs by typing their full name). Once submitted the form is **read-only to the member**. Only the administrator (super admin) can amend it, giving a reason; every revision is kept in the history. The administrator can also submit it on a member's behalf.
- A profile reads **Non-compliant** until the form is submitted (together with National ID and phone). Non-compliant members cannot request withdrawals.
- Officials with member access can view the form and **download it as a PDF** (member profile → Next of Kin form → Download PDF). The PDF follows the group's template with the letterhead, colours and watermark. Section 5 and the witness signature are left blank for ink and stamp.
- The form is stored encrypted. Optional letterhead settings (environment variables): `GROUP_REG_NO`, `GROUP_ADDRESS`, `GROUP_TEL`, `GROUP_MOTTO`. Where a value is not set, the printed form shows a line to write on.

## Member photo and ID card

Each member can take or upload a passport-style photo and both sides of their ID card under **My profile & next of kin** (phone photos are shrunk before upload). A member can add each image once; replacing or removing is for officials (member profile → Photo and ID card → View or upload; removal is super admin only). Images are stored in the database, are visible only to the member and to officials with member access, and every view is audited. They do not affect the Compliant / Non-compliant status.
Each slot has a **Take photo** button that opens the phone camera directly (front camera for the portrait, rear camera for the ID card) as well as a gallery option. The member's photo is shown beside their name in the portal header and on their profile, and officials see it at the top of the member's profile. Images are shown from `blob:` URLs, so the security policy in `server/src/app.ts` allows `img-src blob:`.

## Suspending automatic fines

Settings → Group rules has an **Automatic fines** switch. While it is suspended the system adds no late-payment fines and no unexcused-absence fines on its own (contributions still show as overdue, and any fine can still be raised by hand). The migration that introduced it leaves automatic fines **suspended** on existing deployments. Turning them back on asks for a start date: only contributions due, and meetings held, on or after that date are fined automatically, so the suspended period is never fined retroactively. Each change needs a reason and is recorded in the audit trail.

## Administrator-managed accounts

While `admin_managed` is on (Settings → Rules, super admin only; default on), the administrator decides what is owed:
- Members and officials see no "amount owed" figures; there are no automatic overdue marks, fines or reminders.
- A deposit that does not name its invoices is held until the administrator allocates it.
- A month's contribution falls due on the deadline day of the **following** month (October is due 10 November), set per rule version by `due_month_offset`.
Switching it off restores the automatic behaviour.
