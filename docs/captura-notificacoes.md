# Captura automática pelas notificações do banco

O app lê as notificações que os apps de banco já enviam ("Compra de R$ 35,90 aprovada
em IFOOD…", "Você recebeu um Pix de…") e as transforma em lançamentos para confirmar
com um toque. O objetivo é tirar o trabalho manual de registrar gastos, que é o que
faz um app de finanças sair da rotina.

**Só Android.** iOS não permite ler notificações de outros apps. O texto é interpretado
no aparelho: o serviço nativo grava num arquivo interno e o app lê e interpreta
localmente. Desde o v19, com conta Spendr, a caixa de entrada (com o texto bruto) e as
regras aprendidas sincronizam como o resto: desinstalar o app não leva mais o que
esperava revisão.

## Como funciona

```
Notificação do banco
  └─ CaptureListenerService (Kotlin)      filtra "tem símbolo de moeda + número"
       └─ spendr_captures.jsonl           fila em disco, uma linha por notificação
            └─ ingestRawCaptures (JS)      ao abrir o app, voltar ao 1º plano ou evento
                 ├─ fingerprint            a mesma notificação nunca entra duas vezes
                 ├─ app bloqueado          nunca é capturado
                 ├─ parseCapture           valor, direção, tipo, contraparte, cartão
                 ├─ não é banco            sem banco citado, ignorado direto
                 ├─ decide                 duplicata? transferência? regra? categoria?
                 └─ captures (SQLite)      caixa de entrada, com o texto bruto guardado
```

Arquivos:

- `modules/spendr-captures/` — módulo Expo local: serviço, fila e ponte JS.
- `app/utils/captureParser.ts` — interpretação do texto (puro, testado).
- `app/utils/captureMatcher.ts` — decisões: duplicata, transferência, regras (puro, testado).
- `app/utils/captureActions.ts` — funil de entrada e respostas do usuário.
- `app/database/captures.ts` — tabelas `captures` e `merchant_rules` (sincronizam desde o v19).
- `app/contexts/CapturesContext.tsx` — estado para as telas, desfazer.
- `app/screens/CaptureInboxScreen.tsx` — a tela de revisão (`/inbox`).

## As duas regras que mais importam

**Certo decide sozinho; provável pergunta.** Nenhum palpite entra no livro-caixa em
silêncio.

### Duplicata: Samsung Pay + banco

Ao pagar no cartão pela carteira, chegam dois avisos da mesma compra: o do Samsung Pay
(ou Google Wallet) na hora e o do banco logo depois. Regra:

| Situação | Decisão |
|---|---|
| Carteira e banco, mesmo valor, ambos saída, até 4 h de diferença, com estabelecimento, final do cartão ou conta batendo e nada desmentindo | **Duplicata certa.** Fica a do banco (tem estabelecimento e cartão). Se o usuário já tinha confirmado a da carteira, a do banco é que vira duplicata — nunca uma segunda transação. |
| Carteira e banco, mesmo valor, ambos saída, até 12 h, sem sinal que confirme (ou mais de 4 h) | **Pergunta**, como a linha abaixo. Valor redondo se repete no mesmo dia: eram duas compras de R$ 20,00 fundidas numa. Se o estabelecimento ou o final desmentem, são duas, sem pergunta. Nome escrito de outro jeito não desmente: abreviado ("SUPERM" × "SUPERMERCADO"), com sufixo societário ("LTDA", "S/A"), com palavra a mais ou colada ("POSTOSHELL"). Mas nome assim só confirma junto com o mesmo final ou a mesma conta. |
| Dois bancos (ou o mesmo), mesmo valor e direção, até 3 min de diferença | **Pergunta:** "Parece o mesmo lançamento. Mesmo, ficar com um / Diferentes, ficar com os dois." Pode ser cobrança em dobro, pode ser dois cafés. |
| A mesma notificação reentregue ou repostada pelo Android | Ignorada pela impressão digital: com a chave da notificação, app + chave + `when` + título + texto, em qualquer horário (chaves diferentes são avisos diferentes, mesmo iguais no mesmo minuto); sem a chave, app + título + texto + minuto. |

### Transferência entre contas próprias

Um Pix da conta A para a conta B aparece como saída num app e entrada no outro. Lançar
os dois inventa uma despesa e uma receita; lançar um só distorce o saldo. Regra:

| Situação | Decisão |
|---|---|
| O nome na notificação é o do usuário (nome da conta Spendr, comparado por palavras, sem acento) | **Transferência certa.** Nenhuma perna entra no livro. |
| Contraparte que o usuário já marcou como "conta minha" (regra aprendida) | **Transferência certa.** |
| Saída e entrada do mesmo valor em apps diferentes, tipos compatíveis (Pix, TED, saque, depósito), até 24 h | **Pergunta:** "Transferência entre suas contas? Sim / Não, dois lançamentos." Pode ser um Pix para um amigo e outro de outro amigo. |
| A outra perna já tinha sido confirmada como lançamento | **Pergunta**, mesmo quando o nome é o do usuário: apagar uma transação aprovada é decisão de quem aprovou. Ao responder "sim", a transação é removida e as duas pernas viram transferência. |

Compras e estornos nunca formam par de transferência. Pagamento de fatura, aplicação e
resgate são **neutros**: não são receita nem despesa (as compras do cartão já entraram
uma a uma) e vão direto para o histórico como "ignorado", com o motivo. O dinheiro, porém,
troca de bolso: viram transferência para o cartão ou a reserva quando há uma escolha só
(ver `docs/contas-e-cartoes.md`).

### Apps que não são banco

O app ouve a notificação de todo mundo, e SMS, e-mail, mensageiro, loja e app de corrida
também falam de dinheiro. O app de banco reconhecido pelo nome ou pelo pacote nunca cai
aqui.

| Situação | Decisão |
|---|---|
| App bloqueado (hoje só o OnlineBanking do BASA, `com.mobileapp.basasuperapp`) | Nunca é capturado, nem citando banco. |
| App que não é banco, texto que não cita banco | Ignorado direto: sem item, sem conta, sem texto guardado. |
| App que não é banco, cita um banco | Vale o remetente ("Santander" no título do SMS) ou um padrão de banco no texto ("cartão Nubank", "com Nubank final 1234"); nunca o nome da loja ("LOJA INTER SHOPPING" não é o Inter). Cai na conta daquele banco quando há uma só; nunca cria conta. |
| Três avisos pendentes do mesmo app descartados | O app aprende a ignorá-lo; reverter um descarte desconta. O SMS nunca aprende: o pacote junta todos os remetentes, inclusive o banco. |

## O que a tela faz

- **Um toque para confirmar**, com a categoria sugerida já preenchida; a categoria é
  trocável no próprio cartão. Botões de 48 pt, rótulo e dica para leitor de tela, valor
  anunciado por extenso, resultado anunciado após cada ação.
- **Desfazer** por 8 segundos depois de qualquer ação, e **reverter** a qualquer momento
  pelo histórico (apaga a transação criada e devolve o item à fila).
- **Aprender por estabelecimento:** confirmar "IFOOD" como Alimentação três vezes
  seguidas faz as próximas entrarem sozinhas, listadas em "Adicionadas automaticamente"
  com desfazer. Mudar a categoria no meio zera a contagem.
- **Estorno e devolução** levam o nome da compra que desfazem ("estorno da compra em
  DROGARIA"), entram sempre como "Estorno" e não ensinam a regra da loja — senão a compra
  seguinte perderia a categoria. A regra da loja só decide se o estorno entra sozinho.
- O parser também acha o nome na cobrança de IOF (o estabelecimento é "IOF", não o da
  compra que a gerou), no débito automático ("... para SABESP") e com a data e a hora
  antes do nome ("EM 23/10 AS 12:30 DROGASIL").
- **Sem pressão:** nada de notificação insistente. O selo na aba inicial e a faixa "N
  lançamentos para revisar" somem quando a fila esvazia. Itens pendentes nunca expiram;
  o histórico é apagado depois de 90 dias.
- **Texto bruto sempre à mão** em "Notificação original", para conferir o que o parser leu.

## Apagar todos os dados

Configurações → "Apagar todos os dados" (SPD-082, DEC-35) apaga de verdade, sem lápide:
lançamentos, contas e cartões, contas a pagar, orçamentos, dívidas, metas e a caixa de
entrada inteira. Ficam as categorias, as regras aprendidas por estabelecimento e as
configurações (moeda, idioma, CDI, lembretes, biometria, avisos dispensados); saem só as
duas preferências presas a contas (pares de contas diferentes e a conta da PJ de cada
banco).

- **Com conta**, o servidor apaga primeiro (`POST /me/wipe`) — na conta e, por ela, em
  todos os aparelhos. Sem internet, ou se o servidor não confirmar, nada é apagado e a
  tela pede para tentar de novo. O `dataWipedAt` que ele devolve fica em `sync_state`
  como `knownWipeAt` e vai em todo push: o servidor recusa a remessa de um aparelho que
  ainda não sabe do apagar. **Sem conta**, só o aparelho.
- Da caixa de entrada sobra só a **impressão digital** de cada aviso, numa tabela local
  (`seen_capture_fingerprints`, v22), sem texto nem valor: a notificação que o Android
  reentregar depois não vira dinheiro de novo. A fila nativa é esvaziada antes, e o que
  estava nela é descartado do mesmo jeito. Linhas de extrato não ficam — reimportar o
  extrato traz o mês de volta.
- Também saem os lembretes agendados e o diário de diagnóstico (o id da instalação fica).
- Código: `app/utils/dataWipe.ts` (a ordem) e `wipeLocalData` em `app/database/database.ts`.

### Nos outros aparelhos da conta

O apagar chega aos outros aparelhos pelo sync (SPD-083). O servidor diz quando a conta
foi apagada pela última vez (`dataWipedAt`) em três lugares: no pull, no `/sync/status`
e no 409 `data_wiped` com que recusa o push de quem ainda não sabe. Um `dataWipedAt` mais
novo que o `knownWipeAt` do aparelho quer dizer que a conta foi esvaziada depois do que
ele sabe, e aí a regra é uma só (`app/sync/accountWipe.ts`):

- **O aparelho que já sincronizava com a conta apaga a sua cópia** — o mesmo
  `wipeDevice` do botão, com a marca do servidor na mesma transação — e mostra uma vez
  "Os dados desta conta foram apagados em outro aparelho". "Já sincronizava" é ter o
  último sync ou o cursor do pull desta conta em `sync_state`, sem escolha de dados
  pendente.
- **O aparelho que está entrando na conta agora só passa a conhecer o apagar.** O que ele
  tem foi criado nele antes do login e nunca esteve na conta: apagar isso faria o login num
  celular novo levar embora o que o usuário criou ali. No login, a marca vem do
  `/sync/status` antes de qualquer push — senão o primeiro upload seria recusado.
- **Servidor que não manda o campo** (o de produção até o SPD-080 subir): nada muda.

No pull, a página que trouxe a marca nova **não é gravada**: o servidor lê as linhas antes
de ler a marca, então elas podem ser do que o apagar levou. Ela é lida de novo — do mesmo
cursor, ou do zero quando o aparelho foi apagado (a conta acabou de ser esvaziada; o pull
inteiro é curto). No push recusado, nada daquela remessa foi aplicado: depois do apagar
ela é relida do banco, e o que saiu com ele não está mais lá para subir; o que fica (uma
categoria editada) sobe com a marca nova. Uma vez por rodada: se a conta for apagada de
novo no meio dela, a rodada falha e a fila tenta mais tarde, com o intervalo de sempre.
Tudo isso roda dentro da rodada da fila, que nunca corre junto com outra nem com o botão
de apagar (`runExclusive`).

Sair da conta ou entrar em outra limpa o `sync_state` inteiro, a marca junto: ela é desta
conta. O que foi criado neste aparelho sem rede depois do instante do apagar também sai —
o aparelho não tem como saber, com o relógio dele, o que veio antes ou depois.

Código: `app/sync/accountWipe.ts` (a regra), `applyWipeMark` em `app/sync/engine.ts` (onde
pull, push e login a aplicam) e `app/sync/remoteWipe.ts` (o apagar e o aviso).

## Ligar

Configurações → Captura automática → "Ler notificações do banco" abre a tela do
Android de acesso a notificações; o app não consegue ligar sozinho. O estado (Ativo /
Desativo) é relido toda vez que o app volta ao primeiro plano.

## Extrato OFX: a rede de segurança

Configurações → Dados → "Importar extrato do banco (OFX)". O extrato é a fonte mais
completa, mas chega por último: quando é importado, quase tudo já está no app. Por
isso o import **nunca insere direto** — ele concilia, e só o que o app não conhecia vai
para a mesma caixa de entrada das notificações.

Arquivos: `app/utils/ofxParser.ts` (leitura, SGML 1.x e XML 2.x, Latin-1 e UTF-8),
`app/utils/statementMatcher.ts` (conciliação, pura), `app/utils/statementImport.ts`
(grava o plano numa única transação).

A escada, do mais certo ao mais provável:

| Passo | Regra | Resultado |
|---|---|---|
| 1 | **FITID já visto** (impressão digital `ofx:<conta>:<fitid>`) | Linha ignorada. Reimportar o mesmo arquivo ou dois meses com sobreposição é um no-op |
| 2 | **Notificação capturada** com o mesmo valor e direção, avisada entre 1 dia depois e 5 dias antes da data do extrato | Linha entra como "já vista" apontando para a notificação. Cada notificação casa com uma linha só |
| 3 | **Lançamento do livro** que não veio de captura (digitado ou recorrente), mesmo valor e direção, datado entre 2 dias depois e 5 dias antes da linha | Linha ligada ao lançamento. Cada lançamento casa com uma linha só; reverter a linha não apaga o lançamento, que é do usuário |
| 4 | O que sobra passa pelo **mesmo motor das notificações** | Transferência entre duas contas do arquivo, neutro (fatura, aplicação, resgate), automático (estabelecimento aprendido) ou item para revisar |

Detalhes que importam:

- Entre notificação e lançamento, a linha casa com o registro **que expira antes**
  (prazo mais cedo primeiro), não com o mais próximo. É o que garante que nenhum
  registro compatível fique sem par — "mais próximo" deixava um lançamento digitado
  sobrar e a mesma compra aparecer duas vezes. Coberto por teste com o contraexemplo.
- Duas linhas de extrato nunca perguntam "é duplicata?" entre si: o FITID já responde.
- Uma notificação que chega **depois** de o extrato ter a compra vira duplicata da
  linha, não um segundo item.
- "Pagamento recebido" no extrato do cartão e "pagamento de fatura" na conta são
  neutros; rendimento e juros são receita.
- O plano é determinístico: a ordem das linhas no arquivo não muda o resultado.
- `statementMatcher.test.ts` inclui um teste por propriedades sobre 400 cenários
  aleatórios de compras, avisos e lançamentos digitados: só eventos sem aviso e sem
  lançamento vão para revisão, nenhum registro é reivindicado duas vezes, e reimportar
  é sempre um no-op.

## Contas, cartões e parcelas

Desde o v7 cada captura sabe a conta de origem (`accountId`), compras parceladas viram
uma parcela por mês ao confirmar, e transferências e pagamentos de fatura entram na
tabela `transfers`. Ver `docs/contas-e-cartoes.md`.

## Limites conhecidos

- Bancos mudam o texto das notificações. O parser é por palavras-chave, não por banco,
  e o texto bruto fica guardado — uma notificação mal lida vira um item para corrigir,
  não um dado perdido. Casos novos entram em `captureParser.test.ts`.
- Se o banco não notifica (app do banco com notificações desligadas, compra no débito
  sem aviso), nada é capturado até o próximo import de extrato.
- A conciliação do extrato compara valor, direção e data; não compara o nome do
  estabelecimento. Duas compras do mesmo valor em dias próximos, uma avisada e outra
  não, podem trocar de par entre si — os totais não mudam, e o que sobra vai para
  revisão.
- Sem conta Spendr, regras aprendidas e a caixa de entrada ficam só neste aparelho; com
  conta, sincronizam desde o v19.
