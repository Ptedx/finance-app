# Revisão dos fluxos — 11/10/2026

Seis revisões independentes, uma por fluxo do app, feitas em cima da `hotfix/1.2.5`. Cada
achado traz o lugar, o cenário que quebra e a consequência.

Estado de cada achado:

- **corrigido** — já consertado na 1.2.6;
- **conferido** — li o código e o achado procede, mas o conserto não entrou ainda;
- **relatado** — vem da revisão e não foi conferido linha a linha. Vale confirmar antes de
  mexer.

---

## 1. Dinheiro que some ou aparece

### 1.1 Apagar uma conta deixa as transferências dela vivas — relatado

`deleteAccount` desliga os lançamentos (`accountId = NULL`) mas não toca nas transferências;
`deleteTransfersOf` existe e só é chamada na conversão de cartão. Apagar uma conta de
reserva com R$ 40.000 recebidos da principal deixa a principal R$ 40.000 mais pobre, para
sempre, sem nada ter sido gasto.

### 1.2 Transferência engolida por outra de mesmo valor — relatado

`findLiveTransfer`: com o outro lado ainda desconhecido, a comparação ignora o destino e
casa qualquer transferência viva daquela conta com aquele valor em ±5 dias. Dois aportes
iguais no mês (R$ 200 para o envelope no dia 3, R$ 200 para a reserva no dia 6) viram um só.

### 1.3 Pagar a fatura em duas parcelas iguais perde a segunda — relatado

`recordCardPayment` → `findCardPayment` casa qualquer pagamento do mesmo valor em ±5 dias,
de qualquer conta, e aborta anunciando "esse pagamento já estava registrado". R$ 500 reais
somem do app com uma mensagem de sucesso.

### 1.4 "Acertar valor" do cartão: campo em branco zera aquela fatura — relatado

O campo vazio é lido como "o banco mostra zero". Preencher só a fatura fechada cria um
estorno falso do valor da aberta. A folha não pré-preenche nem mostra o que o app acha hoje,
então não há como perceber.

### 1.5 Atribuir "sem conta" não olha a âncora do destino — relatado

`getUnassignedNet` soma tudo até hoje; o saldo de conta só conta o que é depois da âncora.
Mover 40 lançamentos antigos para uma conta criada hoje faz "Em caixa" pular no instante do
toque, sem aviso.

---

## 2. Contas e identidade de banco

### 2.1 Qualquer app virava conta — corrigido

Seis contas inventadas na conta de produção ("Messages", "99", "OnlineBanking", "Google",
"Gmail", "WhatsApp"). Ver `docs/contas-e-notificacoes.md`.

### 2.2 Juntar contas perdia o nome do cartão — corrigido

A gravação dos nomes era desfeita pelo `updateAccount` seguinte, que regravava a coluna com
o valor antigo: o cartão virtual ficava sem nome e a notificação dele recriava a duplicata.
O final do plástico, o valor do envelope e o rendimento combinado também ficavam para trás.

### 2.3 Conta `external` entra em "Em caixa" mas não existe no quadro do mês — conferido

`summarizeAccounts` joga no caixa tudo que não é cartão nem reserva, inclusive `external`;
`monthOverview` ignora a conta externa por completo. Com a PJ marcada como externa, "Em
caixa" erra por um valor que cresce todo mês.

### 2.4 O que a conta `external` manda para a principal não é receita em lugar nenhum — conferido

O contrato escrito em `schema.ts` diz que é; o cálculo não implementa. Se o pró-labore chega
na principal como **transferência**, o mês mostra receita zero. É o caso de quem recebe pela
PJ — ou seja, o seu.

### 2.5 Conta arquivada: saldo visível e fora de todo total; histórico reescrito — relatado

A tela lista a arquivada com saldo cheio, logo abaixo de "Em caixa", que não a inclui. Pior:
`reportSeries` troca o papel da arquivada por `external` em **todos** os meses, inclusive os
fechados — arquivar um cartão antigo apaga as faturas dele do histórico, e arquivar uma
reserva zera a poupança dos meses passados.

---

