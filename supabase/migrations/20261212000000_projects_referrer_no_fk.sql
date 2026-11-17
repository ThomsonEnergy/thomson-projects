-- Bug fix, 18 Nov 2026 (owner: opening an invoice showed "Could not embed because more than one
-- relationship was found for 'projects' and 'clients'"). Migration 20261210000000 gave
-- projects.referrer_client_id a foreign key to clients; projects already had one (client_id), so every
-- query that embeds clients from projects (or projects from clients) without naming the key broke.
-- The column stays, without the foreign key (the same choice as schedule_assignments.created_by).
-- npm run check now fails a new foreign key to a table the same table already points at.
alter table public.projects drop constraint if exists projects_referrer_client_id_fkey;
