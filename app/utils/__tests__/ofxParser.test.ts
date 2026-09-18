import {
	classifyStatementText,
	decodeOfxBytes,
	extractStatementCounterparty,
	parseOfx,
	parseOfxAmount,
	parseOfxDate,
} from '../ofxParser';

const NUBANK_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:UTF-8
CHARSET:NONE
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260914000000[-3:BRT]
<LANGUAGE>POR
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>BRL
<BANKACCTFROM>
<BANKID>0260
<ACCTID>12345678-9
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901000000[-3:BRT]
<DTEND>20260914000000[-3:BRT]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260902000000[-3:BRT]
<TRNAMT>-35.90
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000001
<MEMO>Compra no débito - IFOOD *IFOOD
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260903000000[-3:BRT]
<TRNAMT>-500.00
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000002
<MEMO>Transferência enviada pelo Pix - VINICIUS COSTA - •••.123.456-•• - BANCO INTER (0077) Agência: 1 Conta: 123-4
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260905000000[-3:BRT]
<TRNAMT>150.00
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000003
<MEMO>Transferência recebida pelo Pix - MARIA APARECIDA SOUZA - •••.987.654-•• - NU PAGAMENTOS
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260910000000[-3:BRT]
<TRNAMT>-2345.67
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000004
<MEMO>Pagamento de fatura
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260911000000[-3:BRT]
<TRNAMT>-1000.00
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000005
<MEMO>Aplicação RDB
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260912000000[-3:BRT]
<TRNAMT>3.21
<FITID>68b5c1a2-1111-4c2a-9c1e-000000000006
<MEMO>Rendimento RDB
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>1234.56
<DTASOF>20260914000000[-3:BRT]
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const ITAU_LATIN1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260914<LANGUAGE>POR<FI><ORG>ITAU<FID>341</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>341<ACCTID>1234 56789-0<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901<DTEND>20260914
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260904<TRNAMT>-89,90<FITID>202609040001<CHECKNUM>000001<MEMO>PIX TRANSF JOÃO 04/09</STMTTRN>
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260906<TRNAMT>-1234,50<FITID>202609060002<MEMO>PAGAMENTO FATURA CARTAO</STMTTRN>
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260907<TRNAMT>5000,00<FITID>202609070003<MEMO>TED RECEBIDA EMPRESA XYZ</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>10,00<DTASOF>20260914</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const CARD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20260914120000</DTSERVER><LANGUAGE>POR</LANGUAGE></SONRS></SIGNONMSGSRSV1>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <TRNUID>1</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <CCSTMTRS>
        <CURDEF>BRL</CURDEF>
        <CCACCTFROM><ACCTID>5555****1234</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260815120000[-03:BRT]</DTPOSTED>
            <TRNAMT>-35.90</TRNAMT>
            <FITID>card-0001</FITID>
            <NAME>IFOOD *IFOOD</NAME>
            <MEMO>Compra &amp; entrega</MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260820120000[-03:BRT]</DTPOSTED>
            <TRNAMT>2345.67</TRNAMT>
            <FITID>card-0002</FITID>
            <NAME>Pagamento recebido</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260821120000[-03:BRT]</DTPOSTED>
            <TRNAMT>35.90</TRNAMT>
            <FITID>card-0003</FITID>
            <NAME>Estorno IFOOD</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260822120000[-03:BRT]</DTPOSTED>
            <TRNAMT>-0.00</TRNAMT>
            <FITID>card-0004</FITID>
            <NAME>Ajuste</NAME>
          </STMTTRN>
        </BANKTRANLIST>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`;

describe('parseOfxAmount', () => {
	it.each([
		['-35.90', -3590],
		['-35,90', -3590],
		['150.00', 15000],
		['+100', 10000],
		['1234.5', 123450],
		['0.99', 99],
		['-2345.67', -234567],
	])('%s → %d', (raw, cents) => {
		expect(parseOfxAmount(raw)).toBe(cents);
	});

	it('recusa separador de milhar e lixo', () => {
		expect(parseOfxAmount('1.234,56')).toBeNull();
		expect(parseOfxAmount('abc')).toBeNull();
		expect(parseOfxAmount('')).toBeNull();
	});
});

describe('parseOfxDate', () => {
	it('lê só o dia, ignorando hora e fuso', () => {
		expect(parseOfxDate('20260914235959[-3:BRT]')).toBe('2026-09-14');
		expect(parseOfxDate('20260914')).toBe('2026-09-14');
		expect(parseOfxDate('20260914120000.000[-03:BRT]')).toBe('2026-09-14');
	});

	it('recusa datas impossíveis', () => {
		expect(parseOfxDate('2026091')).toBeNull();
		expect(parseOfxDate('20261314')).toBeNull();
		expect(parseOfxDate('')).toBeNull();
	});
});

describe('parseOfx — Nubank (SGML, UTF-8)', () => {
	const statement = parseOfx(NUBANK_SGML);
	const account = statement.accounts[0];

	it('identifica a conta e o banco', () => {
		expect(statement.accounts).toHaveLength(1);
		expect(account.accountKey).toBe('0260:12345678-9');
		expect(account.bankName).toBe('Nubank');
		expect(account.isCard).toBe(false);
		expect(account.currency).toBe('BRL');
	});

	it('lê o saldo do extrato e o dia a que ele se refere', () => {
		expect(account.ledgerBalanceCents).toBe(123456);
		expect(account.ledgerDate).toBe('2026-09-14');
	});

	it('lê todas as linhas com FITID, data e valor', () => {
		expect(account.entries).toHaveLength(6);
		expect(account.skipped).toBe(0);
		expect(account.entries.map((e) => e.fitid)).toEqual([
			'68b5c1a2-1111-4c2a-9c1e-000000000001',
			'68b5c1a2-1111-4c2a-9c1e-000000000002',
			'68b5c1a2-1111-4c2a-9c1e-000000000003',
			'68b5c1a2-1111-4c2a-9c1e-000000000004',
			'68b5c1a2-1111-4c2a-9c1e-000000000005',
			'68b5c1a2-1111-4c2a-9c1e-000000000006',
		]);
	});

	it('compra no débito: saída, compra, estabelecimento e categoria', () => {
		const purchase = account.entries[0];
		expect(purchase.postedDate).toBe('2026-09-02');
		expect(purchase.amountCents).toBe(3590);
		expect(purchase.direction).toBe('out');
		expect(purchase.kind).toBe('purchase');
		expect(purchase.counterparty).toBe('IFOOD *IFOOD');
		expect(purchase.merchantKey).toBe('ifood');
		expect(purchase.suggestedCategory).toBe('food');
	});

	it('Pix enviado: contraparte sem o CPF mascarado nem o banco', () => {
		const pix = account.entries[1];
		expect(pix.kind).toBe('pix_out');
		expect(pix.amountCents).toBe(50000);
		expect(pix.counterparty).toBe('VINICIUS COSTA');
	});

	it('Pix recebido: entrada com quem mandou', () => {
		const pix = account.entries[2];
		expect(pix.kind).toBe('pix_in');
		expect(pix.direction).toBe('in');
		expect(pix.counterparty).toBe('MARIA APARECIDA SOUZA');
		expect(pix.suggestedCategory).toBe('other_income');
	});

	it('pagamento de fatura e aplicação são neutros; rendimento é entrada', () => {
		expect(account.entries[3]).toMatchObject({ kind: 'invoice_payment', neutral: true });
		expect(account.entries[4]).toMatchObject({ kind: 'investment', neutral: true });
		expect(account.entries[5]).toMatchObject({ kind: 'unknown', neutral: false, direction: 'in' });
	});
});

describe('parseOfx — Itaú (SGML compacto, vírgula decimal, Latin-1)', () => {
	const statement = parseOfx(ITAU_LATIN1);
	const account = statement.accounts[0];

	it('nome do banco pelo código, mesmo com ORG presente', () => {
		expect(account.bankName).toBe('Itaú');
		expect(account.accountKey).toBe('341:1234 56789-0');
	});

	it('lê valores com vírgula e tags na mesma linha', () => {
		expect(account.entries.map((e) => e.amountCents)).toEqual([8990, 123450, 500000]);
		expect(account.entries.map((e) => e.direction)).toEqual(['out', 'out', 'in']);
	});

	it('classifica Pix, fatura e TED', () => {
		expect(account.entries[0].kind).toBe('pix_out');
		expect(account.entries[0].counterparty).toBe('JOÃO');
		expect(account.entries[1]).toMatchObject({ kind: 'invoice_payment', neutral: true });
		expect(account.entries[2].kind).toBe('transfer_in');
	});
});

describe('parseOfx — cartão de crédito (XML 2.x)', () => {
	const statement = parseOfx(CARD_XML);
	const account = statement.accounts[0];

	it('reconhece o cartão e desescapa entidades XML', () => {
		expect(account.isCard).toBe(true);
		expect(account.accountKey).toBe('card:5555****1234');
		expect(account.entries[0].memo).toBe('Compra & entrega');
	});

	it('"Pagamento recebido" no cartão é neutro: é a fatura paga pela conta', () => {
		expect(account.entries[1]).toMatchObject({ kind: 'invoice_payment', neutral: true, direction: 'in' });
	});

	it('estorno é entrada, não neutro', () => {
		expect(account.entries[2]).toMatchObject({ kind: 'refund', neutral: false });
	});

	it('valor zero é descartado', () => {
		expect(account.entries).toHaveLength(3);
		expect(account.skipped).toBe(1);
	});
});

describe('parseOfx — robustez', () => {
	it('FITID repetido dentro do mesmo arquivo entra uma vez só', () => {
		const duplicated = NUBANK_SGML.replace(
			'68b5c1a2-1111-4c2a-9c1e-000000000002',
			'68b5c1a2-1111-4c2a-9c1e-000000000001'
		);
		const account = parseOfx(duplicated).accounts[0];
		expect(account.entries).toHaveLength(5);
		expect(account.skipped).toBe(1);
	});

	it('linha sem FITID ou sem data é descartada, as outras seguem', () => {
		const broken = NUBANK_SGML.replace('<FITID>68b5c1a2-1111-4c2a-9c1e-000000000003\n', '').replace(
			'<DTPOSTED>20260911000000[-3:BRT]\n',
			''
		);
		const account = parseOfx(broken).accounts[0];
		expect(account.entries).toHaveLength(4);
		expect(account.skipped).toBe(2);
	});

	it('arquivo sem extrato devolve zero contas em vez de quebrar', () => {
		expect(parseOfx('').accounts).toEqual([]);
		expect(parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>').accounts).toEqual([]);
	});

	it('dois extratos no mesmo arquivo viram duas contas', () => {
		const two = `${NUBANK_SGML.replace('</OFX>', '')}${ITAU_LATIN1.slice(ITAU_LATIN1.indexOf('<BANKMSGSRSV1>'))}`;
		const statement = parseOfx(two);
		expect(statement.accounts.map((a) => a.accountKey)).toEqual(['0260:12345678-9', '341:1234 56789-0']);
	});
});

describe('decodeOfxBytes', () => {
	const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
	const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

	it('UTF-8 declarado lê acentos como UTF-8', () => {
		expect(decodeOfxBytes(utf8('ENCODING:UTF-8\n<OFX><MEMO>Transferência João'))).toContain('Transferência João');
	});

	it('CHARSET:1252 lê acentos como Latin-1', () => {
		const bytes = latin1('CHARSET:1252\n<OFX><MEMO>Transferência João');
		expect(decodeOfxBytes(bytes)).toContain('Transferência João');
	});

	it('sem declaração, UTF-8 válido é UTF-8 e inválido é Latin-1', () => {
		expect(decodeOfxBytes(utf8('<OFX><MEMO>Ação'))).toContain('Ação');
		expect(decodeOfxBytes(latin1('<OFX><MEMO>Ação'))).toContain('Ação');
	});

	it('o XML com encoding="UTF-8" também é reconhecido', () => {
		expect(decodeOfxBytes(utf8('<?xml version="1.0" encoding="UTF-8"?><OFX><NAME>Café'))).toContain('Café');
	});
});

describe('classifyStatementText', () => {
	it('fatura e investimento são neutros só nas formas certas', () => {
		expect(classifyStatementText('PGTO FATURA CARTAO', 'out', false).neutral).toBe(true);
		expect(classifyStatementText('Pagamento recebido', 'in', true).neutral).toBe(true);
		expect(classifyStatementText('Pagamento recebido', 'in', false).neutral).toBe(false);
		expect(classifyStatementText('Resgate RDB', 'in', false)).toEqual({ kind: 'investment', neutral: true });
		expect(classifyStatementText('Rendimento RDB', 'in', false)).toEqual({ kind: 'unknown', neutral: false });
	});

	it('sem palavra-chave, saída é compra e entrada é entrada genérica', () => {
		expect(classifyStatementText('MERCADO XYZ', 'out', false).kind).toBe('purchase');
		expect(classifyStatementText('CREDITO SALARIO', 'in', false).kind).toBe('unknown');
	});
});

describe('extractStatementCounterparty', () => {
	it('pega o segundo segmento quando o primeiro é rótulo de operação', () => {
		expect(extractStatementCounterparty('', 'Compra no débito - PADARIA CENTRAL')).toBe('PADARIA CENTRAL');
		expect(
			extractStatementCounterparty('', 'Transferência recebida pelo Pix - JOAO SILVA - •••.111.222-•• - BANCO')
		).toBe('JOAO SILVA');
	});

	it('remove prefixos de operação e datas em texto corrido', () => {
		expect(extractStatementCounterparty('PIX TRANSF MARIA 14/09', '')).toBe('MARIA');
		expect(extractStatementCounterparty('TED RECEBIDA EMPRESA XYZ', '')).toBe('RECEBIDA EMPRESA XYZ');
	});

	it('prefere NAME a MEMO e devolve null sem nome', () => {
		expect(extractStatementCounterparty('IFOOD', 'Compra no débito')).toBe('IFOOD');
		expect(extractStatementCounterparty('', '')).toBeNull();
		expect(extractStatementCounterparty('', '•••.123.456-••')).toBeNull();
	});
});
