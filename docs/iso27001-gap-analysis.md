# ISO/IEC 27001:2022 gap analysis (Annex A)

**Date:** 15 October 2026 · **Scope:** the Utility Optimizer CRM software and its documented deployment.

## What this document is

ISO/IEC 27001 certifies an **organisation's information security management system (ISMS)**, not a piece of software. Certification needs a defined scope, a risk assessment, a Statement of Applicability, policies, training, internal audit and management review, and is granted only by an **accredited certification body** after a Stage 1 and Stage 2 audit. No software can "be ISO 27001 compliant" on its own.

What software can do is **implement the technological controls** and **produce the evidence** an auditor will ask for. This analysis maps the CRM against the Annex A controls that software can affect, and lists what Utility Optimizer must put in place itself. Use it as input to your Statement of Applicability.

**Status key:** ✅ Met by the software (evidence given) · 🟡 Partly met: the software supports it, configuration or a process is also needed · 🏢 Organisational: outside the software

## Clauses 4–10 (the management system)

🏢 All organisational: ISMS scope (include the CRM, its cloud hosting, RingCentral, the e-signature and email providers), information security policy, risk assessment and treatment plan, Statement of Applicability, objectives, competence and awareness, document control, internal audit, management review, corrective action. This document, [security-assessment.md](security-assessment.md) and [security-matrix.md](security-matrix.md) can be referenced as evidence for the CRM.

## A.5 Organisational controls

