# External Accounts and Long-Lead Setup

Last updated 18 Oct 2026

Progress on the outside accounts that gate SMS/calls (backlog item 7) and the native iPhone app (item 3), plus decisions made along the way. No secrets here: Auth Tokens and passwords never go in the repo or in chat.

## Company details used everywhere

- Legal name: **THOMSON ENERGY AUSTRALIA PTY LTD**
- ABN 88 689 985 831, ACN 689 985 831, Australian Private Company, ANZSIC 3232 Electrical Services
- **Business / HQ address: 7319 Tweed Valley Way, Fernvale NSW 2484.** Use this for Twilio, Apple and D&B.
- Not to be used as the HQ address: PO Box 292 Kogarah NSW 1485 (postal only) and the ASIC registered office in Kogarah NSW 2217.
- Authorised representative: Jasper Thomson, Director (also Company Secretary and Public Officer). Job title on forms: **Director**.
- Website: thomsonenergy.com.au. Main phone: 0455 415 464.
- **D-U-N-S: 775058635** (issued 17 Oct 2026)

## Status

| Account | Status | Next step |
|---|---|---|
| D-U-N-S | Done, 775058635 | None |
| Apple Developer Program (organisation) | Submitted 17 Oct 2026, Enrollment ID 58NBR3V7K9. Apple is verifying signing authority. | Watch for Apple's email or call (answer unknown calls on 0455 415 464). Accept the agreement and pay ~AU$149/yr. Chase Apple Developer Support with the Enrollment ID if nothing after ~2 weeks. |
| Apple Business (Manager) | Account created 17 Oct 2026 ("Manage IT needs") | Note the **Organisation ID** (Preferences > Organisation information): the TEops iPhone app ships as a private Custom App to that ID. Skip MDM, Managed Apple Accounts and Apps and Books. |
| Twilio | Business Profile **approved** 18 Oct 2026. AU Mobile regulatory bundle (Business, Messaging channel, Direct Customer) **approved** 18 Oct 2026. Test number **0468 085 277** (+61468085277) active: Voice, SMS, MMS, US$8.25/month. Messaging and Voice configuration not set up yet. | SMS/calls are built after the native iPhone app (decided 17 Oct 2026, backlog item 7), then tested on this number. Until then: turn on 2FA, set a usage alert (~US$20), rename the account to Thomson Energy. |
| Telstra (0455 415 464) | Number still on Telstra. | Note the account number, exact account holder name, DOB/ABN on the account, any port-out PIN or lock, and the contract end date. Do not cancel anything. |
| NSW surveillance notice | Not started. | Send the notice draft to Formby or an HR adviser (starts the 14-day clock sooner). |

## Twilio and the main number

- ServiceM8 never gave us a Twilio login. SM8 used 0455 415 464 only as a Twilio **verified caller ID** (outbound caller ID only, no SMS, inbound still goes to Telstra). The signed Twilio document was for that, or for a port that never finished.
- Plan:
  1. Business Profile approved, then the AU Mobile regulatory bundle approved. Australian numbers cannot be bought before that.
  2. Buy one temporary AU mobile number (a few dollars a month) to build and test TEops SMS/calls on. Done: 0468 085 277. The build waits for the native iPhone app (no interim forward-to-mobile phase, decided 17 Oct 2026).
  3. Port 0455 415 464 from Telstra into our Twilio account (new LOA signed in Twilio, roughly 1 to 2 weeks).
  4. Keep SM8 calling and the Telstra service until the port completes. After the port, the Telstra SIM no longer gets calls or texts on 0455; decide whether it keeps a new number or is cancelled.
- Onboarding answers used: Messaging + Voice, With code.
- Number compliance flow only allows one channel at a time; Messaging was chosen first, Voice can be added later. The bundle is a separate "registration" from the Business Profile, and the approved profile feeds it.
- SIDs (Account, Business Profile, bundle) are not recorded in this public repo. The Account SID goes into TEops Settings (`api_keys`) at build time. Domain verification skipped (only for org-wide user management, not needed).
- The Auth Token goes into TEops Settings (`api_keys` table) when SMS is built, never into chat or the repo. The Account SID is not secret.

## Apple

- Use an Apple Account with 2FA on a work email (jasper@thomsonenergy.com.au) so the business owns it.
- Apple Business domain verification is optional and not needed for TEops. If it is ever done, the TXT record goes in **Netlify DNS** (the domain is registered at GoDaddy but DNS is on Netlify/NS1; never change the GoDaddy nameservers). Never turn on domain capture or lock, which would force anyone with a personal Apple ID on an @thomsonenergy.com.au email to change it.

## Email provider decision (17 Oct 2026): stay on Google Workspace

- TEops email is built on the Gmail API (sales@ sync every 5 minutes, sending, and the planned per-user inboxes with instant alerts, one-tap sign-in and Gmail drafts). The agent plan also uses Drive and Calendar.
- Alternatives considered:
  - Apple Business email: free, but IMAP only.
  - Microsoft 365 Business Basic: ~AU$9/user. The only real Gmail-equivalent API.
  - Zoho Mail: ~AU$2 to $6/user.
  - Fastmail: ~AU$8/user.
  - Web host email.
  
  Any switch means rebuilding the TEops email integration on a live app, for a small saving.
- Current setup: Business Starter, Annual plan (monthly payment), 7 assigned + 2 unassigned seats. Mailboxes: andrew, brad, jasper, cooper, nathan, jade, sales@ (Thomson Energy Team). sales@ must stay a real mailbox because TEops reads it via the Gmail API.
- Savings to action:
  - **Gemini Business (Legacy) add-on**, 3 licences on the Flexible plan. Check its cost on the invoice and cancel if not needed: Gemini features are now bundled with Workspace plans, and we use Claude.
  - **2 unused Starter seats** are paid for on the annual plan. Drop to 7 seats at renewal (note the renewal date), unless hiring soon.
- Revisit the provider only before the per-user inbox build (backlog item 5), since that is when the integration deepens.
