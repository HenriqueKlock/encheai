-- O envio dos lembretes só aceita chamada do próprio banco: um segredo aleatório gerado aqui, guardado em
-- push_keys (só a chave de serviço lê) e mandado pelo pg_cron no cabeçalho x-lembretes.
alter table public.push_keys add column cron_secret text not null default (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
select cron.unschedule('lembretes-depois');
select cron.schedule('lembretes-depois', '0 22 * * *', $$select net.http_post(
  url := 'https://jxpizqwcnoaecszooqxa.supabase.co/functions/v1/lembretes',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-lembretes', (select cron_secret from public.push_keys where id = 1)),
  body := '{}'::jsonb, timeout_milliseconds := 30000)$$);
