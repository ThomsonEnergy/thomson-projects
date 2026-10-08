-- Site photos can now be renamed (project_photos.caption was already there,
-- just never editable) - until now the table only allowed INSERT/SELECT.
-- Marked-up photos are saved as a new row (the original is kept), so no
-- delete policy is needed.
drop policy if exists "Everyone can rename project photos" on project_photos;
create policy "Everyone can rename project photos" on project_photos
  for update using (auth.uid() is not null) with check (auth.uid() is not null);
