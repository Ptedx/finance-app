/**
 * As trilhas do tutorial (SPD-131): um "?" ao lado de cada função abre uma trilha, e o guia
 * anda pelas telas de verdade, destacando cada elemento e explicando como ele funciona. É o
 * guia do SPD-129 (`utils/tour.ts`, `components/tour/`) estendido para várias telas.
 *
 * Aqui só a parte que não depende de tela:
 * - as telas por onde uma trilha passa e como chegar nelas (`TRAIL_SCREENS`);
 * - as trilhas, como dados: cada passo diz a tela, os alvos e o que fazer quando o alvo não
 *   está lá — o `[sem dado]` do texto aprovado (`TRAILS`);
 * - o plano de uma trilha para o usuário de agora: quais registros dele cada tela abre (a
 *   primeira conta, o primeiro cartão) e quais passos saem ou viram texto sem apontar
 *   (`planTrail`);
 * - o passo já na tela: o alvo medido, o `[sem dado]` ou pular (`resolveTrailStep`);
 * - a navegação: ir ao próximo passo, voltar um, e no fim voltar para onde começou
 *   (`navigateTrail`).
 *
 * A trilha nunca cria, altera nem apaga dado: ela só abre telas e aponta. Um formulário aberto
 * para mostrar os campos fecha sem salvar; a tela de uma conta ou de um cartão usa um registro
 * que o usuário já tem. Os textos ficam em `trails.<trilha>.steps.<passo>` no i18n.
 *
 * Para as trilhas 8 a 21 (fases 2 e 3): uma entrada em `TRAILS` (e, se a tela for nova, em
 * `TRAIL_SCREENS`), os alvos marcados nas telas (`TourTarget`/`useTourTarget`), o
 * `useScreenTour` na tela nova e o "?" (`HelpButton trail=…`). As trilhas 9 a 15 (SPD-131b):
 * Dívidas, Reserva, Patrimônio, "Este mês", Lançamentos e as duas dos Relatórios.
 */

import { hasSize, type Rect, type TourScreen } from './tour';

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------

/**
 * Como cada tela se anuncia ao guia (`useScreenTour`). As do SPD-129 (`TourScreen`) e as que
 * só as trilhas visitam. O formulário de conta nova e a tela de uma conta são a mesma tela
 * (`account`), como o cadastro e a edição do cartão (`cardEdit`) e os da dívida (`debtEdit`).
 */
export type TourPlace =
	| TourScreen
	| 'accounts'
	| 'account'
	| 'cards'
	| 'debitCard'
	| 'transaction'
	| 'transactions'
	| 'debt'
	| 'debtEdit';

/** As telas por onde as trilhas passam. */
export type TrailScreen =
	| 'home'
	| 'add'
	| 'settings'
	| 'accounts'
	| 'accountNew'
	| 'account'
	| 'cards'
	| 'cardNew'
	| 'card'
	| 'cardEdit'
	| 'debitCard'
	| 'transaction'
	| 'inbox'
	| 'wealth'
	| 'transactions'
	| 'reports'
	| 'debtNew'
	| 'debt'
	| 'debtEdit';

/**
 * O que a trilha precisa do usuário: o registro que uma tela abre (a conta, o cartão) ou uma
 * condição (há o que revisar, a captura existe neste aparelho). Cada um é uma lista, na ordem
 * da tela do app; vazia quando o usuário não tem.
 */
export type RecordKind =
	| 'account'
	| 'capturedAccount'
	| 'feedAccount'
	| 'businessAccount'
	| 'card'
	| 'cardNoClosing'
	| 'otherCard'
	| 'debitCard'
	| 'transaction'
	| 'pending'
	| 'capture'
	| 'debt';

/** Os parâmetros da rota de um registro (`{ id }`, ou `{ accountId, last4 }` no débito). */
export type TrailParams = Readonly<Record<string, string>>;
export type TrailRecords = Partial<Record<RecordKind, readonly TrailParams[]>>;

export interface TrailLocation {
	screen: TrailScreen;
	params?: TrailParams;
}

interface ScreenDef {
	/** A rota do expo-router. */
	path: string;
	/** Como a tela se anuncia ao guia. */
	report: TourPlace;
	/** Uma aba (Início, "+"): troca de aba em vez de abrir por cima. */
	tab?: boolean;
	/** A tela de onde esta se abre no app; o guia volta até ela antes de abrir esta. */
	parent?: TrailScreen;
	/** O registro que a tela abre. */
	record?: RecordKind;
	/**
	 * A tela guarda o que o usuário digitou ou escolheu e ainda não salvou (um formulário, as
	 * escolhas da revisão): a trilha que começa nela não a tira da pilha (`dropsOrigin`).
	 */
	keep?: boolean;
}

