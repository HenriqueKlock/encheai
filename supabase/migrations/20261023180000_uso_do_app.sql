-- Uso do app: eventos de navegação para entender por onde as pessoas passam (funil do primeiro acesso, telas,
-- caminhos). Pseudônimo: só um id aleatório do aparelho e um da abertura do app; nada de conta, e-mail,
-- localização, preço ou texto digitado. Ninguém lê pela API: só as funções agregadas do painel, para admins.
-- Guardado por 90 dias. Quem desliga "Medir uso do app" no Perfil não envia nada.
create table public.app_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  dev uuid not null,
  sess uuid not null,
  ev text not null check (ev ~ '^[a-z_]{2,24}$'),
  view text check (view ~ '^[a-z]{2,15}$'),
  plat text check (plat ~ '^[a-z_ ]{2,30}$'),
  ver text check (ver ~ '^[0-9a-z.\-]{1,20}$')
);
create index app_events_at_idx on public.app_events (at);
create index app_events_sess_idx on public.app_events (sess, at);
alter table public.app_events enable row level security;
revoke all on public.app_events from anon, authenticated;

-- Entrada: lote de até 50 eventos; cada abertura do app grava no máximo 400 por dia
create or replace function public.log_events(batch jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  s uuid;
begin
  if jsonb_typeof(batch) <> 'array' or jsonb_array_length(batch) = 0 then return 0; end if;
  if jsonb_array_length(batch) > 50 then raise exception 'lote grande demais' using errcode = '23514'; end if;
  s := (batch -> 0 ->> 'sess')::uuid;
  select count(*) into n from public.app_events e where e.sess = s and e.at > now() - interval '1 day';
  if n > 400 then return 0; end if;
  insert into public.app_events (dev, sess, ev, view, plat, ver)
  select (x ->> 'dev')::uuid, s, x ->> 'ev', nullif(x ->> 'view', ''), nullif(x ->> 'plat', ''), nullif(x ->> 'ver', '')
  from jsonb_array_elements(batch) x
  where x ->> 'ev' in ('open', 'view', 'welcome', 'welcome_skip', 'login_link', 'login_code', 'login_ok',
                       'car_step', 'car_skip', 'car_created', 'fill_open', 'fill_saved', 'price_seen', 'push_on', 'import_open');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.log_events(jsonb) from public;
grant execute on function public.log_events(jsonb) to anon, authenticated;

-- Painel: só admins (tabela app_admins), só números agregados
create or replace function public.sou_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.app_admins a where a.user_id = auth.uid()) and (auth.jwt() ->> 'client_id') is null $$;
revoke all on function public.sou_admin() from public;
grant execute on function public.sou_admin() to authenticated;

create or replace function public.admin_uso(dias integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  desde timestamptz := now() - make_interval(days => greatest(1, least(dias, 90)));
  out jsonb;
begin
  if not public.sou_admin() then raise exception 'só para administradores' using errcode = '42501'; end if;
  with e as (select * from public.app_events where at >= desde),
  passos as (
    select p.ev, p.ord, count(distinct e.dev) as n
    from (values ('open', 1), ('welcome', 2), ('login_link', 3), ('login_ok', 4), ('car_step', 5), ('car_created', 6), ('fill_open', 7), ('fill_saved', 8)) p(ev, ord)
    left join e on e.ev = p.ev group by p.ev, p.ord
  ),
  vs as (  -- sequência de telas da sessão, sem repetições seguidas
    select sess, view, at from (
      select sess, view, at, lag(view) over (partition by sess order by at) as prev from e where ev = 'view'
    ) x where prev is distinct from view
  ),
  caminhos as (
    select array_to_string((array_agg(view order by at))[1:4], ' → ') as c from vs group by sess
  )
  select jsonb_build_object(
    'dias', greatest(1, least(dias, 90)),
    'aparelhos', (select count(distinct dev) from e),
    'aberturas', (select count(distinct sess) from e),
    'eventos', (select count(*) from e),
    'funil', (select jsonb_agg(jsonb_build_object('ev', ev, 'n', n) order by ord) from passos),
    'diario', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'aparelhos', a, 'aberturas', s) order by d), '[]') from (
                 select (at at time zone 'America/Sao_Paulo')::date as d, count(distinct dev) as a, count(distinct sess) as s from e group by 1) x),
    'telas', (select coalesce(jsonb_agg(jsonb_build_object('view', view, 'aberturas', n) order by n desc), '[]') from (
                 select view, count(distinct sess) as n from e where ev = 'view' group by view) x),
    'plataformas', (select coalesce(jsonb_agg(jsonb_build_object('plat', plat, 'aparelhos', n) order by n desc), '[]') from (
                 select coalesce(plat, '?') as plat, count(distinct dev) as n from e group by 1) x),
    'caminhos', (select coalesce(jsonb_agg(jsonb_build_object('c', c, 'n', n) order by n desc), '[]') from (
                 select c, count(*) as n from caminhos group by c order by n desc limit 12) x),
    'pularam_carro', (select count(distinct dev) from e where ev = 'car_skip')
  ) into out;
  return out;
end;
$$;
revoke all on function public.admin_uso(integer) from public;
grant execute on function public.admin_uso(integer) to authenticated;

select cron.schedule('uso-retencao', '17 4 * * *', $$delete from public.app_events where at < now() - interval '90 days'$$);
