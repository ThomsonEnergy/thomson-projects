-- Migration 113 - Job pipeline automation, phase 2
--
-- Second slice: job_booked through to complete. completed_at records
-- exactly when a job hit 'complete' (every invoice paid, after the
-- final claim was sent) - phase 3's 2-day auto-archive job needs to
-- know how long it's been sitting there, which nothing before this
-- phase ever had a reason to track.

alter table projects add column if not exists completed_at timestamptz;