| Control | Status | How the CRM meets it / what's needed |
|---|---|---|
| 5.1 Policies for information security | 🏢 | Write and approve the policies. |
| 5.2 Roles and responsibilities | 🟡 | Six system roles with a published permission matrix ([security-matrix.md](security-matrix.md)). Assign the people who own the system, approve access and review logs. |
| 5.3 Segregation of duties | ✅ | Internal approval only by managers; activation and submission by Operations; restricted compliance notes only for Compliance; bank details only for Finance/Compliance; merging customers manager-only; audit log administrator-only. Enforced server-side on every request. |
| 5.9 Inventory of information and assets | 🟡 | [field-dictionary.md](field-dictionary.md) lists every stored field. Add the CRM, its data stores and providers to your asset register. |
| 5.10 Acceptable use | 🏢 | Policy and staff acknowledgement. |
| 5.12 Classification of information | 🟡 | Restricted fields are classified in code (encrypted, masked, audited on reveal; see "Restricted data" in the security matrix). Adopt a classification scheme that matches. |
| 5.14 Information transfer | 🟡 | TLS required in production; documents leave only through short-lived signed links or the audited submission pack. Agree transfer rules with suppliers and Worldpay. |
| 5.15 Access control | ✅ | Deny-by-default guards; role capabilities plus row-level rules on every request; other people's records return 404. Verified by the automated authentication, CSRF and IDOR sweeps across all 150 API operations. |
| 5.16 Identity management | ✅ | One account per person, unique email, deactivation keeps history; SSO only signs in existing, active users (never auto-creates). |
| 5.17 Authentication information | ✅ | Passwords ≥ 12 characters, scrypt-hashed, current password needed to change, admin resets audited; TOTP 2FA with single-use codes; MFA secrets encrypted; session tokens stored only as hashes. 🏢 Issue and recover credentials securely; consider enforcing 2FA for all staff. |
| 5.18 Access rights | 🟡 | Role changes and deactivation end all sessions immediately and are audited. 🏢 Quarterly access review (export users and roles from Administration) and a leaver process. |
| 5.19–5.22 Supplier relationships and cloud services (5.23) | 🏢 | Due diligence and contracts (incl. GDPR Art. 28 DPAs) for hosting, RingCentral, OCR, e-signature, email and WhatsApp providers. The CRM isolates each behind an adapter and stores credentials only in environment variables. |
| 5.24–5.27 Incident management | 🟡 | Evidence is available: append-only audit log, request ids, logged access refusals, failed MFA and password-change attempts. 🏢 Incident response procedure, contacts, and alerting from your log platform. |
| 5.28 Collection of evidence | ✅ | Audit and timeline entries can't be edited or deleted (database triggers); corrections are new entries linked to the original. |
| 5.29–5.30 Continuity and ICT readiness | 🟡 | Stateless API/web, health endpoint, backup and restore procedure in [deployment.md](deployment.md). 🏢 Business-continuity plan, restore tests (quarterly suggested), RTO/RPO. |
| 5.31 Legal, statutory, regulatory requirements | 🏢 | Register of obligations (GDPR, ePrivacy for calls/WhatsApp, CRU for energy, PCI context for Worldpay referrals). |
| 5.33 Protection of records | ✅ | Opportunities can't be deleted or archived (trigger); historical contracts are immutable once live; audit history is append-only. |
| 5.34 Privacy and protection of PII | 🟡 | Data minimisation (restricted fields masked by default), encryption of sensitive personal data, audited access, configurable retention that erases sensitive documents and principal data after deals are lost or contracts end, salespeople limited to their own customers. 🏢 Records of processing, lawful basis, privacy notices, DPIA, and a procedure for access/erasure requests (performed by an administrator; there's no self-service export yet). |
| 5.36 Compliance with policies | 🏢 | Periodic review. |
| 5.37 Documented operating procedures | ✅ | [administrator-guide.md](administrator-guide.md), [deployment.md](deployment.md), [user-guide.md](user-guide.md). |

## A.6 People controls

🏢 All organisational (screening, terms of employment, awareness training, disciplinary process, responsibilities after termination, confidentiality agreements, remote working, event reporting). The CRM supports 6.5 (termination) by deactivating users and ending their sessions at once, and 6.8 (event reporting) through the audit trail.

## A.7 Physical controls

🏢 All organisational / hosting provider (data centre security is inherited from the cloud provider's certifications; office and clear-desk rules are yours). 7.10 storage media: files live only in the private bucket, encrypted server-side.

## A.8 Technological controls

| Control | Status | How the CRM meets it / what's needed |
|---|---|---|
| 8.1 User endpoint devices | 🏢 | Device management, screen lock, disk encryption. The CRM keeps no data in browser storage beyond the session cookie; idle sessions end after 60 minutes. |
| 8.2 Privileged access rights | ✅ | Administration is a separate capability, audit log admin-only, every admin action audited; admins can't read others' passwords or MFA secrets. 🏢 Keep the number of administrators small and review it. |
| 8.3 Information access restriction | ✅ | Row-level access for opportunities, customers, activities, chat and scans; masked principal and bank data; restricted documents; 1,710-request IDOR sweep passes. |
| 8.4 Access to source code | 🏢 | Repository access control, branch protection, reviews. |
| 8.5 Secure authentication | ✅ | SSO (OIDC + PKCE, state, nonce, issuer/audience/expiry checks) or password + optional TOTP; lockout after 8 failures; login throttling; identical errors for unknown and wrong accounts; HTTP-only, SameSite, Secure cookies; idle and absolute session expiry. |
| 8.6 Capacity management | 🟡 | Load-tested (see [security-assessment.md](security-assessment.md#stress-test)); scale-out guidance given. 🏢 Monitor resource use in production. |
| 8.7 Protection against malware | 🟡 | Upload type allow-list, content sniffing (rejects disguised executables), ClamAV adapter, files flagged until scanned. 🏢 Enable `VIRUS_SCAN_DRIVER=clamav` in production. |
| 8.8 Management of technical vulnerabilities | 🟡 | `npm audit --omit=dev` clean; dependency pins and overrides; automated security tests on every run. 🏢 Patch cadence, dependency monitoring (e.g. Dependabot), yearly independent pen test. |
| 8.9 Configuration management | ✅ | All configuration is validated at start-up (the API refuses to start with missing or unsafe settings, e.g. non-secure cookies in production); infrastructure defined in Dockerfiles and compose files; documented baseline. |
| 8.10 Information deletion | 🟡 | Retention job erases sensitive documents and principal data on schedule (audited). 🏢 Set retention periods to match your policy; bucket lifecycle for old object versions. |
| 8.11 Data masking | ✅ | Principal date of birth, nationality and address, compliance notes, bank details, identity documents masked unless the role holds the specific capability; duplicate warnings masked for salespeople. |
| 8.12 Data leakage prevention | 🟡 | Exports (commission CSV, submission packs) are capability-restricted and audited; file links expire in 5 minutes; CSV is formula-injection safe. 🏢 Email/DLP tooling on endpoints. |
| 8.13 Information backup | 🟡 | Procedure and retention in [deployment.md](deployment.md). 🏢 Configure managed backups and test restores. |
| 8.15 Logging | ✅ | Append-only audit log of business and security events (sign-ins, failures, MFA, password changes, role changes, sensitive reads, exports); structured JSON request logs with request ids; secrets and restricted fields redacted. |
| 8.16 Monitoring activities | 🟡 | Access refusals (401/403/429) logged with user, route and IP; health endpoint. 🏢 Central log platform with alerts. |
| 8.17 Clock synchronisation | 🏢 | Use NTP on hosts (cloud default). Timestamps are stored in UTC. |
| 8.18 Use of privileged utility programs | 🏢 | Restrict database and cloud console access. |
| 8.19 Installation of software on operational systems | 🟡 | Immutable container images built from locked dependencies. 🏢 Change control. |
| 8.20 Networks security | 🟡 | Only the web app is public; the API is reachable only through it. 🏢 Private networking for API, database, Redis and storage; firewall rules. |
| 8.21 Security of network services | 🟡 | TLS required (HSTS sent); `sslmode=require` and `rediss://` documented. 🏢 Enforce TLS 1.2+ at the load balancer. |
| 8.22 Segregation of networks | 🏢 | Separate production from development and test (separate databases are already supported). |
| 8.23 Web filtering | 🏢 | Endpoint/network control. |
| 8.24 Use of cryptography | ✅ | AES-256-GCM field encryption with key ids and rotation support; scrypt for passwords; SHA-256 for session tokens; HMAC-SHA256 for webhooks with replay protection; TLS in transit. 🏢 Keep `FIELD_ENCRYPTION_KEY` in a secrets manager, backed up separately. |
| 8.25 Secure development life cycle | ✅ | Typed code, linting, 148 automated tests including security regression and penetration suites on every run; threat-driven review documented. 🏢 Make tests a required CI check before merge. |
| 8.26 Application security requirements | ✅ | Requirements traced to tests ([test-report.md](test-report.md)): permissions, masking, audit, CSRF, sessions, uploads. |
| 8.27 Secure system architecture | ✅ | Layered guards (rate limit → session → CSRF → capability → row-level), deny by default, single proxy origin (no CORS), private object storage, adapters isolating third parties ([architecture.md](architecture.md)). |
| 8.28 Secure coding | ✅ | All input validated with schemas; parameterised database access only; output encoding by React; no `dangerouslySetInnerHTML`; generic error messages; injection fuzzing passes. |
| 8.29 Security testing in development and acceptance | ✅ | Automated authentication, CSRF, IDOR, injection, secret-exposure and load tests ([security-assessment.md](security-assessment.md)). 🏢 Independent penetration test before go-live. |
| 8.30 Outsourced development | 🏢 | If external developers work on the CRM: contracts, reviews. |
| 8.31 Separation of environments | 🟡 | Separate configuration and databases for development, test and production; production refuses unsafe settings. 🏢 Separate cloud accounts/projects. |
| 8.32 Change management | 🟡 | Forward-only, reviewed database migrations; versioned releases. 🏢 Change approval process. |
| 8.33 Test information | ✅ | Tests use generated data on a separate database, never production data. |
| 8.34 Protection during audit testing | 🏢 | Plan pen tests and audits with the operations team. |

## Summary

| Area | Met by software | Partly (software + your process) | Organisational |
|---|---:|---:|---:|
| A.5 Organisational (selected) | 7 | 8 | 5 |
| A.6 People | – | – | all |
| A.7 Physical | – | – | all |
| A.8 Technological | 13 | 12 | 8 |

## Path to certification

1. Define the ISMS scope and appoint an owner.
2. Run a risk assessment; use this document for the CRM's technological controls.
3. Write the policies listed as 🏢 and the Statement of Applicability.
4. Close the 🟡 items in production (backups and restore test, central logging and alerts, ClamAV, TLS policy, access reviews, network isolation).
5. Commission an independent penetration test of the production environment.
6. Operate the ISMS for at least 3 months (records of access reviews, incidents, training), then internal audit and management review.
7. Engage an accredited certification body (Stage 1 documentation review, Stage 2 audit).
