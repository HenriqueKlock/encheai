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
  - `ratings`: avaliações, uma por abastecimento, só do próprio e até 7 dias depois.
  - `station_live`: números da rede por posto. São só agregados, recalculados a cada 15 min por `rede_refresh()` (pg_cron) a partir de quem aceitou contribuir.
  - Limites de publicação: rendimento com 5 pessoas e 15 tanques; cada item da avaliação com 3 respostas; preço dos últimos 7 dias.
  - Funções:
    - `postos-google`: notas, fotos e sugestões de endereço, com cota diária por conta.
    - `excluir-conta`: apaga a conta e tudo dela.
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

## Configuração que só o dono do projeto faz

1. Supabase › Authentication › URL Configuration: Site URL `https://henriqueklock.github.io/encheai/` e o mesmo em Redirect URLs.
2. Supabase › Edge Functions › Secrets: `GOOGLE_MAPS_API_KEY`. A chave nunca passa pelo chat nem pelo repositório.
3. GitHub › Settings › Pages: Source = GitHub Actions.
4. Opcional: SMTP próprio (Resend ou Brevo) em Authentication › Emails, para passar do limite de e-mails de login.

## Próximas etapas

- **R2, piloto de 60 dias:** metas de 50% dos usuários contribuindo e 40% ainda ativos depois de 4 semanas.
- **R3:** viagem com paradas, todos os estados, planos de manutenção dos carros mais vendidos.
- **R4:** receita, com página verificada para postos e plano para frotas.