export const TRAIL_SCREENS: Readonly<Record<TrailScreen, ScreenDef>> = {
	home: { path: '/', report: 'home', tab: true },
	add: { path: '/add-transaction', report: 'add', tab: true },
	settings: { path: '/settings', report: 'settings', parent: 'home' },
	accounts: { path: '/accounts', report: 'accounts', parent: 'settings' },
	accountNew: { path: '/accounts/new', report: 'account', parent: 'accounts', keep: true },
	account: {
		path: '/accounts/[id]',
		report: 'account',
		parent: 'accounts',
		record: 'account',
		keep: true,
	},
	cards: { path: '/cards', report: 'cards', parent: 'settings' },
	cardNew: { path: '/cards/new', report: 'cardEdit', parent: 'cards', keep: true },
	card: { path: '/cards/[id]', report: 'card', parent: 'cards', record: 'card' },
	cardEdit: {
		path: '/cards/edit/[id]',
		report: 'cardEdit',
		parent: 'card',
		record: 'card',
		keep: true,
	},
	debitCard: {
		path: '/cards/debit/[accountId]/[last4]',
		report: 'debitCard',
		parent: 'cards',
		record: 'debitCard',
	},
	transaction: {
		path: '/transaction/[id]',
		report: 'transaction',
		parent: 'home',
		record: 'transaction',
	},
	inbox: { path: '/inbox', report: 'inbox', parent: 'home', keep: true },
	wealth: { path: '/wealth', report: 'wealth', tab: true },
	transactions: { path: '/transactions', report: 'transactions', tab: true },
	reports: { path: '/reports', report: 'reports', tab: true },
	debtNew: { path: '/debts/new', report: 'debtEdit', parent: 'wealth', keep: true },
	debt: { path: '/debts/[id]', report: 'debt', parent: 'wealth', record: 'debt' },
	debtEdit: {
		path: '/debts/edit/[id]',
		report: 'debtEdit',
		parent: 'debt',
		record: 'debt',
		keep: true,
	},
};

// ---------------------------------------------------------------------------
// Trilhas
// ---------------------------------------------------------------------------

/** O que fazer quando o alvo (ou o registro da tela) não existe: o `[sem dado]` do passo. */
export type MissingPolicy =
	/** Mesmo texto, sem apontar (também o padrão de passo sem `[sem dado]`). */
	| 'text'
	/** O texto próprio do `[sem dado]` (`…steps.<id>.missing`), sem apontar. */
	| 'alt'
	/**
	 * "Passo pulado". Decidido antes do primeiro balão (SPD-151): pelos dados, aqui no plano, ou
	 * pelo alvo na tela onde a trilha abre. Numa tela aberta depois, o alvo que falta mostra o
	 * texto sem apontar, para o total do contador não mudar no meio da trilha.
	 */
	| 'skip';

export interface TrailStepDef {
	/** O número do passo no texto aprovado; também a chave do texto. */
	id: string;
	screen: TrailScreen;
	/**
	 * Os alvos, em ordem de preferência: vale o primeiro grupo com algum alvo na tela, e o
	 * destaque cobre todos os do grupo que estão lá ("Nome" e "Tipo"). Um grupo seguinte é o
	 * `[sem dado]` que aponta para outro elemento, com o mesmo texto.
	 */
	targets?: readonly (readonly string[])[];
	/** O registro que a tela abre, quando não é o padrão dela (a conta criada pela captura). */
	record?: RecordKind;
	/** Uma condição para o passo existir (outro cartão para juntar). */
	needs?: RecordKind;
	missing?: MissingPolicy;
	/** Passo "Atenção:": a mesma caixa, com um rótulo de destaque. */
	attention?: boolean;
	/** O alvo fica fora da rolagem (a barra de abas). */
	fixed?: boolean;
	/** Só o texto, sem apontar nada. */
	textOnly?: boolean;
	/** A chave do texto, quando não é o `id` (os textos próprios das trilhas sem dado). */
	textId?: string;
	/**
	 * A partir deste grupo de `targets`, o alvo é o do `[sem dado]` que aponta para outro
	 * elemento com o texto próprio (`…steps.<id>.missing`): "mês vazio → aponta para 'Nenhum
	 * lançamento em …'", com outro texto. Os grupos de antes usam o texto do passo.
	 */
	altGroup?: number;
}

