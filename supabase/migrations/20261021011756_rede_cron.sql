-- Recalcula os números da rede a cada 15 minutos
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('rede-refresh', '*/15 * * * *', 'select public.rede_refresh()');
