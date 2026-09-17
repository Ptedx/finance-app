import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import CardFace from '../components/cards/CardFace';
import { Button, ChipGroup, type ChipOption, Field } from '../components/cards/formParts';
import { useAccounts } from '../contexts/AccountsContext';
import { type Account, type AccountDraft, DEFAULT_CLOSING_DAYS_BEFORE } from '../database/schema';
import {
	BANK_BRANDS,
	brandFor,
	CARD_NETWORKS,
	type CardNetwork,
	NETWORK_LABELS,
	NEUTRAL_CARD_COLOR,
} from '../utils/bankBrands';
import { todayISO } from '../utils/dateUtils';
import { centsToDisplayInput, parseAmountToCents } from '../utils/money';

/**
 * Criar ou editar um cartão. Nada aqui fala de saldo.
 *
 * O cartão aparece no topo e muda enquanto se preenche — escolher o banco já pinta o
 * cartão com a cor dele, e o final e a bandeira aparecem onde estariam no plástico.
 * Isso confirma a escolha sem precisar ler.
 *
 * Campos na ordem em que se acha a informação no app do banco: banco, final, bandeira,
 * limite e vencimento. O fechamento não é digitado: sai do vencimento menos N dias (7 no
 * Nubank), já com o vencimento empurrado para dia útil. Só o banco é obrigatório; sem
 * vencimento o cartão funciona, mas não monta faturas — e a tela diz isso.
 *
 * Débito fica de fora: não tem fatura nem limite, a compra sai da conta na hora. Quem
 * cadastrou um débito aqui por engano leva os lançamentos para a conta com um toque.
 */

const POPULAR_BANKS = ['nubank', 'inter', 'mercadopago', 'itau', 'bradesco', 'santander', 'bb', 'caixa', 'c6', 'picpay'];
const OTHER = 'other';

type CardType = 'credit' | 'debit';

interface CardEditScreenProps {
	cardId?: string;
}

