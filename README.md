# Enche AI

Saiba em qual posto vale abastecer, medido por quem abastece lá. É um caderno do carro (consumo, gastos,
manutenção) que funciona sem internet, ligado a uma rede de postos. A rede mostra o preço que os usuários pagaram,
o rendimento medido do combustível e avaliações de um toque, além da fiscalização da ANP e das notas do Google.

- App: https://henriqueklock.github.io/encheai/
- Desenho do produto e telas: documento “Enche AI — desenho do produto” (com a trilha de IA) e o canvas de design.
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
  - `station_places`: posto da ANP (CNPJ) → `place_id` do Google, na Grande Florianópolis. Só o id é guardado (os termos do Google permitem guardar o place_id sem prazo; nota, nome e avaliações vêm do Google na hora). A função `postos-ligar` (pg_cron, todo dia às 03:17) confere 80 postos por vez e revê cada um a cada 30 dias; tira os fechados de vez e, quando o mesmo endereço tem dois cadastros no Google (nome ou bandeira antigos), fica com o que tem mais avaliações. Leitura pública; só a chave de serviço grava.
  - `station_name_votes` e `station_names`: nome do posto na fachada, sugerido na ficha ("Na fachada é outro nome?"). A lista e o mapa usam esse nome; sem ele, o da ANP sem bandeira antiga. Vale para todos com 2 pessoas escrevendo o mesmo nome em 180 dias ou na hora para quem está em `app_admins`.
  - `station_place_votes`: na ficha do posto, a pessoa confirma ou corrige qual é o posto no Google (ou diz que não está lá). Vale na hora para ela; para todos quando duas pessoas concordam em 180 dias ou quem corrige está em `app_admins` (preenchida direto no banco). A ligação feita pelas pessoas (`source = 'pessoas'`) não é revista pela busca automática. Só o dono lê os próprios votos.
  - Limites de publicação: rendimento com 5 pessoas e 15 tanques; cada item da avaliação e o "depois" com 3 respostas; estrelas com 5 notas; preço dos últimos 7 dias.
  - Lembretes: `push_subscriptions` (inscrições Web Push, só da própria conta), `push_keys` (chaves VAPID e segredo do envio, gerados no servidor, só a chave de serviço lê), `push_reminders` (um lembrete por abastecimento). O pg_cron chama a função `lembretes` às 19h de Brasília.
  - Funções:
    - `postos-google`: custo zero com o Google. Toda chamada passa pelo orçamento do app inteiro (`google_budget` e `consume_google_budget`, só a chave de serviço), que nunca deixa um SKU passar da faixa grátis do mês (Pro 5 mil, Enterprise mil, Essentials 10 mil, com 5% de folga) e divide o mês em tetos por dia. A busca por perto só pede campos Pro (nome, endereço, ponto, foto); a nota vem à parte, só na ficha (`nota`), e não entra na confiabilidade nem no sugerido. O aparelho guarda o que veio do Google só até o fim do dia. Também: fotos e sugestões de endereço, nota de um posto pelo `place_id` (`lugar`) e as até 5 avaliações do Google quando a pessoa toca na nota (`avaliacoes`, nada é guardado), com cota diária por conta.
    - `excluir-conta`: apaga a conta e tudo dela (só pelo próprio app, nunca por app conectado).
    - `relato`: problema ou sugestão enviado pelo Perfil; guarda em `feedback` (só o dono lê, pelo painel) e manda e-mail pelo Resend.
    - `lembretes`: `GET …/chave` devolve a chave pública VAPID; `POST` envia os lembretes devidos e só aceita o segredo que o banco manda. A notificação não leva conteúdo; o texto é fixo no `public/push-sw.js`.
    - `mcp`: conector para o Claude (MCP por HTTP). Login pelo OAuth 2.1 do Supabase; ferramentas para listar carros, ver histórico, conferir e importar. Apps conectados (token com `client_id`) só leem carros e histórico e acrescentam registros; políticas restritivas no banco garantem isso.
- **Trazer histórico (`#/importar`):** planilha .csv/.xlsx sem IA (`src/planilha.ts`), resposta da IA da pessoa no formato `encheai-importacao-1` (`src/importacao.ts`, o mesmo arquivo roda na função `mcp`) e backup. Tudo passa por uma prévia que tira duplicados.
- **Dados da ANP:** `pipeline/postos.py` roda no GitHub Actions (`dados.yml`, terça e sábado). Gera `postos-SC.json` na branch `dados`, que o deploy publica em `/dados/`. Também busca os postos de SC no OpenStreetMap (Overpass, licença ODbL: pode guardar citando "© colaboradores do OpenStreetMap") e liga cada um ao CNPJ por endereço, nome, bandeira e distância: o nome na fachada vai no campo `o` e o ponto exato substitui o aproximado. Redes com vários postos perto só são ligadas com o endereço completo; nome que só repete a bandeira não é usado. No app, o nome confirmado pelas pessoas vale mais que o do OpenStreetMap, que vale mais que o da ANP. `--osm relatorio` só grava `osm-relatorio-SC.json` para conferir.

