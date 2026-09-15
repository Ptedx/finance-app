# Captura automática pelas notificações do banco

O app lê as notificações que os apps de banco já enviam ("Compra de R$ 35,90 aprovada
em IFOOD…", "Você recebeu um Pix de…") e as transforma em lançamentos para confirmar
com um toque. O objetivo é tirar o trabalho manual de registrar gastos, que é o que
faz um app de finanças sair da rotina.

**Só Android.** iOS não permite ler notificações de outros apps. O texto nunca sai do
aparelho: o serviço nativo grava num arquivo interno, o app lê e interpreta localmente,
e só a transação confirmada segue para o sync como qualquer outra.

## Como funciona

```
Notificação do banco
  └─ CaptureListenerService (Kotlin)      filtra "tem símbolo de moeda + número"
       └─ spendr_captures.jsonl           fila em disco, uma linha por notificação
            └─ ingestRawCaptures (JS)      ao abrir o app, voltar ao 1º plano ou evento
                 ├─ fingerprint            a mesma notificação nunca entra duas vezes
                 ├─ parseCapture           valor, direção, tipo, contraparte, cartão
                 ├─ decide                 duplicata? transferência? regra? categoria?
                 └─ captures (SQLite)      caixa de entrada, com o texto bruto guardado
```

Arquivos:

- `modules/spendr-captures/` — módulo Expo local: serviço, fila e ponte JS.
- `app/utils/captureParser.ts` — interpretação do texto (puro, testado).
- `app/utils/captureMatcher.ts` — decisões: duplicata, transferência, regras (puro, testado).
- `app/utils/captureActions.ts` — funil de entrada e respostas do usuário.
- `app/database/captures.ts` — tabelas `captures` e `merchant_rules` (locais, não sincronizam).
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
| Carteira e banco, mesmo valor, ambos saída, até 12 h de diferença | **Duplicata certa.** Fica a do banco (tem estabelecimento e cartão). Se o usuário já tinha confirmado a da carteira, a do banco é que vira duplicata — nunca uma segunda transação. |
| Dois bancos (ou o mesmo), mesmo valor e direção, até 3 min de diferença | **Pergunta:** "Parece o mesmo lançamento. Mesmo, ficar com um / Diferentes, ficar com os dois." Pode ser cobrança em dobro, pode ser dois cafés. |
| A mesma notificação reentregue pelo Android | Ignorada pela impressão digital (app + título + texto + minuto). |

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
uma a uma) e vão direto para o histórico como "ignorado", com o motivo.

## O que a tela faz

- **Um toque para confirmar**, com a categoria sugerida já preenchida; a categoria é
  trocável no próprio cartão. Botões de 48 pt, rótulo e dica para leitor de tela, valor
  anunciado por extenso, resultado anunciado após cada ação.
- **Desfazer** por 8 segundos depois de qualquer ação, e **reverter** a qualquer momento
  pelo histórico (apaga a transação criada e devolve o item à fila).
- **Aprender por estabelecimento:** confirmar "IFOOD" como Alimentação três vezes
  seguidas faz as próximas entrarem sozinhas, listadas em "Adicionadas automaticamente"
  com desfazer. Mudar a categoria no meio zera a contagem.
- **Sem pressão:** nada de notificação insistente. O selo na aba inicial e a faixa "N
  lançamentos para revisar" somem quando a fila esvazia. Itens pendentes nunca expiram;
  o histórico é apagado depois de 90 dias.
- **Texto bruto sempre à mão** em "Notificação original", para conferir o que o parser leu.

## Ligar

Configurações → Captura automática → "Ler notificações do banco" abre a tela do
Android de acesso a notificações; o app não consegue ligar sozinho. O estado (Ativo /
Desativo) é relido toda vez que o app volta ao primeiro plano.

## Limites conhecidos

- Bancos mudam o texto das notificações. O parser é por palavras-chave, não por banco,
  e o texto bruto fica guardado — uma notificação mal lida vira um item para corrigir,
  não um dado perdido. Casos novos entram em `captureParser.test.ts`.
- Se o banco não notifica (app do banco com notificações desligadas, compra no débito
  sem aviso), nada é capturado. O import de extrato OFX/CSV é a rede de segurança
  planejada para isso.
- Regras aprendidas e a caixa de entrada são deste aparelho; não sincronizam.