## 3. Mês, orçamento e relatórios

### 3.1 Recorrente cobrada no cartão conta duas vezes — relatado

A recorrência lança sem conta (vira "gasto da principal") e a notificação do cartão lança a
mesma compra na fatura. Toda assinatura cadastrada como recorrente e paga no cartão infla o
mês e o "já comprometido".

### 3.2 Gasto em conta `reserve` desaparece; receita que cai lá vira "rendimento" — relatado

`monthOverview` ignora a despesa da conta de reserva e joga toda a receita dela em
"rendimento". Uma compra no débito do Mercado Pago não entra em "Gastos"; um Pix recebido
ali vira rendimento de investimento que não houve.

### 3.3 Duas contas de "sobrou" na mesma tela — relatado

Os indicadores de Relatórios vêm da soma crua do período e a grade de saúde vem do quadro do
mês (fatura que fecha, envelope pelo combinado). As duas se contradizem no mesmo scroll.

### 3.4 Custo do envelope pode ficar negativo — relatado

É `max(mensal, entrou) − saiu`, sem piso em zero: devolver a sobra do envelope para a
principal **reduz** o gasto do mês.

### 3.5 Mudar a natureza de uma categoria não recalcula o mês — relatado

`updateCategory` não manda recarregar, e os totais são calculados em SQL com join na
natureza. Marcar "Repasse sócio" como repasse não tem efeito até reabrir o app — exatamente
a ação que corrige a receita inflada do seu caso.

### 3.6 "Guardado neste mês" repetido em cada conta de reserva — relatado

Duas reservas, R$ 1.000 e R$ 300: as duas linhas mostram R$ 1.300.

### 3.7 "Definir saldo" compara o gasto do mês selecionado e lança o ajuste hoje — relatado

Olhar setembro e acertar o saldo com o número de outubro gera receita falsa no mês atual.

---

## 4. Cartão, fatura e parcelas

### 4.1 Faturas futuras paravam no 12º mês — corrigido

Parcelamento de 36x somava no limite usado, mas as parcelas depois do 12º mês não tinham
fatura nenhuma na tela.

### 4.2 O mês das parcelas vinha da data do lançamento — corrigido

"de ago a out" onde as faturas são "set a nov": a parcela é datada no começo do ciclo (o
fechamento anterior), e o rótulo usava o mês dessa data em vez do mês em que a fatura fecha.

### 4.3 Parcela antiga pode cair antes da âncora do cartão — conferido

`existingInstallmentDates` data a parcela atual no começo do ciclo aberto, que é o
fechamento anterior. Num cartão cadastrado hoje (âncora = ontem) essa parcela fica **antes**
da âncora e é descartada da fatura; informando "fatura atual" primeiro, ela passa a contar
**em cima** do valor informado. Precisa de uma decisão: datar no maior entre o começo do
ciclo e o dia seguinte à âncora, ou perguntar se o valor informado já inclui a parcela. No
cartão 1534 (âncora 15/09, fechamento dia 25) o caso não acontece hoje.

### 4.4 Estorno na fatura aberta reduz o "a pagar" da fatura fechada — relatado

Fatura fechada de R$ 1.000 com um estorno de R$ 200 na aberta passa a mostrar "a pagar
R$ 800", enquanto a aba da fatura mostra R$ 1.000. No Brasil o estorno credita a fatura
seguinte.

### 4.5 "Pagar fatura" pode vir pré-selecionada com a reserva do mesmo banco — relatado

A tela escolhe a primeira conta do banco que não é externa, incluindo poupança e
investimento; o util `findCheckingForCard` já sabe a resposta certa e não é usado ali.

### 4.6 A conversão "débito cadastrado como crédito" adivinha a conta, sozinha, sem volta — relatado

A migração escolhe a única conta corrente do banco, ou a principal, e move todo o histórico.
Com duas contas no mesmo banco o palpite pode jogar meses de gastos na conta errada — o
mesmo palpite que o resolvedor de notificações recusa explicitamente fazer.

---

## 5. Patrimônio, reserva e aposentadoria

