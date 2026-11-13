import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ACCENT, type ChipOption } from './cards/formParts';
import Sheet from './cards/Sheet';

/**
 * Campo de escolha única que abre uma lista de baixo para cima (SPD-130).
 *
 * Os grupos de botões (banco, conta, categoria) ocupavam meia tela com 11 opções. O campo
 * tem a cara do `Field` (rótulo, dica, erro, "opcional") e mostra só a opção escolhida — com
 * a bolinha de cor ou o ícone dela — ou o texto de "escolher"; tocar abre a `Sheet` com
 * todas, a escolhida com check. Tocar numa linha escolhe e fecha.
 *
 * - Campo opcional (`clearLabel` + `onClear`): a lista começa com a linha que limpa
 *   ("Nenhuma", "Sem conta", "Todas as contas"), que aparece escolhida quando nada está.
 * - `featured`: uma seção no topo (as categorias mais usadas), e depois todas.
 * - Lista com mais de `SEARCH_FROM` opções ganha um campo de busca no topo.
 * - `compact`: sem o rótulo visível (o filtro da lista de lançamentos); o leitor de tela
 *   continua ouvindo o rótulo.
 *
 * Acessibilidade: o campo é um botão cujo rótulo diz o nome do campo e o valor atual; a
 * lista é um `radiogroup` com o nome do campo, cada linha um `radio` com `selected` e pelo
 * menos 48 pontos, e a escolhida tem check visível — nunca só a cor.
 */

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export interface SelectOption<T extends string> extends ChipOption<T> {
	/** Ícone da opção (o tipo da conta, o da categoria), na cor dela. */
	icon?: IconName;
	/** Uma segunda linha, menor (o banco da conta, para separar dois nomes iguais). */
	description?: string;
}

/** Uma seção no topo da lista; as opções continuam todas depois, sob `restTitle`. */
export interface SelectFeatured<T extends string> {
	title: string;
	values: T[];
	restTitle: string;
}

/** A partir de quantas opções a lista ganha a busca. */
export const SEARCH_FROM = 12;

/** Sem acento e sem maiúscula: "saude" acha "Saúde". */
const normalize = (text: string): string =>
	text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.trim();

/** As opções cujo nome (ou a segunda linha) contém o que foi digitado. */
export const filterSelectOptions = <T extends string>(options: SelectOption<T>[], query: string): SelectOption<T>[] => {
	const wanted = normalize(query);
	if (!wanted) return options;
	return options.filter(
		(option) => normalize(option.label).includes(wanted) || (option.description ? normalize(option.description).includes(wanted) : false)
	);
};

/** A bolinha de cor ou o ícone da opção. */
const OptionMark: React.FC<{ color?: string; icon?: IconName; size?: 'small' | 'regular' }> = ({ color, icon, size = 'regular' }) => {
	if (icon) {
		const box = size === 'small' ? 28 : 36;
		return (
			<View
				style={[
					styles.iconBox,
					{ width: box, height: box, borderRadius: box / 2 },
					{ backgroundColor: color ? `${color}33` : 'rgba(255,255,255,0.08)' },
				]}
			>
				<Ionicons name={icon} size={size === 'small' ? 16 : 20} color={color ?? '#FFFFFF'} />
			</View>
		);
	}
	if (color) return <View style={[styles.swatch, { backgroundColor: color }]} />;
	return null;
};

interface SelectSheetProps<T extends string> {
	visible: boolean;
	title: string;
	subtitle?: string;
	options: SelectOption<T>[];
	selected: T | null;
	/** Escolher já fecha a folha (chama `onClose` depois). */
	onSelect: (value: T) => void;
	onClose: () => void;
	clearLabel?: string;
	onClear?: () => void;
	featured?: SelectFeatured<T>;
	/** Prefixo do `testID` de cada linha (`<prefixo><valor>`). */
	optionTestID?: string;
}

/**
 * Só a lista, numa folha. O `SelectField` a usa; a Caixa de entrada também, com a linha da
 * conta e o chip da categoria do cartão da revisão como gatilho.
 */
