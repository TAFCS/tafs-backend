# Meezan Bank Integration — Credential Request
**Date:** 10 May 2025
**From:** TAFS Development Team
**To:** Meezan Bank Integration Team
**Subject:** API Credentials Required for Go-Live

---

## Status

We have completed full implementation of both services on our end as per the Bill Collection API specification:

- **Service 1 — Bill Inquiry** (`/bill-inquiry`)
- **Service 2 — Bill Payment** (`/bill-payment`)

Both endpoints handle all request/response fields, status codes, and error scenarios as defined in the sample document (Ver 1.0). The implementation is ready and awaiting your credentials to go live.

---

## Our API Endpoints

| Service | Method | Endpoint |
|---|---|---|
| Bill Inquiry | POST | `https://tafs-webapp.vercel.app/api/v1/meezan/bill-inquiry` |
| Bill Payment | POST | `https://tafs-webapp.vercel.app/api/v1/meezan/bill-payment` |

> **Important — URL Change Notice:**
> The current domain is `tafs-webapp.vercel.app`. This URL will be updated to a permanent production domain before go-live. Please let us know if a domain change requires re-whitelisting or any reconfiguration on your side, so we can coordinate accordingly.

---

## What We Need From You

We require the following three credentials to configure our server:

| # | Parameter | Description |
|---|---|---|
| 1 | `ServiceUserId` | The service user ID your system will use when calling our APIs |
| 2 | `UserPassword` | The password associated with the service user ID |
| 3 | `BillCompanyCode` | The company/campus code assigned to our institution |

These are the values our system validates on every incoming request from Meezan. Without them, we cannot authenticate your calls.

---

## Next Steps

1. Meezan provides the three credentials above
2. We add them to our server environment
3. We confirm go-live and the endpoints are made active

Please share the credentials at your earliest convenience so we can complete the integration.

---

*For any queries, please reach out to the TAFS development team.*
