-- Migration 106 — Customizable home page shortcuts
--
-- The Home page's quick-nav tiles used to be a fixed, hardcoded list.
-- Now each user can star/unstar any nav tab (desktop topbar and the
-- mobile dropdown both get the same star toggle) to choose which show up
-- on their own Home page, and reorder/remove them from an Edit view
-- there. null means "hasn't customized yet" - falls back to a sensible
-- default set (DEFAULT_HOME_SHORTCUTS in supabase-client.js) rather than
-- showing nothing for every existing user.

alter table profiles add column home_shortcuts jsonb;
