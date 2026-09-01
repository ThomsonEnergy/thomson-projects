-- Migration 012 — Per-job contact assignment
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- A client (e.g. "Acme Builders") can have several people in each contact
-- role — multiple project managers, multiple site supervisors, across
-- several jobs running at once. This lets each individual job pick which
-- specific person from the client's contact list is running THIS job, so
-- correspondence (variations, etc.) can go to the right person rather than
-- whoever happens to be the first contact on file.
--
-- These columns aren't constrained to only allow contacts belonging to the
-- project's own client_id — the UI only ever offers that client's contacts
-- in the picker, so in practice they always line up, but nothing at the
-- database level enforces it. Worth knowing if you're ever writing data in
-- directly rather than through the app.

alter table projects
  add column if not exists project_manager_contact_id uuid references client_contacts(id) on delete set null;

alter table projects
  add column if not exists site_contact_id uuid references client_contacts(id) on delete set null;

alter table projects
  add column if not exists job_contact_id uuid references client_contacts(id) on delete set null;

alter table projects
  add column if not exists sales_contact_id uuid references client_contacts(id) on delete set null;

alter table projects
  add column if not exists accounts_contact_id uuid references client_contacts(id) on delete set null;
