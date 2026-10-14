-- Migration 149 - Employment contracts actually become "signed"
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- employee_contracts.status had a 'signed' value but nothing ever set it:
-- signing the contract in onboarding only inserted an
-- onboarding_document_signatures row, so every signed contract still showed
-- "ready to sign". A trigger now flips it when the contract is signed, and
-- existing contracts signed since their last edit are corrected.

create or replace function trg_contract_signed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from onboarding_documents where id = new.document_id and is_contract) then
    update employee_contracts set status = 'signed', updated_at = now()
    where profile_id = new.profile_id and status = 'ready_to_sign';
  end if;
  return new;
exception when others then
  return new;   -- never block the signature itself
end $$;

drop trigger if exists contract_signed on onboarding_document_signatures;
create trigger contract_signed after insert on onboarding_document_signatures
  for each row execute function trg_contract_signed();

-- Backfill: ready to sign, and signed at or after the contract was last edited.
update employee_contracts c set status = 'signed'
where c.status = 'ready_to_sign'
  and exists (
    select 1 from onboarding_document_signatures s
    join onboarding_documents d on d.id = s.document_id and d.is_contract
    where s.profile_id = c.profile_id and s.signed_at >= c.updated_at
  );
