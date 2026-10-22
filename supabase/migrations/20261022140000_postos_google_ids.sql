-- Postos da ANP ligados aos lugares do Google (Grande Florianópolis). Guarda só o place_id, que os termos do
-- Google permitem guardar sem prazo; nota, nome e avaliações vêm do Google na hora. Leitura pública (é dado
-- público, sem nada de usuário); só a chave de serviço grava (função postos-ligar, pelo pg_cron).
create table public.station_places (
  station_id text primary key,
  place_id text,
  checked_at timestamptz not null default now()
);
alter table public.station_places enable row level security;
create policy station_places_leitura on public.station_places for select to anon, authenticated using (true);

select cron.schedule('postos-ligar', '17 6 * * *', $$select net.http_post(
  url := 'https://jxpizqwcnoaecszooqxa.supabase.co/functions/v1/postos-ligar',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select cron_secret from public.push_keys where id = 1)),
  body := '{}'::jsonb, timeout_milliseconds := 140000)$$);

-- Nota da comparação (para um lugar do Google ficar com um posto só: o mais parecido).
alter table public.station_places add column score real;

-- O app lê a ligação posto → place_id (com ou sem login). Só leitura: escrita fica só com a chave de serviço.
grant select on public.station_places to anon, authenticated;
