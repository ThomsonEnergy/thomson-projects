-- Referral link and lead rewards, step 3a: no money yet (backlog item 74b; owner's "3 steps ok",
-- 18 Nov 2026). The link, the leads it makes, the referrer on the quote, and the reward settings.
-- Nothing here is paid, credited or put on a quote: step 3b does that.
--
--  * clients.lead_reward_kind: off (default), pay (bank transfer) or credit (off their next
--    invoice), set on the Clients page. clients.referral_token: the private link refer.html?r=...
--    (made for every client; Regenerate on the Clients page makes a new one).
--  * leads.referrer_client_id, referral_kind (quick or full), already_client (the person is the
--    referrer, or already has an open quote or job with us at that address: no reward).
--  * projects.referrer_client_id: set at Create quote from a referred lead.
--  * company_settings: the reward tiers and amounts, edited under Settings > Rewards.
-- Additions only.

alter table public.clients
  add column if not exists lead_reward_kind text not null default 'off' check (lead_reward_kind in ('off', 'pay', 'credit')),
  add column if not exists referral_token text;
update public.clients set referral_token = encode(extensions.gen_random_bytes(16), 'hex') where referral_token is null;
alter table public.clients alter column referral_token set default encode(extensions.gen_random_bytes(16), 'hex');
create unique index if not exists clients_referral_token on public.clients (referral_token);

alter table public.leads
  add column if not exists referrer_client_id uuid references public.clients(id) on delete set null,
  add column if not exists referral_kind text check (referral_kind in ('quick', 'full')),
  add column if not exists already_client boolean not null default false;
create index if not exists leads_referrer_client on public.leads (referrer_client_id);

alter table public.projects add column if not exists referrer_client_id uuid references public.clients(id) on delete set null;
create index if not exists projects_referrer_client on public.projects (referrer_client_id);

alter table public.company_settings
  add column if not exists lead_reward_tiers jsonb not null default '[{"from": 1000, "amount": 80}, {"from": 5000, "amount": 200}, {"from": 15000, "amount": 500}]'::jsonb,
  add column if not exists lead_reward_quick_amount numeric(10,2) not null default 50,
  add column if not exists lead_reward_min_job numeric(10,2) not null default 1000;
