-- Higiene: as funções do painel não precisam ser chamáveis sem login (já recusavam, agora nem executam)
revoke execute on function public.admin_uso(integer) from anon;
revoke execute on function public.sou_admin() from anon;