## Google (termos e custo zero)

- Os termos do Google Maps Platform não deixam mostrar dados do Places (nome, nota, foto, avaliações, ponto) junto de um mapa que não é do Google, nem guardá-los (só o `place_id`). Por isso a lista, o mapa da aba Postos (OpenStreetMap) e o Início usam só nossos dados: nome da ANP sem bandeira antiga e ponto da ANP. A nota do Google não entra na confiabilidade nem no sugerido.
- O Google aparece só na ficha do posto, com o mapa do Google (Maps Embed API) no lugar do OpenStreetMap: nome e endereço no Google, nota, foto e avaliações, e a confirmação "é este o posto?". Tudo fica só na memória enquanto o app está aberto.
- Mapa da aba Postos em Google Maps (Maps JavaScript API) teria custo depois de 10 mil carregamentos por mês; fica no OpenStreetMap, que é grátis e sem limite.

## Visual

- No computador (tela a partir de 960 px): navegação na lateral, Postos com a lista numa coluna ao lado do mapa e as folhas como janelas no centro. Com mouse, os mapas têm botões de zoom e a rodinha aproxima. Tudo no fim de `src/visual-novo.css` (e `desktop()` em `src/folha.ts`).
- Um visual só: a marca Enche AI (`src/visual-novo.css`, sob a classe `v2` que o `<html>` já traz; `src/styles.css` é a base). Não há mais opção de visual no Perfil.
- Boas-vindas, Início, Postos (mapa no topo e lista em folha), ficha do posto, Abastecer, a avaliação depois de salvar e Meu carro têm marcação própria, gerada quando `isNovo()` é verdadeiro (agora sempre). Os trechos `only-v1` e os ramos do visual clássico ainda estão no código e podem ser removidos aos poucos. Na avaliação, bomba, atendimento e banheiro são etiquetas de três estados (1 toque: sim, 2: não, 3: sem resposta).
- Identidade: gota (logo), Mata #0E3B2E, Folha #1E7A4E, Broto #C3F25C, Névoa #F2F1EA; Bricolage Grotesque (títulos e números) e Instrument Sans (texto), servidas pelo próprio app.

## Privacidade

- Documentos de LGPD em `docs/lgpd/`: registro das operações, avaliação de legítimo interesse (rede de postos) e plano de incidentes. Base da rede: legítimo interesse com opção de sair.
- Importações (planilha, IA, Claude) ficam marcadas com lote e origem (`import_batch`, `import_source`) e podem ser desfeitas inteiras em Trazer histórico. Apps conectados só inserem com lote e sem posto da rede.

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
   - `GOOGLE_EMBED_KEY`: outra chave, só para o mapa do Google na ficha do posto (Maps Embed API, grátis e sem limite). No Google Cloud: ativar a Maps Embed API, criar a chave com restrição de API (só Maps Embed API) e de site (`https://henriqueklock.github.io/*`). É uma chave de navegador (aparece no endereço do mapa), por isso a restrição; fica no segredo para não entrar no repositório. Sem ela, a ficha não mostra nada do Google, só o link para o Google Maps.
3. GitHub › Settings › Pages: Source = GitHub Actions.
4. Opcional: SMTP próprio (Resend ou Brevo) em Authentication › Emails, para passar do limite de e-mails de login.
5. Relatos por e-mail: Supabase › Edge Functions › Secrets: `RESEND_API_KEY` e `RELATO_PARA` (e-mail que recebe). Com domínio verificado no Resend, também `RELATO_DE` (ex.: `Enche AI <nao-responda@seu-dominio>`). Sem eles, os relatos ficam só na tabela `feedback`.
6. Conector do Claude: Supabase › Authentication › OAuth Server: ligar o servidor OAuth 2.1, Authorization Path `/autorizar` e permitir registro dinâmico de clientes. A tela de autorização é `#/autorizar` (com `autorizar/index.html` e `404.html` encaminhando o `authorization_id`).

## Próximas etapas

- **R2, piloto de 60 dias:** metas de 50% dos usuários contribuindo e 40% ainda ativos depois de 4 semanas.
- **R3:** viagem com paradas, todos os estados, planos de manutenção dos carros mais vendidos.
- **R4:** receita, com página verificada para postos e plano para frotas.
