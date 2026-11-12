import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	AccessibilityInfo,
	Alert,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ACCOUNT_KIND_ICONS } from '../components/AccountPicker';
import TransactionItem from '../components/TransactionItem';
import AdjustAccountSheet from '../components/accounts/AdjustAccountSheet';
import MergeTargetSheet from '../components/MergeTargetSheet';
import { TourTarget, useScreenTour, useTourScroll, useTourTarget } from '../components/tour/TourContext';
import { useAccounts } from '../contexts/AccountsContext';
import { useTransactions } from '../contexts/TransactionsContext';
import {
	type Account,
	type AccountDraft,
	type AccountKind,
	type AccountRole,
	defaultRoleFor,
	type Transaction,
} from '../database/schema';
import { feedOwnerOf } from '../utils/accountBinding';
import { planBusinessFeed } from '../utils/businessFeed';
import { getBusinessFeeds } from '../utils/businessFeedPreference';
import { ACCOUNT_COLORS } from '../utils/accountResolver';
import { showsBalanceUnset } from '../utils/balanceUnset';
import { dismissBalanceUnset, getDismissedBalanceUnset } from '../utils/balanceUnsetDismissals';
import { type ClosePlan, closeTargets, isAccountEmpty, mergeTargets } from '../utils/accountClosing';
import {
	closeBlockedMessage,
	closeConfirmMessage,
	deleteConfirmMessage,
	deleteRefusedMessage,
	mergeConfirmMessage,
	mergeRoleBlockedMessage,
	reopenMessage,
} from '../utils/deletionNotice';
import { brandFor } from '../utils/bankBrands';
import { usePeriod } from '../contexts/PeriodContext';
import { addDays, formatDate, formatMonthLong, monthStartISO, todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, formatAmountInput, formatCents, parseAmountToCents } from '../utils/money';
import { bpToPercentInput, formatPercentBp, percentInputToBp } from '../utils/percent';

/**
 * Criar ou editar uma conta ou cartão.
 *
 * A ação mais importante da tela é "definir saldo": é o que deixa o app 100% alinhado
 * com o banco num toque, sem reescrever lançamento nenhum. Para o cartão, o campo é
 * "valor a pagar agora" — o usuário pensa em quanto deve, não em saldo negativo.
 *
 * Acessibilidade: todo campo tem rótulo visível e `accessibilityLabel`; o tipo é um
 * grupo de rádio; erros aparecem abaixo do campo e são anunciados; alvos de 48 pt.
 */

const ACCENT = '#15E8FE';
// Cartão não é conta: tem tela e cadastro próprios em /cards.
const KINDS: AccountKind[] = ['checking', 'savings', 'investment', 'cash'];
const ROLES: AccountRole[] = ['main', 'envelope', 'reserve', 'external'];
const ROLE_ICONS: Record<AccountRole, React.ComponentProps<typeof Ionicons>['name']> = {
	main: 'home-outline',
	card: 'card-outline',
	envelope: 'mail-outline',
	reserve: 'shield-checkmark-outline',
	external: 'log-out-outline',
};

interface AccountEditScreenProps {
	accountId?: string;
}

