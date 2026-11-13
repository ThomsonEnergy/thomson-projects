-- Migration 107 — Fix missing SELECT grant on profiles.home_shortcuts
--
-- Same class of bug migrations 079/086 fixed for other profiles columns:
-- this project uses explicit column-level GRANTs on profiles, not a
-- blanket table-level one, and adding a new column (migration_106) does
-- NOT automatically inherit them. home_shortcuts got INSERT/UPDATE but
-- not SELECT - so saving from the Home page edit view actually worked,
-- but reading it back always came back null and silently fell back to
-- the default list, making it look like nothing had saved at all.

grant select (home_shortcuts) on profiles to authenticated;
