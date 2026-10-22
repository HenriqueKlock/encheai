-- Nome do posto na fachada, dado pelas pessoas (o cadastro da ANP traz a razão social ou um nome antigo, e o
-- nome do Google não pode ser guardado nem mostrado fora da ficha). Cada pessoa tem uma sugestão por posto.
-- Vale para todos quando duas pessoas escrevem o mesmo nome (sem diferença de maiúsculas e espaços) nos
-- últimos 180 dias, ou na hora quando quem sugere está em app_admins. Até lá, vale só para quem sugeriu.

create table public.station_names (
  station_id text primary key check (station_id ~ '^\d{14}$'),
  name text not null check (char_length(name) between 2 and 60),
  updated_at timestamptz not null default now()
);
alter table public.station_names enable row level security;
create policy station_names_leitura on public.station_names for select to anon, authenticated using (true);
grant select on public.station_names to anon, authenticated;

create table public.station_name_votes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  station_id text not null check (station_id ~ '^\d{14}$'),
  name text not null check (char_length(name) between 2 and 60 and name !~ '[<>{}\\]'),
  created_at timestamptz not null default now(),
  primary key (user_id, station_id)
);
alter table public.station_name_votes enable row level security;
create policy "dono lê" on public.station_name_votes for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.station_name_votes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.station_name_votes for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono apaga" on public.station_name_votes for delete to authenticated using (user_id = (select auth.uid()));
create policy "apps: sem nome de posto" on public.station_name_votes as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
grant select, insert, update, delete on public.station_name_votes to authenticated;
revoke all on public.station_name_votes from anon;

create or replace function public.station_name_vote_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  agree int;
  admin boolean;
  today int;
  k text := lower(regexp_replace(btrim(new.name), '\s+', ' ', 'g'));
begin
  select count(*) into today from public.station_name_votes
    where user_id = new.user_id and created_at > now() - interval '1 day';
  if today > 30 then
    raise exception 'Muitas correções hoje. Tente amanhã.' using errcode = 'P0001';
  end if;
  select exists (select 1 from public.app_admins a where a.user_id = new.user_id) into admin;
  select count(distinct v.user_id) into agree from public.station_name_votes v
    where v.station_id = new.station_id and lower(regexp_replace(btrim(v.name), '\s+', ' ', 'g')) = k
      and v.created_at > now() - interval '180 days';
  if not admin and agree < 2 then
    return new;
  end if;
  insert into public.station_names (station_id, name, updated_at)
    values (new.station_id, regexp_replace(btrim(new.name), '\s+', ' ', 'g'), now())
    on conflict (station_id) do update set name = excluded.name, updated_at = now();
  return new;
end $$;
revoke all on function public.station_name_vote_apply() from public, anon, authenticated;

create trigger station_name_vote_apply after insert or update on public.station_name_votes
  for each row execute function public.station_name_vote_apply();
