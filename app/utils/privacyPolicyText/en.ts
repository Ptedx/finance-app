import type { PrivacyPolicy } from '../privacyPolicy';

/** A política em inglês, tradução fiel da versão em português. Igual a `docs/privacy-policy.en.html`. */
const en: PrivacyPolicy = {
	title: 'Your data is yours.',
	accent: 'Nothing is sold.',
	intro:
		'Spendr runs on your device. If you create an account, a copy of your data is kept on the Spendr server so it can sync and come back on a new device. There are no ads, no tracking and no selling of data.',
	updated: 'Updated October 27, 2026',
	pills: [
		{ icon: '📱', label: 'Works without an account' },
		{ icon: '☁️', label: 'Optional account' },
		{ icon: '🚫', label: 'No tracking' },
		{ icon: '🤝', label: 'Nothing is sold' },
	],
	sections: [
		{
			icon: '📱',
			title: 'What stays on your device',
			body: [
				'Transactions, accounts, cards, bills, budgets, debts, goals, categories and settings are kept in a database on the device itself.',
				'Without an account, none of this leaves the device. The app only uses the internet to fetch the CDI rate and updates to the app itself (see "Third-party services").',
			],
		},
		{
			icon: '🔔',
			title: 'Bank notifications (automatic capture)',
			body: [
				'On Android, if you allow notification access, Spendr reads incoming notifications to turn purchases, Pix payments and transfers into transactions.',
				'Only a notification that shows an amount of money and comes from a banking app (or from a message that mentions a bank) is kept: its title, text, source app and time. All other notifications are discarded without being stored.',
				'You can turn this access off whenever you want, in the Android settings.',
			],
		},
		{
			icon: '☁️',
			title: 'If you create an account',
			body: [
				'The account is optional and is used to sync your data between devices and to recover it on a new device. With an account, the Spendr server stores:',
			],
			list: [
				[
					'Sign-up details',
					'name, email, currency and language. Your password is never stored: only a cryptographic hash of it (bcrypt).',
				],
				[
					'Your app data',
					'transactions, accounts and cards (name, bank, last 4 digits, limit and balance), transfers, bills, budgets, debts, goals, the categories the app learned for each merchant, and your preferences.',
				],
				[
					'Bank notifications',
					'the captured notifications, including the notification text, so that the review can continue on another device.',
				],
			],
			after: [
				'The connection to the server is encrypted (HTTPS). The session uses an access token that expires in 15 minutes and a refresh key kept in the secure storage of the device; the server keeps only a hash of that key.',
			],
		},
		{
			icon: '🩺',
			title: 'Diagnostics',
			body: [
				'To fix bugs, the app keeps a technical log of what it did: what it decided about each notification, sync failures, the app version, the operating system and a random installation identifier (it is not the device number).',
				'With an account, this log is sent to the server at most once every 6 hours and deleted after 30 days. When a bank notification is not understood, its text is sent along with it, so that the reading can be fixed. The log never includes your email, password or access key.',
				'The server also records each request it receives (the path, the result, the time and the IP address without its last digits), without the content of the request.',
				'In Settings, "Export diagnostics" saves this log to a file that only leaves the device if you share it.',
			],
		},
		{
			icon: '🌐',
			title: 'Third-party services',
			list: [
				[
					'Central Bank of Brazil',
					'the app looks up the CDI rate to calculate the yield of your accounts. None of your data is sent.',
				],
				['Expo', 'delivers the app updates.'],
			],
			after: [
				'Spendr does not use ads, analytics, tracking or third-party error reporting, and does not sell, rent or share your data.',
			],
		},
		{
			icon: '🔐',
			title: 'Permissions',
			list: [
				['Notification access', 'for the automatic capture of bank notifications. Optional.'],
				['Notifications', 'for bill reminders. Created on the device itself.'],
				[
					'Biometrics',
					'to lock the app with your fingerprint or face, through the system itself. The app does not receive biometric data.',
				],
				['Files', 'to export and import backups, CSV reports and OFX statements.'],
				['Internet', 'for the account, syncing and the CDI rate.'],
			],
		},
		{
			icon: '💾',
			title: 'Backup and export',
			body: [
				'Backups and reports are files you create and send wherever you choose, through the system share sheet. They are not encrypted, and the backup includes the text of the bank notifications: keep them somewhere safe.',
			],
		},
		{
			icon: '🗑️',
			title: 'Your controls',
			list: [
				['Sign out', 'ends the session on the server and keeps everything on this device.'],
				[
					'Reset all data',
					'in Settings, deletes transactions, accounts, cards, bills, budgets, debts, goals and captured notifications; the categories, what the app learned about each merchant and the settings are kept. With an account, it also truly deletes them on the server, and the other devices connected to it delete them at the next sync. For each deleted notification, only a marker, with no text or amount, stays on this device, so that the same notification does not come in again.',
				],
				[
					'Delete account',
					'in Settings, in the Account section, deletes the account and all of its data on the server and on every device connected to it — on this one right away; the others are signed out and delete the data the next time they talk to the server. On each device, the categories, what the app learned about each merchant and the settings are kept. If you no longer have the app, you can ask for the account to be deleted by email: vinicosta37@gmail.com.',
				],
			],
			after: [
				'Under the LGPD (the Brazilian data protection law), you can ask for access to, correction of or deletion of your data. The backup in Settings already gives you a copy of everything; for the rest, ask through the contact below.',
			],
		},
		{
			icon: '👶',
			title: 'Children',
			body: ['Spendr is not made for children under 13 and does not knowingly collect their data.'],
		},
		{
			icon: '🔄',
			title: 'Changes to this policy',
			body: [
				'When this policy changes, the new version appears here with the date it was updated. New features that use your data are explained before they arrive in the app.',
			],
		},
		{
			icon: '✉️',
			title: 'Contact',
			body: ['Questions about this policy or about your data: vinicosta37@gmail.com.'],
		},
	],
	footer: 'Spendr — built from the open-source project by okazakee.',
};

export default en;
