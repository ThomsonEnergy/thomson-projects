-- Solar quote compliance: adds two new job_tasks types so a solar job's
-- checklist can distinguish "must be sorted before this quote is sent"
-- (quote) and "must be sorted after install, for STC/handover paperwork"
-- (handover) from the existing prejob/onsite split. Widening an existing
-- check constraint, not renaming anything - all current prejob/onsite
-- rows and every page that filters on them keep working unchanged.
--
-- Also adds the handover paperwork fields (NMI, serial numbers) a solar
-- job needs for STC creation, and a manually-set Formbay STC lodgement
-- status field. Formbay itself is purely STC compliance/lodgement (confirmed
-- with Jasper - nothing to do with ordering, that's the existing Purchase
-- Orders feature) - staff take photos and submit compliance evidence
-- inside Formbay's own app, this app just needs somewhere to show which
-- stage a lodgement is at. The live push-to-Formbay and status-pull-back
-- isn't built here: test-formbay-connection.js (added separately) hasn't
-- confirmed a working auth method against Formbay's API yet, so this
-- column starts out staff-editable by hand and gets wired up to the real
-- API once that connection is confirmed.

alter table job_tasks drop constraint if exists job_tasks_task_type_check;
alter table job_tasks add constraint job_tasks_task_type_check
  check (task_type in ('quote', 'prejob', 'onsite', 'handover'));

-- No new accreditation columns on profiles - staff already record licences
-- (name, number, expiry) in profile_licences via the existing "Industry
-- licences" panel in Settings. The handover checklist looks there for a
-- licence whose name mentions SAA/accreditation and one that mentions
-- electrical, rather than duplicating that as separate dedicated fields.

-- Handover/STC paperwork fields. Text, not a repeating rows table - v1
-- assumes one NMI and a free-text list of serials per job (fine for the
-- typical single-system residential/small-commercial job this app quotes;
-- a job with genuinely separate multi-system serial tracking can still
-- just list them all in these fields, one per line).
alter table projects add column if not exists nmi text;
alter table projects add column if not exists panel_serial_numbers text;
alter table projects add column if not exists inverter_serial_numbers text;

alter table projects add column if not exists formbay_lodgement_status text
  check (formbay_lodgement_status in ('pending_installer_action', 'pending_retailer_action', 'pending_cer_audit', 'approved_for_sale', 'sold'));
alter table projects add column if not exists formbay_lodgement_id text;