export type TrailId =
	| 'accounts'
	| 'cardSetup'
	| 'cardInvoice'
	| 'cardExtras'
	| 'add'
	| 'capture'
	| 'review'
	| 'debts'
	| 'reserve'
	| 'netWorth'
	| 'month'
	| 'transactions'
	| 'health'
	| 'freedom';

export interface TrailDef {
	id: TrailId;
	steps: readonly TrailStepDef[];
	/** Sem este registro, a trilha inteira é outra (sem cartão, iPhone, nada para revisar). */
	fallback?: { when: RecordKind; steps: readonly TrailStepDef[] };
}

type StepOptions = Omit<TrailStepDef, 'id' | 'screen' | 'targets' | 'altGroup'> & {
	/** Os alvos do `[sem dado]` que aponta para outro elemento, com o texto próprio. */
	altTargets?: string;
};

const groupsOf = (targets: string) => targets.split('|').map((group) => group.split('+'));

/**
 * Um passo: `targets` são grupos separados por `|` e, dentro do grupo, alvos por `+`;
 * `altTargets`, os grupos do `[sem dado]` com o texto próprio, depois dos outros.
 */
const s = (
	id: string,
	screen: TrailScreen,
	targets: string,
	{ altTargets, ...options }: StepOptions = {}
): TrailStepDef => {
	const groups = groupsOf(targets);
	return altTargets
		? {
				id,
				screen,
				targets: [...groups, ...groupsOf(altTargets)],
				altGroup: groups.length,
				...options,
			}
		: { id, screen, targets: groups, ...options };
};

/** Um passo só de texto. */
const text = (id: string, screen: TrailScreen, options: StepOptions = {}): TrailStepDef => ({
	id,
	screen,
	textOnly: true,
	...options,
});

const attention = { attention: true } as const;

