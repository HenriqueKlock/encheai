# Plano de resposta a incidentes de segurança

Versão de 22/10/2026. Referência: Resolução CD/ANPD nº 15/2024.

1. **Conter**: revogar chaves expostas (Supabase: chaves de API e segredos das funções; Resend; Google), desligar a função afetada, revogar sessões se preciso.
2. **Avaliar** em até 24 h: quais dados, quantas contas, desde quando, se há risco ou dano relevante aos titulares.
3. **Comunicar** em até 3 dias úteis, se houver risco ou dano relevante: à ANPD (formulário de comunicação de incidente) e às pessoas afetadas (e-mail e aviso no app), com o que aconteceu, os dados envolvidos, o que foi feito e o que a pessoa pode fazer.
4. **Registrar** o incidente (mesmo sem comunicação) e guardar por 5 anos: data, causa, dados, decisão de comunicar ou não e por quê.
5. **Corrigir** a causa e acrescentar uma checagem ao teste de caixa preta (`tests/blackbox.mjs`) quando for possível.
