// app/item/[slug]/not-found.tsx
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-black text-white/90 flex items-start justify-center p-10">
      <div className="max-w-xl w-full">
        <div className="text-xs text-white/40">404</div>
        <h1 className="mt-2 text-3xl font-semibold">Articolo non trovato</h1>
        <p className="mt-3 text-sm text-white/55">
          Questo slug non esiste nello spreadsheet oppure è stato rimosso.
        </p>

        <Link
          href="/spreadsheet"
          className="inline-flex mt-6 items-center justify-center h-10 px-4 rounded-full border border-white/10 bg-white/5 hover:bg-white/8 text-sm"
        >
          Torna al catalogo →
        </Link>
      </div>
    </div>
  );
}
