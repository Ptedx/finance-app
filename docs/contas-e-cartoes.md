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

## Papéis: como cada conta entra no mês

Toda conta tem um `role`, escolhido na tela da conta (padrão pelo tipo: cartão é
`card`, poupança e investimento são `reserve`, o resto é `main`). O papel é o que faz
as informações não se atravessarem:

| Papel | Exemplo | No quadro do mês |
|---|---|---|
| `main` (Principal) | Nubank PF | Receitas caem aqui. Pix e débito saindo são gastos. |
| `card` (Cartão) | Cartão Nubank | Compras contam no mês da compra, parcela a parcela. Pagar a fatura é transferência. |
| `envelope` (Envelope) | Inter PF, R$ 1.000/mês | O que entra no envelope é o gasto do mês. O que acontece lá dentro é detalhe ("gastou 700 de 1.000") e a sobra fica na conta como recompensa. |
| `reserve` (Reserva) | Mercado Pago | O que entra é poupança, não gasto. Rendimento é receita de investimento. |
| `external` (Externa) | Nubank PJ | Não acompanhada. O que ela manda para a principal é receita. |

O quadro (`monthOverview.ts`, puro e testado) fica no card "Este mês" da tela inicial:

```
Receitas                       12.000
Gastos                         10.200
  Cartão Nubank                 6.800   (7.400 comprados neste mês)
  Pix e débito                  2.400
  Inter PF                      1.000   gastou 700 de 1.000
Guardado                        1.500   mais 30 de rendimento
Sobrou                          1.800   15% da sua receita ficou com você
```

Duas métricas no cartão: **o que cai na fatura do mês** (à vista + parcelas do mês, a
principal, é o que se paga) e **o que foi comprado no mês** (valor cheio, para ver o
compromisso assumido). O orçamento compara com o gasto total, não só com o cartão.

### A conta PJ

Vive no mesmo app da PF, então as notificações chegam iguais. Quando o usuário
confirma um recebimento da empresa como receita (categoria de receita), o app aprende
que aquela contraparte é fonte externa: os próximos recebimentos nunca viram
transferência, mesmo com a saída "você enviou para VINICIUS" (avisada pela PJ) na
caixa de entrada; e essa saída, se já tinha virado transferência para fora, é
neutralizada (`external_leg`). Não é preciso importar OFX da PJ.

### Lançamentos sem conta

Os que entraram antes de existirem contas aparecem em "Sem conta" no painel; um toque
abre a tela que move todos para uma conta de uma vez.

## Cartões: um módulo à parte

Cartão não tem saldo. Tem **limite**, **fatura aberta**, **fatura fechada** e **parcelas
futuras**. Desde o schema v9 cartão é sempre `kind = credit_card` e `role = card`
(`normalizeAccountDraft` garante em toda gravação), e as telas de conta não aceitam
cartão: cadastro, edição e detalhe vivem em `/cards`.

A migração v9 corrige cartões salvos como conta com papel "cartão": vira cartão de
crédito, e o valor positivo que tinha sido digitado como "saldo" passa a ser valor a
pagar (sinal invertido só nesses casos).

### Ciclo e faturas (`cardMath.ts`, puro e testado)

- O usuário informa só o **vencimento** (dia 25, no Nubank) e quantos dias antes a
  fatura fecha (7, o padrão). Vencimento em sábado, domingo ou feriado bancário nacional
  (`businessDays.ts`: fixos, Carnaval, Sexta-feira Santa, Corpus Christi, 20/11) passa
  para o próximo dia útil, e o fechamento acompanha: sempre N dias antes do vencimento real.
- A fatura fecha no começo do dia do fechamento: compras desse dia em diante vão para a
  próxima, e ele é o **melhor dia de compra**.
- A fatura leva o **nome do mês em que vence**. Vence 25/09 e fecha 18/09: é a de setembro,
  com compras de 18/08 a 17/09. A de outubro só começa em 18/09. Ciclos são contíguos
  (teste por propriedades, inclusive nos meses em que o vencimento anda).
- No quadro do mês, o cartão entra pela **fatura que vence no mês** (`invoicesDueBetween`),
  com parcelas e com a "fatura atual" informada; as compras feitas no mês são a métrica
  secundária. Cartão sem vencimento cai no cálculo antigo (compras datadas no mês).
- Cartão de débito não é cartão aqui: não tem fatura nem limite. Na edição do cartão, o
  tipo "Débito" leva os lançamentos para a conta de onde o dinheiro sai e remove o cartão.
