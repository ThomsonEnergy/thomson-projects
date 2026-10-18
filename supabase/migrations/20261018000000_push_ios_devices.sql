-- TEgo iPhone app: lets push_subscriptions hold iPhone devices as well as
-- browsers. An iPhone row keeps its Apple push token in `endpoint` and has no
-- web push keys. netlify/functions/_shared/push.js sends 'ios' rows through
-- Apple push (apns.js) and 'web' rows through web push as before.

alter table public.push_subscriptions add column if not exists platform text not null default 'web';
alter table public.push_subscriptions alter column p256dh drop not null;
alter table public.push_subscriptions alter column auth drop not null;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_platform_check;
alter table public.push_subscriptions add constraint push_subscriptions_platform_check
  check (platform in ('web', 'ios') and (platform = 'ios' or (p256dh is not null and auth is not null)));

-- Called by public/js/native.js when the app gets its Apple push token. The
-- phone may have been signed in as someone else before (a shared or handed
-- down iPhone), and RLS would stop this person updating that row, so this
-- moves the device to whoever is signed in now.
create or replace function public.register_ios_push_device(p_token text, p_user_agent text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{64,200}$' then raise exception 'Invalid device token'; end if;
  insert into push_subscriptions (user_id, endpoint, platform, p256dh, auth, user_agent)
  values (auth.uid(), lower(p_token), 'ios', null, null, left(p_user_agent, 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, platform = 'ios', p256dh = null, auth = null, user_agent = excluded.user_agent;
end $function$;

revoke execute on function public.register_ios_push_device(text, text) from public, anon;
grant execute on function public.register_ios_push_device(text, text) to authenticated;
