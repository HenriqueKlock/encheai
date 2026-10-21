-- Enche Aí (antes Caderneta do Carro 2.0): base pessoal (carros, abastecimentos, manutenção, preferências, locais).
-- Regras: cada linha pertence a um usuário (user_id = auth.uid()); o id é gerado no celular;
-- vence a alteração mais recente (updated_at do cliente); server_updated_at é o relógio do servidor usado no pull.
-- Tudo aponta para auth.users com ON DELETE CASCADE: excluir a conta apaga tudo.

create table public.vehicles (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  make text check (char_length(make) <= 40),
  model text check (char_length(model) <= 60),
  year int check (year between 1900 and 2100),
  engine text check (char_length(engine) <= 40),
  fuel_type text not null default 'flex' check (fuel_type in ('flex','gasolina','etanol','diesel')),
  initial_km int check (initial_km >= 0),
  plan_key text check (char_length(plan_key) <= 40),
  archived boolean not null default false,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.fuel_logs (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date not null,
  odometer_km int not null check (odometer_km >= 0),
  liters numeric(8,3) not null check (liters > 0 and liters < 500),
  total_brl numeric(10,2) not null check (total_brl >= 0),
  price_per_l numeric(8,3) not null check (price_per_l >= 0),
  fuel text not null check (fuel in ('gasolina','etanol','diesel','gnv')),
  full_tank boolean not null default true,
  range_left_km int,
  station text check (char_length(station) <= 120),
  station_id text check (station_id ~ '^\d{14}$'),
  note text check (char_length(note) <= 500),
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date not null,
  odometer_km int check (odometer_km >= 0),
  shop text check (char_length(shop) <= 120),
  os_number text check (char_length(os_number) <= 40),
  type text not null default 'revisao' check (type in ('revisao','corretiva','pneus','outros')),
  note text check (char_length(note) <= 1000),
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table public.service_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  description text not null check (char_length(description) <= 200),
  plan_item_key text check (char_length(plan_item_key) <= 60),
  position int not null default 0 check (position >= 0),
  parts_brl numeric(10,2) not null default 0 check (parts_brl >= 0),
  labor_brl numeric(10,2) not null default 0 check (labor_brl >= 0),
  next_due_km int,
  next_due_date date,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

-- Preferências e consentimento. contribute = aceitou entrar na rede (só agregados por posto).
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  home_indicators jsonb not null default '["gasto_mes","km_mes"]'::jsonb check (pg_column_size(home_indicators) < 2000),
  contribute boolean not null default false,
  consent_at timestamptz,
  terms_version text check (char_length(terms_version) <= 20),
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now()
);

-- Casa, trabalho e o caminho entre eles. Guardamos rua/bairro e o ponto no mapa; nunca o número.
create table public.user_places (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('casa', 'trabalho', 'rota')),
  label text check (char_length(label) <= 120),
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 60000),
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create index vehicles_user_sync_idx on public.vehicles (user_id, server_updated_at);
create index fuel_logs_user_sync_idx on public.fuel_logs (user_id, server_updated_at);
create index fuel_logs_vehicle_idx on public.fuel_logs (vehicle_id, odometer_km);
create index fuel_logs_station_idx on public.fuel_logs (station_id, date) where station_id is not null and deleted_at is null;
create index services_user_sync_idx on public.services (user_id, server_updated_at);
create index services_vehicle_idx on public.services (vehicle_id);
create index service_items_user_sync_idx on public.service_items (user_id, server_updated_at);
create index service_items_service_idx on public.service_items (service_id);

-- Sincronização: no INSERT o dono é sempre quem está logado; no UPDATE o dono não muda
-- e uma escrita com updated_at mais antigo que o gravado é ignorada (vence a mais recente).
create or replace function public.sync_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
  else
    new.user_id := old.user_id;
    if new.updated_at <= old.updated_at then
      return null;
    end if;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger vehicles_sync_guard before insert or update on public.vehicles for each row execute function public.sync_guard();
create trigger fuel_logs_sync_guard before insert or update on public.fuel_logs for each row execute function public.sync_guard();
create trigger services_sync_guard before insert or update on public.services for each row execute function public.sync_guard();
create trigger service_items_sync_guard before insert or update on public.service_items for each row execute function public.sync_guard();
create trigger user_settings_sync_guard before insert or update on public.user_settings for each row execute function public.sync_guard();
create trigger user_places_sync_guard before insert or update on public.user_places for each row execute function public.sync_guard();

-- Filhos só podem apontar para pais do mesmo usuário (a FK sozinha não olha a RLS)
create or replace function public.check_parent_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  owner uuid;
begin
  if tg_table_name in ('fuel_logs','services') then
    select v.user_id into owner from public.vehicles v where v.id = new.vehicle_id;
  else
    select s.user_id into owner from public.services s where s.id = new.service_id;
  end if;
  if owner is null or owner <> new.user_id then
    raise exception 'registro pai não encontrado para este usuário' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger fuel_logs_parent_owner after insert or update on public.fuel_logs for each row execute function public.check_parent_owner();
create trigger services_parent_owner after insert or update on public.services for each row execute function public.check_parent_owner();
create trigger service_items_parent_owner after insert or update on public.service_items for each row execute function public.check_parent_owner();

-- RLS: cada usuário só enxerga e altera as próprias linhas. Sem DELETE físico pelo app (exclusão é deleted_at).
alter table public.vehicles enable row level security;
alter table public.fuel_logs enable row level security;
alter table public.services enable row level security;
alter table public.service_items enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_places enable row level security;

create policy "dono lê" on public.vehicles for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.vehicles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.vehicles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono lê" on public.fuel_logs for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.fuel_logs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.fuel_logs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono lê" on public.services for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.services for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.services for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono lê" on public.service_items for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.service_items for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.service_items for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono lê" on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dono lê" on public.user_places for select to authenticated using (user_id = (select auth.uid()));
create policy "dono insere" on public.user_places for insert to authenticated with check (user_id = (select auth.uid()));
create policy "dono altera" on public.user_places for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Só as permissões que o app usa: sem DELETE, TRUNCATE, REFERENCES, TRIGGER; anônimo sem nada.
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger, delete on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
grant select, insert, update on public.vehicles, public.fuel_logs, public.services, public.service_items, public.user_settings, public.user_places to authenticated;

-- Cota diária por usuário nas funções que custam dinheiro (Google Places).
create table public.api_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  fn text not null check (fn in ('google_nearby', 'google_posto', 'google_address', 'google_photo')),
  n integer not null default 0,
  primary key (user_id, day, fn)
);
alter table public.api_usage enable row level security;
revoke all on public.api_usage from anon, authenticated;

create or replace function public.consume_quota(p_fn text, p_max integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  used integer;
begin
  if uid is null then
    return false;
  end if;
  insert into public.api_usage as u (user_id, day, fn, n)
  values (uid, current_date, p_fn, 1)
  on conflict (user_id, day, fn) do update set n = u.n + 1
  returning u.n into used;
  return used <= p_max;
end;
$$;
revoke all on function public.consume_quota(text, integer) from public, anon;
grant execute on function public.consume_quota(text, integer) to authenticated;

-- As funções de gatilho não são chamáveis pela API
revoke all on function public.sync_guard() from public, anon, authenticated;
revoke all on function public.check_parent_owner() from public, anon, authenticated;
