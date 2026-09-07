# Bugs & System Updates

Auto-generated from the in-app Bugs & Updates page (/bugs.html) - do not
edit this file by hand, it gets fully regenerated on every submission,
approval, status change, or comment. Only APPROVED reports appear here -
read this when asked to check for bugs or update ideas, and only act on
what's listed. If something here is ambiguous, leave a comment on the
report (via add-agent-comment.js) asking for clarification instead of
guessing, and skip it until it's answered.

## Open

### Update idea: Quick job
- **Reported:** 5 Sept 2026, 12:02 am by Jasper Thomson
- **Approved:** 7 Sept 2026, 10:58 am by Jasper Thomson
- **Page/feature:** Job pipeline board
- **What they want:** I want the quick job to be built differently from a quote and project. Click it and add customer details but it will be just do and charge so no quoting section no variation nothing. Just log time and pos and based off time and materials it creates bill amount. But make the time and materials editable too so we can add more or take some off. Remove the ability to make an invoice standalone and this will take its place so we can actually add costs to it and make it an invoice.
- **Record id:** 99527a44-210e-41a4-9dd5-f9ddeac18120

## In Progress

None.

## Resolved

### Update idea: adding photos to jobs
- **Reported:** 31 Aug 2026, 01:03 am by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** job documents page.
- **What they want:** Make it more user friendly to upload photos and videos. also show a preview of the photos eg. grid style. so we can scroll through to see which ophoto we want. rather than just a image name
- **Record id:** 7b6245d9-2de2-4764-8f6c-053a85236845
- **Comments:**
  - *Claude, 7 Sept 2026, 03:18 am:* Done - the job documents section now shows a proper thumbnail grid (image/video previews) instead of a bare filename list, with folders/pills to filter and click-through to view full size.

### Update idea: POs
- **Reported:** 31 Aug 2026, 12:14 am by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** Purchase orders
- **What they want:** When approving POs, allow a backorder function for each line item so if an item is backordered, we can tick that its backordered and select an ETA.
- **Record id:** a60a93eb-9735-42c6-bd7e-02d6690b84b3
- **Comments:**
  - *Claude, 7 Sept 2026, 03:18 am:* Done - PO line items now support marking an item backordered with an ETA date.

### Bug: Timesheets this week
- **Reported:** 30 Aug 2026, 09:13 pm by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** Timesheets
- **What's happening:** Timesheets count into the next day
- **Expected instead:** Don’t allow timesheets to count past midnight. It should carry over to the following day. Also the in and out time should show there prominently. And when clicked on it should open the split so they can edit the clock in and clock out time and control the split between each cost center all in The one place. This should be the only place to do it I think we remove the recent timesheets tab at the bottom
- **Record id:** 7bc8e931-3fc7-4dcd-a7d2-21b04669000c
- **Comments:**
  - *Claude, 7 Sept 2026, 03:18 am:* Done - timesheets now split at Sydney midnight instead of counting into the next day, the in/out time shows prominently per day, and clicking a day opens one panel to edit the clock in/out time and the split across stages/jobs together. The old separate "recent timesheets" tab has been removed.

### Update idea: Invoice changes
- **Reported:** 30 Aug 2026, 07:06 am by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** Invoice page
- **What they want:** Should be able to select the labour charge out rate and material cost same as a normal cost center for the stand alone invoice. 
Also I don’t want people to be able to type in an invoice number. Should always be automated.
- **Record id:** 785fdec5-a4ee-4e94-846d-1b99e1a3f32c
- **Comments:**
  - *Claude, 7 Sept 2026, 03:33 am:* Invoice numbers were already fully automated. For the rate-selection part: standalone invoices have been removed entirely per Jasper's direction - instead, "+ New job (no quote)" (Job pipeline board and My Day) creates a real job with one cost centre, skipping the quote/estimate step. Time and materials get logged against it normally (timesheets, POs, or manually), and it's invoiced off whatever actually accrued (labour at each person's charge-out rate, materials at cost plus markup) via the new "Invoice actual costs" button on the job page, rather than a standalone line-item form.

### Update idea: Task for office/general
- **Reported:** 30 Aug 2026, 07:04 am by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** Task page
- **What they want:** Should be able to create a task on the task page and assign it to a job or office if it’s not job related eg. Take bins out or mow the lawn
- **Record id:** 2acefc3e-f8fc-4670-a785-c386a8b4977d
- **Comments:**
  - *Claude, 7 Sept 2026, 03:18 am:* Done - the Add task panel already lets the job field be left blank for an office/general task.

### Update idea: add timsheets from the your timesheets this week.
- **Reported:** 27 Aug 2026, 08:31 pm by Jasper Thomson
- **Approved:** 1 Sept 2026, 08:20 am by Jasper Thomson
- **Page/feature:** timesheets tab
- **What they want:** add and edit timesheets from your timesheets this week. once they are approved and sent to xero, time shouldnt be edited but job stage or job nujmkber shoukld be editable encase they clock into wrong job
- **Record id:** 967c4671-d4f1-43ca-aed9-504572d3c416
- **Comments:**
  - *Claude, 7 Sept 2026, 03:19 am:* Done - timesheets can be added/edited from "your timesheet this week", and once an entry has been pushed to Xero its clock in/out time is locked, but the job and stage stay editable.