export const SelectSheet = <T extends string>({
	visible,
	title,
	subtitle,
	options,
	selected,
	onSelect,
	onClose,
	clearLabel,
	onClear,
	featured,
	optionTestID,
}: SelectSheetProps<T>) => {
	const { t } = useTranslation();
	const [query, setQuery] = useState('');
	// A busca começa vazia a cada abertura.
	useEffect(() => {
		if (visible) setQuery('');
	}, [visible]);

	const searchable = options.length > SEARCH_FROM;
	const searching = searchable && query.trim() !== '';
	const shown = searching ? filterSelectOptions(options, query) : options;
	const featuredOptions =
		featured && !searching
			? featured.values.map((value) => options.find((option) => option.value === value)).filter((option): option is SelectOption<T> => Boolean(option))
			: [];
	const hasClear = Boolean(clearLabel && onClear) && !searching;

	const choose = (value: T) => {
		onSelect(value);
		onClose();
	};

	const row = (key: string, option: SelectOption<T>) => {
		const isSelected = option.value === selected;
		return (
			<Pressable
				key={key}
				testID={optionTestID ? `${optionTestID}${option.value}` : undefined}
				onPress={() => choose(option.value)}
				accessibilityRole="radio"
				accessibilityState={{ selected: isSelected }}
				accessibilityLabel={option.label}
				accessibilityHint={option.description}
				style={({ pressed }) => [styles.row, isSelected && { borderColor: option.color ?? ACCENT }, pressed && styles.pressed]}
			>
				<OptionMark color={option.color} icon={option.icon} />
				<View style={styles.rowTexts}>
					<Text style={styles.rowLabel} numberOfLines={2}>
						{option.label}
					</Text>
					{option.description ? (
						<Text style={styles.rowDescription} numberOfLines={1}>
							{option.description}
						</Text>
					) : null}
				</View>
				{isSelected ? <Ionicons name="checkmark" size={22} color="#FFFFFF" /> : null}
			</Pressable>
		);
	};

	return (
		<Sheet visible={visible} title={title} subtitle={subtitle} onClose={onClose}>
			{searchable ? (
				<View style={styles.searchRow}>
					<Ionicons name="search" size={18} color="rgba(255,255,255,0.6)" />
					<TextInput
						style={styles.searchInput}
						value={query}
						onChangeText={setQuery}
						placeholder={t('select.search')}
						placeholderTextColor="rgba(255,255,255,0.4)"
						accessibilityLabel={t('select.searchLabel', { field: title })}
						autoCorrect={false}
						returnKeyType="search"
					/>
				</View>
			) : null}
			<View style={styles.list} accessibilityRole="radiogroup" accessibilityLabel={title}>
				{hasClear ? (
					<Pressable
						key="__none"
						testID={optionTestID ? `${optionTestID}__none` : undefined}
						onPress={() => {
							onClear?.();
							onClose();
						}}
						accessibilityRole="radio"
						accessibilityState={{ selected: selected === null }}
						accessibilityLabel={clearLabel}
						style={({ pressed }) => [styles.row, selected === null && { borderColor: ACCENT }, pressed && styles.pressed]}
					>
						<View style={[styles.iconBox, styles.noneBox]}>
							<Ionicons name="remove-circle-outline" size={20} color="rgba(255,255,255,0.8)" />
						</View>
						<Text style={[styles.rowLabel, styles.rowTexts]}>{clearLabel}</Text>
						{selected === null ? <Ionicons name="checkmark" size={22} color="#FFFFFF" /> : null}
					</Pressable>
				) : null}
				{featuredOptions.length > 0 && featured ? (
					<>
						<Text style={styles.section} accessibilityRole="header">
							{featured.title}
						</Text>
						{featuredOptions.map((option) => row(`featured-${option.value}`, option))}
						<Text style={styles.section} accessibilityRole="header">
							{featured.restTitle}
						</Text>
					</>
				) : null}
				{shown.map((option) => row(option.value, option))}
				{searching && shown.length === 0 ? (
					<Text style={styles.empty} accessibilityLiveRegion="polite">
						{t('select.noResults')}
					</Text>
				) : null}
			</View>
		</Sheet>
	);
};

interface SelectFieldProps<T extends string> {
	label: string;
	options: SelectOption<T>[];
	selected: T | null;
	onSelect: (value: T) => void;
	/** O que o campo mostra sem escolha. Sem ele, o `clearLabel` ou "Escolher". */
	placeholder?: string;
	hint?: string;
	error?: string;
	optionalLabel?: string;
	/** A linha que limpa a escolha, para campo opcional. Só aparece com `onClear`. */
	clearLabel?: string;
	onClear?: () => void;
	featured?: SelectFeatured<T>;
	/** Explicação no topo da folha. */
	sheetSubtitle?: string;
	/** Sem o rótulo visível e sem a dica: o filtro numa linha. */
	compact?: boolean;
	/** Algo ao lado do rótulo (o "Editar categorias"). */
	labelAccessory?: React.ReactNode;
	disabled?: boolean;
	testID?: string;
	/** Prefixo do `testID` de cada linha da lista. */
	optionTestID?: string;
}

