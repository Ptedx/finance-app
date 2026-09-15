import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useCaptures } from '../contexts/CapturesContext';

// biome-ignore lint/suspicious/noExplicitAny: external API shape unknown
const TabBarIcon = ({ name, color }: { name: any; color: string }) => {
	return <Ionicons name={name} size={24} color={color} />;
};

export default function TabsLayout() {
	const { t } = useTranslation();
	// O selo na aba inicial é o único lembrete de que há lançamentos capturados a
	// revisar: discreto, sem notificação, e some sozinho quando a fila esvazia.
	const { pendingCount } = useCaptures();

	return (
		<Tabs
			screenOptions={{
				tabBarStyle: styles.tabBar,
				tabBarBackground: () => (
					<BlurView intensity={10} tint="dark" style={StyleSheet.absoluteFill} />
				),
				tabBarActiveTintColor: '#15E8FE',
				tabBarInactiveTintColor: 'rgba(255, 255, 255, 0.5)',
				tabBarShowLabel: true,
				tabBarLabelStyle: styles.tabLabel,
				headerShown: false,
				tabBarHideOnKeyboard: true,
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: t('tabs.home'),
					tabBarIcon: ({ color }) => <TabBarIcon name="home" color={color} />,
					tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
					tabBarBadgeStyle: styles.badge,
					tabBarAccessibilityLabel:
						pendingCount > 0 ? `${t('tabs.home')}, ${t('captures.tabBadge', { count: pendingCount })}` : t('tabs.home'),
				}}
			/>
			<Tabs.Screen
				name="transactions"
				options={{
					title: t('tabs.transactions'),
					tabBarIcon: ({ color }) => <TabBarIcon name="list" color={color} />,
				}}
			/>
			<Tabs.Screen
				name="add-transaction"
				options={{
					title: '',
					tabBarLabel: () => null,
					tabBarIcon: () => (
						<View style={styles.addButtonContainer}>
							<View style={styles.addButtonBackground}>
								<Ionicons name="add" size={30} color="#000000" />
							</View>
						</View>
					),
				}}
			/>
			<Tabs.Screen
				name="reports"
				options={{
					title: t('tabs.reports'),
					tabBarLabel: t('tabs.reports'),
					tabBarLabelStyle: {
						fontSize: 12,
						fontWeight: '500',
						width: '100%',
						textAlign: 'center',
					},
					tabBarIcon: ({ color }) => <TabBarIcon name="pie-chart" color={color} />,
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					title: t('tabs.settings'),
					tabBarIcon: ({ color }) => <TabBarIcon name="settings-outline" color={color} />,
				}}
			/>
		</Tabs>
	);
}

const styles = StyleSheet.create({
	tabBar: {
		position: 'absolute',
		backgroundColor: 'rgba(18, 18, 18, 1)',
		borderTopWidth: 1,
		borderTopColor: 'rgba(255, 255, 255, 1)',
		height: 70,
		paddingBottom: 20,
	},
	tabLabel: {
		fontSize: 12,
		fontWeight: '500',
	},
	badge: {
		backgroundColor: '#15E8FE',
		color: '#000000',
		fontSize: 11,
		fontWeight: '700',
	},
	addButtonContainer: {
		top: -10,
		justifyContent: 'center',
		alignItems: 'center',
	},
	addButtonBackground: {
		backgroundColor: '#15E8FE',
		borderRadius: 50,
		width: 60,
		height: 60,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
