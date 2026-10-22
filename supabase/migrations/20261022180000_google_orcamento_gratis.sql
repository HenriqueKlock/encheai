-- Custo zero com o Google: cada tipo de chamada (SKU) tem uma faixa grátis por mês, e o servidor nunca passa
-- dela. google_budget conta as chamadas de todo o app por SKU e por dia (no fuso do Google, o do Pacífico);
-- consume_google_budget só deixa chamar se o dia e o mês ainda estão abaixo do limite. Só a chave de serviço
-- (as funções postos-google e postos-ligar) usa. A cota do Google Cloud fica como segunda trava.

create table public.google_budget (
  sku text not null,
  day date not null,
  n integer not null default 0,
  primary key (sku, day)
);
alter table public.google_budget enable row level security;
revoke all on public.google_budget from anon, authenticated;

create or replace function public.consume_google_budget(p_sku text, p_day_max integer, p_month_max integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  d date := (now() at time zone 'America/Los_Angeles')::date;
  m integer;
  cur integer;
begin
  -- uma chamada de cada vez por SKU, para a conta nunca passar do limite
  perform pg_advisory_xact_lock(hashtext('google_budget:' || p_sku));
  select coalesce(sum(n), 0) into m from public.google_budget
    where sku = p_sku and day >= date_trunc('month', d)::date and day <= d;
  if m >= p_month_max then return false; end if;
  insert into public.google_budget as b (sku, day, n) values (p_sku, d, 1)
    on conflict (sku, day) do update set n = b.n + 1 where b.n < p_day_max
    returning n into cur;
  return cur is not null;
end $$;
revoke all on function public.consume_google_budget(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_google_budget(text, integer, integer) to service_role;

-- Cota por pessoa também para a nota do Google na ficha (busca separada, a única que traz nota).
alter table public.api_usage drop constraint api_usage_fn_check;
alter table public.api_usage add constraint api_usage_fn_check check (fn = any (array['google_nearby', 'google_posto', 'google_address', 'google_photo', 'google_autocomplete', 'google_details', 'google_lugar', 'google_avaliacoes', 'google_nota']));
