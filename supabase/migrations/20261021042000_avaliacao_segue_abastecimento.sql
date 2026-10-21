-- A avaliação vale só enquanto o abastecimento existe e continua ligado ao mesmo posto.
-- Os abastecimentos são excluídos com deleted_at (para sincronizar entre aparelhos), então o
-- "on delete cascade" da chave não dispara. O app apaga a avaliação junto com o abastecimento
-- (e limpa as que ficaram para trás na sincronização); aqui o cálculo da rede ignora as órfãs.
create or replace function public.rede_refresh()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  create temporary table _logs on commit drop as
    select l.user_id, l.vehicle_id, l.station_id, l.date, l.odometer_km, l.liters::float8 as liters,
           l.price_per_l::float8 as price, l.fuel, l.full_tank
    from public.fuel_logs l
    join public.user_settings s on s.user_id = l.user_id and s.contribute
    where l.deleted_at is null;

  -- Preço: últimos 7 dias, faixa plausível e a menos de 30% da mediana do combustível
  create temporary table _price on commit drop as
  with recent as (
    select station_id, fuel, date, price, user_id from pg_temp._logs
    where station_id is not null and date >= current_date - 7 and price between 0.5 and 15
      and fuel in ('gasolina', 'etanol', 'diesel')
  ), med as (
    select fuel, percentile_cont(0.5) within group (order by price) as m from recent group by fuel
  ), ok as (
    select r.* from recent r join med on med.fuel = r.fuel where abs(r.price / med.m - 1) <= 0.30
  ), last_day as (
    select station_id, fuel, max(date) as d from ok group by station_id, fuel
  ), win as (
    select o.station_id, o.fuel, ld.d, o.price, o.user_id, o.date from ok o
    join last_day ld using (station_id, fuel) where o.date >= ld.d - 3
  )
  select station_id,
         jsonb_object_agg(fuel, jsonb_build_object('v', round(v::numeric, 2), 'd', d, 'n', n)) as price
  from (
    select station_id, fuel, max(d) as d, count(distinct user_id) as n,
           case when count(*) >= 2 then percentile_cont(0.5) within group (order by price)
                else max(price) end as v
    from win group by station_id, fuel
  ) p group by station_id;

  -- Tanques: de um tanque cheio até o próximo, no mesmo carro; o posto é onde o tanque foi enchido
  create temporary table _tanks on commit drop as
  with fulls as (
    select user_id, vehicle_id, station_id, date, odometer_km, fuel,
           lead(odometer_km) over w as next_odo
    from pg_temp._logs where full_tank
    window w as (partition by vehicle_id order by odometer_km, date)
  ), t as (
    select f.user_id, f.vehicle_id, f.station_id, f.date, f.fuel,
           (f.next_odo - f.odometer_km)::float8 as km,
           (select sum(x.liters) from pg_temp._logs x
             where x.vehicle_id = f.vehicle_id and x.odometer_km > f.odometer_km and x.odometer_km <= f.next_odo) as liters
    from fulls f where f.next_odo is not null
  )
  select user_id, vehicle_id, station_id, date, fuel, km / liters as kml
  from t where km between 50 and 2000 and liters > 0 and km / liters between 3 and 30;

  -- Rendimento: km/l do tanque dividido pela mediana da mesma pessoa (mesmo carro e combustível) nos outros postos
  create temporary table _yield on commit drop as
  with r as (
    select t.station_id, t.user_id, t.date,
           t.kml / (select percentile_cont(0.5) within group (order by o.kml) from pg_temp._tanks o
                     where o.vehicle_id = t.vehicle_id and o.fuel = t.fuel
                       and o.station_id is distinct from t.station_id) as ratio,
           (select count(*) from pg_temp._tanks o
             where o.vehicle_id = t.vehicle_id and o.fuel = t.fuel and o.station_id is distinct from t.station_id) as base_n
    from pg_temp._tanks t
    where t.station_id is not null and t.date >= current_date - 180
  ), valid as (
    select station_id, user_id, date, ratio,
           row_number() over (partition by station_id, user_id order by date desc) as k
    from r where base_n >= 2 and ratio between 0.75 and 1.25
  ), capped as (
    select station_id, user_id, ratio,
           ntile(10) over (partition by station_id order by ratio) as dec,
           count(*) over (partition by station_id) as total
    from valid where k <= 5
  )
  select station_id, count(distinct user_id) as people, count(*) as tanks,
         avg(ratio) filter (where total < 10 or dec between 2 and 9) as ratio
  from capped group by station_id;

  -- Avaliações dos últimos 180 dias; cada item publica com 3 ou mais respostas
  create temporary table _rat on commit drop as
  select r.station_id, count(*) as n,
         array[count(*) filter (where bomba = 1), count(bomba)] as bomba,
         array[count(*) filter (where atendimento = 1), count(atendimento)] as atendimento,
         array[count(*) filter (where banheiro = 1), count(banheiro)] as banheiro
  from public.ratings r
  join public.user_settings s on s.user_id = r.user_id and s.contribute
  -- só vale enquanto o abastecimento existe e continua ligado ao mesmo posto
  join public.fuel_logs l on l.id = r.fuel_log_id and l.deleted_at is null and l.station_id = r.station_id
  where r.created_at >= now() - interval '180 days'
  group by r.station_id;

  create temporary table _out on commit drop as
  select coalesce(p.station_id, y.station_id, a.station_id) as station_id,
         coalesce(p.price, '{}'::jsonb) as price,
         case when y.station_id is null then null else jsonb_build_object(
           'people', y.people, 'tanks', y.tanks,
           'pub', y.people >= 5 and y.tanks >= 15,
           'r', case when y.people >= 5 and y.tanks >= 15 then round(y.ratio::numeric, 3) end) end as yield,
         case when a.station_id is null then null else jsonb_build_object(
           'n', a.n,
           'bomba', case when a.bomba[2] >= 3 then to_jsonb(a.bomba) end,
           'atendimento', case when a.atendimento[2] >= 3 then to_jsonb(a.atendimento) end,
           'banheiro', case when a.banheiro[2] >= 3 then to_jsonb(a.banheiro) end) end as ratings
  from pg_temp._price p
  full join pg_temp._yield y on y.station_id = p.station_id
  full join pg_temp._rat a on a.station_id = coalesce(p.station_id, y.station_id);

  insert into public.station_live as s (station_id, price, yield, ratings, updated_at)
  select station_id, price, yield, ratings, now() from pg_temp._out
  on conflict (station_id) do update
    set price = excluded.price, yield = excluded.yield, ratings = excluded.ratings, updated_at = excluded.updated_at;
  get diagnostics v_rows = row_count;

  -- Postos que saíram da janela ficam sem números (quem excluiu a conta ou parou de contribuir some daqui)
  update public.station_live s set price = '{}'::jsonb, yield = null, ratings = null, updated_at = now()
  where not exists (select 1 from pg_temp._out o where o.station_id = s.station_id)
    and (s.price <> '{}'::jsonb or s.yield is not null or s.ratings is not null);
  return v_rows;
end;
$$;
