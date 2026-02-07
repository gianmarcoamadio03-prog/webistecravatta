import Link from "next/link";

export const metadata = {
  title: "Coupon • Cravatta",
  description: "Codici sconto e link rapidi.",
};

export default function CouponsPage() {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="mx-auto w-full max-w-3xl rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-[0_40px_140px_rgba(0,0,0,0.55)]">
        <div className="text-[11px] tracking-[0.28em] text-white/40 uppercase">
          Savings
        </div>
        <h1 className="mt-2 text-4xl font-semibold text-white/95">Coupon</h1>

        <p className="mt-3 text-sm text-white/60 leading-relaxed">
          Pagina in costruzione: qui inserirò solo codici e promo realmente
          funzionanti (con data e note). Niente spam.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/"
            className="inline-flex items-center justify-center h-10 px-4 rounded-full border border-white/15 bg-white/10 hover:bg-white/12 hover:border-white/25 text-sm"
          >
            ← Home
          </Link>

          <Link
            href="/spreadsheet"
            className="inline-flex items-center justify-center h-10 px-4 rounded-full border border-white/15 bg-gradient-to-r from-violet-300/90 to-emerald-200/90 text-black hover:brightness-105 text-sm font-semibold"
          >
            Vai alla Spreadsheet →
          </Link>
        </div>
      </div>
    </main>
  );
}
