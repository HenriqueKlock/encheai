-- Limites dos apps conectados (token OAuth com client_id, como o do conector do Claude).
-- Mesmo padrão do rls_isolamento.sql: tudo dentro de uma transação que termina com um erro proposital
-- trazendo o resultado (nada fica no banco). Procure por "FALHOU" na mensagem.
-- As alterações avançam updated_at: a trava de sincronização ignora escrita com data igual ou mais velha.
do $$
declare
  a uuid := 'aaaaaaaa-0000-4000-8000-0000000000c1';
  va uuid := gen_random_uuid(); fa uuid := gen_random_uuid(); sa uuid := gen_random_uuid(); ia uuid := gen_random_uuid();
  res text[] := '{}';
  n bigint;
  ok_count int := 0;
  fail_count int := 0;
begin
  insert into auth.users (id, email, aud, role, instance_id) values (a, 'teste-app@exemplo.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  -- a pessoa, pelo app (sem client_id), cria os dados
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.vehicles (id, name, fuel_type, archived, updated_at) values (va, 'Carro', 'flex', false, now());
  insert into public.fuel_logs (id, vehicle_id, date, odometer_km, liters, total_brl, price_per_l, fuel, full_tank, station_id, updated_at)
    values (fa, va, current_date, 1000, 40, 260, 6.5, 'gasolina', true, '11111111000111', now());
  insert into public.services (id, vehicle_id, date, type, updated_at) values (sa, va, current_date, 'revisao', now());
  insert into public.service_items (id, service_id, description, parts_brl, labor_brl, updated_at) values (ia, sa, 'Óleo', 100, 50, now());
  insert into public.user_settings (home_indicators, updated_at) values ('["gasto_mes"]', now());
  insert into public.user_places (kind, label, lat, lon, updated_at) values ('casa', 'Rua', -27.6, -48.5, now());
  insert into public.ratings (fuel_log_id, station_id, bomba) values (fa, '11111111000111', 1);

  -- agora como o app conectado (token OAuth)
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'client_id', 'cliente-teste')::text, true);

  select count(*) into n from public.vehicles;          if n = 1 then ok_count := ok_count + 1; res := res || 'ok    app lê os carros'::text; else fail_count := fail_count + 1; res := res || ('FALHOU app leu ' || n || ' carros')::text; end if;
  select count(*) into n from public.fuel_logs;         if n = 1 then ok_count := ok_count + 1; res := res || 'ok    app lê os abastecimentos'::text; else fail_count := fail_count + 1; res := res || ('FALHOU app leu ' || n || ' abastecimentos')::text; end if;
  select count(*) into n from public.service_items;     if n = 1 then ok_count := ok_count + 1; res := res || 'ok    app lê os itens de manutenção'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app não leu itens'::text; end if;
  select count(*) into n from public.user_places;       if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não vê casa/trabalho'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app viu casa/trabalho'::text; end if;
  select count(*) into n from public.ratings;           if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não vê avaliações'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app viu avaliações'::text; end if;
  select count(*) into n from public.user_settings;     if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não vê preferências'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app viu preferências'::text; end if;

  insert into public.fuel_logs (id, vehicle_id, date, odometer_km, liters, total_brl, price_per_l, fuel, full_tank, updated_at)
    values (gen_random_uuid(), va, current_date, 1400, 40, 260, 6.5, 'gasolina', true, now());
  insert into public.services (id, vehicle_id, date, type, updated_at) values (gen_random_uuid(), va, current_date, 'outros', now());
  ok_count := ok_count + 1; res := res || 'ok    app acrescenta abastecimento e manutenção'::text;

  update public.fuel_logs set total_brl = 1, updated_at = now() + interval '1 minute' where id = fa;  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não altera abastecimento'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app alterou abastecimento'::text; end if;
  update public.fuel_logs set deleted_at = now(), updated_at = now() + interval '2 minutes' where id = fa;  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não marca abastecimento como excluído'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app excluiu abastecimento'::text; end if;
  update public.services set note = 'x', updated_at = now() + interval '1 minute' where id = sa;  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não altera manutenção'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app alterou manutenção'::text; end if;
  update public.vehicles set name = 'x', updated_at = now() + interval '1 minute' where id = va;  get diagnostics n = row_count;
  if n = 0 then ok_count := ok_count + 1; res := res || 'ok    app não altera carro'::text; else fail_count := fail_count + 1; res := res || 'FALHOU app alterou carro'::text; end if;
  begin
    insert into public.vehicles (id, name, fuel_type, archived, updated_at) values (gen_random_uuid(), 'Novo', 'flex', false, now());
    fail_count := fail_count + 1; res := res || 'FALHOU app criou carro'::text;
  exception when others then ok_count := ok_count + 1; res := res || 'ok    app não cria carro'::text;
  end;
  begin
    insert into public.user_places (kind, label, lat, lon, updated_at) values ('trabalho', 'X', -27, -48, now());
    fail_count := fail_count + 1; res := res || 'FALHOU app gravou local'::text;
  exception when others then ok_count := ok_count + 1; res := res || 'ok    app não grava locais'::text;
  end;

  -- de volta ao app normal: tudo continua como a pessoa deixou
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into n from public.fuel_logs where id = fa and total_brl = 260 and deleted_at is null;
  if n = 1 then ok_count := ok_count + 1; res := res || 'ok    o app da pessoa segue com acesso total'::text; else fail_count := fail_count + 1; res := res || 'FALHOU abastecimento mudou'::text; end if;
  update public.fuel_logs set note = 'pelo app', updated_at = now() + interval '3 minutes' where id = fa;  get diagnostics n = row_count;
  if n = 1 then ok_count := ok_count + 1; res := res || 'ok    o app da pessoa ainda altera'::text; else fail_count := fail_count + 1; res := res || 'FALHOU o app da pessoa perdeu acesso'::text; end if;

  raise exception E'RESULTADO apps conectados: % ok, % falhas\n%', ok_count, fail_count, array_to_string(res, E'\n');
end $$;
