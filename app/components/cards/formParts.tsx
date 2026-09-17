import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { Pressable, StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native';

/**
 * Campo e grupo de opções das telas de cartão.
 *
 * Rótulo sempre visível acima do campo (placeholder some ao digitar e não serve de
 * rótulo), dica e erro abaixo, erro anunciado ao aparecer. Opções são rádios com check
 * visível no selecionado — nunca só a cor.
 */

export const ACCENT = '#15E8FE';

interface FieldProps extends Omit<TextInputProps, 'style'> {
	label: string;
	hint?: string;
	error?: string;
	optionalLabel?: string;
}

export const Field: React.FC<FieldProps> = ({ label, hint, error, optionalLabel, ...input }) => (
	<View style={styles.field}>
		<Text style={styles.label}>
			{label}
			{optionalLabel ? <Text style={styles.optional}> · {optionalLabel}</Text> : null}
		</Text>
		<TextInput
			placeholderTextColor="rgba(255,255,255,0.4)"
			accessibilityLabel={label}
			accessibilityHint={hint}
			{...input}
			style={[styles.input, error ? styles.inputError : null]}
		/>
		{hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
		{error ? (
			<Text style={styles.error} accessibilityLiveRegion="polite">
				{error}
			</Text>
		) : null}
	</View>
);

export interface ChipOption<T extends string> {
	value: T;
	label: string;
	/** Cor de destaque do chip selecionado (a cor do banco, por exemplo). */
	color?: string;
}

interface ChipGroupProps<T extends string> {
	label: string;
	options: ChipOption<T>[];
	selected: T | null;
	onSelect: (value: T) => void;
	hint?: string;
}

export const ChipGroup = <T extends string>({ label, options, selected, onSelect, hint }: ChipGroupProps<T>) => (
	<View style={styles.field}>
		<Text style={styles.label}>{label}</Text>
		{hint ? <Text style={[styles.hint, styles.hintTop]}>{hint}</Text> : null}
		<View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
			{options.map((option) => {
				const isSelected = option.value === selected;
				const color = option.color ?? ACCENT;
				return (
					<Pressable
						key={option.value}
						onPress={() => onSelect(option.value)}
						accessibilityRole="radio"
						accessibilityState={{ selected: isSelected }}
						accessibilityLabel={option.label}
						style={({ pressed }) => [
							styles.chip,
							isSelected && { borderColor: color, backgroundColor: 'rgba(255,255,255,0.08)' },
							pressed && styles.pressed,
						]}
					>
						{option.color ? <View style={[styles.swatch, { backgroundColor: option.color }]} /> : null}
						<Text style={styles.chipLabel}>{option.label}</Text>
						{isSelected ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
					</Pressable>
				);
			})}
		</View>
	</View>
);

interface ButtonProps {
	label: string;
	onPress: () => void;
	icon?: React.ComponentProps<typeof Ionicons>['name'];
	variant?: 'primary' | 'secondary' | 'danger';
	disabled?: boolean;
	hint?: string;
}

export const Button: React.FC<ButtonProps> = ({ label, onPress, icon, variant = 'primary', disabled, hint }) => {
	const primary = variant === 'primary';
	const danger = variant === 'danger';
	const color = primary ? '#000000' : danger ? '#FF8A80' : '#FFFFFF';
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityHint={hint}
			accessibilityState={{ disabled: Boolean(disabled) }}
			style={({ pressed }) => [
				styles.button,
				primary && styles.buttonPrimary,
				danger && styles.buttonDanger,
				pressed && styles.pressed,
				disabled && styles.disabled,
			]}
		>
			{icon ? <Ionicons name={icon} size={20} color={color} /> : null}
			<Text style={[styles.buttonLabel, { color }]}>{label}</Text>
		</Pressable>
	);
};

const styles = StyleSheet.create({
	field: {
		gap: 6,
	},
	label: {
		fontSize: 14,
		fontWeight: '600',
		color: 'rgba(255,255,255,0.85)',
	},
	optional: {
		fontWeight: '400',
		color: 'rgba(255,255,255,0.55)',
	},
	input: {
		minHeight: 48,
		borderRadius: 12,
		paddingHorizontal: 14,
		backgroundColor: 'rgba(255,255,255,0.06)',
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.15)',
		color: '#FFFFFF',
		fontSize: 16,
	},
	inputError: {
		borderColor: '#FF8A80',
	},
	hint: {
		fontSize: 13,
		lineHeight: 18,
		color: 'rgba(255,255,255,0.65)',
	},
	hintTop: {
		marginTop: -2,
	},
	error: {
		fontSize: 13,
		color: '#FF8A80',
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		minHeight: 44,
		paddingHorizontal: 14,
		borderRadius: 22,
		borderWidth: 1.5,
		borderColor: 'rgba(255,255,255,0.2)',
	},
	swatch: {
		width: 14,
		height: 14,
		borderRadius: 7,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.4)',
	},
	chipLabel: {
		fontSize: 14,
		color: '#FFFFFF',
	},
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		minHeight: 50,
		paddingHorizontal: 16,
		borderRadius: 12,
		backgroundColor: 'rgba(255,255,255,0.1)',
	},
	buttonPrimary: {
		backgroundColor: ACCENT,
	},
	buttonDanger: {
		backgroundColor: 'rgba(255,138,128,0.14)',
	},
	buttonLabel: {
		fontSize: 16,
		fontWeight: '700',
	},
	pressed: {
		opacity: 0.7,
	},
	disabled: {
		opacity: 0.45,
	},
});

export default { Field, ChipGroup, Button };
