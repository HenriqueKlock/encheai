-- Lembretes do "como o carro andou": todo dia às 19h de Brasília (22h UTC) a função `lembretes` envia os devidos.
select cron.schedule('lembretes-depois', '0 22 * * *', $$select net.http_post(url := 'https://jxpizqwcnoaecszooqxa.supabase.co/functions/v1/lembretes', headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000)$$);