export const TRAILS: Readonly<Record<TrailId, TrailDef>> = {
	// Trilha 1 — Contas: cadastro, papel e saldo. Começa em Ajustes › Contas.
	accounts: {
		id: 'accounts',
		steps: [
			s('1', 'accounts', 'accounts.totals'),
			s('2', 'accounts', 'accounts.empty|accounts.add'),
			s('3', 'accountNew', 'accountEdit.name+accountEdit.kind'),
			s('4', 'accountNew', 'accountEdit.role'),
			s('5', 'accountNew', 'accountEdit.role'),
			s('6', 'accountNew', 'accountEdit.purpose|accountEdit.roleReserve'),
			s('7', 'accountNew', 'accountEdit.opening'),
			s('8', 'accountNew', 'accountEdit.yield'),
			s('9', 'account', 'account.adjust', { missing: 'alt' }),
			s('10', 'account', 'account.unset', { ...attention, record: 'capturedAccount' }),
			s('11', 'accounts', 'accounts.duplicate', attention),
			s('12', 'account', 'account.merge+account.archive+account.delete'),
		],
	},
	// Trilha 2 — Cartões: cadastro. Começa em Ajustes › Cartões.
	cardSetup: {
		id: 'cardSetup',
		steps: [
			s('1', 'cards', 'cards.totals'),
			s('2', 'cards', 'cards.add'),
			s('3', 'cardNew', 'cardEdit.type'),
			s('4', 'cardNew', 'cardEdit.bank+cardEdit.nickname'),
			s('5', 'cardNew', 'cardEdit.last4'),
			s('6', 'cardNew', 'cardEdit.network+cardEdit.limit'),
			s('7', 'cardNew', 'cardEdit.days'),
			s('8', 'cardNew', 'cardEdit.cycle'),
			s('9', 'cardNew', 'cardEdit.due', attention),
			s('10', 'cardNew', 'cardEdit.closedInvoice+cardEdit.openInvoice'),
			s('11', 'card', 'card.noClosing', { ...attention, record: 'cardNoClosing' }),
		],
	},
	// Trilha 3 — Cartão: fatura, pagamento e acertos. Começa na tela de um cartão.
	cardInvoice: {
		id: 'cardInvoice',
		steps: [
			s('1', 'card', 'card.face'),
			s('2', 'card', 'card.pay'),
			// "Pago com" fica na folha do pagamento, que o guia não abre: aponta o botão dela.
			s('3', 'card', 'card.pay', attention),
			s('4', 'card', 'card.adjust'),
			// [sem dado]: a pergunta fica na folha → mesmo texto, apontando para "Acertar valor".
			s('5', 'card', 'card.adjust', attention),
			s('6', 'card', 'card.charge'),
			s('7', 'card', 'card.installments'),
			s('8', 'card', 'card.invoices'),
			s('9', 'card', 'card.leftToPay'),
			s('10', 'card', 'card.pending', attention),
			s('11', 'card', 'card.duplicates', attention),
			// "Limite" e o painel das datas (Fechamento e Vencimento: o "Melhor dia de compra" saiu
			// da tela, SPD-143). O texto aprovado fica igual.
			s('12', 'card', 'card.limit+card.dates'),
		],
		fallback: { when: 'card', steps: [text('1', 'cards', { textId: 'noCard' })] },
	},
	// Trilha 4 — Cartões: virtuais, débito, juntar e encerrar. Começa na tela de um cartão.
	cardExtras: {
		id: 'cardExtras',
		steps: [
			s('1', 'card', 'card.byCard'),
			s('2', 'card', 'card.rename'),
			// "Qual cartão" só aparece com um cartão de crédito escolhido; o guia não escolhe
			// nada no formulário: aponta o campo da conta, onde ele aparece.
			s('3', 'add', 'add.whichCard|add.account'),
			s('4', 'cards', 'cards.debit'),
			s('5', 'debitCard', 'debitCard.history', { missing: 'skip' }),
			// "Mover lançamentos e remover cartão" só aparece com Débito escolhido.
			s('6', 'cardEdit', 'cardEdit.type+cardEdit.debitConvert'),
			s('7', 'cardEdit', 'cardEdit.merge', { needs: 'otherCard', missing: 'skip' }),
			s('8', 'cardEdit', 'cardEdit.merge', attention),
			s('9', 'cardEdit', 'cardEdit.archive+cardEdit.delete'),
		],
	},
	// Trilha 5 — Lançar: despesa, receita e transferência. Começa em Início › "+".
	add: {
		id: 'add',
		steps: [
			s('1', 'home', 'home.add', { fixed: true }),
			s('2', 'add', 'add.type'),
			s('3', 'add', 'add.amount'),
			s('4', 'add', 'add.category'),
			s('5', 'add', 'add.account'),
			s('6', 'add', 'add.installments', { missing: 'alt' }),
			s('7', 'add', 'add.date'),
			s('8', 'add', 'add.note'),
			// "De" e "Para" só existem com Transferência escolhida: aponta a opção.
			s('9', 'add', 'add.from+add.to|add.transfer'),
			s('10', 'add', 'add.to|add.transfer', attention),
			// "Editar" e "Apagar" lado a lado: a linha dos dois.
			s('11', 'transaction', 'transaction.actions'),
			// "Salvar" ao lado de "Cancelar": a linha dos dois.
			s('12', 'add', 'add.save', attention),
		],
	},
	// Trilha 6 — Captura automática. Começa em Ajustes › seção "Captura automática".
	capture: {
		id: 'capture',
		steps: [
			s('1', 'settings', 'settings.captureSection'),
			s('2', 'settings', 'settings.capture'),
			s('3', 'settings', 'settings.capture', attention),
			s('4', 'settings', 'settings.review'),
			s('5', 'settings', 'settings.review'),
			s('6', 'settings', 'settings.ownName'),
			s('7', 'settings', 'settings.ownName', attention),
			s('8', 'accounts', 'accounts.linked', attention),
			s('9', 'account', 'account.feed', { record: 'feedAccount' }),
			s('10', 'account', 'account.business', { record: 'businessAccount', missing: 'skip' }),
			s('11', 'home', 'home.captureOff'),
			s('12', 'home', 'home.captureStalled', attention),
		],
		// No iPhone a seção não existe: só o passo 1, com o texto do iPhone.
		fallback: { when: 'capture', steps: [text('1', 'settings', { textId: 'ios' })] },
	},
	// Trilha 7 — Revisar: as perguntas e o que o app aprende. Começa em Início › "Revisar".
	review: {
		id: 'review',
		steps: [
			s('1', 'home', 'home.review'),
			s('2', 'inbox', 'inbox.card'),
			s('3', 'inbox', 'inbox.account'),
			s('4', 'inbox', 'inbox.category'),
			s('5', 'inbox', 'inbox.buttons'),
			s('6', 'inbox', 'inbox.raw'),
			s('7', 'inbox', 'inbox.question', attention),
			s('8', 'inbox', 'inbox.ambiguity', attention),
			s('9', 'inbox', 'inbox.learned'),
			s('10', 'inbox', 'inbox.auto+inbox.ignored'),
			s('11', 'inbox', 'inbox.history'),
		],
		// Nada para revisar: "Para revisar" vazia, com os passos 1, 9 e 11 sem apontar.
		fallback: {
			when: 'pending',
			steps: [text('1', 'inbox'), text('9', 'inbox'), text('11', 'inbox')],
		},
	},
	// Trilha 9 — Dívidas. Começa em Patrimônio › "Dívidas".
	debts: {
		id: 'debts',
		steps: [
			s('1', 'wealth', 'wealth.debts'),
			s('2', 'debtNew', 'debtEdit.kind+debtEdit.system'),
			s('3', 'debtNew', 'debtEdit.installment+debtEdit.remaining+debtEdit.dueDay'),
			s('4', 'debtNew', 'debtEdit.balance+debtEdit.rate'),
			s('5', 'debtNew', 'debtEdit.ratePeriod', attention),
			// A prévia só aparece com a parcela, o prazo e o saldo ou a taxa digitados.
			s('6', 'debtNew', 'debtEdit.preview'),
			// O reajuste só aparece com Consórcio escolhido; o guia não escolhe nada no formulário:
			// aponta o "Tipo", onde fica o Consórcio.
			s('7', 'debtNew', 'debtEdit.adjustment|debtEdit.kind', attention),
			s('8', 'debtNew', 'debtEdit.account'),
			// "Saldo devedor hoje" e "Juros que ainda faltam" ficam no mesmo quadro.
			s('9', 'debt', 'debt.summary', { missing: 'alt' }),
			s('10', 'debt', 'debt.verdict'),
			// "Simular amortização" abre a folha, que o guia não abre: aponta o botão.
			s('11', 'debt', 'debt.simulate'),
			s('12', 'debtEdit', 'debtEdit.archive+debtEdit.delete'),
		],
	},
	// Trilha 10 — Reserva de emergência e "Por onde começar". Começa em Patrimônio › Reserva.
	reserve: {
		id: 'reserve',
		steps: [
			s('1', 'wealth', 'wealth.reserve'),
			s('2', 'wealth', 'reserve.source'),
			s('3', 'wealth', 'reserve.source', attention),
			// O ícone "Ajustar a reserva" abre a folha, que o guia não abre: aponta o ícone.
			s('4', 'wealth', 'reserve.edit'),
			s('5', 'wealth', 'reserve.target', attention),
			s('6', 'wealth', 'reserve.cascade'),
			s('7', 'wealth', 'reserve.fill', { missing: 'alt', altTargets: 'reserve.setCost' }),
			s('8', 'wealth', 'wealth.priorities'),
			s('9', 'wealth', 'priorities.steps'),
		],
	},
	// Trilha 11 — Patrimônio: o que soma e o que desconta. Começa no Patrimônio.
	netWorth: {
		id: 'netWorth',
		steps: [
			s('1', 'wealth', 'netWorth.total'),
			s('2', 'wealth', 'netWorth.cash'),
			s('3', 'wealth', 'netWorth.reserve+netWorth.invested'),
			s('4', 'wealth', 'netWorth.outside|netWorth.have'),
			s('5', 'wealth', 'netWorth.cards'),
			s('6', 'wealth', 'netWorth.debts'),
			s('7', 'wealth', 'netWorth.note', attention),
			// O título da tela fica fora da rolagem.
			s('8', 'wealth', 'wealth.title', { ...attention, fixed: true }),
		],
	},
	// Trilha 12 — "Este mês" e o orçamento. Começa em Início › "Este mês".
	month: {
		id: 'month',
		steps: [
			s('1', 'home', 'month.header'),
			s('2', 'home', 'month.income'),
			s('3', 'home', 'month.spending'),
			s('4', 'home', 'month.card', { needs: 'card', missing: 'skip' }),
			s('5', 'home', 'month.envelope', { missing: 'skip' }),
			s('6', 'home', 'month.saved+month.leftover'),
			s('7', 'home', 'month.pendingIncome+month.pendingSpend', attention),
			// "Definir orçamento" e "Editar" abrem a folha, que o guia não abre: aponta o botão.
			s('8', 'home', 'month.budget'),
		],
	},
	// Trilha 13 — Lançamentos: lista, filtros e busca. Começa na aba Lançamentos.
	transactions: {
		id: 'transactions',
		steps: [
			// O seletor do mês fica no título, fora da lista.
			s('1', 'transactions', 'transactions.period', { fixed: true }),
			s('2', 'transactions', 'transactions.totals'),
			s('3', 'transactions', 'transactions.expense', attention),
			s('4', 'transactions', 'transactions.search'),
			s('5', 'transactions', 'transactions.kinds'),
			s('6', 'transactions', 'transactions.account'),
			s('7', 'transactions', 'transactions.first', {
				missing: 'alt',
				altTargets: 'transactions.empty',
			}),
			s('8', 'transactions', 'transactions.list', attention),
		],
	},
	// Trilha 14 — Relatórios: saúde financeira. Começa na aba Relatórios.
	health: {
		id: 'health',
		steps: [
			// O seletor do mês fica no cabeçalho, fora da rolagem.
			s('1', 'reports', 'reports.period', { fixed: true }),
			s('2', 'reports', 'reports.health'),
			s('3', 'reports', 'health.savings-rate'),
			s('4', 'reports', 'health.emergency-reserve'),
			s('5', 'reports', 'health.fixed-cost'),
			s('6', 'reports', 'health.card-load'),
			s('7', 'reports', 'health.spending-trend'),
			s('8', 'reports', 'reports.debts', { needs: 'debt', missing: 'skip' }),
			s('9', 'reports', 'reports.committed'),
			s('10', 'reports', 'reports.insights'),
		],
	},
	// Trilha 15 — Relatórios: liberdade financeira e histórico. Começa na aba Relatórios.
	freedom: {
		id: 'freedom',
		steps: [
			s('1', 'reports', 'freedom.title+freedom.goal'),
			// Os campos da meta ficam na folha, que o guia não abre: aponta o botão que a abre
			// ("Definir meta", ou o lápis com a meta definida).
			s('2', 'reports', 'freedom.goal'),
			s('3', 'reports', 'freedom.goal'),
			s('4', 'reports', 'freedom.capital|freedom.goal'),
			s('5', 'reports', 'freedom.pace|freedom.goal', attention),
			s('6', 'reports', 'freedom.horizons'),
			s('7', 'reports', 'reports.range+reports.trend'),
			s('8', 'reports', 'reports.projection'),
			s('9', 'reports', 'reports.categories+reports.sources'),
			s('10', 'reports', 'reports.export'),
		],
	},
};

