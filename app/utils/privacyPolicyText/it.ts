import type { PrivacyPolicy } from '../privacyPolicy';

/** A política em italiano, tradução fiel da versão em português. Igual a `docs/privacy-policy.it.html`. */
const it: PrivacyPolicy = {
	title: 'I tuoi dati sono tuoi.',
	accent: 'Nulla viene venduto.',
	intro:
		'Spendr funziona sul tuo dispositivo. Se crei un account, una copia dei tuoi dati resta sul server di Spendr per sincronizzarli e ritrovarli su un nuovo dispositivo. Niente pubblicità, niente tracciamento, nessuna vendita di dati.',
	updated: 'Aggiornata il 27 ottobre 2026',
	pills: [
		{ icon: '📱', label: 'Funziona senza account' },
		{ icon: '☁️', label: 'Account facoltativo' },
		{ icon: '🚫', label: 'Nessun tracciamento' },
		{ icon: '🤝', label: 'Nulla viene venduto' },
	],
	sections: [
		{
			icon: '📱',
			title: 'Cosa resta sul tuo dispositivo',
			body: [
				'Movimenti, conti, carte, conti da pagare, budget, debiti, obiettivi, categorie e impostazioni sono salvati in un database sul dispositivo stesso.',
				"Senza account, nulla di tutto questo esce dal dispositivo. L'app usa internet solo per scaricare il tasso CDI e gli aggiornamenti dell'app stessa (vedi «Servizi di terze parti»).",
			],
		},
		{
			icon: '🔔',
			title: 'Notifiche della banca (acquisizione automatica)',
			body: [
				"Su Android, se consenti l'accesso alle notifiche, Spendr legge le notifiche in arrivo per trasformare acquisti, Pix e trasferimenti in movimenti.",
				"Viene salvata solo la notifica che riporta un importo in denaro e proviene da un'app bancaria (o da un messaggio che cita una banca): il titolo, il testo, l'app di origine e l'orario. Le altre notifiche vengono scartate senza essere salvate.",
				'Puoi disattivare questo accesso quando vuoi, nelle impostazioni di Android.',
			],
		},
		{
			icon: '☁️',
			title: 'Se crei un account',
			body: [
				"L'account è facoltativo e serve a sincronizzare i dati tra dispositivi e a recuperarli su un nuovo dispositivo. Con un account, il server di Spendr conserva:",
			],
			list: [
				[
					'Registrazione',
					"nome, e-mail, valuta e lingua. La password non viene mai salvata: solo un'impronta crittografica (bcrypt).",
				],
				[
					"I dati dell'app",
					"movimenti, conti e carte (nome, banca, ultime 4 cifre, limite e saldo), trasferimenti, conti da pagare, budget, debiti, obiettivi, le categorie che l'app ha imparato per ogni negozio e le tue preferenze.",
				],
				[
					'Notifiche della banca',
					'le notifiche acquisite, compreso il testo della notifica, perché la revisione possa continuare su un altro dispositivo.',
				],
			],
			after: [
				"La connessione con il server è cifrata (HTTPS). La sessione usa un accesso che scade dopo 15 minuti e una chiave di rinnovo salvata nell'archivio sicuro del dispositivo; sul server resta solo l'impronta di questa chiave.",
			],
		},
		{
			icon: '🩺',
			title: 'Diagnostica',
			body: [
				"Per correggere gli errori, l'app tiene un registro tecnico di ciò che ha fatto: cosa ha deciso su ogni notifica, gli errori di sincronizzazione, la versione dell'app, il sistema e un identificativo casuale dell'installazione (non è il numero del dispositivo).",
				'Con un account, questo registro viene inviato al server al massimo ogni 6 ore e cancellato dopo 30 giorni. Quando una notifica della banca non viene capita, il suo testo viene inviato insieme, perché la lettura possa essere corretta. Il registro non contiene mai e-mail, password o chiave di accesso.',
				"Il server registra anche ogni richiesta che riceve (il percorso, l'esito, il tempo e l'indirizzo IP senza le ultime cifre), senza il contenuto della richiesta.",
				'In Impostazioni, «Esporta diagnostica» salva questo registro in un file che esce dal dispositivo solo se lo condividi.',
			],
		},
		{
			icon: '🌐',
			title: 'Servizi di terze parti',
			list: [
				[
					'Banca Centrale del Brasile',
					"l'app consulta il tasso CDI per calcolare il rendimento dei conti. Nessun tuo dato viene inviato.",
				],
				['Expo', "distribuisce gli aggiornamenti dell'app."],
			],
			after: [
				'Spendr non usa pubblicità, analytics, tracciamento né segnalazioni di errore di terze parti, e non vende, affitta né condivide i tuoi dati.',
			],
		},
		{
			icon: '🔐',
			title: 'Permessi',
			list: [
				['Accesso alle notifiche', "per l'acquisizione automatica delle notifiche della banca. Facoltativo."],
				['Notifiche', 'per i promemoria dei conti da pagare. Generati sul dispositivo stesso.'],
				[
					'Biometria',
					"per bloccare l'app con l'impronta o il volto, tramite il sistema stesso. L'app non riceve dati biometrici.",
				],
				['File', 'per esportare e importare il backup, i report in CSV e gli estratti conto OFX.'],
				['Internet', "per l'account, la sincronizzazione e il tasso CDI."],
			],
		},
		{
			icon: '💾',
			title: 'Backup ed esportazione',
			body: [
				'Il backup e i report sono file che generi tu e invii dove preferisci, tramite la condivisione del sistema. Non sono cifrati e il backup contiene il testo delle notifiche della banca: conservali in un posto sicuro.',
			],
		},
		{
			icon: '🗑️',
			title: 'I tuoi controlli',
			list: [
				["Esci dall'account", 'chiude la sessione sul server e mantiene tutto su questo dispositivo.'],
				[
					'Reimposta tutti i dati',
					"in Impostazioni, cancella movimenti, conti, carte, conti da pagare, budget, debiti, obiettivi e notifiche acquisite; restano le categorie, ciò che l'app ha imparato di ogni negozio e le impostazioni. Con un account, cancella davvero anche sul server, e gli altri dispositivi collegati all'account cancellano alla sincronizzazione successiva. Di ogni notifica cancellata resta su questo dispositivo solo un segno, senza testo né importo, perché la stessa notifica non entri di nuovo.",
				],
				[
					"Elimina l'account",
					"in Impostazioni, nella sezione Account, elimina l'account e tutti i suoi dati sul server e su tutti i dispositivi collegati — su questo subito; gli altri escono dall'account e cancellano i dati la prossima volta che si collegano al server. Su ogni dispositivo restano le categorie, ciò che l'app ha imparato di ogni negozio e le impostazioni. Chi non ha più l'app può chiedere l'eliminazione dell'account via e-mail: vinicosta37@gmail.com.",
				],
			],
			after: [
				"Ai sensi della LGPD (la legge brasiliana sulla protezione dei dati), puoi chiedere l'accesso, la rettifica o la cancellazione dei tuoi dati. Il backup in Impostazioni ti dà già una copia di tutto; per il resto, scrivi al contatto qui sotto.",
			],
		},
		{
			icon: '👶',
			title: 'Minori',
			body: ['Spendr non è pensato per i minori di 13 anni e non raccoglie consapevolmente i loro dati.'],
		},
		{
			icon: '🔄',
			title: 'Modifiche a questa informativa',
			body: [
				"Quando questa informativa cambia, la nuova versione compare qui con la data di aggiornamento. Le nuove funzioni che usano i tuoi dati vengono spiegate prima di arrivare nell'app.",
			],
		},
		{
			icon: '✉️',
			title: 'Contatti',
			body: ['Domande su questa informativa o sui tuoi dati: vinicosta37@gmail.com.'],
		},
	],
	footer: 'Spendr — nato dal progetto open source di okazakee.',
};

export default it;
