-- Fingerprint of the scope of works + stages an installer summary was written
-- from, so the summary is only regenerated when those actually change.
alter table projects add column if not exists installer_summary_hash text;