export const TRAIL_IDS = Object.keys(TRAILS) as TrailId[];

export const isTrailId = (value: unknown): value is TrailId =>
	typeof value === 'string' && (TRAIL_IDS as string[]).includes(value);

// ---------------------------------------------------------------------------
// O plano
// ---------------------------------------------------------------------------

export interface PlannedTrailStep {
	trail: TrailId;
	id: string;
	/** A tela (e o registro) onde o passo aparece. */
	location: TrailLocation;
	targets: readonly (readonly string[])[];
	missing: MissingPolicy;
	attention: boolean;
	fixed: boolean;
	/** Mostra o texto sem apontar: o passo já nasce assim, ou o registro dele não existe. */
	textOnly: boolean;
	titleKey: string;
	bodyKey: string;
	/** O texto do `[sem dado]` (`missing: 'alt'`). */
	altBodyKey?: string;
	/** A partir deste grupo de alvos, o texto é o do `[sem dado]`. */
	altGroup?: number;
}

const sameParams = (a?: TrailParams, b?: TrailParams): boolean => {
	const keysA = Object.keys(a ?? {});
	const keysB = Object.keys(b ?? {});
	return keysA.length === keysB.length && keysA.every((key) => a?.[key] === b?.[key]);
};

export const sameLocation = (a: TrailLocation, b: TrailLocation): boolean =>
	a.screen === b.screen && sameParams(a.params, b.params);