### 5.1 O rendimento estimado do CDI nunca entra no "rendimento observado" — relatado

O acréscimo do CDI é derivado em memória e nada é lançado no livro, mas o "rendeu nos
últimos 12 meses" só soma rendimento **lançado**. A tela afirma "rendeu 0% ao ano" e o
insight sugere trocar de investimento — num CDB de 120% do CDI.

### 5.2 Rendimento lançado e rendimento estimado se somam — relatado

O estimador não olha a natureza dos lançamentos: uma receita de rendimento já está no saldo
e continua sendo estimada por cima. Infla reserva, capital, patrimônio e progresso da meta.

### 5.3 "Reserva primeiro" não vale para "quanto guardar por mês" — relatado

O aporte-alvo dos horizontes de 5/10/15/20 anos é resolvido como se o dinheiro fosse para a
meta desde o mês 1, enquanto o app diz (certo) que os primeiros meses vão para a reserva. O
número que dimensiona o aporte sai sistematicamente baixo.

### 5.4 O Patrimônio segue o mês escolhido em outra tela — relatado

Selecionar dezembro na Home muda a meta da reserva, "em quantos meses enche" e a data da
aposentadoria, porque as médias passam a terminar num mês futuro.

### 5.5 Dívida quitada no prazo continua pesando — relatado

Só a amortização confirmada arquiva. Quem pagou as 48 parcelas no prazo continua vendo
"Parcela R$ 1.234" e o chip verde "Amortize" numa dívida que não existe mais.

### 5.6 Aporte negativo: ETA, frase e gráfico usam três premissas diferentes — relatado

---

## 6. Sync, backup e extrato

### 6.1 Orçamento do mesmo mês vindo de dois lados trava o sync do aparelho — relatado

O servidor faz upsert do orçamento sem tratar o índice que exige um só orçamento vivo por
ano/mês. Dois ids diferentes para o mesmo mês (aparelho anônimo + conta, ou dois aparelhos
offline) derrubam o push inteiro com 500, e a fila reenvia a mesma remessa para sempre: nada
mais sai do aparelho, nem lançamento, nem conta.

### 6.2 A pergunta "puxar da conta / subir do aparelho / juntar" só existe na memória — relatado

Nada é gravado. Fechar o app (ou o Android matar o processo) no meio da escolha faz a
abertura seguinte **juntar** em silêncio. Quem queria descartar o aparelho fica com os dois
conjuntos somados.

### 6.3 Importar backup recria todo lançamento com id novo — relatado

Contas e transferências preservam o id; lançamentos, não. Importar o mesmo arquivo duas
vezes pode deixar duas gerações vivas na conta. A importação também perde de qual cartão
saiu cada compra, o dado que a 1.2.4 acabou de introduzir.

### 6.4 O cursor do pull não é reiniciado quando a sessão cai — relatado

Só o "sair" explícito limpa. Com o refresh recusado e login em outra conta, o cursor antigo
esconde tudo o que a conta nova gravou antes dele.

### 6.5 Extrato OFX: o saldo disponível sobrescreve o saldo contábil — relatado

Os dois usam os mesmos nomes de campo e o parser guarda o último: num banco que manda os
dois, o limite do cheque especial entra no saldo da conta, calado, e sobe para todos os
aparelhos.

### 6.6 `resetDatabase` não mexe em categorias nem capturas — relatado

A importação soma as categorias do arquivo com as que o aparelho já tinha, e as capturas
antigas ficam apontando para lançamentos que acabaram de ganhar lápide.

### 6.7 A versão do schema só é gravada depois dos 17 passos — relatado

Um crash no meio refaz tudo do zero na abertura seguinte; no passo mais antigo (dinheiro em
centavos) a repetição falha com "tabela já existe" e o app não abre mais.

---

## 7. Captura de notificação → lançamento

### 7.1 Chamariz no fim do aviso descartava a notificação inteira — corrigido

