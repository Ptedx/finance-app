# Contas, cartões e parcelas

A partir do schema v7 o app sabe **de onde** o dinheiro saiu ou entrou. Cada conta ou
cartão tem saldo próprio, a tela inicial mostra "em caixa", "cartões a pagar" e o
líquido, e compras parceladas viram uma parcela por mês, como na fatura.

## Modelo

- **`accounts`** (sincronizada): nome, tipo (`checking`, `savings`, `investment`, `cash`,
  `credit_card`), banco, final do cartão, dia de fechamento e vencimento, limite, e a
  ligação com a origem: `packageName` (app do banco) e `accountKey` (conta do OFX).
- **`transfers`** (sincronizada): dinheiro trocando de bolso entre duas contas suas, ou
  entre uma conta sua e uma que o app não acompanha (lado nulo). Nunca é receita nem
  despesa, por isso vive fora de `transactions`: relatórios, exportação CSV e listas
  não mudam. Pagar a fatura do cartão é uma transferência da conta para o cartão.
- **`transactions`** ganha `accountId` e as colunas de parcela (`installmentGroup`,
  `installmentIndex`, `installmentCount`). Tudo anulável: lançamentos antigos ficam
  "sem conta" e continuam nos totais.

### O saldo é calculado, nunca guardado

`saldo(conta, dia) = âncora + Σ receitas − Σ despesas − Σ transferências que saíram +
Σ transferências que entraram`, contando só o que é datado **depois** da âncora
(`openingBalanceDate`, com valor `openingBalanceCents`). Ajustar o saldo é mover a
âncora, não reescrever lançamentos:

- **"Definir saldo"** na tela da conta: o app põe a âncora em ontem, com o valor que
  faz o saldo de hoje bater com o digitado depois de somar o que já aconteceu hoje.
  Lançamentos que entrarem mais tarde hoje continuam somando por cima.
- **Import de OFX** de conta corrente: o `LEDGERBAL` do arquivo vira a âncora quando é
  mais novo que a atual. É o saldo que o próprio banco imprimiu.

Num cartão o saldo é negativo quando há fatura a pagar; a mesma fórmula serve e a tela
mostra `-saldo` como "a pagar". "Fatura aberta" é o que entrou desde o último
fechamento (`cardCycleOn` em `accountMath.ts`).

### Contas nascem sozinhas

`accountResolver.ts`: a primeira notificação de cada app cria a conta corrente; a
primeira compra no crédito com "final 1234" cria o cartão; o primeiro import de OFX
cria ou **adota** a conta daquele banco (uma conta do Nubank vinda das notificações
ganha a chave do extrato em vez de nascer uma segunda). O usuário só dá nome, informa o
saldo e, nos cartões, o dia de fechamento.

### Transferências e pagamento de fatura

- Duas notificações pareadas como transferência viram **uma** transferência entre as
  duas contas. Uma perna só (nome próprio, sem par) vira transferência com o outro lado
  nulo; quando a outra perna chega, completa a mesma em vez de criar outra.
- "Pagamento da fatura" na conta vira transferência conta → cartão, quando há um único
  cartão do mesmo banco. "Pagamento recebido" no extrato do cartão procura essa mesma
  transferência (valor igual, até 5 dias) e a reaproveita. Com mais de um cartão o lado
  fica nulo e as duas vistas ainda se reconhecem pelo valor e pela data.

### Parcelas

`installments.ts`. A notificação "R$ 300,00 em 3x" (ou "3x de R$ 100,00") registra a
compra inteira; ao confirmar, viram 3 lançamentos de R$ 100,00, um por mês a partir da
compra, com "(k/3)" na descrição e o mesmo `installmentGroup`. O resto da divisão vai
para a primeira parcela, como os bancos fazem. No extrato do cartão, a linha "LOJA 2/3"
casa só com a parcela 2 de 3, com janela de 45 dias (a fatura lança no fechamento, não
no dia da parcela). Reverter a captura apaga todas as parcelas.

## Tela inicial

"Contas e cartões", logo abaixo do resumo do mês: três números (em caixa, cartões a
pagar, líquido) e uma linha por conta, cartões por último. Cartão com dia de fechamento
mostra "Fatura aberta R$ X · Fecha em N dias" e a barra do limite. Lista vertical, não
carrossel: um carrossel esconde contas e é ruim para o leitor de tela. Cada linha é um
botão de 56 pontos com rótulo completo ("Nubank final 6422, a pagar R$ 200,00, fatura
aberta R$ 80,00"); vermelho nunca é a única pista.

Gerenciar: Ajustes → "Contas e cartões", ou "Gerenciar" no painel. A tela da conta tem
"definir saldo" no topo, o formulário, arquivar, excluir e os lançamentos recentes.

## Roteiro: deixar o app 100% alinhado com o banco

1. **Backup.** Ajustes → Dados → Exportar. Leva segundos e guarda contas, transferências
   e parcelas.
2. **Ligue a captura** (Ajustes → Captura automática) e use os apps dos bancos por um
   dia: as contas correntes e os cartões aparecem sozinhos em "Contas e cartões".
3. **Importe o OFX de cada conta corrente** (Nubank pessoal, Nubank PJ, Inter,
   Mercado Pago) do mês corrente. Cada import cria ou adota a conta, traz o histórico do
   mês para revisão e **ancora o saldo no valor do extrato**. Depois disso o saldo já
   está certo sem digitar nada.
4. **Poupança do Mercado Pago** e qualquer conta sem extrato: abra "Contas e cartões",
   "Adicionar conta", tipo Investimento ou Poupança, e use "Definir saldo" com o valor
   que o app do banco mostra agora.
5. **Cartões**: abra cada um, informe dia de fechamento, vencimento e limite. Em
   "Valor a pagar agora" digite o total em aberto que o app do banco mostra (fatura
   fechada + aberta) e toque em "Definir saldo". A partir daí cada compra nova entra pela
   notificação e o pagamento da fatura entra pela conta.
6. **Compras parceladas já em andamento** (feitas antes do app): as parcelas que
   ainda vão cair não geram notificação. Dois caminhos: importar o OFX do cartão todo
   mês, e cada parcela nova aparece para revisar como "LOJA 3/6"; ou digitar as
   parcelas restantes uma vez, com a data de cada mês e o cartão como conta. As compras
   novas chegam pela notificação já divididas.
7. **Revise a caixa de entrada** uma vez por dia nas primeiras semanas. Confirmar,
   descartar e "transferência entre minhas contas" ensinam o app; depois de 3
   confirmações iguais, o estabelecimento entra sozinho.
8. **Todo mês**: importe o OFX de cada conta corrente. Nada duplica, e o saldo é
   reancorado no valor do banco. Se o "em caixa" do app e o saldo do banco divergirem,
   é porque algo ficou pendente na caixa de entrada ou um lançamento manual não tem
   conta — a tela da conta lista os lançamentos dela para conferir.

## Limites conhecidos

- Conta pessoal e PJ do mesmo banco chegam das notificações com o mesmo `packageName`.
  As notificações caem na primeira conta criada para aquele app; o extrato OFX de cada
  uma tem chave própria e corrige a conta dos lançamentos que casar. Para a PJ, importe
  o OFX dela ao menos uma vez por mês.
- O `LEDGERBAL` de extrato de **cartão** é ignorado: o sinal varia entre bancos. Use
  "Definir saldo" no cartão.
- Saldos de contas não sincronizadas (sem conta Spendr) ficam no aparelho; com conta,
  `accounts` e `transfers` sincronizam como tudo o mais.
