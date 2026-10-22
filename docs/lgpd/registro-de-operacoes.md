# Registro das operações de tratamento (LGPD, art. 37)

Versão de 22/10/2026. Controlador: Henrique Klock (responsável pelo Enche Aí). Canal do titular: o e-mail da política de privacidade, no app (`#/privacidade`).
Porte: agente de tratamento de pequeno porte (Resolução CD/ANPD nº 2/2022); sem encarregado nomeado, com canal de atendimento.

| Operação | Dados | Titulares | Finalidade | Base legal | Onde fica | Retenção | Compartilhamento |
|---|---|---|---|---|---|---|---|
| Conta e login | e-mail, identificador | usuários | entrar e sincronizar | execução do serviço (art. 7º, V) | Supabase (São Paulo) | enquanto a conta existir | — |
| Caderno do carro | carros, abastecimentos, manutenções, arquivos de OS | usuários | registro pessoal, consumo, manutenção | execução do serviço | aparelho + Supabase | enquanto a conta existir | Claude (Anthropic), só se o usuário conectar |
| Casa e trabalho | rua e ponto no mapa, sem número | usuários | comparar postos perto | execução do serviço | aparelho + Supabase | até o usuário apagar ou excluir a conta | — |
| Rede de postos | abastecimentos com posto, avaliações, preços informados | usuários com "Contribuir" ligado | números agregados por posto | legítimo interesse (art. 7º, IX), com opção de sair | Supabase | entra na rede: preço 7 dias, rendimento/avaliações 180 dias | publicado só agregado e com volume mínimo |
| Lembrete | endereço de push do navegador | quem liga | lembrar de avaliar | consentimento (ligar no Perfil) | Supabase | até desligar, sair da conta ou o navegador descartar | serviço de push do navegador (sem conteúdo) |
| Relatos | texto, prints, e-mail | quem envia | suporte e melhoria | legítimo interesse | Supabase + e-mail (Resend) | até resolver, no máximo 1 ano | Resend (EUA) |
| Busca de postos e endereços | texto buscado, região | usuários | notas, fotos e endereços | execução do serviço | não guardado (cache no aparelho 7 dias) | — | Google (EUA), Photon/OSM e OSRM (Europa) |
| Correção do posto no Google | qual lugar do Google é cada posto (ou "não está no Google"), por conta | quem corrige | ligar cada posto ao cadastro certo do Google | legítimo interesse | Supabase | enquanto a conta existir; vale para todos com 2 pessoas em 180 dias | publicado só o resultado (posto → lugar), sem quem corrigiu |
| Estatísticas agregadas | médias e contagens por posto/região/período, mínimo 5 pessoas | usuários com "Contribuir" ligado | relatórios e licenciamento (inclusive pago), melhoria do app | legítimo interesse; agregado anonimizado | Supabase | — | postos, distribuidoras, parceiros, pesquisas (só agregados) |
| Segurança | contadores de uso por conta | usuários | limites e prevenção de abuso | legítimo interesse | Supabase | dias correntes | — |

Transferência internacional: Google, Resend, GitHub e Anthropic (EUA); OSM/Photon/OSRM (Europa). Fornecedores com contratos/termos de proteção de dados; revisar a adoção das cláusulas-padrão da ANPD (Resolução CD/ANPD nº 19/2024) a cada fornecedor novo.
