-- Migration 089 — Deleting a client actually unlinks their jobs/invoices, as promised
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- clients.html's delete confirmation says "Existing quotes stay as they
-- are, just unlinked" - but projects.client_id and invoices.client_id
-- were both ON DELETE NO ACTION, so deleting any client that actually
-- had a job or invoice failed outright with a raw foreign-key-violation
-- error, silently working only for a client nobody had ever quoted or
-- invoiced. Both project/invoice rows already carry their own copy of
-- the client's name/email/phone/address at the time they were created
-- (client_name, client_email, ...), so losing the client_id link doesn't
-- lose any of that - only the ability to look the row up FROM the (now
-- deleted) client record.

alter table projects drop constraint projects_client_id_fkey;
alter table projects add constraint projects_client_id_fkey
  foreign key (client_id) references clients(id) on delete set null;

alter table invoices drop constraint invoices_client_id_fkey;
alter table invoices add constraint invoices_client_id_fkey
  foreign key (client_id) references clients(id) on delete set null;