const CardEditScreen: React.FC<CardEditScreenProps> = ({ cardId }) => {
	const { t } = useTranslation();
	const router = useRouter();
	const { accounts, bankAccounts, createAccount, saveAccount, removeAccount, setCardOwedToday, convertCardToDebit } = useAccounts();

	const existing: Account | undefined = useMemo(
		() => accounts.find((account) => account.id === cardId && account.kind === 'credit_card'),
		[accounts, cardId]
	);

	const initialBrand = brandFor(existing?.bankName);
	const [bankId, setBankId] = useState<string>(initialBrand?.id ?? (existing?.bankName ? OTHER : 'nubank'));
	const [otherBank, setOtherBank] = useState(initialBrand ? '' : (existing?.bankName ?? ''));
	const [name, setName] = useState(existing?.name ?? '');
	const [last4, setLast4] = useState(existing?.last4 ?? '');
	const [network, setNetwork] = useState<CardNetwork | null>((existing?.network as CardNetwork | null) ?? null);
	const [limit, setLimit] = useState(existing?.creditLimitCents ? centsToDisplayInput(existing.creditLimitCents) : '');
	const [cardType, setCardType] = useState<CardType>('credit');
	const [debitAccountId, setDebitAccountId] = useState<string | null>(null);
	const [closingDaysBefore, setClosingDaysBefore] = useState(String(existing?.closingDaysBefore ?? DEFAULT_CLOSING_DAYS_BEFORE));
	const [dueDay, setDueDay] = useState(existing?.dueDay ? String(existing.dueDay) : '');
	const [currentInvoice, setCurrentInvoice] = useState('');
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!existing) return;
		const brand = brandFor(existing.bankName);
		setBankId(brand?.id ?? (existing.bankName ? OTHER : 'nubank'));
		setOtherBank(brand ? '' : (existing.bankName ?? ''));
		setName(existing.name);
		setLast4(existing.last4 ?? '');
		setNetwork((existing.network as CardNetwork | null) ?? null);
		setLimit(existing.creditLimitCents ? centsToDisplayInput(existing.creditLimitCents) : '');
		setClosingDaysBefore(String(existing.closingDaysBefore ?? DEFAULT_CLOSING_DAYS_BEFORE));
		setDueDay(existing.dueDay ? String(existing.dueDay) : '');
	}, [existing]);

	const brand = BANK_BRANDS.find((b) => b.id === bankId) ?? null;
	const bankName = bankId === OTHER ? otherBank.trim() : (brand?.name ?? '');
	const color = brand?.color ?? (existing && bankId === OTHER ? existing.color : NEUTRAL_CARD_COLOR);

	const bankOptions: ChipOption<string>[] = [
		...POPULAR_BANKS.map((id) => BANK_BRANDS.find((b) => b.id === id))
			.filter((b): b is (typeof BANK_BRANDS)[number] => Boolean(b))
			.map((b) => ({ value: b.id, label: b.name, color: b.color })),
		{ value: OTHER, label: t('cards.edit.otherBank') },
	];
	const networkOptions: ChipOption<CardNetwork>[] = CARD_NETWORKS.map((n) => ({ value: n, label: NETWORK_LABELS[n] }));

	const parseDay = (value: string): number | null | false => {
		if (value.trim() === '') return null;
		const day = Number(value);
		return Number.isInteger(day) && day >= 1 && day <= 31 ? day : false;
	};

	const preview: Account = {
		...(existing ?? {
			id: 'preview',
			kind: 'credit_card',
			role: 'card',
			envelopeMonthlyCents: null,
			packageName: null,
			accountKey: null,
			openingBalanceCents: 0,
			openingBalanceDate: todayISO(),
			sortOrder: 0,
			archived: false,
			updatedAt: '',
		}),
		name: name.trim() || bankName || t('cards.edit.newTitle'),
		bankName: bankName || null,
		color,
		last4: last4 || null,
		network,
		closingDay: null,
		dueDay: null,
		closingDaysBefore: null,
		creditLimitCents: null,
	};

	const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

	const handleSave = async () => {
		const next: Record<string, string | undefined> = {};
		if (!bankName) next.bank = t('cards.edit.bankRequired');
		const due = parseDay(dueDay);
		const daysBefore = Number(closingDaysBefore);
		if (!Number.isInteger(daysBefore) || daysBefore < 1 || daysBefore > 20) next.closing = t('cards.edit.invalidDaysBefore');
		if (due === false) next.due = t('cards.edit.invalidDay');
		if (last4 && !/^\d{4}$/.test(last4)) next.last4 = t('cards.edit.invalidLast4');

		let limitCents: number | null = null;
		if (limit.trim()) {
			limitCents = parseAmountToCents(limit);
			if (limitCents === null || limitCents <= 0) next.limit = t('cards.edit.invalidAmount');
		}
		let invoiceCents: number | null = null;
		if (!existing && currentInvoice.trim()) {
			invoiceCents = parseAmountToCents(currentInvoice);
			if (invoiceCents === null || invoiceCents < 0) next.invoice = t('cards.edit.invalidAmount');
		}

		setErrors(next);
		const messages = Object.values(next).filter(Boolean);
		if (messages.length > 0) {
			announce(messages.join('. '));
			return;
		}

		const draft: AccountDraft = {
			name: name.trim() || (last4 ? `${bankName} · ${last4}` : bankName),
			kind: 'credit_card',
			role: 'card',
			envelopeMonthlyCents: null,
			network,
			bankName,
			color,
			last4: last4 || null,
			closingDay: null,
			dueDay: due as number | null,
			closingDaysBefore: due ? daysBefore : null,
			creditLimitCents: limitCents,
			packageName: existing?.packageName ?? null,
			accountKey: existing?.accountKey ?? null,
			openingBalanceCents: existing?.openingBalanceCents ?? 0,
			openingBalanceDate: existing?.openingBalanceDate ?? todayISO(),
			sortOrder: existing?.sortOrder ?? accounts.length,
			archived: existing?.archived ?? false,
		};

		try {
			setSaving(true);
			if (existing) {
				await saveAccount({ ...draft, id: existing.id });
				announce(t('cards.edit.saved'));
				router.back();
			} else {
				const id = await createAccount(draft);
				if (invoiceCents !== null && invoiceCents > 0) await setCardOwedToday(id, invoiceCents);
				router.replace({ pathname: '/cards/[id]', params: { id } });
			}
		} finally {
			setSaving(false);
		}
	};

	const sameBankAccount = bankAccounts.find((account) => brandFor(account.bankName)?.id === bankId) ?? null;
	const chosenDebitAccount = bankAccounts.find((account) => account.id === (debitAccountId ?? sameBankAccount?.id)) ?? null;

	const handleConvertToDebit = () => {
		if (!existing || !chosenDebitAccount) return;
		Alert.alert(t('cards.edit.debitConvert'), t('cards.edit.debitConfirm', { account: chosenDebitAccount.name }), [
			{ text: t('cards.cancel'), style: 'cancel' },
			{
				text: t('cards.edit.debitConvert'),
				onPress: async () => {
					await convertCardToDebit(existing.id, chosenDebitAccount.id);
					announce(t('cards.edit.debitDone', { account: chosenDebitAccount.name }));
					router.replace('/cards/index');
				},
			},
		]);
	};

	const handleArchive = async () => {
		if (!existing) return;
		await saveAccount({ ...existing, archived: !existing.archived });
		announce(existing.archived ? t('cards.edit.unarchived') : t('cards.edit.archived'));
		router.back();
	};

	const handleDelete = () => {
		if (!existing) return;
		Alert.alert(t('cards.edit.delete'), t('cards.edit.deleteConfirm'), [
			{ text: t('cards.cancel'), style: 'cancel' },
			{
				text: t('cards.edit.delete'),
				style: 'destructive',
				onPress: async () => {
					await removeAccount(existing.id);
					router.replace('/cards/index');
				},
			},
		]);
	};

	return (
		<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
			<Stack.Screen options={{ headerShown: false }} />
			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<View style={styles.header}>
					<Pressable
						onPress={() => router.back()}
						accessibilityRole="button"
						accessibilityLabel={t('cards.back')}
						style={styles.iconButton}
					>
						<Ionicons name="arrow-back" size={24} color="#FFFFFF" />
					</Pressable>
					<Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
						{existing ? t('cards.edit.title') : t('cards.edit.newTitle')}
					</Text>
				</View>

				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
						<CardFace card={preview} summary={undefined} />
					</View>

					<ChipGroup
						label={t('cards.edit.type')}
						options={[
							{ value: 'credit', label: t('cards.edit.credit') },
							{ value: 'debit', label: t('cards.edit.debit') },
						]}
						selected={cardType}
						onSelect={(value) => setCardType(value)}
					/>

					{cardType === 'debit' ? (
						<View style={styles.debit} accessibilityLiveRegion="polite">
							<Text style={styles.debitBody}>{t('cards.edit.debitBody')}</Text>
							{existing ? (
								bankAccounts.length > 0 ? (
									<>
										<ChipGroup
											label={t('cards.edit.debitAccount')}
											options={bankAccounts.map((account) => ({ value: account.id, label: account.name, color: account.color }))}
											selected={chosenDebitAccount?.id ?? null}
											onSelect={(value) => setDebitAccountId(value)}
										/>
										<Button
											label={t('cards.edit.debitConvert')}
											icon="swap-horizontal"
											onPress={handleConvertToDebit}
											disabled={!chosenDebitAccount}
										/>
									</>
								) : (
									<Text style={styles.debitBody}>{t('cards.edit.debitNoAccount')}</Text>
								)
							) : (
								<Button label={t('cards.back')} icon="arrow-back" variant="secondary" onPress={() => router.back()} />
							)}
						</View>
					) : null}

					{cardType === 'credit' ? (
					<>
					<ChipGroup
						label={t('cards.edit.bank')}
						options={bankOptions}
						selected={bankId}
						onSelect={(value) => setBankId(value)}
					/>
					{errors.bank && bankId !== OTHER ? (
						<Text style={styles.error} accessibilityLiveRegion="polite">
							{errors.bank}
						</Text>
					) : null}
					{bankId === OTHER ? (
						<Field
							label={t('cards.edit.bankName')}
							value={otherBank}
							onChangeText={setOtherBank}
							placeholder={t('cards.edit.bankNamePlaceholder')}
							error={errors.bank}
						/>
					) : null}

					<Field
						label={t('cards.edit.nickname')}
						optionalLabel={t('cards.edit.optional')}
						value={name}
						onChangeText={setName}
						placeholder={t('cards.edit.nicknamePlaceholder')}
						hint={t('cards.edit.nicknameHint')}
					/>

					<Field
						label={t('cards.edit.last4')}
						optionalLabel={t('cards.edit.optional')}
						value={last4}
						onChangeText={(text) => setLast4(text.replace(/\D/g, '').slice(0, 4))}
						keyboardType="number-pad"
						maxLength={4}
						hint={t('cards.edit.last4Hint')}
						error={errors.last4}
					/>

					<ChipGroup
						label={t('cards.edit.network')}
						options={networkOptions}
						selected={network}
						onSelect={(value) => setNetwork(value === network ? null : value)}
					/>

					<Field
						label={t('cards.edit.limit')}
						optionalLabel={t('cards.edit.optional')}
						value={limit}
						onChangeText={setLimit}
						keyboardType="decimal-pad"
						hint={t('cards.edit.limitHint')}
						error={errors.limit}
					/>

					<View style={styles.twoColumns}>
						<View style={styles.column}>
							<Field
								label={t('cards.edit.dueDay')}
								value={dueDay}
								onChangeText={(text) => setDueDay(text.replace(/\D/g, '').slice(0, 2))}
								keyboardType="number-pad"
								maxLength={2}
								error={errors.due}
							/>
						</View>
						<View style={styles.column}>
							<Field
								label={t('cards.edit.closingDaysBefore')}
								value={closingDaysBefore}
								onChangeText={(text) => setClosingDaysBefore(text.replace(/\D/g, '').slice(0, 2))}
								keyboardType="number-pad"
								maxLength={2}
								error={errors.closing}
							/>
						</View>
					</View>
					<Text style={styles.explain}>{t('cards.edit.cycleHint')}</Text>

					{!existing ? (
						<Field
							label={t('cards.edit.currentInvoice')}
							optionalLabel={t('cards.edit.optional')}
							value={currentInvoice}
							onChangeText={setCurrentInvoice}
							keyboardType="decimal-pad"
							hint={t('cards.edit.currentInvoiceHint')}
							error={errors.invoice}
						/>
					) : null}

					<Button label={t('cards.edit.save')} onPress={handleSave} disabled={saving} icon="checkmark" />

					{existing ? (
						<View style={styles.secondary}>
							<Button
								label={existing.archived ? t('cards.edit.unarchive') : t('cards.edit.archive')}
								hint={t('cards.edit.archiveHint')}
								onPress={handleArchive}
								variant="secondary"
								icon={existing.archived ? 'arrow-undo-outline' : 'archive-outline'}
							/>
							<Button label={t('cards.edit.delete')} onPress={handleDelete} variant="danger" icon="trash-outline" />
						</View>
					) : null}
					</>
					) : null}
				</ScrollView>
			</KeyboardAvoidingView>
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
		paddingHorizontal: 8,
		paddingVertical: 4,
		gap: 4,
	},
	iconButton: {
		width: 48,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headerTitle: {
		flex: 1,
		fontSize: 22,
		fontWeight: '700',
		color: '#FFFFFF',
	},
	content: {
		paddingHorizontal: 16,
		paddingBottom: 60,
		gap: 18,
	},
	error: {
		fontSize: 13,
		color: '#FF8A80',
		marginTop: -10,
	},
	twoColumns: {
		flexDirection: 'row',
		gap: 12,
	},
	column: {
		flex: 1,
	},
	explain: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.7)',
		marginTop: -8,
	},
	secondary: {
		gap: 10,
	},
	debit: {
		gap: 14,
		backgroundColor: '#1E1E1E',
		borderRadius: 16,
		padding: 16,
	},
	debitBody: {
		fontSize: 15,
		lineHeight: 22,
		color: 'rgba(255,255,255,0.85)',
	},
});

export default CardEditScreen;
