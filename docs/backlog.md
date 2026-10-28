# Backlog do Enche AI

Ideias avaliadas e ainda não feitas. Regras que valem para tudo: custo zero, nada de dados pessoais ou chaves no repositório, conteúdo do Google só na ficha do posto, sem usar dados de outros usuários.

## Plano de manutenção do carro (avaliado em 28/10/2026)

Pedido de usuário: buscar o plano de manutenção do carro cadastrado. Hoje o app só tem o plano básico e o do Creta 2.0; para os outros carros a tela oferece "básico" ou "montar do zero".

- **A. Montar a partir do histórico** (recomendado, fase 1): com manutenções importadas, medir o intervalo entre trocas do mesmo item e propor o plano; o que faltar vem do básico. A pessoa confere antes de salvar. Roda no aparelho.
- **B. Buscar com o Claude pelo conector** (recomendado, fase 1): botão "Buscar o plano do fabricante com o Claude". Ferramentas novas no MCP (`ver_plano`, `salvar_plano`); o Claude da pessoa pesquisa o manual e a tabela de revisões, mostra itens e fontes e grava em `plan_custom` só depois de confirmado.
- **C. Com qualquer IA**: o app gera um texto para colar no ChatGPT ou Gemini, que devolve o plano num formato que "Trazer histórico" lê.
- **D. Catálogo embutido**: planos dos 20 a 30 carros mais vendidos, aos poucos; depende de identificar bem o modelo (ver catálogo FIPE).
- Conferir com print: um usuário viu um "plano genérico" no Início, mas pelo código o Início não mostra manutenção sem plano.

## Cadastro do carro pelo catálogo FIPE

Não há API pública e gratuita de placa (Sinesp descontinuado, Senatran limitado e por contrato, APIs comerciais pagas). Em vez disso: catálogo marca → modelo → ano/versão da FIPE baixado uma vez por semana pelo pipeline de dados, com busca offline. Bônus: consumo oficial por modelo (Inmetro/PBEV) como referência antes dos dois primeiros tanques.

## Abrir no Android Auto e no CarPlay (avaliado em 28/10/2026)

Ver a seção correspondente na conversa: exige app nativo (o PWA não aparece na multimídia), aprovação de categoria (POI no Android Auto; entitlement de fueling no CarPlay) e contas de loja (Google Play US$ 25 uma vez; Apple US$ 99 por ano). Caminho sugerido: Android primeiro, tela "Postos perto" com preço e distância, tocar abre a navegação.

## Pequenos

- Código de 6 dígitos no e-mail de login (modelo Magic Link e Confirm signup no painel do Supabase, `{{ .Token }}`), para o login no iPhone não cair em outro navegador.
- Acentos nos nomes de cidade ("Florianopolis").
- 238 postos sem geocódigo.
- Apagar a tabela de snapshot `supabase_migrations.station_places_antes_20261022`.
- Places UI Kit como alternativa para a ficha do posto.
