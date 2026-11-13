-- A client now signs a quote when they approve it online: their typed name and a
-- drawn signature are kept on the quote (the frozen, approved record) and shown on the
-- accepted proposal. Same idea as the signature on a fixed-price variation (migration 143).

alter table projects add column if not exists accepted_signed_by_name text;
alter table projects add column if not exists accepted_signature_data_url text;
