# User guide

For salespeople, operations, compliance, finance and managers. Everything here works on a phone too.

## The basics

- **Customer**: the business (legal name, VAT, contacts, sites, bank details). It's created once and kept forever.
- **Opportunity**: one sale to that customer, e.g. "Harbour Café – dual fuel" or a renewal. A customer collects opportunities over the years. Completed ones stay visible under **Live / Won**.
- **Stage**: where the opportunity is in the 18-step pipeline. The CRM checks what each stage needs and tells you exactly what's missing.
- **Tasks**: calls and to-dos with a due date. Many are created for you automatically (first contact, missing documents, signature chasers, renewals) and close themselves once the work is done.
- **Timeline**: everything that happened on an opportunity, with who did it and when. Entries can't be edited; if something was wrong, add a correction.

## Daily routine

1. Open **Dashboard**: overdue work, outstanding documents, compliance queries and renewals due are at the top.
2. Open **My tasks** and work through what's due today.
3. Use **Pipeline** to move deals along: drag a card, or use its ⋯ menu.

## Capturing a lead (30 seconds)

**Opportunities → New opportunity.** Only the **name** and **service** are required: Electricity, Gas, Dual Fuel or Merchant Services / Worldpay. Add the business, contact and phone if you have them. A *Make first contact* task appears for you straight away.

Other ways in:
- **Scan business card**: take a photo, check the details the scan read, pick an existing customer if one is suggested, then confirm. Nothing is saved until you confirm.
- Leads from the website or API arrive **unassigned** and are given to the least-busy salesperson within 15 minutes.

## Customers

From the opportunity's **Overview**, use **Create from these details** or **Link existing**. This never changes the opportunity's stage, salesperson or status.

Creating a customer always checks for duplicates (same email, phone, CRO number, VAT number, or name and Eircode). If there's a match you can open the existing record, start a new opportunity for it, or confirm it's a different business. Only a manager can merge duplicates.

## Energy deals

On the **Energy** tab:
1. **Add site**: the supply address. For rented premises you'll be asked for the landlord.
2. **Add meter**: the CRM shows **MPRN** for electricity (11 digits, starting 10) and **GPRN** for gas (7 digits). Dual fuel shows both. If a number really doesn't fit the format (a new connection, a Northern Ireland site), tick *genuine exception* and give the reason.
3. **Add contract**: current supplier, account number and end date from the bill, plus rates when you have them. Rates are entered in cent.
4. **Price comparison**: add each supplier's quote, then **Choose** the one the customer picks. This sets the selected supplier and the expected commission.

## Worldpay deals

On the **Worldpay** tab, **Start application**, then fill in:
- **Business details**: legal entity, turnover, card percentage, average transaction. These are needed before you send a proposal. If there's no website, give the advertising method.
- **Products & pricing**: at least one terminal or product.
- **Principals**: the people behind the business (owner, partners or directors depending on the legal entity), each with date of birth, nationality and 3 years of addresses. Once saved, these details are only visible to Compliance; you'll see "recorded ✓".
- **Underwriting & risk**: if the business takes deposits or full payment in advance, the follow-up questions appear.
- **Record customer acceptance** when they agree to the offer.

Compliance reviews the risk section. If they raise a query, you get a task and a notification.

## Documents

The **Documents** tab is the checklist. **Add standard checklist** adds the usual items. Upload by dragging a file onto a row or using **Upload** (PDF or photo, up to 20 MB). Every upload is kept as a new version. Operations or Compliance approve or reject each document; a rejected document has to be supplied again. Tick documents and **Request from customer** to log the request and create a chaser task.

Identity documents and bank statements are restricted: you can upload them but only Compliance, Finance and administrators can open them.

## Signatures

**Signatures → Request signature**: add the customer (and Utility Optimizer, if needed) as signers. When the customer has signed (in person or by returning a scan), use **Record signature** and attach the signed copy.

## What each stage needs

| Before moving to… | You need |
|---|---|
| Proposal Sent | Energy: at least one supply site. Worldpay: application with turnover, card % and average transaction. |
| Supplier or Product Selected | Energy: supplier chosen. Worldpay: a product/pricing line. |
| Documents Prepared | Customer linked; VAT number if VAT registered; landlord for rented sites; Worldpay: principals for the legal entity, risk answers (deposit/prepayment details if applicable), advertising method if no website. |
| Submitted *(Operations/manager)* | All of the above, plus an MPRN for every electricity meter and a GPRN for every gas meter, every required document received and approved, the customer's signature, internal approval and (Worldpay) compliance approval. |

If something's missing, the CRM lists it. The **Overview → Checklist** shows the same list in advance.

## After submission

- **Operations** submits (and can **Send submission pack** by email), records the supplier or Worldpay reference, tracks queries (**Compliance Query** stage) and confirmation.
- **Activate** records the go-live date. The opportunity moves to **Live / Won**, keeps its salesperson, contracts get their end dates and a renewal review is scheduled.
- **Renewals** are created automatically 120 days before a contract ends, as a new opportunity linked to the old one, assigned to the same salesperson. The old deal and contract are kept unchanged.

## Lost deals

**More → Mark as lost** with a reason. The deal stays in the CRM under **Lost** and can be reopened.

## Saved views

My open opportunities · All opportunities · All won · Energy · Worldpay · Renewals due · Awaiting customer · Awaiting supplier · Awaiting Worldpay · Compliance queries · Missing documents · Unsigned applications · Unassigned leads · Lost. Your last filters are remembered in your browser.

## Your account

If your administrator has set it up, use **Sign in with Microsoft** or **Sign in with Google** on the login page with your work account. If you've turned on CRM two-factor, you'll be asked for your code afterwards (not if Microsoft already asked for MFA).


**Account menu → Security & two-factor**: switch on two-factor authentication or change your password.
