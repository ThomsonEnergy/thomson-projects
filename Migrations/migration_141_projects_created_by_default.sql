-- projects.created_by existed but nothing ever filled it in (0 of 11 projects
-- had one), so a quote couldn't say who prepared it. Default it to whoever is
-- logged in when the project is created, so every new quote carries its author
-- (shown as "Prepared by" on the client quote - see get_quote_by_token,
-- migration 140). Existing projects stay blank rather than guessing an author.

alter table projects alter column created_by set default auth.uid();