- Datas e dinheiro seguem o **idioma do app** (`locale.ts`): em português, sempre
  "16/09" e "R$ 3.832,80", mesmo com região do aparelho em inglês ou `Intl` reduzido.
- **Devido** = âncora + compras − estornos − pagamentos até hoje. **Fatura aberta** =
  lançamentos do ciclo aberto, inclusive parcelas já programadas nele. **A pagar agora**
  = devido − o que já caiu na fatura aberta: é o que falta das faturas fechadas, com
  status em dia, vence em até 3 dias, ou vencida.
- **Limite usado** = devido + parcelas futuras (é o que o banco desconta).
- "Acertar valor" põe a âncora em ontem com o que o app do banco mostra (fatura atual
  + fechada não paga). A âncora entra como um lançamento único no ciclo em que cai, então
  devido, fatura aberta e a pagar sempre fecham entre si.
- Pagar fatura é transferência da conta para o cartão; não é gasto.
- "Parcela antiga" cria as parcelas restantes de compras feitas antes do app: a atual no
  começo do ciclo aberto e uma por fatura depois dela.

### Visual

`CardFace` pinta o cartão com a cor do banco (`bankBrands.ts`); o texto é preto ou
branco pelo contraste WCAG, testado ≥ 4,5:1 para todas as marcas. O selo de fatura
fechada/vencida tem fundo escuro e ícone próprios. A face inteira é um elemento com
rótulo completo na ordem de leitura.

## Tela inicial

Ordem pela pergunta de quem abre o app:

1. **Para revisar** — faixa da caixa de entrada, só quando há algo.
2. **Este mês** — receita, gastos por bolso, guardado, sobrou, com seletor de mês.
3. **Cartões** — "a pagar agora", "faturas abertas" e "limite disponível" no topo, e os
   cartões como na carteira num carrossel com a borda do próximo aparecendo. "Ver todos"
   abre os mesmos cartões em lista vertical, para quem não desliza bem.
4. **Contas** — "em caixa" e "depois das faturas", e uma linha por conta.
5. **Recorrências**, no fim.

O histórico de lançamentos saiu da tela inicial (fica na aba Lançamentos). A taxa de
poupança e o fôlego foram para Relatórios.

Acessibilidade: cada seção abre com título marcado como cabeçalho; cada cartão é um
botão com "cartão 2 de 3" no rótulo; os pontos do carrossel ficam fora do leitor de
tela; alvos de pelo menos 44–48 pontos; nada tem altura fixa, e o texto cresce com a
fonte do sistema.

## Roteiro: deixar o app 100% alinhado com o banco

1. **Backup.** Ajustes → Dados → Exportar.
2. **Ligue a captura** (Ajustes → Captura automática). Contas correntes e cartões
   aparecem sozinhos conforme as notificações chegam.
3. **Contas**: importe o OFX de cada conta corrente (âncora no saldo do extrato) ou use
   "Definir saldo" na tela da conta. Marque o papel de cada uma.
4. **Cartões**: em Cartões, abra ou adicione cada um e informe banco, final, limite,
   vencimento (fecha 7 dias antes). Depois toque em **Acertar valor** e digite a fatura atual e,
   se houver, a fechada ainda não paga, como aparecem no app do banco.
5. **Parcelas de compras antigas**: no cartão, **Parcela antiga**, uma por compra
   (valor da parcela, parcela desta fatura e total). O limite usado e as faturas futuras
   passam a bater com o banco.
6. **Pagou a fatura**: se a notificação do pagamento chegar, vira transferência sozinha;
   senão, **Pagar fatura** no cartão.
7. **Revise a caixa de entrada** nas primeiras semanas.
8. **Todo mês**: confira "a pagar agora" e o limite disponível com o app do banco; se
   divergirem, **Acertar valor** resolve sem apagar nada.

## Limites conhecidos

- Conta pessoal e PJ do mesmo banco chegam das notificações com o mesmo `packageName`.
  As notificações caem na primeira conta criada para aquele app; o extrato OFX de cada
  uma tem chave própria e corrige a conta dos lançamentos que casar. Para a PJ, importe
  o OFX dela ao menos uma vez por mês.
- O `LEDGERBAL` de extrato de **cartão** é ignorado: o sinal varia entre bancos. Use
  "Definir saldo" no cartão.
- Saldos de contas não sincronizadas (sem conta Spendr) ficam no aparelho; com conta,
  `accounts` e `transfers` sincronizam como tudo o mais.