const hasRecord = (records: TrailRecords, kind: RecordKind): boolean =>
	(records[kind]?.length ?? 0) > 0;

/** O registro de onde a trilha começou, se ele serve; senão, o primeiro da lista. */
const pickRecord = (
	records: TrailRecords,
	kind: RecordKind,
	origin: TrailLocation
): TrailParams | null => {
	const candidates = records[kind] ?? [];
	if (origin.params) {
		const here = candidates.find((candidate) => sameParams(candidate, origin.params));
		if (here) return here;
	}
	return candidates[0] ?? null;
};

/**
 * O plano da trilha para este usuário. Sem o registro que a trilha inteira precisa, vale a
 * trilha do `fallback`. Passo cuja tela precisa de um registro que o usuário não tem (ou cuja
 * condição falta) segue o `[sem dado]`: sai do plano, ou mostra o texto sem apontar, na tela
 * onde o guia já está. O resto do `[sem dado]` (o alvo que não está na tela) só se sabe com a
 * tela aberta: `resolveTrailStep`.
 */
export const planTrail = (
	trail: TrailDef,
	records: TrailRecords,
	origin: TrailLocation
): PlannedTrailStep[] => {
	const defs =
		trail.fallback && !hasRecord(records, trail.fallback.when) ? trail.fallback.steps : trail.steps;
	const plan: PlannedTrailStep[] = [];
	for (const def of defs) {
		const missing = def.missing ?? 'text';
		const key = `trails.${trail.id}.steps.${def.textId ?? def.id}`;
		const altBodyKey = missing === 'alt' ? `${key}.missing` : undefined;
		const recordKind = def.record ?? TRAIL_SCREENS[def.screen].record;
		const params = recordKind ? pickRecord(records, recordKind, origin) : null;
		const absent =
			(recordKind !== undefined && params === null) ||
			(def.needs !== undefined && !hasRecord(records, def.needs));
		if (absent && missing === 'skip') continue;
		const previous = plan.length > 0 ? plan[plan.length - 1].location : origin;
		const location: TrailLocation = absent
			? previous
			: params
				? { screen: def.screen, params }
				: { screen: def.screen };
		plan.push({
			trail: trail.id,
			id: def.id,
			location,
			targets: def.targets ?? [],
			missing,
			attention: def.attention ?? false,
			fixed: def.fixed ?? false,
			textOnly: (def.textOnly ?? false) || absent,
			titleKey: `${key}.title`,
			bodyKey: absent && altBodyKey ? altBodyKey : `${key}.body`,
			...(altBodyKey ? { altBodyKey } : {}),
			...(def.altGroup !== undefined ? { altGroup: def.altGroup } : {}),
		});
	}
	return plan;
};

