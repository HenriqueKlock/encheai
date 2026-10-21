-- Números da rede recalculados a cada 5 minutos (antes 15): mudar ou apagar uma avaliação aparece mais rápido.
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'rede-refresh'), schedule := '*/5 * * * *');
