-- What was marked up on a plan PDF (symbol counts, circuit item counts, cable
-- runs and lengths), per page, saved when a marked-up copy is made in the
-- in-app PDF viewer. Lets the job/quote export a schedule PDF without needing
-- the drawings themselves. Shape:
--   { "allowance": 10, "pages": { "0": { "symbols": {id: n}, "circuits": {label: n},
--                                         "cables": {name: {"runs": n, "metres": m}} } } }
alter table project_documents add column if not exists plan_summary jsonb;
