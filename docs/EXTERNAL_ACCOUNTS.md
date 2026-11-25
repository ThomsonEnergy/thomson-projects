# External Accounts and Long-Lead Setup

Last updated 25 Nov 2026

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
| Photoroom (automatic cut-out in the picture editor, item 73c) | No account yet (12 Nov 2026). Optional: the editor cuts out by hand without it. | When wanted: photoroom.com/api, make an account, take the Remove Background API (Basic plan, about 2 US cents a picture), copy the API key into TEops Settings > API Keys > Photoroom API key. Then cut one picture out in a quote's editor to prove it. |
| Apple Developer Program (organisation) | Submitted 17 Oct 2026, Enrollment ID 58NBR3V7K9. No confirmation email ever arrived and on 22 Oct 2026 the Apple Developer app showed "Enroll Now"; re-enrolling in the app (passport ID check) failed with "contact support". Support case **103004717118** opened 22 Oct 2026 via developer.apple.com/contact (Program Enrolment) quoting the Enrollment ID. TEgo app (bundle ID `au.com.thomsonenergy.app`) is built and waiting on this. | **Update 24 Nov 2026:** Apple opened a second enrolment, ID **9DL8BD28YZ** (27 Oct). Support (Ryan, 2 Nov) asked for photo ID, employment verification and an ASIC certificate or ABR extract through developer.apple.com/contact/file-upload; Apple confirmed receiving documents on 12 Nov, no answer since. The first enrolment 58NBR3V7K9 was due to be withdrawn about 17 Nov (licence agreement not clicked within 7 days). On 14 Nov the sign-in was renamed by Apple Business (see "Apple" below), so the old email reads as "account does not exist". Owner chased case 103004717118 by email on 24 Nov. Next: sign in with the @thomsonenergy.appleaccount.com name, then get support to say which enrolment is live. Earlier note: Watch for a reply from developer@email.apple.com (check Spam too) or a call on 0455 415 464. If Apple asks for proof of authority, send a current ASIC company extract. Then accept the agreement, pay ~AU$149/yr and follow `docs/IOS_APP.md`. Decided 22 Oct 2026: never rent or borrow another party's developer account; publishing through an agency only if Apple drags past a month. |
| Apple Business (Manager) | Account created 17 Oct 2026 ("Manage IT needs") | Note the **Organisation ID** (Preferences > Organisation information): the TEops iPhone app ships as a private Custom App to that ID. Skip MDM, Managed Apple Accounts and Apps and Books. |
| Twilio | Business Profile **approved** 18 Oct 2026. AU Mobile regulatory bundle (Business, Messaging channel, Direct Customer) **approved** 18 Oct 2026. Test number **0468 085 277** (+61468085277) active: Voice, SMS, MMS, US$8.25/month. Messaging and Voice configuration not set up yet. | SMS/calls are built after the native iPhone app (decided 17 Oct 2026, backlog item 7), then tested on this number. Until then: turn on 2FA, set a usage alert (~US$20), rename the account to Thomson Energy. |
| Pear Telco (hosted phone system, a possible alternative to building calls on Twilio) | Proposal received 25 Nov 2026 (quote QP261125, in the owner's Gmail). Nothing signed. A "Thanks for choosing Pear X-Fax" sign-up email also arrived the same day; fax is not in the quote, owner to check whether that was meant. | Owner decides after Pear answers the questions in `docs/IDEAS_BACKLOG.md` item 7 ("Pear Telco alternative"). Do not sign a number port with Pear until then. |
| Telstra (0455 415 464) | Number still on Telstra. | Note the account number, exact account holder name, DOB/ABN on the account, any port-out PIN or lock, and the contract end date. Do not cancel anything. |
| NSW surveillance notice | Drafts written 18 Oct 2026 in `policies/`: surveillance notice (covers AI and future location), AI Features Consent, Location Tracking Consent. | Send all three to Formby or an HR adviser. After sign-off, fill in the start date, load the notice and AI consent in Settings > Onboarding, then give existing staff the notice (14 days before the start date). |

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
- **Sign-in renamed 14 Nov 2026.** thomsonenergy.com.au was added to Apple Business on 17 Oct 2026 and never verified (no TXT record within 14 days; warning email 31 Oct). On 14 Nov Apple renamed the 1 account on @thomsonenergy.com.au to **@thomsonenergy.appleaccount.com** (same password). Confirmed 24 Nov 2026: the sign-in is now `jasper@thomsonenergy.appleaccount.com` and it works on developer.apple.com. Signing in with the old email says the account does not exist. To get the old name back: add the TXT record in Netlify DNS, verify the domain in Apple Business, then change the account's domain back. Still never turn on domain capture or lock.
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

## invoice@ (Google Group)

- invoice@thomsonenergy.com.au is a Google Group (supplier bills, statements, price lists only). Members: sales@ (added 18 Oct 2026 so TEops reads it), jasper@, accounts@, jade@.
- sales@ Gmail filter: To invoice@, skip the inbox, label `Supplier Bills`, never spam.
- TEops sends supplier queries FROM invoice@ through the sales@ connection. Needs invoice@ as a "Send mail as" address on sales@ (Gmail, signed in as sales@: Settings > See all settings > Accounts > Send mail as > Add another email address > invoice@thomsonenergy.com.au (leave "Treat as an alias" ticked), verify with the code emailed to invoice@). Until that is done Gmail sends them as sales@. Status: owner to do (18 Oct 2026).


## Netlify (hosting, team "Thomson Energy", project `thomsonprojects`)

- Pro plan, billed in credits. **19 Oct 2026: the credits ran out mid afternoon, so every merge to `main` after 3:09pm (PRs #85 to #104) was skipped and the live site stayed on the old version for about 6 hours.** The owner upgraded to 5,000 credits that night. Netlify does not build the skipped commits by itself: the next merge to `main` (or Deploys > Trigger deploy > Deploy project) builds the latest code.
- If the site stops picking up merges: open https://app.netlify.com/projects/thomsonprojects/deploys and look at the top rows and any banner. "Skipped" or a credits banner means credits; "Failed" means read the log. Check credits under Team > Billing before anything else.
- Each deploy uses credits, so docs-only changes are merged in one go where possible rather than one PR per line.
