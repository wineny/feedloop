-- Durable owner-email dispatch intent; Postmark has no idempotency key.
create table public.handoff_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  status text not null default 'delivery_unknown' check (status in ('delivery_unknown','sent','failed')),
  provider_message_id text,
  error text
);
create index on public.handoff_email_deliveries(bot_id, claimed_at);
alter table public.handoff_email_deliveries enable row level security;
grant all on public.handoff_email_deliveries to service_role;

create function public.claim_handoff_email(p_bot_id uuid,p_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare claim_id uuid;
begin
  -- Serialize the hourly cap across all conversations belonging to this bot.
  perform 1 from public.bots where id=p_bot_id for update;
  if not found then return jsonb_build_object('reason','lookup_failed'); end if;
  perform 1 from public.conversations where id=p_conversation_id and bot_id=p_bot_id for update;
  if not found then return jsonb_build_object('reason','lookup_failed'); end if;
  if exists(select 1 from public.handoff_email_deliveries where conversation_id=p_conversation_id and status='delivery_unknown') then
    return jsonb_build_object('reason','delivery_unknown');
  end if;
  if exists(select 1 from public.conversations where id=p_conversation_id and owner_notified_at > now()-interval '1 hour') then
    return jsonb_build_object('reason','rate_limited');
  end if;
  if (select count(*) from public.handoff_email_deliveries where bot_id=p_bot_id and claimed_at > now()-interval '1 hour')
    + (select count(*) from public.conversations c where c.bot_id=p_bot_id and c.owner_notified_at > now()-interval '1 hour'
       and not exists(select 1 from public.handoff_email_deliveries d where d.conversation_id=c.id and d.claimed_at > now()-interval '1 hour')) >= 10 then
    return jsonb_build_object('reason','bot_rate_limited');
  end if;
  insert into public.handoff_email_deliveries(bot_id,conversation_id) values(p_bot_id,p_conversation_id) returning id into claim_id;
  update public.conversations set owner_notified_at=now() where id=p_conversation_id;
  return jsonb_build_object('id',claim_id);
end $$;
revoke all on function public.claim_handoff_email(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_handoff_email(uuid,uuid) to service_role;

alter table public.conversations add column owner_email_status text;
alter table public.conversations add column owner_email_error text;
create function public.record_handoff_email_status() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.handoff_email_deliveries where conversation_id=new.conversation_id and claimed_at>new.claimed_at) then
    update public.conversations set owner_email_status=new.status,owner_email_error=new.error where id=new.conversation_id;
  end if;
  return new;
end $$;
revoke all on function public.record_handoff_email_status() from public,anon,authenticated;
create trigger handoff_email_status after insert or update on public.handoff_email_deliveries for each row execute function public.record_handoff_email_status();
