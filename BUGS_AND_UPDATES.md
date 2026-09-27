# Bugs & System Updates

Auto-generated from the in-app Bugs & Updates page (/bugs.html) - do not
edit this file by hand, it gets fully regenerated on every submission,
approval, status change, or comment. Only APPROVED reports appear here -
read this when asked to check for bugs or update ideas, and only act on
what's listed. If something here is ambiguous, leave a comment on the
report (via add-agent-comment.js) asking for clarification instead of
guessing, and skip it until it's answered.

## Open

### Bug: Calender isnt putting jobs on
- **Reported:** 4 Sept 2026, 05:12 am by Nathan Hicks
- **Approved:** 7 Sept 2026, 10:58 am by Jasper Thomson
- **What's happening:** Jobs cant be dragged onto the schedule
- **Record id:** 70b1f34a-ffcd-4684-98f7-19ada1d6aa69
- **Comments:**
  - *Claude, 14 Sept 2026, 05:33 am:* Pushed a likely fix: native HTML5 drag-and-drop never works on touch input at all (no error, it just silently does nothing), and the schedule page was only switching to its tap-based mobile view below 700px screen width - so a touch device with a wider screen (a tablet in landscape, or a touchscreen laptop) would land on the drag-only desktop layout with no way to actually drag. It now switches to the tap-based view for any touch/coarse-pointer device regardless of width. Also tightened up the drag data format for better cross-browser support on genuine desktop/mouse use. Can you confirm what device/browser this was on, and try again? If it still doesn't work, let us know the device and we'll keep digging.

### Update idea: Credit notes
- **Reported:** 4 Sept 2026, 04:40 am by Nathan Hicks
- **Approved:** 7 Sept 2026, 10:58 am by Jasper Thomson
- **Page/feature:** jobs
- **What they want:** Have an option to create a credit note for an invcoice, and push to xero
- **Record id:** 5e2b56ca-2cbc-477f-8eeb-3daeaec28535
- **Comments:**
  - *Claude, 14 Sept 2026, 09:14 pm:* Built and deployed (commit 1d2c730). Finance/Admin only. On an invoice already pushed to Xero (where the old Edit button no longer appears, since Xero blocks editing an Approved invoice), theres now an "Issue credit note" button - pick which stage(s)/amounts to credit (defaults to a full credit, editable down for partial), add a reason, and mark it as an account credit or a refund if the client already paid. Creates the record locally first, then a separate "Push to Xero" button creates the actual Xero credit note and allocates it against the invoice. This hasnt been tested against a real invoice/Xero push yet - recommend trying it on a real (or low-stakes test) invoice before relying on it for something that matters, given its live accounting data. Leaving this open until confirmed working end-to-end.

### Update idea: job search
- **Reported:** 3 Sept 2026, 08:54 pm by Nathan Hicks
- **Approved:** 7 Sept 2026, 10:58 am by Jasper Thomson
- **Page/feature:** my day
- **What they want:** when im clocked into a job have a search bar for any other jobs so we cna clock into anothe rjob without clocking out.
- **Record id:** 0207bcdc-1208-46e5-ade6-7468d1a5aeb9
- **Comments:**
  - *Claude, 14 Sept 2026, 05:32 am:* Checking before marking this resolved: My Day already has a "Switch job" button + search bar while clocked in (never returns you to the idle "Clock in" screen in between - you go straight from job A to job B). It does still show a "Confirm clock-out" step first (clock-out time, and which stage(s) the time counts against) before starting the new job, since that's needed for accurate payroll/Xero reporting on the job you're leaving. Is that what you had in mind, or were you after something with no confirmation step at all in between? Leaving this open until you confirm.

## In Progress

None.

## Resolved

None.