const AccountEditScreen: React.FC<AccountEditScreenProps> = ({ accountId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const {
		accounts,
		balances,
		accruedYield,
		cdi,
		periodSpentByAccount,
		month,
		createAccount,
		saveAccount,
		removeAccount,
		mergeAccounts,
		closeAccount,
		reopenAccount,
		planClose,
		loadAccountContents,
		takeNotifications,
		takeBusinessNotifications,
		adjustAccountMonth,
	} = useAccounts();
	const { transactions } = useTransactions();
	// O gasto pré-preenchido na folha é o do **período escolhido** na tela inicial, e o
	// ajuste é lançado hoje. Quem está olhando setembro e digita o número de outubro gera
	// receita falsa no mês atual; dizer de qual mês é o número é o que evita a troca.
	const { selectedYear, selectedMonth } = usePeriod();

	const existing: Account | undefined = useMemo(
		() => accounts.find((account) => account.id === accountId),
		[accounts, accountId]
	);
	const isEditing = Boolean(existing);

	const [name, setName] = useState(existing?.name ?? '');
	const [kind, setKind] = useState<AccountKind>(existing?.kind ?? 'checking');
	const [bankName, setBankName] = useState(existing?.bankName ?? '');
	const [role, setRole] = useState<AccountRole>(existing?.role ?? defaultRoleFor(existing?.kind ?? 'checking'));
	const [envelopeMonthly, setEnvelopeMonthly] = useState(
		existing?.envelopeMonthlyCents ? centsToDisplayInput(existing.envelopeMonthlyCents) : ''
	);
	const [yieldCdi, setYieldCdi] = useState(existing?.yieldCdiBp ? bpToPercentInput(existing.yieldCdiBp) : '');
	// Numa reserva: entra na cascata da reserva de emergência, ou é só investimento.
	const [reservePurpose, setReservePurpose] = useState<'cascade' | 'investment'>(existing?.reservePurpose === 'investment' ? 'investment' : 'cascade');
	// Só na criação: o saldo que o banco mostra hoje. Em branco, a conta nasce zerada.
	const [openingBalance, setOpeningBalance] = useState('');
	const [adjusting, setAdjusting] = useState(false);
	const [errors, setErrors] = useState<{ name?: string; day?: string; amount?: string; balance?: string; yieldCdi?: string }>({});
	const [saving, setSaving] = useState(false);
	// A folha de "Juntar com outra conta" aberta.
	const [merging, setMerging] = useState(false);
	// A folha de "para qual conta vai o saldo" do encerrar, com o plano que a abriu.
	const [closing, setClosing] = useState<Extract<ClosePlan, { kind: 'transfer' }> | null>(null);
	// As trilhas de Contas e da captura (SPD-131) passam por aqui: a conta nova e a de uma conta.
	useScreenTour('account', { blocked: adjusting || merging || closing !== null });
	const tourScroll = useTourScroll('account');
	const unsetTarget = useTourTarget('account.unset');
	const adjustTarget = useTourTarget('account.adjust');
	const reserveTarget = useTourTarget('accountEdit.roleReserve');
	const archiveTarget = useTourTarget('account.archive');
	const mergeTarget = useTourTarget('account.merge');
	const deleteTarget = useTourTarget('account.delete');

	// Quando a conta chega depois (a lista ainda carregava), preenche o formulário.
	useEffect(() => {
		if (!existing) return;
		setName(existing.name);
		setKind(existing.kind);
		setBankName(existing.bankName ?? '');
		setRole(existing.role);
		setEnvelopeMonthly(existing.envelopeMonthlyCents ? centsToDisplayInput(existing.envelopeMonthlyCents) : '');
		setYieldCdi(existing.yieldCdiBp ? bpToPercentInput(existing.yieldCdiBp) : '');
		setReservePurpose(existing.reservePurpose === 'investment' ? 'investment' : 'cascade');
	}, [existing]);

	useEffect(() => {
		if (existing?.kind === 'credit_card') router.replace({ pathname: '/cards/[id]', params: { id: existing.id } });
	}, [existing, router]);

	/** Trocar o tipo numa conta nova leva o papel junto; numa existente o papel é escolha do usuário. */
	const chooseKind = (next: AccountKind) => {
		setKind(next);
		if (!existing) setRole(defaultRoleFor(next));
	};

	/**
	 * "Saldo não informado" (SPD-114): a conta que a captura criou com saldo 0. Aqui o aviso
	 * troca o "Saldo definido em" — ninguém definiu nada — e tem o "Dispensar", só neste
	 * aparelho. Quem toca no selo da lista chega com `setBalance=1`, e o "Acertar com o banco"
	 * já abre.
	 */
	const { setBalance: openSetBalance } = useLocalSearchParams<{ setBalance?: string }>();
	const [dismissedBalanceUnset, setDismissedBalanceUnset] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		void getDismissedBalanceUnset().then(setDismissedBalanceUnset);
	}, []);
	const balanceUnset = !!existing && showsBalanceUnset(existing, dismissedBalanceUnset);
	const openedFromBadge = useRef(false);
	useEffect(() => {
		if (!existing || existing.kind === 'credit_card' || openSetBalance !== '1' || openedFromBadge.current) return;
		openedFromBadge.current = true;
		setAdjusting(true);
	}, [existing, openSetBalance]);

	const handleDismissBalanceUnset = async () => {
		if (!existing) return;
		setDismissedBalanceUnset(await dismissBalanceUnset(existing.id));
		announce(t('accounts.balanceUnset.dismissed'));
	};

	const balanceCents = existing ? (balances.get(existing.id) ?? existing.openingBalanceCents) : 0;
	const recent: Transaction[] = useMemo(
		() => (existing ? transactions.filter((tx) => tx.accountId === existing.id).slice(0, 10) : []),
		[transactions, existing]
	);

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		const nextErrors: typeof errors = {};
		if (name.trim().length === 0) nextErrors.name = t('accounts.edit.invalidName');

		let envelopeCents: number | null = null;
		if (role === 'envelope' && envelopeMonthly.trim() !== '') {
			envelopeCents = parseAmountToCents(envelopeMonthly);
			if (envelopeCents === null || envelopeCents <= 0) nextErrors.amount = t('accounts.edit.invalidAmount');
		}

		// "120" = 120% do CDI. Vazio = a conta não rende.
		const yieldCdiBp = yieldCdi.trim() === '' ? null : percentInputToBp(yieldCdi, 1_000);
		if (yieldCdi.trim() !== '' && yieldCdiBp === null) nextErrors.yieldCdi = t('accounts.edit.invalidYield');

		let openingCents = 0;
		if (!existing && openingBalance.trim() !== '') {
			const parsed = parseAmountToCents(openingBalance);
			if (parsed === null || parsed < 0) nextErrors.balance = t('accounts.edit.invalidAmount');
			else openingCents = parsed;
		}

		setErrors(nextErrors);
		if (Object.keys(nextErrors).length > 0) {
			announce(Object.values(nextErrors).join('. '));
			return;
		}

		const draft: AccountDraft = {
			name: name.trim(),
			kind,
			role,
			envelopeMonthlyCents: role === 'envelope' ? envelopeCents : null,
			bankName: bankName.trim() || null,
			network: null,
			color: existing?.color ?? brandFor(bankName)?.color ?? ACCOUNT_COLORS[kind],
			last4: null,
			closingDay: null,
			closingDaysBefore: null,
			dueDay: null,
			creditLimitCents: null,
			cardNames: existing?.cardNames ?? null,
			yieldCdiBp: yieldCdiBp && yieldCdiBp > 0 ? yieldCdiBp : null,
			reservePurpose: role === 'reserve' && reservePurpose === 'investment' ? 'investment' : null,
			packageName: existing?.packageName ?? null,
			accountKey: existing?.accountKey ?? null,
			// Conta nova: o saldo de hoje vira âncora no fim de ontem, como no "Acertar com o
			// banco" (`setAccountBalanceToday`). Âncora com a data de hoje já conta o dia
			// inteiro, e o que a conta recebesse ou gastasse ainda hoje não mexeria no saldo.
			// Nenhum lançamento: o dinheiro já estava na conta, não é receita do mês.
			openingBalanceCents: existing?.openingBalanceCents ?? openingCents,
			openingBalanceDate: existing?.openingBalanceDate ?? addDays(todayISO(), -1),
			sortOrder: existing?.sortOrder ?? accounts.length,
			archived: existing?.archived ?? false,
		};

		try {
			setSaving(true);
			if (existing) {
				await saveAccount({ ...draft, id: existing.id });
				announce(t('accounts.edit.saved'));
			} else {
				const id = await createAccount(draft);
				router.replace({ pathname: '/accounts/[id]', params: { id } });
				return;
			}
		} finally {
			setSaving(false);
		}
	};

	/**
	 * Encerrar (SPD-144), no lugar de "Arquivar": a conta sai das listas, dos seletores e dos
	 * totais de hoje, e o histórico fica. Com saldo, uma transferência de hoje leva o saldo
	 * para a conta escolhida antes — o patrimônio não muda, e a confirmação diz quanto vai.
	 * Na conta já encerrada com saldo, o mesmo caminho é "Acertar o saldo".
	 */
	const closeCandidates = existing ? closeTargets(accounts, existing) : [];

	const startClose = async () => {
		if (!existing) return;
		let plan: ClosePlan;
		try {
			plan = await planClose(existing.id);
		} catch (error) {
			console.error('Error planning the account close:', error);
			return;
		}
		const title = existing.archived ? t('accounts.edit.settle') : t('accounts.edit.close');
		if (plan.kind === 'blocked') {
			Alert.alert(title, closeBlockedMessage('accounts.edit', existing.name, plan, t));
			return;
		}
		if (plan.kind === 'direct') {
			confirmClose(plan, null);
			return;
		}
		if (closeCandidates.length === 0) {
			Alert.alert(title, t('accounts.edit.closeNoTarget', { name: existing.name }));
			return;
		}
		// O destino se escolhe na mesma folha do "Juntar": o Alert do Android mostra no máximo três botões.
		setClosing(plan);
	};

	const confirmClose = (plan: ClosePlan, target: Account | null) => {
		setClosing(null);
		if (!existing) return;
		const wasClosed = existing.archived;
		const message = closeConfirmMessage(
			'accounts.edit',
			{ name: existing.name, target: target?.name, plan, alreadyClosed: wasClosed, roleChange: target !== null && target.role !== existing.role },
			t
		);
		Alert.alert(wasClosed ? t('accounts.edit.settle') : t('accounts.edit.close'), message, [
			{ text: t('accounts.edit.cancel'), style: 'cancel' },
			{
				text: t('accounts.edit.closeAction'),
				onPress: async () => {
					await closeAccount(existing.id, target?.id ?? null);
					announce(wasClosed ? t('accounts.edit.settle') : t('accounts.edit.closed'));
				},
			},
		]);
	};

	/** Reabrir: com saldo, avisa que ele volta aos totais de hoje. */
	const handleReopen = async () => {
		if (!existing) return;
		const reopen = async () => {
			await reopenAccount(existing.id);
			announce(t('accounts.edit.reopened'));
		};
		const message = existing.role === 'external' ? null : reopenMessage('accounts.edit', existing.name, balanceCents, t);
		if (message === null) {
			await reopen();
			return;
		}
		Alert.alert(t('accounts.edit.reopen'), message, [
			{ text: t('accounts.edit.cancel'), style: 'cancel' },
			{ text: t('accounts.edit.reopen'), onPress: reopen },
		]);
	};

	/**
	 * A mesma conta do banco com duas fichas no app: a que o usuário cadastrou e a que a
	 * primeira notificação criou, por exemplo. Juntar leva lançamentos, capturas e
	 * transferências para a escolhida e apaga esta. Só com conta ativa do mesmo papel
	 * (SPD-144): papéis diferentes reclassificariam o histórico.
	 */
	const mergeCandidates = existing && !existing.archived ? mergeTargets(accounts, existing) : [];

	// O destino se escolhe numa folha com todas as contas (E2E-39): o Alert do Android mostra no
	// máximo três botões. A confirmação, com dois, continua no Alert.
	const handleMerge = () => {
		if (!existing || mergeCandidates.length === 0) return;
		setMerging(true);
	};

	const balanceOf = (account: Account): number => balances.get(account.id) ?? account.openingBalanceCents;

	const confirmMerge = (account: Account) => {
		setMerging(false);
		if (!existing) return;
		const total = balanceOf(existing) + balanceOf(account);
		Alert.alert(t('accounts.edit.merge'), mergeConfirmMessage('accounts.edit', existing.name, account.name, total, t), [
			{ text: t('accounts.edit.cancel'), style: 'cancel' },
			{
				text: t('accounts.edit.mergeAction'),
				onPress: async () => {
					try {
						await mergeAccounts(existing.id, account.id);
					} catch (error) {
						// Papéis diferentes (SPD-152): a lista já filtra, mas o papel pode ter mudado no
						// outro aparelho entre abrir a folha e tocar. Nada mudou; a frase diz por quê.
						if (error instanceof Error && error.name === 'MergeRoleError') {
							Alert.alert(t('accounts.edit.merge'), mergeRoleBlockedMessage(existing.name, account.name, t));
							return;
						}
						throw error;
					}
					announce(t('accounts.edit.merged', { into: account.name }));
					// Esta tela é a da conta que saiu, e é a de cima: fechá-la não deixa nada dela na pilha.
					router.back();
				},
			},
		]);
	};

	/**
	 * Quem recebe as compras que o app deste banco avisa. O vínculo é invisível na tela e
	 * nasce de qual ficha a primeira notificação encontrou — então é aqui que o usuário vê
	 * para onde o dinheiro do banco está indo, e muda.
	 */
	const feedOwner = existing && existing.kind !== 'credit_card' ? feedOwnerOf(accounts, existing) : null;

	const handleTakeNotifications = () => {
		if (!existing || !feedOwner || feedOwner.id === existing.id) return;
		Alert.alert(
			t('accounts.edit.feedTitle'),
			t('accounts.edit.feedConfirm', { from: feedOwner.name, into: existing.name }),
			[
				{ text: t('accounts.edit.cancel'), style: 'cancel' },
				{
					text: t('accounts.edit.feedTake'),
					onPress: async () => {
						await takeNotifications(existing.id);
						announce(t('accounts.edit.feedMoved', { name: existing.name }));
					},
				},
			]
		);
	};

	/**
	 * Os avisos da PJ ("da conta Nu Empresas"), que o banco marca no texto (SPD-074). Só
	 * aparece para banco que marca; a resposta vem da preferência, que o sync também traz.
	 */
	const businessPlan = existing && feedOwner ? planBusinessFeed(accounts, existing.id) : null;
	const [businessFeeds, setBusinessFeeds] = useState<Record<string, string>>({});
	useEffect(() => {
		void getBusinessFeeds().then(setBusinessFeeds);
	}, []);
	const businessHere = !!existing && !!businessPlan && businessFeeds[businessPlan.packageName] === existing.id;

	const handleTakeBusiness = () => {
		if (!existing || !businessPlan || businessHere) return;
		const { label, moveFeedTo } = businessPlan;
		Alert.alert(
			t('accounts.edit.feedTitle'),
			moveFeedTo
				? t('accounts.edit.businessConfirmMove', { label, name: existing.name, other: moveFeedTo.name })
				: t('accounts.edit.businessConfirm', { label, name: existing.name }),
			[
				{ text: t('accounts.edit.cancel'), style: 'cancel' },
				{
					text: t('accounts.edit.businessTake', { label }),
					onPress: async () => {
						await takeBusinessNotifications(existing.id);
						setBusinessFeeds(await getBusinessFeeds());
						announce(t('accounts.edit.businessMoved', { label, name: existing.name }));
					},
				},
			]
		);
	};

	/**
	 * Apagar só conta vazia (SPD-144, `isAccountEmpty`): aí nada muda nos números, e a
	 * confirmação diz isso. Com conteúdo, diz por quê não e oferece Encerrar ou Juntar.
	 */
	const handleDelete = async () => {
		if (!existing) return;
		let contents: Awaited<ReturnType<typeof loadAccountContents>>;
		try {
			contents = await loadAccountContents(existing.id);
		} catch (error) {
			console.error('Error reading what is linked to the account:', error);
			return;
		}
		if (!isAccountEmpty(contents)) {
			Alert.alert(t('accounts.edit.delete'), deleteRefusedMessage('accounts.edit', existing.name, contents, t), [
				{ text: t('accounts.edit.cancel'), style: 'cancel' },
				...(existing.archived ? [] : [{ text: t('accounts.edit.close'), onPress: () => void startClose() }]),
				...(mergeCandidates.length > 0 ? [{ text: t('accounts.edit.merge'), onPress: handleMerge }] : []),
			]);
			return;
		}
		Alert.alert(t('accounts.edit.delete'), deleteConfirmMessage('accounts.edit', existing.name, contents, t), [
			{ text: t('accounts.edit.cancel'), style: 'cancel' },
			{
				text: t('accounts.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					try {
						await removeAccount(existing.id);
					} catch (error) {
						// Ganhou conteúdo entre a pergunta e o toque: o banco recusou e nada mudou.
						if (error instanceof Error && error.name === 'AccountInUseError') {
							Alert.alert(t('accounts.edit.delete'), t('accounts.edit.deleteChanged', { name: existing.name }));
							return;
						}
						throw error;
					}
					router.back();
				},
			},
		]);
	};

	const field = (
		label: string,
		value: string,
		onChange: (text: string) => void,
		options: {
			placeholder?: string;
			keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
			hint?: string;
			error?: string;
			optional?: boolean;
			/** O alvo das trilhas (SPD-131). */
			tourId?: string;
		} = {}
	) => (
		<TourTarget id={options.tourId} style={styles.field}>
			<Text style={styles.label}>
				{label}
				{options.optional ? <Text style={styles.optional}> · {t('accounts.edit.optional')}</Text> : null}
			</Text>
			<TextInput
				style={[styles.input, options.error && styles.inputError]}
				value={value}
				onChangeText={onChange}
				placeholder={options.placeholder}
				placeholderTextColor="rgba(255,255,255,0.35)"
				keyboardType={options.keyboardType ?? 'default'}
				accessibilityLabel={label}
				accessibilityHint={options.hint}
			/>
			{options.error ? (
				<Text style={styles.error} accessibilityLiveRegion="polite">
					{options.error}
				</Text>
			) : null}
		</TourTarget>
	);

	// Aberta com uma conta que não existe mais (juntada, excluída): dizer isso, com o voltar, em
	// vez do formulário de conta nova — salvar ali criava outra conta (E2E-40). Aberta direto,
	// sem tela antes, o voltar leva à lista de contas.
	if (accountId && !existing) {
		return (
			<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
				<Stack.Screen options={{ headerShown: false }} />
				<View style={styles.header}>
					<Pressable
						onPress={() => (router.canGoBack() ? router.back() : router.replace('/accounts'))}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.back')}
						hitSlop={12}
						style={styles.backButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header">
						{t('accounts.edit.notFound')}
					</Text>
				</View>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			{/* No Android, sem `behavior` nada encolhia e o teclado cobria o salvar no fim da rolagem (SPD-121): o `height` encolhe a área, como na `Sheet`. */}
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
				<View style={styles.header}>
					<Pressable
						onPress={() => router.back()}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.back')}
						hitSlop={12}
						style={styles.backButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header">
						{isEditing ? existing?.name : t('accounts.edit.newTitle')}
					</Text>
				</View>

				<ScrollView ref={tourScroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
					{existing && (
						<View style={styles.balanceCard}>
							<Text style={styles.balanceLabel}>{t('accounts.balance')}</Text>
							<Text style={[styles.balanceValue, balanceCents < 0 && styles.owed]}>
								{formatCents(balanceCents)}
							</Text>
							{balanceUnset ? (
								<View {...unsetTarget} style={styles.balanceUnset}>
									<View style={styles.balanceUnsetTitleRow}>
										<Ionicons name="alert-circle-outline" size={18} color="#000000" />
										<Text style={styles.balanceUnsetTitle}>{t('accounts.balanceUnset.badge')}</Text>
									</View>
									<Text style={styles.balanceUnsetBody}>{t('accounts.balanceUnset.body')}</Text>
									<Pressable
										onPress={handleDismissBalanceUnset}
										accessibilityRole="button"
										accessibilityLabel={t('accounts.balanceUnset.dismiss')}
										accessibilityHint={t('accounts.balanceUnset.dismissHint')}
										style={({ pressed }) => [styles.balanceUnsetDismiss, pressed && styles.pressed]}
									>
										<Text style={styles.balanceUnsetDismissText}>{t('accounts.balanceUnset.dismiss')}</Text>
									</Pressable>
								</View>
							) : (
								<Text style={styles.balanceMeta}>
									{t('accounts.anchoredOn', { date: formatDate(existing.openingBalanceDate) })}
								</Text>
							)}
							{existing.packageName && (
								<Text style={styles.balanceMeta}>
									{t('accounts.linkedNotifications', { app: existing.bankName ?? existing.packageName })}
								</Text>
							)}
							{existing.accountKey && <Text style={styles.balanceMeta}>{t('accounts.linkedStatement')}</Text>}
							{(accruedYield.get(existing.id) ?? 0) > 0 ? (
								<Text style={styles.balanceMeta}>
									{t('accounts.yieldIncluded', {
										amount: formatCents(accruedYield.get(existing.id) ?? 0),
										date: formatDate(existing.openingBalanceDate),
									})}
								</Text>
							) : null}

							<Pressable
								{...adjustTarget}
								onPress={() => setAdjusting(true)}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.edit.setBalance')}
								accessibilityHint={t('accounts.edit.setBalanceHint')}
								style={({ pressed }) => [styles.primaryButton, styles.setBalanceButton, pressed && styles.pressed]}
							>
								<Text style={styles.primaryButtonText}>{t('accounts.edit.setBalance')}</Text>
							</Pressable>
						</View>
					)}

					{field(t('accounts.edit.name'), name, setName, {
						placeholder: t('accounts.edit.namePlaceholder'),
						error: errors.name,
						tourId: 'accountEdit.name',
					})}

					<TourTarget id="accountEdit.kind" style={styles.field}>
						<Text style={styles.label}>{t('accounts.edit.kind')}</Text>
						<View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.edit.kind')}>
							{KINDS.map((option) => {
								const selected = kind === option;
								const color = ACCOUNT_COLORS[option];
								return (
									<Pressable
										key={option}
										onPress={() => chooseKind(option)}
										accessibilityRole="radio"
										accessibilityState={{ selected }}
										accessibilityLabel={t(`accounts.kind.${option}`)}
										style={({ pressed }) => [
											styles.kindChip,
											selected && { borderColor: color, backgroundColor: `${color}22` },
											pressed && styles.pressed,
										]}
									>
										<Ionicons name={selected ? 'checkmark-circle' : ACCOUNT_KIND_ICONS[option]} size={18} color={selected ? color : 'rgba(255,255,255,0.8)'} />
										<Text style={[styles.kindLabel, selected && { color }]}>{t(`accounts.kind.${option}`)}</Text>
									</Pressable>
								);
							})}
						</View>
					</TourTarget>

					<TourTarget id="accountEdit.role" style={styles.field}>
						<Text style={styles.label}>{t('accounts.edit.role')}</Text>
						<Text style={styles.roleHint}>{t('accounts.edit.roleHint')}</Text>
						<View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.edit.role')}>
							{ROLES.map((option) => {
								const selected = role === option;
								return (
									<Pressable
										key={option}
										{...(option === 'reserve' ? reserveTarget : {})}
										onPress={() => setRole(option)}
										accessibilityRole="radio"
										accessibilityState={{ selected }}
										accessibilityLabel={t(`accounts.role.${option}`)}
										accessibilityHint={t(`accounts.roleDescription.${option}`)}
										style={({ pressed }) => [
											styles.kindChip,
											selected && { borderColor: ACCENT, backgroundColor: `${ACCENT}22` },
											pressed && styles.pressed,
										]}
									>
										<Ionicons name={selected ? 'checkmark-circle' : ROLE_ICONS[option]} size={18} color={selected ? ACCENT : 'rgba(255,255,255,0.8)'} />
										<Text style={[styles.kindLabel, selected && { color: ACCENT }]}>{t(`accounts.role.${option}`)}</Text>
									</Pressable>
								);
							})}
						</View>
						<Text style={styles.roleDescription} accessibilityLiveRegion="polite">
							{t(`accounts.roleDescription.${role}`)}
						</Text>
					</TourTarget>

					{role === 'reserve' ? (
						<TourTarget id="accountEdit.purpose" style={styles.field}>
							<Text style={styles.label}>{t('accounts.edit.reservePurpose')}</Text>
							<View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel={t('accounts.edit.reservePurpose')}>
								{(['cascade', 'investment'] as const).map((option) => {
									const selected = reservePurpose === option;
									return (
										<Pressable
											key={option}
											onPress={() => setReservePurpose(option)}
											accessibilityRole="radio"
											accessibilityState={{ selected }}
											accessibilityLabel={t(`accounts.reservePurpose.${option}`)}
											style={({ pressed }) => [
												styles.kindChip,
												selected && { borderColor: ACCENT, backgroundColor: `${ACCENT}22` },
												pressed && styles.pressed,
											]}
										>
											<Ionicons
												name={selected ? 'checkmark-circle' : option === 'cascade' ? 'shield-checkmark-outline' : 'trending-up-outline'}
												size={18}
												color={selected ? ACCENT : 'rgba(255,255,255,0.8)'}
											/>
											<Text style={[styles.kindLabel, selected && { color: ACCENT }]}>{t(`accounts.reservePurpose.${option}`)}</Text>
										</Pressable>
									);
								})}
							</View>
							<Text style={styles.roleDescription} accessibilityLiveRegion="polite">
								{t(`accounts.reservePurposeDescription.${reservePurpose}`)}
							</Text>
						</TourTarget>
					) : null}

					{role === 'envelope' &&
						field(t('accounts.edit.envelopeMonthly'), envelopeMonthly, setEnvelopeMonthly, {
							keyboardType: 'decimal-pad',
							hint: t('accounts.edit.envelopeMonthlyHint'),
							error: errors.amount,
						})}

					{existing ? null : (
						<>
							{field(t('accounts.edit.openingBalance'), openingBalance, (text) => setOpeningBalance(formatAmountInput(text)), {
								keyboardType: 'decimal-pad',
								placeholder: centsToDisplayInput(0),
								hint: t('accounts.edit.openingBalanceHint'),
								error: errors.balance,
								optional: true,
								tourId: 'accountEdit.opening',
							})}
							<Text style={styles.fieldNote}>{t('accounts.edit.openingBalanceHint')}</Text>
						</>
					)}

					{kind !== 'credit_card' ? (
						<>
							{field(t('accounts.edit.yieldCdi'), yieldCdi, setYieldCdi, {
								keyboardType: 'decimal-pad',
								placeholder: t('accounts.edit.yieldCdiPlaceholder'),
								hint: t('accounts.edit.yieldCdiHint'),
								error: errors.yieldCdi,
								optional: true,
								tourId: 'accountEdit.yield',
							})}
							<Text style={styles.fieldNote}>
								{cdi
									? t('accounts.edit.cdiToday', { rate: formatPercentBp(cdi.annualBp, 2), date: formatDate(cdi.date) })
									: t('accounts.edit.cdiUnknown')}
							</Text>
						</>
					) : null}

					{field(t('accounts.edit.bank'), bankName, setBankName, {
						placeholder: t('accounts.edit.bankPlaceholder'),
						optional: true,
					})}

					<Pressable
						onPress={handleSave}
						disabled={saving}
						accessibilityRole="button"
						accessibilityLabel={t('accounts.edit.save')}
						accessibilityState={{ disabled: saving }}
						style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, saving && styles.disabled]}
					>
						<Text style={styles.primaryButtonText}>{t('accounts.edit.save')}</Text>
					</Pressable>

					{existing?.archived && existing.role !== 'external' && balanceCents !== 0 ? (
						<View style={styles.section}>
							<Text style={styles.empty}>{t('accounts.edit.closedWithBalance', { amount: formatCents(balanceCents) })}</Text>
							<Pressable
								onPress={() => void startClose()}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.edit.settle')}
								accessibilityHint={t('accounts.edit.settleHint')}
								style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
							>
								<Ionicons name="swap-horizontal-outline" size={18} color="#FFFFFF" />
								<Text style={styles.secondaryButtonText}>{t('accounts.edit.settle')}</Text>
							</Pressable>
						</View>
					) : null}

					{existing && (
						<View style={styles.secondaryActions}>
							<Pressable
								{...archiveTarget}
								onPress={existing.archived ? handleReopen : () => void startClose()}
								accessibilityRole="button"
								accessibilityLabel={existing.archived ? t('accounts.edit.reopen') : t('accounts.edit.close')}
								accessibilityHint={existing.archived ? t('accounts.edit.reopenHint') : t('accounts.edit.closeHint')}
								style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
							>
								<Ionicons name={existing.archived ? 'arrow-undo-outline' : 'archive-outline'} size={18} color="#FFFFFF" />
								<Text style={styles.secondaryButtonText}>
									{existing.archived ? t('accounts.edit.reopen') : t('accounts.edit.close')}
								</Text>
							</Pressable>
							{mergeCandidates.length > 0 ? (
								<Pressable
									{...mergeTarget}
									onPress={handleMerge}
									accessibilityRole="button"
									accessibilityLabel={t('accounts.edit.merge')}
									accessibilityHint={t('accounts.edit.mergeHint')}
									style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
								>
									<Ionicons name="git-merge-outline" size={18} color="#FFFFFF" />
									<Text style={styles.secondaryButtonText}>{t('accounts.edit.merge')}</Text>
								</Pressable>
							) : null}
							<Pressable
								{...deleteTarget}
								onPress={handleDelete}
								accessibilityRole="button"
								accessibilityLabel={t('accounts.edit.delete')}
								accessibilityHint={t('accounts.edit.deleteHint')}
								style={({ pressed }) => [styles.secondaryButton, styles.dangerButton, pressed && styles.pressed]}
							>
								<Ionicons name="trash-outline" size={18} color="#FF6B6B" />
								<Text style={[styles.secondaryButtonText, styles.dangerText]}>{t('accounts.edit.delete')}</Text>
							</Pressable>
						</View>
					)}

					{existing && feedOwner ? (
						<TourTarget id="account.feed" style={styles.section}>
							<Text style={styles.sectionTitle} accessibilityRole="header">
								{t('accounts.edit.feedTitle')}
							</Text>
							<Text style={styles.empty}>
								{feedOwner.id === existing.id
									? t('accounts.edit.feedHere')
									: t('accounts.edit.feedElsewhere', { name: feedOwner.name })}
							</Text>
							{feedOwner.id === existing.id ? null : (
								<Pressable
									onPress={handleTakeNotifications}
									accessibilityRole="button"
									accessibilityLabel={t('accounts.edit.feedTake')}
									accessibilityHint={t('accounts.edit.feedHint')}
									style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
								>
									<Ionicons name="swap-horizontal-outline" size={18} color="#FFFFFF" />
									<Text style={styles.secondaryButtonText}>{t('accounts.edit.feedTake')}</Text>
								</Pressable>
							)}
							{businessPlan && businessHere ? (
								<TourTarget id="account.business">
									<Text style={styles.empty}>{t('accounts.edit.businessHere', { label: businessPlan.label })}</Text>
								</TourTarget>
							) : null}
							{businessPlan && !businessHere ? (
								<TourTarget id="account.business">
								<Pressable
									onPress={handleTakeBusiness}
									accessibilityRole="button"
									accessibilityLabel={t('accounts.edit.businessTake', { label: businessPlan.label })}
									accessibilityHint={t('accounts.edit.businessHint', { label: businessPlan.label })}
									style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
								>
									<Ionicons name="briefcase-outline" size={18} color="#FFFFFF" />
									<Text style={styles.secondaryButtonText}>
										{t('accounts.edit.businessTake', { label: businessPlan.label })}
									</Text>
								</Pressable>
								</TourTarget>
							) : null}
						</TourTarget>
					) : null}

					{existing && (
						<View style={styles.section}>
							<Text style={styles.sectionTitle} accessibilityRole="header">
								{t('accounts.edit.transactions')}
							</Text>
							{recent.length === 0 ? (
								<Text style={styles.empty}>{t('accounts.edit.noTransactions')}</Text>
							) : (
								recent.map((transaction) => (
									<TransactionItem
										key={transaction.id}
										transaction={transaction}
										onPress={(tx) => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
									/>
								))
							)}
						</View>
					)}
				</ScrollView>
			</KeyboardAvoidingView>

			{existing ? (
				<AdjustAccountSheet
					visible={adjusting}
					account={existing}
					spentCents={periodSpentByAccount.get(existing.id) ?? 0}
					monthLabel={formatMonthLong(monthStartISO(selectedYear, selectedMonth))}
					balanceCents={balanceCents}
					targetCents={month?.envelopes.find((envelope) => envelope.accountId === existing.id)?.targetCents ?? 0}
					isEnvelope={existing.role === 'envelope'}
					balanceOnly={existing.role === 'reserve'}
					onClose={() => setAdjusting(false)}
					onConfirm={async (input) => {
						await adjustAccountMonth(existing.id, input);
						// Acertado, o selo sai. A âncora nova já o tira, mas confirmar o valor que a
						// tela mostrava (ou um saldo que de fato é zero) não mexe nela: aí vale como
						// dispensa, neste aparelho.
						if (balanceUnset) setDismissedBalanceUnset(await dismissBalanceUnset(existing.id));
						setAdjusting(false);
					}}
				/>
			) : null}
			{existing ? (
				<MergeTargetSheet
					visible={merging}
					title={t('accounts.edit.merge')}
					subtitle={t('accounts.edit.mergePick', { name: existing.name })}
					targets={mergeCandidates}
					onPick={confirmMerge}
					onClose={() => setMerging(false)}
				/>
			) : null}
			{existing && closing ? (
				<MergeTargetSheet
					visible
					title={existing.archived ? t('accounts.edit.settle') : t('accounts.edit.close')}
					subtitle={t(closing.direction === 'out' ? 'accounts.edit.closePick' : 'accounts.edit.closePickIn', {
						amount: formatCents(closing.amountCents),
						name: existing.name,
					})}
					targets={closeCandidates}
					onPick={(target) => confirmClose(closing, target)}
					onClose={() => setClosing(null)}
				/>
			) : null}
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
	flex: {
		flex: 1,
	},
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	backButton: {
		minWidth: 48,
		minHeight: 48,
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: 'bold',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 120,
	},
	// A nota sob um campo (o CDI em uso, o saldo de hoje): encosta no campo de cima e deixa
	// o mesmo respiro de um campo para o rótulo seguinte — sem ele, o "Banco · opcional"
	// colava na frase do CDI (E2E-03).
	fieldNote: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.6)',
		marginTop: -8,
		marginBottom: 16,
	},
	balanceCard: {
		backgroundColor: '#1E1E1E',
		borderRadius: 12,
		padding: 16,
		marginBottom: 16,
		gap: 4,
	},
	balanceLabel: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
	},
	balanceValue: {
		fontSize: 30,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	owed: {
		color: '#FF6B6B',
	},
	balanceMeta: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
	},
	// O mesmo âmbar do selo na lista de contas.
	balanceUnset: {
		backgroundColor: '#FFB74D',
		borderRadius: 10,
		padding: 12,
		gap: 6,
		marginTop: 4,
	},
	balanceUnsetTitleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
	},
	balanceUnsetTitle: {
		fontSize: 15,
		fontWeight: '700',
		color: '#000000',
	},
	balanceUnsetBody: {
		fontSize: 14,
		lineHeight: 20,
		color: '#000000',
	},
	balanceUnsetDismiss: {
		minHeight: 44,
		alignSelf: 'flex-start',
		justifyContent: 'center',
		paddingHorizontal: 12,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: '#000000',
	},
	balanceUnsetDismissText: {
		fontSize: 14,
		fontWeight: '600',
		color: '#000000',
	},
	modes: {
		gap: 8,
		marginTop: 12,
	},
	mode: {
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
		borderRadius: 12,
		padding: 12,
		minHeight: 48,
		justifyContent: 'center',
	},
	modeSelected: {
		borderColor: '#15E8FE',
		backgroundColor: 'rgba(21,232,254,0.1)',
	},
	modeTitle: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	modeTitleSelected: {
		color: '#15E8FE',
	},
	modeHint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	setBalanceRow: {
		flexDirection: 'row',
		gap: 8,
		marginTop: 10,
	},
	setBalanceInput: {
		flex: 1,
	},
	setBalanceButton: {
		paddingHorizontal: 14,
	},
	field: {
		marginBottom: 16,
	},
	label: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.75)',
		marginBottom: 6,
	},
	optional: {
		color: 'rgba(255,255,255,0.45)',
	},
	input: {
		minHeight: 48,
		borderRadius: 10,
		paddingHorizontal: 14,
		backgroundColor: 'rgba(255,255,255,0.06)',
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.12)',
		color: '#FFFFFF',
		fontSize: 16,
	},
	inputError: {
		borderColor: '#FF6B6B',
	},
	error: {
		fontSize: 13,
		color: '#FF6B6B',
		marginTop: 6,
	},
	kinds: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	roleHint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.55)',
		marginBottom: 8,
	},
	roleDescription: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.75)',
		marginTop: 8,
	},
	kindChip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
		minHeight: 48,
		paddingHorizontal: 14,
		borderRadius: 24,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.2)',
		backgroundColor: 'rgba(255,255,255,0.05)',
	},
	kindLabel: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	column: {
		flex: 1,
	},
	primaryButton: {
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: ACCENT,
		alignItems: 'center',
		justifyContent: 'center',
	},
	primaryButtonText: {
		fontSize: 16,
		fontWeight: '600',
		color: '#000000',
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.5,
	},
	secondaryActions: {
		flexDirection: 'row',
		gap: 8,
		marginTop: 12,
	},
	secondaryButton: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 48,
		borderRadius: 10,
		backgroundColor: 'rgba(255,255,255,0.08)',
	},
	secondaryButtonText: {
		fontSize: 15,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	dangerButton: {
		backgroundColor: 'rgba(255,107,107,0.12)',
	},
	dangerText: {
		color: '#FF6B6B',
	},
	section: {
		marginTop: 24,
	},
	sectionTitle: {
		fontSize: 18,
		fontWeight: '600',
		color: '#FFFFFF',
		marginBottom: 8,
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.6)',
	},
});

export default AccountEditScreen;