export const SelectField = <T extends string>({
	label,
	options,
	selected,
	onSelect,
	placeholder,
	hint,
	error,
	optionalLabel,
	clearLabel,
	onClear,
	featured,
	sheetSubtitle,
	compact = false,
	labelAccessory,
	disabled = false,
	testID,
	optionTestID,
}: SelectFieldProps<T>) => {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const current = options.find((option) => option.value === selected) ?? null;
	const clearable = Boolean(clearLabel && onClear);
	// Sem escolha num campo opcional, a linha que limpa é o valor; num obrigatório, o convite.
	const shownText = current?.label ?? placeholder ?? (clearable ? clearLabel : undefined) ?? t('select.placeholder');
	const dim = current === null && !clearable;

	return (
		<View style={compact ? null : styles.field}>
			{compact ? null : (
				<View style={styles.labelRow}>
					<Text style={styles.label}>
						{label}
						{optionalLabel ? <Text style={styles.optional}> · {optionalLabel}</Text> : null}
					</Text>
					{labelAccessory}
				</View>
			)}
			<Pressable
				testID={testID}
				onPress={() => setOpen(true)}
				disabled={disabled}
				accessibilityRole="button"
				accessibilityLabel={`${label}, ${shownText}`}
				accessibilityHint={compact ? undefined : hint}
				accessibilityState={{ expanded: open, disabled }}
				style={({ pressed }) => [
					styles.input,
					compact && styles.inputCompact,
					error ? styles.inputError : null,
					pressed && styles.pressed,
					disabled && styles.disabled,
				]}
			>
				{current ? <OptionMark color={current.color} icon={current.icon} size="small" /> : null}
				<Text style={[styles.value, dim && styles.placeholder]} numberOfLines={1}>
					{shownText}
				</Text>
				<Ionicons name="chevron-down" size={20} color="rgba(255,255,255,0.7)" />
			</Pressable>
			{hint && !error && !compact ? <Text style={styles.hint}>{hint}</Text> : null}
			{error ? (
				<Text style={styles.error} accessibilityLiveRegion="polite">
					{error}
				</Text>
			) : null}
			<SelectSheet
				visible={open}
				title={label}
				subtitle={sheetSubtitle}
				options={options}
				selected={current ? current.value : null}
				onSelect={onSelect}
				onClose={() => setOpen(false)}
				clearLabel={clearLabel}
				onClear={onClear}
				featured={featured}
				optionTestID={optionTestID}
			/>
		</View>
	);
};

const styles = StyleSheet.create({
	field: {
		gap: 6,
	},
	labelRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
	},
	label: {
		flexShrink: 1,
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	optional: {
		fontWeight: '400',
		color: 'rgba(255,255,255,0.55)',
	},
	input: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
		minHeight: 48,
		borderRadius: 12,
		paddingHorizontal: 14,
		paddingVertical: 6,
		backgroundColor: 'rgba(255,255,255,0.06)',
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	inputCompact: {
		borderRadius: 24,
	},
	inputError: {
		borderColor: '#FF8A80',
	},
	value: {
		flex: 1,
		fontSize: 16,
		color: '#FFFFFF',
	},
	placeholder: {
		color: 'rgba(255,255,255,0.5)',
	},
	hint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.65)',
	},
	error: {
		fontSize: 13,
		color: '#FF8A80',
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.45,
	},
	swatch: {
		width: 14,
		height: 14,
		borderRadius: 7,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.4)',
	},
	iconBox: {
		width: 36,
		height: 36,
		borderRadius: 18,
		alignItems: 'center',
		justifyContent: 'center',
	},
	noneBox: {
		backgroundColor: 'rgba(255,255,255,0.08)',
	},
	searchRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 48,
		paddingHorizontal: 12,
		borderRadius: 12,
		backgroundColor: 'rgba(255,255,255,0.06)',
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
	},
	searchInput: {
		flex: 1,
		minHeight: 46,
		color: '#FFFFFF',
		fontSize: 16,
	},
	list: {
		gap: 8,
	},
	section: {
		fontSize: 13,
		fontWeight: '700',
		textTransform: 'uppercase',
		letterSpacing: 0.5,
		color: 'rgba(255,255,255,0.6)',
		marginTop: 6,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 12,
		minHeight: 56,
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 12,
		borderWidth: 1.5,
		borderColor: 'transparent',
		backgroundColor: 'rgba(255,255,255,0.06)',
	},
	rowTexts: {
		flex: 1,
	},
	rowLabel: {
		fontSize: 16,
		fontWeight: '600',
		color: '#FFFFFF',
	},
	rowDescription: {
		fontSize: 13,
		color: 'rgba(255,255,255,0.7)',
		marginTop: 2,
	},
	empty: {
		fontSize: 14,
		color: 'rgba(255,255,255,0.65)',
		textAlign: 'center',
		paddingVertical: 16,
	},
});

export default SelectField;
