-- Lembrete no dia seguinte ao abastecimento (antes: uma semana). Janela de 1 a 5 dias para pegar quem ligou o lembrete depois.
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
    and l.date between current_date - 5 and current_date - 1
    and exists (select 1 from public.push_subscriptions p where p.user_id = l.user_id)
    and not exists (select 1 from public.ratings r where r.fuel_log_id = l.id and r.after_effect is not null)
    and not exists (select 1 from public.push_reminders m where m.fuel_log_id = l.id)
    and not exists (select 1 from public.fuel_logs n where n.vehicle_id = l.vehicle_id and n.deleted_at is null
                    and (n.date > l.date or (n.date = l.date and n.odometer_km > l.odometer_km)))
  order by l.user_id, l.date desc;
$$;
revoke all on function public.lembretes_devidos() from public, anon, authenticated;
grant execute on function public.lembretes_devidos() to service_role;
