# Nuova sezione HAUL - CravattaCinese

## Google Sheets (un nuovo documento, una sola scheda `hauls`)

Copia esattamente queste intestazioni sulla riga 1, da A a I:

`id | title | cover_image | weight_kg | dimensions_cm | shipping_agent | description | package_photos | items`

Esempio di dati:
- id: `haul-001` (minuscole, numeri e trattini; non cambiare dopo la pubblicazione)
- title: `Haul Streetwear 5 kg`
- cover_image: URL HTTPS pubblico della copertina (obbligatorio)
- weight_kg: `5.4` (facoltativo)
- dimensions_cm: `40x30x25` (facoltativo)
- shipping_agent: `Mulebuy` (facoltativo)
- description: testo libero (facoltativo)
- package_photos: `https://foto-pacco-1.jpg | https://foto-pacco-2.jpg`
- items: **una riga per articolo NELLA STESSA CELLA**. Formato di ogni riga: `Titolo ; URL_FOTO_1 | URL_FOTO_2 ; URL_PRODOTTO`

Esempio colonna `items` (una singola cella, con a capo mediante Alt+Invio / Option+Invio, dipende dal sistema):

```
Felpa Stone Island ; https://example.com/felpa.jpg | https://example.com/felpa2.jpg ; https://example.com/prodotto-1
Sneakers Nike ; https://example.com/nike.jpg ; https://example.com/prodotto-2
```

Il campo `items` e la galleria del pacco possono rimanere vuoti. Gli haul sono visualizzati nell'ordine inverso delle righe, quindi i più recenti vanno in fondo al foglio. Solo le righe con id valido, titolo e copertina sono pubblicate.

## Collegamento Google

Nel `.env.local` del sito **aggiungi soltanto** questa nuova variabile (senza toccare quelle esistenti):

`HAULS_SHEET_ID="ID_DEL_NUOVO_GOOGLE_SHEET"`

Assicurati che il Google Sheet sia condiviso come Visualizzatore con l'indirizzo email del service account già configurato nel progetto. La pagina legge di default la scheda chiamata `hauls`.

## Installazione

1. Crea un backup del progetto o dei file che verranno sostituiti.
2. Estrai lo ZIP **nella cartella principale** `cravatta-app-optimized` (mantieni i percorsi interni).
3. Riavvia Next.js: `npm run dev`.
4. Verifica `/hauls`, `/hauls/haul-001` e la homepage.
5. Fai `npm run build` prima di pubblicare.

## Note

- `/tutorials` fa un redirect a `/hauls`, così vecchi link non risultano rotti.
- Il file TutorialCarousel.tsx non è usato dalla nuova homepage, ma puoi rimuoverlo **solo dopo** aver verificato che non esistano altri import nel progetto.
- La modifica non cambia i componenti Seller o Spreadsheet.
- Foto: usa URL HTTPS diretti, pubblicamente accessibili, con permessi di utilizzo.
