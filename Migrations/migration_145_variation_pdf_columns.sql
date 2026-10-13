-- When a client signs a fixed-price variation the app makes its PDF (the original quote plus
-- the variation, signed), files the previous quote PDF away as a legacy document, and makes a
-- fresh current quote PDF with every approved variation in it. These columns record that:
--   pdf_path / pdf_generated_at   the signed variation's own PDF
--   documents_finalized_at        set once the documents above have been made, so a repeat
--                                 call can never file the same legacy copy twice

alter table job_variation_entries add column if not exists pdf_path text;
alter table job_variation_entries add column if not exists pdf_generated_at timestamptz;
alter table job_variation_entries add column if not exists documents_finalized_at timestamptz;
