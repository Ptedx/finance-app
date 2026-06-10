import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

export default function OnboardingLayout() {
	return (
		<View style={styles.container}>
			<Stack
				screenOptions={{
					headerShown: false,
					contentStyle: { backgroundColor: '#121212' },
					animation: 'slide_from_right',
				}}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: '#121212',
	},
});
