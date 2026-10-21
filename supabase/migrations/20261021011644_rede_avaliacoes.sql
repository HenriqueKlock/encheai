-- Rede de postos: avaliações em um toque e os números agregados por posto.
-- O que sai daqui é só média por posto, calculada de quem aceitou contribuir (user_settings.contribute),
-- com volume mínimo para publicar. Nunca quem, nunca o horário, nunca casa ou trabalho.

-- 1) Avaliação: uma por abastecimento, só de abastecimento próprio ligado a um posto e feito há até 7 dias.
create table public.ratings (
  fuel_log_id uuid primary key references public.fuel_logs(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  station_id text not null check (station_id ~ '^\d{14}$'),
  bomba smallint check (bomba in (-1, 1)),
  atendimento smallint check (atendimento in (-1, 1)),
  banheiro smallint check (banheiro in (-1, 1)),
  created_at timestamptz not null default now(),
  check (coalesce(bomba, atendimento, banheiro) is not null)
);
create index ratings_station_idx on public.ratings (station_id, created_at);
create index ratings_user_idx on public.ratings (user_id);

create or replace function public.ratings_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  f record;
begin
  new.user_id := auth.uid();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.fuel_log_id := old.fuel_log_id;
  end if;
  select l.user_id, l.station_id, l.date, l.deleted_at into f from public.fuel_logs l where l.id = new.fuel_log_id;
  if f.user_id is null or f.user_id <> new.user_id or f.deleted_at is not null then
    raise exception 'abastecimento não encontrado' using errcode = '23503';
  end if;
  if f.station_id is null or f.station_id <> new.station_id then
    raise exception 'o abastecimento não está ligado a este posto' using errcode = '23514';
  end if;
  if f.date < current_date - 7 then
    raise exception 'só dá para avaliar até 7 dias depois de abastecer' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.ratings_guard() from public, anon, authenticated;
create trigger ratings_guard before insert or update on public.ratings for each row execute function public.ratings_guard();

alter table public.ratings enable row level security;
create policy "dono lê" on public.ratings for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.ratings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.ratings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono apaga" on public.ratings for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.ratings from anon, authenticated;
grant select, insert, update, delete on public.ratings to authenticated;

-- 2) Números da rede por posto (só agregados), recalculados a cada 15 minutos; leitura para quem está logado.
create table public.station_live (
  station_id text primary key check (station_id ~ '^\d{14}$'),
  price jsonb not null default '{}'::jsonb,   -- {"gasolina": {"v": 6.59, "d": "2026-10-18", "n": 3}, "etanol": {...}}
  yield jsonb,                                -- {"r": 1.01, "people": 9, "tanks": 23, "pub": true}
  ratings jsonb,                              -- {"n": 41, "bomba": [38, 41], "atendimento": [...], "banheiro": [...]} = [bons, total]
  updated_at timestamptz not null default now()
);
alter table public.station_live enable row level security;
create policy "logado lê" on public.station_live for select to authenticated using (true);
revoke all on public.station_live from anon, authenticated;
grant select on public.station_live to authenticated;
