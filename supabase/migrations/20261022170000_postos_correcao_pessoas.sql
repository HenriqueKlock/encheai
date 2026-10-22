-- Quem usa o app pode dizer qual é o posto certo no Google (ou que o posto não está no Google).
-- Cada pessoa tem um voto por posto (pode trocar). A correção passa a valer para todos quando duas pessoas
-- concordam (nos últimos 180 dias) ou quando quem corrige é administrador do app (tabela app_admins,
-- preenchida direto no banco, fora do repositório). Até lá, vale só no aparelho de quem corrigiu.
-- Uma ligação feita pelas pessoas (source = 'pessoas') não é revista nem tomada pela busca automática.

alter table public.station_places add column source text not null default 'google' check (source in ('google', 'pessoas'));

create table public.app_admins (user_id uuid primary key references auth.users on delete cascade);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

create table public.station_place_votes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  station_id text not null check (station_id ~ '^\d{14}$'),
  -- null = "o posto não está no Google"
  place_id text check (place_id ~ '^[A-Za-z0-9_-]{10,255}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, station_id)
);
alter table public.station_place_votes enable row level security;
create policy "dono lê" on public.station_place_votes for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.station_place_votes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.station_place_votes for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono apaga" on public.station_place_votes for delete to authenticated using (user_id = (select auth.uid()));
create policy "apps: sem correção de posto" on public.station_place_votes as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
grant select, insert, update, delete on public.station_place_votes to authenticated;
revoke all on public.station_place_votes from anon;

-- Aplica o voto quando ele passa a valer para todos.
create or replace function public.station_place_vote_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  agree int;
  admin boolean;
  today int;
begin
  select count(*) into today from public.station_place_votes
    where user_id = new.user_id and created_at > now() - interval '1 day';
  if today > 30 then
    raise exception 'Muitas correções hoje. Tente amanhã.' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.app_admins a where a.user_id = new.user_id) into admin;
  select count(distinct v.user_id) into agree from public.station_place_votes v
    where v.station_id = new.station_id and v.place_id is not distinct from new.place_id
      and v.created_at > now() - interval '180 days';
  if not admin and agree < 2 then
    return new;
  end if;
  if new.place_id is not null then
    -- um lugar do Google fica com um posto só: quem tinha este lugar volta para a fila da busca
    update public.station_places set place_id = null, score = null, source = 'google', checked_at = '2000-01-01T00:00:00Z'
      where place_id = new.place_id and station_id <> new.station_id;
  end if;
  insert into public.station_places (station_id, place_id, score, checked_at, source)
    values (new.station_id, new.place_id, null, now(), 'pessoas')
    on conflict (station_id) do update set place_id = excluded.place_id, score = null, checked_at = now(), source = 'pessoas';
  return new;
end $$;
revoke all on function public.station_place_vote_apply() from public, anon, authenticated;

create trigger station_place_vote_apply after insert or update on public.station_place_votes
  for each row execute function public.station_place_vote_apply();

-- O app sabe se a correção já vale para todos lendo station_places (leitura pública já existente).
