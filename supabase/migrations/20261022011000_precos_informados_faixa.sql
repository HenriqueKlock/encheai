-- Preço informado fora de uma faixa plausível por combustível é recusado na entrada
-- (com poucos preços na semana, a mediana sozinha não segura um valor absurdo).
create or replace function public.price_reports_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.user_id := auth.uid();
  new.day := (now() at time zone 'America/Sao_Paulo')::date;
  if (new.fuel = 'etanol' and new.price not between 2 and 9) or (new.fuel <> 'etanol' and new.price not between 3 and 12) then
    raise exception 'preço fora da faixa esperada' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.day <> new.day then raise exception 'só dá para corrigir o preço informado hoje' using errcode = '23514'; end if;
    new.created_at := old.created_at;
  elsif (select count(*) from public.price_reports p where p.user_id = new.user_id and p.day = new.day) >= 30 then
    raise exception 'limite de preços informados por dia' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.price_reports_guard() from public, anon, authenticated;
