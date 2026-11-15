-- Plans and documents sent with a request for quote (a builder's plan and "please quote"), kept on
-- the request so every supplier's email and Send again carry them: [{ bucket, path, name, size }].
-- The lines are optional when files go with the request. Additive only; the existing pricing-role
-- policies on supplier_quote_requests cover the new column.
alter table public.supplier_quote_requests add column if not exists attachments jsonb not null default '[]'::jsonb;