/**
 * Onde a trilha começa: no passo pedido (o "?" do Acertar abre a Trilha 1 no 9); se ele saiu
 * do plano, no seguinte; sem pedido, no primeiro.
 */
export const startIndexOf = (plan: readonly PlannedTrailStep[], from?: string): number => {
	if (!from) return 0;
	const exact = plan.findIndex((step) => step.id === from);
	if (exact >= 0) return exact;
	const wanted = Number(from);
	const after = Number.isFinite(wanted) ? plan.findIndex((step) => Number(step.id) > wanted) : -1;
	return after >= 0 ? after : 0;
};

// ---------------------------------------------------------------------------
// O passo na tela
// ---------------------------------------------------------------------------

export type ResolvedTrailStep =
	| { kind: 'point'; ids: string[]; bodyKey: string }
	| { kind: 'text'; bodyKey: string }
	| { kind: 'skip' };

/**
 * O passo com a tela aberta e os alvos medidos: aponta o primeiro grupo que está na tela (com
 * o texto do `[sem dado]` a partir do `altGroup`); sem nenhum, segue o `[sem dado]` — o texto
 * sem apontar (o próprio, se houver) ou pular.
 */
export const resolveTrailStep = (
	step: PlannedTrailStep,
	rects: Readonly<Record<string, Rect | null | undefined>>
): ResolvedTrailStep => {
	if (step.textOnly) return { kind: 'text', bodyKey: step.bodyKey };
	for (const [index, group] of step.targets.entries()) {
		const present = group.filter((id) => hasSize(rects[id]));
		if (present.length === 0) continue;
		const alt = step.altGroup !== undefined && index >= step.altGroup;
		return {
			kind: 'point',
			ids: present,
			bodyKey: alt ? (step.altBodyKey ?? step.bodyKey) : step.bodyKey,
		};
	}
	if (step.missing === 'skip') return { kind: 'skip' };
	return { kind: 'text', bodyKey: step.altBodyKey ?? step.bodyKey };
};

