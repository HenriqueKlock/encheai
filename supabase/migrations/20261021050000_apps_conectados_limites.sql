-- Apps conectados pelo OAuth (o Claude, pelo conector): o token deles tem o claim client_id.
-- Mesmo que alguém use esse token direto no banco, ele só pode o que o conector promete:
-- ler carros e histórico e acrescentar abastecimentos e manutenções. Nada de alterar ou apagar,
-- nem ver casa/trabalho, avaliações, preferências, cotas ou arquivos de OS.
-- (políticas restritivas: somam-se às de dono, nunca ampliam)

-- carros: só leitura
create policy "apps: carros só leitura (insert)" on public.vehicles as restrictive for insert to authenticated
  with check ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: carros só leitura (update)" on public.vehicles as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: carros só leitura (remover)" on public.vehicles as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);

-- histórico: ler e acrescentar; não alterar nem remover
create policy "apps: abastecimentos sem alterar" on public.fuel_logs as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: abastecimentos sem remover" on public.fuel_logs as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: manutenções sem alterar" on public.services as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: manutenções sem remover" on public.services as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: itens sem alterar" on public.service_items as restrictive for update to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: itens sem remover" on public.service_items as restrictive for delete to authenticated
  using ((select auth.jwt() ->> 'client_id') is null);

-- fora do alcance dos apps
create policy "apps: sem locais" on public.user_places as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: sem avaliações" on public.ratings as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: sem preferências" on public.user_settings as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: sem cotas" on public.api_usage as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'client_id') is null) with check ((select auth.jwt() ->> 'client_id') is null);
create policy "apps: sem arquivos de OS" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'os' or (select auth.jwt() ->> 'client_id') is null)
  with check (bucket_id <> 'os' or (select auth.jwt() ->> 'client_id') is null);
