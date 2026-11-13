-- Migration 009 — Editable estimate disclaimer default + Google Maps key
-- Run this in Supabase: SQL Editor > New query > paste > Run.

alter table company_settings
  add column if not exists default_estimate_disclaimer text
  default 'Estimate only — the final invoice is based on actual hours and materials used, not this figure. Accepting this estimate lets us schedule the work.';

-- Google Maps JS API keys are designed to be used in the browser (secured
-- via HTTP referrer restrictions in Google Cloud Console, not secrecy), so
-- storing this alongside other company settings — readable by the same
-- pricing roles who build quotes — is the right spot for it, unlike the
-- truly secret keys in api_keys.
alter table company_settings
  add column if not exists google_maps_api_key text;
