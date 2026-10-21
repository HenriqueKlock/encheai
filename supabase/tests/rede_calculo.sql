-- Teste do cálculo da rede, rodado direto no banco dentro de uma transação que termina em erro de propósito
-- (nada fica gravado). Seis pessoas que contribuem abastecem no posto S e no posto O; no S o carro rende 10% a mais.
-- Uma sétima pessoa NÃO contribui e abastece no S com preço estranho: não pode aparecer em nada.
-- Procure "FALHOU" na mensagem do erro.
do $$
declare
  s_id text := '11111111000111';
  o_id text := '22222222000122';
  u uuid; v uuid; f uuid;
  i int; k int;
  res text[] := '{}';
  live record;
  fails int := 0;
begin
  for k in 1..7 loop
    u := ('cccccccc-0000-4000-8000-' || lpad(k::text, 12, '0'))::uuid;
    v := gen_random_uuid();
    insert into auth.users (id, email, aud, role, instance_id)
      values (u, 'rede-' || k || '@exemplo.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
    insert into public.user_settings (user_id, contribute, consent_at, updated_at) values (u, k <= 6, now(), now());
    insert into public.vehicles (id, user_id, name, updated_at) values (v, u, 'Carro ' || k, now());
    -- 9 tanques cheios a cada 400 km; abastecimentos 1, 3 e 5 no posto S, o resto no O.
    -- Tanque que começa no S rende 11 km/l (36,364 l no abastecimento seguinte); no O, 10 km/l (40 l).
    for i in 0..8 loop
      f := gen_random_uuid();
      insert into public.fuel_logs (id, user_id, vehicle_id, date, odometer_km, liters, total_brl, price_per_l, fuel, full_tank, station_id, updated_at)
      values (f, u, v, current_date - (8 - i), 1000 + 400 * i,
              case when i = 0 then 40 when (i - 1) in (1, 3, 5) then 36.364 else 40 end,
              260, case when k = 7 then 9.9 when i in (1, 3, 5) then 6.49 + k * 0.01 else 6.79 end,
              'gasolina', true, case when i in (1, 3, 5) then s_id else o_id end, now());
      -- avaliação do último abastecimento no S (feito há 3 dias)
      if i = 5 and k <= 4 then
        perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
        insert into public.ratings (fuel_log_id, station_id, bomba, banheiro) values (f, s_id, case when k = 4 then -1 else 1 end, 1);
        perform set_config('request.jwt.claims', '', true);
      end if;
    end loop;
  end loop;

  perform public.rede_refresh();
  select * into live from public.station_live where station_id = s_id;

  if live.yield ->> 'pub' = 'true' and abs((live.yield ->> 'r')::numeric - 1.1) < 0.005 then res := res || ('ok    rendimento do S publicado: ' || (live.yield ->> 'r'));
  else fails := fails + 1; res := res || ('FALHOU rendimento do S: ' || coalesce(live.yield::text, 'nulo')); end if;

  if (live.yield ->> 'people')::int = 6 and (live.yield ->> 'tanks')::int = 18 then res := res || 'ok    6 pessoas e 18 tanques (a que não contribui ficou de fora)'::text;
  else fails := fails + 1; res := res || ('FALHOU contagem: ' || coalesce(live.yield::text, 'nulo')); end if;

  if (live.price -> 'gasolina' ->> 'n')::int = 6 and (live.price -> 'gasolina' ->> 'v')::numeric between 6.50 and 6.56 then res := res || ('ok    preço da rede no S: ' || (live.price -> 'gasolina')::text);
  else fails := fails + 1; res := res || ('FALHOU preço: ' || live.price::text); end if;

  if (live.ratings -> 'bomba') = '[3, 4]'::jsonb and (live.ratings -> 'banheiro') = '[4, 4]'::jsonb and (live.ratings -> 'atendimento') = 'null'::jsonb then res := res || ('ok    avaliações: ' || live.ratings::text);
  else fails := fails + 1; res := res || ('FALHOU avaliações: ' || coalesce(live.ratings::text, 'nulo')); end if;

  select * into live from public.station_live where station_id = o_id;
  res := res || ('info  posto O: ' || coalesce(live.yield::text, 'nulo') || ' ' || live.price::text);

  raise exception E'\n%\n%', array_to_string(res, E'\n'), case when fails = 0 then 'TUDO CERTO' else fails || ' FALHA(S)' end;
end;
$$;
