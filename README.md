# Paramount+ Qualidade Máxima

Script para o Tampermonkey que faz o Paramount+ tocar sempre na **maior resolução disponível**,
sem esperar o modo adaptativo "subir" a qualidade.

## Instalação

1. Instale o [Tampermonkey](https://www.tampermonkey.net/) no navegador.
2. Tampermonkey → **Criar novo script** → apague o conteúdo e cole o conteúdo de
   [`paramount-quality.user.js`](paramount-quality.user.js) → **Salvar**.
3. Abra (ou recarregue) um filme/episódio no Paramount+.

## Uso

- O modo padrão já é **Máxima**: não precisa fazer nada.
- Um painel pequeno aparece quando há vídeo. **F2** mostra/oculta.
  - **Tocando agora**: resolução que o player está exibindo (verde = na resolução travada).
  - **Melhor disponível**: topo da lista que o Paramount+ enviou.
  - **Travado em**: o que o script deixou o player usar.
- No seletor dá para escolher **Máxima**, **Até 720p** (etc.) ou **Automática** (comportamento
  original do site). A escolha fica salva e vale para todos os vídeos; ela passa a valer ao
  recarregar o vídeo.

## Como funciona

O player baixa um manifesto (DASH `.mpd` ou HLS `.m3u8`) com todas as resoluções. O script
intercepta esse arquivo (`fetch` e `XMLHttpRequest`) e remove as resoluções abaixo da escolhida,
então o player só enxerga a melhor. Resoluções com codec que o navegador não decodifica são ignoradas.

## Limitações

- O script só escolhe entre as qualidades que o Paramount+ já oferece para o seu navegador.
  Se o site mandar no máximo 720p para o seu navegador, o máximo continua sendo 720p.
- Com a qualidade travada o player não pode baixar a resolução quando a internet cai: se o vídeo
  ficar carregando ou der erro, escolha uma resolução menor ou **Automática**.