"toque para", "clique", "saiba mais" e "quando quiser" estavam na lista de sinais de
propaganda, e o aviso só era poupado se tivesse palavra de confirmação. Rodando o parser:
"Pix enviado: R$ 1.200,00 para JOAO SILVA. Toque para ver o comprovante." era **descartado
sem deixar rastro** — não virava item para revisar, não virava ignorado, não entrava no
histórico, e a fila nativa já tinha sido esvaziada. O gasto não existia para o app.

### 7.2 Aplicação e resgate não geram nada, e o saldo fica errado para sempre — relatado

"Aplicação de R$ 5.000,00 realizada" é gravada como ignorada, com a justificativa de que
investimento não é receita nem despesa. Mas o dinheiro saiu da conta corrente e entrou na
caixinha: sem transferência, a conta corrente fica R$ 5.000 acima do real indefinidamente.
O pagamento de fatura grava transferência justamente por isso — aqui faltou.

### 7.3 Um toque em "Transferência" cria regra permanente, invisível e irreversível — relatado

Tocar por engano em "Transferência" num item grava a regra na primeira vez (a categoria
exige três confirmações) e o "Desfazer" não a remove. Nenhuma tela mostra ou apaga regras
aprendidas: aquele estabelecimento desaparece das despesas para sempre.

### 7.4 Duplicata de carteira casa só por valor e direção, em 12 horas — relatado

Duas compras de R$ 20,00 no mesmo dia (uma pela carteira às 9h, outra no cartão às 18h)
viram uma só, sem pergunta. Não compara estabelecimento, final do cartão nem conta.

### 7.5 `recordTransfer` reaproveita qualquer transferência viva de mesmo valor em ±5 dias — relatado

Mesmo defeito do achado 1.2, visto do outro lado: um Pix de R$ 1.500 pode ser casado com o
pagamento da fatura de R$ 1.500 de dois dias antes. Pior, reverter o Pix apaga o pagamento
da fatura.

### 7.6 Compra "no crédito" vai para a conta corrente quando há 2 cartões do mesmo banco — conferido

Sem final exato e com dois cartões do banco, a função cai no caso "conta corrente" mesmo
quando o texto diz "crédito". R$ 480 saem do saldo e ficam fora das duas faturas. A
convenção do projeto manda devolver "não dá para responder" na ambiguidade; aqui ela chuta.

### 7.7 A tela de revisão não mostra em qual conta a captura caiu, nem as parcelas — relatado

O item mostra valor, estabelecimento, app e hora. A decisão mais arriscada do fluxo (qual
conta) e a que mais muda o caixa futuro (ser parcelada) são as duas invisíveis no único
momento de revisão: uma compra em 3x aparece como "− R$ 300,00" e ao confirmar vira três
parcelas de R$ 100 em três faturas.

---

## O que as revisões conferiram e consideraram correto

Vale registrar, porque é a cobertura: ciclo de fatura (fechamento 29/30/31, fevereiro, dia
1, virada de ano, compra no dia do fechamento, cartão sem fechamento), soma das parcelas
igual ao total, parcela na fatura certa, pagamento de fatura como transferência, quitação
parcial/a mais/antecipada, limite, repasse simétrico nos dois lados, recorrência no dia 31 e
em fevereiro, ids determinísticos que não duplicam entre aparelhos, categoria apagada ou
renomeada, orçamento por mês sem vazamento, `null` tratado como "não dá para responder" em
vez de zero, fuso horário e cortes de mês (nenhuma data civil saindo de `toISOString`),
âncora de saldo e lápides em todas as consultas, álgebra da cascata da reserva, patrimônio
líquido fechando com a quebra exibida, motores de Price/SAC/consórcio fechando em saldo
zero, CDI em base 252 com dias úteis, as nove coleções do sync completas item por item nas
duas direções com gatilho de `serverSeq` em todas, e o cursor de pull que não pula registro.

## Sem rede de proteção

Não há teste para `database.ts`, para os contextos, para `captureActions.ts` nem para o
backend. Os achados 1.1, 2.2 e 1.5 seriam pegos de primeira por um teste de `mergeAccounts`
e um de atribuição dos lançamentos sem conta; 7.2, 7.3 e 7.5 estão todos no caminho de
escrita das capturas, que é o que não tem teste nenhum.
