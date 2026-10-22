# Enche Aí

Saiba em qual posto vale abastecer, medido por quem abastece lá. É um caderno do carro (consumo, gastos,
manutenção) que funciona sem internet, ligado a uma rede de postos. A rede mostra o preço que os usuários pagaram,
o rendimento medido do combustível e avaliações de um toque, além da fiscalização da ANP e das notas do Google.

- App: https://henriqueklock.github.io/encheai/
- Desenho do produto e telas: documento “Enche Aí — desenho do produto” (com a trilha de IA) e o canvas de design.
- Nasceu como Caderneta do Carro; o app anterior continua em https://henriqueklock.github.io/caderneta-carro/.

## Como funciona

- **Celular (PWA):** Vite + TypeScript, sem framework. Os dados ficam no IndexedDB do aparelho (Dexie) e sincronizam com o Supabase quando há internet; vence a alteração mais recente.
  - Telas em `src/screens/`, estado central em `src/store.ts`, navegação por endereço em `src/router.ts`.
  - Os cálculos não dependem de tela e são testados: `src/calc.ts`, `src/postos.ts`, `src/indicators.ts`, `src/maintenance.ts`.
- **Supabase (projeto `encheai`, São Paulo):**
  - Tabelas pessoais com RLS por usuário.
  - `ratings`: avaliações, uma por abastecimento, só do próprio e até 30 dias depois; na média vale a data do abastecimento. Nota de 1 a 5 estrelas, bomba, atendimento, banheiro e "como o carro andou depois" (`after_effect`), que é sempre sobre o combustível daquele abastecimento: o app pergunta no abastecimento seguinte (sobre o posto anterior), pelo histórico, no Início a partir do dia seguinte e por notificação às 19h do dia seguinte (`src/depois.ts`).
  - `price_reports`: preço visto na bomba, informado sem abastecer (um por pessoa, posto, combustível e dia; faixa plausível e até 30 por dia). Na rede sai como "informado" e só quando não há preço de abastecimento na janela; só a própria conta vê as suas linhas.
  - `station_live`: números da rede por posto. São só agregados, recalculados a cada 5 min por `rede_refresh()` (pg_cron) a partir de quem aceitou contribuir.
  - Limites de publicação: rendimento com 5 pessoas e 15 tanques; cada item da avaliação e o "depois" com 3 respostas; estrelas com 5 notas; preço dos últimos 7 dias.
  - Lembretes: `push_subscriptions` (inscrições Web Push, só da própria conta), `push_keys` (chaves VAPID e segredo do envio, gerados no servidor, só a chave de serviço lê), `push_reminders` (um lembrete por abastecimento). O pg_cron chama a função `lembretes` às 19h de Brasília.
  - Funções:
    - `postos-google`: notas, fotos e sugestões de endereço, com cota diária por conta.
    - `excluir-conta`: apaga a conta e tudo dela (só pelo próprio app, nunca por app conectado).
    - `relato`: problema ou sugestão enviado pelo Perfil; guarda em `feedback` (só o dono lê, pelo painel) e manda e-mail pelo Resend.
    - `lembretes`: `GET …/chave` devolve a chave pública VAPID; `POST` envia os lembretes devidos e só aceita o segredo que o banco manda. A notificação não leva conteúdo; o texto é fixo no `public/push-sw.js`.
    - `mcp`: conector para o Claude (MCP por HTTP). Login pelo OAuth 2.1 do Supabase; ferramentas para listar carros, ver histórico, conferir e importar. Apps conectados (token com `client_id`) só leem carros e histórico e acrescentam registros; políticas restritivas no banco garantem isso.
- **Trazer histórico (`#/importar`):** planilha .csv/.xlsx sem IA (`src/planilha.ts`), resposta da IA da pessoa no formato `encheai-importacao-1` (`src/importacao.ts`, o mesmo arquivo roda na função `mcp`) e backup. Tudo passa por uma prévia que tira duplicados.
- **Dados da ANP:** `pipeline/postos.py` roda no GitHub Actions (`dados.yml`, terça e sábado). Gera `postos-SC.json` na branch `dados`, que o deploy publica em `/dados/`.

## Privacidade

- Casa, trabalho e a localização atual nunca entram na rede.
- Exclusão de conta pelo Perfil, que apaga tudo em cascata, inclusive os arquivos de OS.
- Política e termos ficam dentro do app, em `#/privacidade`.
- Chaves secretas ficam só nos segredos do Supabase; o site publicado é verificado a cada deploy (`tests/blackbox.mjs`).

## Desenvolvimento

```
npm ci
npm run dev        # http://localhost:5173/encheai/
npm test           # cálculos
npm run check      # tipos
```

Testes de banco (rodar no SQL do Supabase; terminam com um erro de propósito que desfaz tudo):

- `supabase/tests/rls_isolamento.sql`: um usuário não lê nem altera dados de outro.
- `supabase/tests/rede_calculo.sql`: preço, rendimento e avaliações da rede.
- `supabase/tests/apps_conectados.sql`: o que um app conectado (Claude) pode e não pode fazer.

Conector MCP com o Supabase simulado: `npx -y deno@2 run --allow-env --allow-net --allow-read tests/mcp-servidor.deno.ts`.

## Configuração que só o dono do projeto faz

1. Supabase › Authentication › URL Configuration: Site URL `https://henriqueklock.github.io/encheai/` e o mesmo em Redirect URLs.
2. Supabase › Edge Functions › Secrets: `GOOGLE_MAPS_API_KEY`. A chave nunca passa pelo chat nem pelo repositório.
3. GitHub › Settings › Pages: Source = GitHub Actions.
4. Opcional: SMTP próprio (Resend ou Brevo) em Authentication › Emails, para passar do limite de e-mails de login.
5. Relatos por e-mail: Supabase › Edge Functions › Secrets: `RESEND_API_KEY` e `RELATO_PARA` (e-mail que recebe). Com domínio verificado no Resend, também `RELATO_DE` (ex.: `Enche Aí <nao-responda@seu-dominio>`). Sem eles, os relatos ficam só na tabela `feedback`.
6. Conector do Claude: Supabase › Authentication › OAuth Server: ligar o servidor OAuth 2.1, Authorization Path `/autorizar` e permitir registro dinâmico de clientes. A tela de autorização é `#/autorizar` (com `autorizar/index.html` e `404.html` encaminhando o `authorization_id`).

## Próximas etapas

- **R2, piloto de 60 dias:** metas de 50% dos usuários contribuindo e 40% ainda ativos depois de 4 semanas.
- **R3:** viagem com paradas, todos os estados, planos de manutenção dos carros mais vendidos.
- **R4:** receita, com página verificada para postos e plano para frotas.
