-- Lembrete por notificação (Web Push) uma semana depois do abastecimento: "como o carro andou?".
-- A pessoa liga no Perfil; o aparelho guarda a inscrição aqui (só a própria pessoa vê e apaga).
create table public.push_subscriptions (
  endpoint text primary key check (char_length(endpoint) between 20 and 1000 and endpoint like 'https://%'),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
create policy "dono lê" on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "dono inscreve" on public.push_subscriptions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono atualiza" on public.push_subscriptions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono cancela" on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
create policy "apps: sem notificações" on public.push_subscriptions as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Chaves VAPID do servidor de notificações: geradas pela própria função `lembretes`, só a chave de serviço lê.
create table public.push_keys (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_keys enable row level security;
revoke all on public.push_keys from anon, authenticated;

-- Um lembrete por abastecimento, no máximo.
create table public.push_reminders (
  fuel_log_id uuid primary key references public.fuel_logs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  sent_at timestamptz not null default now()
);
alter table public.push_reminders enable row level security;
revoke all on public.push_reminders from anon, authenticated;

-- Quem deve receber o lembrete hoje: abastecimento com posto de 7 a 10 dias atrás, de quem contribui,
-- sem resposta do "depois", sem lembrete enviado e sem abastecimento mais novo no mesmo carro
-- (nesse caso a pergunta já apareceu ao registrar). Um por pessoa: o mais recente.
create or replace function public.lembretes_devidos()
returns table (user_id uuid, fuel_log_id uuid, station_id text, date date)
language sql
security definer
set search_path = ''
as $$
  select distinct on (l.user_id) l.user_id, l.id, l.station_id, l.date
  from public.fuel_logs l
  join public.user_settings s on s.user_id = l.user_id and s.contribute
  where l.station_id is not null and l.deleted_at is null
    and l.date between current_date - 10 and current_date - 7
    and exists (select 1 from public.push_subscriptions p where p.user_id = l.user_id)
    and not exists (select 1 from public.ratings r where r.fuel_log_id = l.id and r.after_effect is not null)
    and not exists (select 1 from public.push_reminders m where m.fuel_log_id = l.id)
    and not exists (select 1 from public.fuel_logs n where n.vehicle_id = l.vehicle_id and n.deleted_at is null
                    and (n.date > l.date or (n.date = l.date and n.odometer_km > l.odometer_km)))
  order by l.user_id, l.date desc;
$$;
revoke all on function public.lembretes_devidos() from public, anon, authenticated;

create extension if not exists pg_net with schema extensions;
grant execute on function public.lembretes_devidos() to service_role;