/** O retângulo que cobre todos os alvos do passo. */
export const unionRect = (rects: readonly Rect[]): Rect => {
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
};

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------

export type TrailNavAction =
	/** Volta `count` telas na pilha. */
	| { type: 'pop'; count: number }
	/** Abre a tela por cima. */
	| { type: 'push'; location: TrailLocation }
	/** Fecha tudo o que está por cima das abas. */
	| { type: 'root' }
	/** Troca de aba (as abas já estão no topo). */
	| { type: 'tab'; screen: TrailScreen };

const isTab = (location: TrailLocation | undefined): boolean =>
	Boolean(location && TRAIL_SCREENS[location.screen].tab);

/** A tela de onde esta se abre: editar cartão se abre do mesmo cartão. */
const parentOf = (location: TrailLocation): TrailLocation | null => {
	const parent = TRAIL_SCREENS[location.screen].parent;
	if (!parent) return null;
	return TRAIL_SCREENS[parent].record && location.params
		? { screen: parent, params: location.params }
		: { screen: parent };
};

const lastIndexOf = (stack: readonly TrailLocation[], target: TrailLocation): number => {
	for (let index = stack.length - 1; index >= 0; index -= 1)
		if (sameLocation(stack[index], target)) return index;
	return -1;
};

/**
 * Como ir da tela de agora até a do passo. `stack` é o que o guia sabe da pilha: a tela onde
 * a trilha começou e o que ele abriu por cima (a pilha de baixo é do usuário, e o guia não
 * volta para dentro dela). A tela já na pilha: volta até ela. Uma aba: volta até as abas e
 * troca. As outras abrem por cima — depois de voltar até a tela de onde elas se abrem, se ela
 * estiver na pilha (sair da Nova conta para a conta fecha o formulário, sem salvar). Do
 * formulário do "+" o guia passa pela Início antes de abrir outra tela, para o formulário não
 * ficar por baixo.
 *
 * O fim da trilha é a mesma conta, com a tela onde ela começou.
 */
export const navigateTrail = (
	stack: readonly TrailLocation[],
	target: TrailLocation
): { actions: TrailNavAction[]; stack: TrailLocation[] } => {
	const size = stack.length;
	if (size > 0 && sameLocation(stack[size - 1], target)) return { actions: [], stack: [...stack] };

	const found = lastIndexOf(stack, target);
	if (found >= 0)
		return {
			actions: [{ type: 'pop', count: size - 1 - found }],
			stack: stack.slice(0, found + 1),
		};

	if (isTab(target)) {
		const actions: TrailNavAction[] = [];
		if (isTab(stack[0])) {
			if (size > 1) actions.push({ type: 'pop', count: size - 1 });
		} else {
			actions.push({ type: 'root' });
		}
		actions.push({ type: 'tab', screen: target.screen });
		return { actions, stack: [target] };
	}

	const actions: TrailNavAction[] = [];
	let base: TrailLocation[] = [...stack];
	const parent = parentOf(target);
	const parentAt = parent ? lastIndexOf(stack, parent) : -1;
	if (parentAt >= 0 && parentAt < size - 1) {
		actions.push({ type: 'pop', count: size - 1 - parentAt });
		base = stack.slice(0, parentAt + 1);
	}
	if (base.length === 1 && base[0].screen === 'add') {
		actions.push({ type: 'tab', screen: 'home' });
		base = [{ screen: 'home' }];
	}
	actions.push({ type: 'push', location: target });
	return { actions, stack: [...base, target] };
};

/**
 * Se ir até a tela tiraria da pilha a tela de onde a trilha começou, quando ela guarda o que o
 * usuário digitou ou escolheu sem salvar (`keep`): só acontece indo para uma aba. Aí o passo
 * segue o `[sem dado]` na tela onde o guia já está, e o que foi digitado não se perde.
 */
export const dropsOrigin = (stack: readonly TrailLocation[], target: TrailLocation): boolean => {
	const origin = stack[0];
	if (!origin || !TRAIL_SCREENS[origin.screen].keep) return false;
	const { stack: next } = navigateTrail(stack, target);
	return next.length === 0 || !sameLocation(next[0], origin);
};

/** O endereço do expo-router de uma tela. */
export const hrefOf = (location: TrailLocation): { pathname: string; params?: TrailParams } => {
	const { path } = TRAIL_SCREENS[location.screen];
	return location.params ? { pathname: path, params: location.params } : { pathname: path };
};
