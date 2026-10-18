# Decisions and Progress Log

Newest first. One line per decision, scope change, idea or finished task, with where the detail lives. Every chat (cloud, laptop, planning) adds its lines before it ends; see "Keep every chat in the loop" in `CLAUDE.md`. Read this first to catch up.

## 18 Oct 2026
- Team chat LIVE on production: migration 20261020000000 applied (staging first), PR #45 merged and deployed. Next: owner publishes the new AI consent version, tests with 2 people, sets a WhatsApp cutover date. (`docs/PROJECT_SPEC.md` A19a)
- Team chat built with Sparky (job tagging, voice transcripts, @Sparky answers): migration 20261020000000 on staging, code on PR `claude/team-chat`, waiting on owner's yes for production. Defaults used: company feed stays as is, only admins make channels, staff only (no subcontractors). (`docs/PROJECT_SPEC.md` A19a, `docs/AI_AGENTS_PLAN.md`)
- AI in chat goes live per person on signing: staff can agree to a shorter notice period than 14 days (Workplace Surveillance Act allows it), added to the AI Features Consent wording. Anyone who doesn't sign stays on WhatsApp until the 14 days are up. (`policies and Contracts/Thomson Energy AI Features Consent.txt`)
- Emailed price lists built and live: read from sales@ and invoice@, keep material cost prices accurate. Owner chose option A: known parts under 20% change update automatically, bigger changes and first-time matches wait. Missing items flagged only if unused for 6 months and a likely replacement is on the list; deleting stays manual. Migration 20261019020000. (`docs/PROJECT_SPEC.md` A11b)
- Fixed: sales@ sync had failed every run since at least 00:00 UTC 18 Oct (a message deleted from Gmail stopped each run), so no new mail and no invoice@ bills came in. The sync now skips messages Gmail no longer has. Found through the new ops manager log. (`netlify/functions/_shared/gmail-sync.js`)
- Ops manager version 1 built: workers report to it, Needs me list, 5am Sydney digest to Jasper only, Ops manager page, assistant acts as manager in chat. Agents run as Netlify functions, not Supabase Edge Functions. LIVE: migration 20261019010000 applied to production (staging skipped, owner gave database permission for the session). (`docs/PROJECT_SPEC.md` A30, `docs/AI_AGENTS_PLAN.md`)
- invoice@ supplier bill agent LIVE on production (suggest only): reads emailed bills, matches supplier and PO, Emailed bills page to check and save. Migration 20261019000000 applied straight to production at the owner's request (staging skipped). Turn on auto-save after 2 weeks if matches are right. (`docs/PROJECT_SPEC.md` A11a, `docs/IDEAS_BACKLOG.md` item 8)
- invoice@ goes to sales@ with a Gmail filter (skip inbox, label Supplier Bills); TEops agent reads it from there. Not accounts@. (`docs/IDEAS_BACKLOG.md` item 8)
- invoice@ is supplier bills only, currently delivers to jasper@, accounts@, jade@; agent to read accounts@ (or sales@ with a skip-inbox filter) so sales@ stays clean. (`docs/IDEAS_BACKLOG.md` item 8)
- invoice@ supplier bill intake agent planned (alias, agent reads bills, attaches to POs), waiting on owner answers before build. (`docs/IDEAS_BACKLOG.md` item 8)
- Surveillance notice, AI consent and location consent drafted for adviser review; location stays in the notice now, location consent form waits for the iPhone app. (`policies and Contracts/`, `docs/IDEAS_BACKLOG.md` item 6)
- Re-sign screen built: policy versions, I agree / I don't agree consent, Remind me later once per login or day, My Profile switches. Live on production (migration 20261018120000, renumbered because 20261018000000 is push_ios_devices from the TEgo app). (`docs/PROJECT_SPEC.md` A26)
- TEgo iPhone app stage 1 built: Capacitor wrap of the live site, native Apple push, black icon, GitHub Actions builds; migration 20261018000000 on production. Waiting on Apple approval for signing and install. Name TEgo can change; bundle ID au.com.thomsonenergy.app cannot. (`docs/IOS_APP.md`, `docs/IDEAS_BACKLOG.md` item 3)
- Twilio Business Profile and AU Mobile bundle approved; test number 0468 085 277 active. (`docs/EXTERNAL_ACCOUNTS.md`)
- Rule added: every chat writes its notes back to the repo and gets them onto `main` the same session. (`CLAUDE.md`)
- This log started. (`docs/DECISIONS.md`)

## 17 Oct 2026
- D-U-N-S 775058635 issued; Apple Developer Program enrolment submitted (Enrollment ID 58NBR3V7K9); Apple Business account created. (`docs/EXTERNAL_ACCOUNTS.md`)
- Stay on Google Workspace for email; cancel the Gemini add-on if not needed, drop 2 unused seats at renewal. (`docs/EXTERNAL_ACCOUNTS.md`)
- SMS and calls: no interim phase (no forward-to-mobile or click-to-call bridge). Built in one go after the native iPhone app, with TEops as the phone (Twilio Voice SDK, CallKit on iPhone, browser on desktop). (`docs/IDEAS_BACKLOG.md` item 7, `docs/PROJECT_SPEC.md` G3)
- Incoming call screen: shows it is a work call, the client and their main J number while ringing; full client card with jobs, open Q and unpaid SI once answered; unknown caller can become a lead. (`docs/IDEAS_BACKLOG.md` item 7)
- Ringtones: branded default plus 4 to 6 alternatives, picked per user, bundled in the native app (under 30 seconds each). (`docs/IDEAS_BACKLOG.md` item 7)
