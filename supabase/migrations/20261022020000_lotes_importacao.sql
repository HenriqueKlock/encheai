-- Importações ganham lote e origem, para dar para desfazer uma importação inteira pelo app.
-- Apps conectados (o Claude): todo abastecimento ou manutenção que acrescentam vem marcado com lote e
-- origem 'claude', e abastecimento vindo deles não liga posto da rede (não mexe nos números dos postos).
alter table public.fuel_logs
  add column import_batch uuid,
  add column import_source text check (import_source in ('claude', 'ia', 'planilha'));
alter table public.services
  add column import_batch uuid,
  add column import_source text check (import_source in ('claude', 'ia', 'planilha'));
create index fuel_logs_import_batch_idx on public.fuel_logs (user_id, import_batch) where import_batch is not null;
create index services_import_batch_idx on public.services (user_id, import_batch) where import_batch is not null;

create policy "apps: abastecimento com lote e sem posto da rede" on public.fuel_logs as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'client_id') is null or (station_id is null and import_batch is not null and import_source = 'claude'));
create policy "apps: manutenção com lote" on public.services as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'client_id') is null or (import_batch is not null and import_source = 'claude'));
