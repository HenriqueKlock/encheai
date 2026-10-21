-- 1) Plano de manutenção do próprio carro: a pessoa parte de um modelo (ou do zero) e ajusta os itens.
alter table public.vehicles add column plan_custom jsonb
  check (plan_custom is null or (jsonb_typeof(plan_custom) = 'object' and pg_column_size(plan_custom) < 20000));

-- 2) Relatos de problema e sugestões. Só a função `relato` grava (com a chave de serviço) e só o dono
--    do projeto lê, pelo painel do Supabase. Se a conta for excluída, o relato fica sem dono.
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('problema', 'sugestao')),
  message text not null check (char_length(message) between 3 and 4000),
  contact text check (char_length(contact) <= 120),
  page text check (char_length(page) <= 80),
  app_version text check (char_length(app_version) <= 40),
  device text check (char_length(device) <= 300),
  emailed boolean not null default false,
  created_at timestamptz not null default now()
);
create index feedback_user_idx on public.feedback (user_id, created_at);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
