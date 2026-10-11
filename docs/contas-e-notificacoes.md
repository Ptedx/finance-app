# De quem é esta compra: contas, bancos e notificações

O app cria conta sozinho. É o que faz ele funcionar no primeiro dia sem cadastro nenhum, e
é também de onde vinham duas confusões: conta duplicada do mesmo banco e conta com o nome
de um app que não é banco. Este documento é a regra que vale hoje.

## O aviso é de um banco?

Antes de qualquer coisa, o app decide se o aviso veio de um banco (`bankLabelOf`):

1. **O nome do app é de um banco conhecido** ("Inter", "Nu", "Mercado Pago" — a lista está
   em `app/utils/bankBrands.ts`). É banco.
2. **Senão, vale o banco que o texto citar.** É o caso do SMS, do e-mail e do mensageiro
   que repassam o aviso do banco, e do aviso da carteira (Samsung Pay, Google Wallet).
3. **Nenhum dos dois: o aviso não vira conta.** A captura fica **sem conta**, aparece em
   "Sem conta" e o usuário diz de onde saiu.

O passo 3 existe porque meio mundo fala de dinheiro numa notificação: o app de corrida
avisa o valor da viagem, o e-mail mostra a fatura, o mensageiro mostra o SMS do banco.
Até a 1.2.5, cada um desses virava uma conta com o nome do app.

## Para qual conta vai

Com o banco na mão, `pickNotificationTarget` decide, nesta ordem:

1. **Final de débito nomeado numa conta corrente** ("Débito Inter", final 0443): a compra é
   daquela conta. Quem declarou decide, e vence até o cartão de crédito do mesmo banco.
2. **Cartão de crédito com aquele final**, pelo plástico ou por um virtual já nomeado.
3. **O único cartão de crédito ativo daquele banco** — é o caso dos virtuais do Nubank, que
   caem todos na mesma fatura.
4. Sem cartão do banco e com o aviso dizendo "crédito": **nasce um cartão**.
5. **A conta corrente daquele app.**

Aviso de terceiro (carteira, SMS, e-mail) nunca cria cartão nem conta: ele só encontra o
que já existe. E o pacote do mensageiro nunca é gravado como origem de uma conta — senão o
WhatsApp "viraria" o banco para sempre.

## Uma conta do banco, uma ficha no app

Três coisas ligam uma ficha do app à conta de verdade:

- `packageName`: o app do banco que avisa as compras;
- `accountKey`: a conta no extrato OFX (`banco:conta`);
- `cardNames`: o nome de cada final (cartões virtuais e cartões de débito).

A primeira notificação de um banco **adota** a conta que já existe sem app — a cadastrada à
mão ou a que veio do extrato — em vez de criar uma segunda. Com duas fichas do mesmo banco
nada é adivinhado: pôr dinheiro na conta errada é pior do que criar uma ficha nova.

Quando a duplicata já existe, duas telas resolvem:

- **Contas** avisa "duas contas do mesmo banco" e pergunta qual fica (`duplicateAccountPairs`).
  Juntar leva lançamentos, capturas, transferências, nomes de cartão e o vínculo com o app
  para a que ficar. Os saldos **não** se somam: cada ficha tinha a sua âncora, e somá-las
  contaria o mesmo dinheiro duas vezes — "Definir saldo" acerta o resto.
- **A tela da conta** mostra em qual conta entram as compras daquele app e deixa trazê-las
  para esta (`feedOwnerOf`, "Compras do app do banco"). É para quem tem duas contas de
  verdade no mesmo banco — a de todo dia e a do envelope, a PF e a PJ — e o app escolheu a
  outra.

## O que a 1.2.6 limpou

A migração v18 apaga as contas que nasceram de um app que não é banco, e **só as vazias**:
nome igual ao do banco, âncora zerada, sem chave de extrato, marca desconhecida e sem
nenhum lançamento, transferência ou captura apontando para ela. Qualquer dinheiro de
verdade segura a conta — pode ser um banco que a lista de marcas não conhece.
