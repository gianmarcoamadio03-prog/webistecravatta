## Cravatta

Next.js app (App Router) che mostra un **catalogo** letto da Google Sheets:

- Home “premium” + carousel
- Pagina **Spreadsheet** con filtri/ricerca/paginazione
- Pagina **Item** con galleria + bottoni affiliate
- API route `/api/img` per proxy/cache immagini Yupoo (CDN-friendly)
- (Opzionale) **Quality Check** con OpenAI
- (Opzionale) **Support form** via SMTP

Nota: nel repo **non** vanno mai committati `node_modules`, `.next`, `.env.local` o file di credenziali.

---

## Setup locale

### 1) Install

```bash
npm install
npm run dev
```

Apri `http://localhost:3000`.

### 2) Environment

```bash
cp .env.example .env.local
```

Poi compila **almeno**:

- `SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (consigliato) **oppure** `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`

---

## Scraper (opzionale)

Lo scraper sta in `./scraper` (dipendenze separate).

```bash
cd scraper
npm install
cp .env.example .env
node scrape_yupoo_to_sheet.mjs "https://.../categories/..." --maxPages 5 --seller rainbowreps --brand "Amiri"
```

---

## Deploy online (consigliato: Vercel)

Perché Vercel: è “nativo” per Next.js, supporta ISR/cache, e gestisce bene le API routes.

### 1) Metti il progetto su GitHub

- Assicurati di NON includere `node_modules` e `.env.local` (già ignorati da `.gitignore`).

### 2) Import su Vercel

- Vai su Vercel → **Add New Project** → importa il repo.
- Framework: Next.js (auto-detect).
- Build command: `next build` (default).

### 3) Environment su Vercel

Project → **Settings → Environment Variables**

Inserisci le stesse variabili di `.env.local` (almeno Sheets + Service Account).

### 4) Deploy

Fai Deploy e testa l’URL `*.vercel.app`.

---

## Collegare il tuo dominio Wix

Hai 2 strade (scegli la più comoda):

### Opzione A — Sostituisci il sito Wix con questo Next.js (dominio principale)

1. In Vercel: Project → **Settings → Domains** → aggiungi `tuodominio.com` e `www.tuodominio.com`.
2. Vercel ti mostra i record DNS da impostare.
3. In Wix: **Domains → Advanced → DNS** (o “Manage DNS”) e imposta:
   - `A` record per `@` (root) → IP indicato da Vercel
   - `CNAME` per `www` → target indicato da Vercel
4. Aspetta propagazione DNS (può volerci un po’). Quando Vercel vede i record, il dominio diventa “Verified”.

### Opzione B — Tieni Wix sulla home e metti questo progetto su un sottodominio

Esempio: `shop.tuodominio.com`

1. Vercel: aggiungi **solo** `shop.tuodominio.com`.
2. Wix DNS: crea `CNAME` `shop` → target Vercel.
3. Il sito Wix capisce su `tuodominio.com`, il catalogo Next.js su `shop.tuodominio.com`.

---

## Note performance

- `/api/img` gira in **Edge runtime** e manda `Cache-Control` lungo → immagini molto più veloci.
- In griglia/carousel usiamo Yupoo `medium` al posto di `big` (download molto più leggero).
- La pagina Spreadsheet ora usa **ISR** (`revalidate`) per ridurre chiamate a Google Sheets.
