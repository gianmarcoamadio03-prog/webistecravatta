import type { Metadata } from "next";
import Link from "next/link";
import HaulCards from "@/components/HaulCards";
import { getHauls } from "@/data/haulsFromSheet";

export const metadata: Metadata = { title: "Haul — Cravatta", description: "Pacchi, foto e link agli articoli." };
export const runtime = "nodejs";
export const revalidate = 60;
export default async function HaulsPage() {
  let hauls = [] as Awaited<ReturnType<typeof getHauls>>;
  let error = false;
  try { hauls = await getHauls(); } catch(e) { console.error("Hauls page:",e); error = true; }
  return <main className="mx-auto min-h-screen max-w-7xl px-5 py-16 text-white md:px-8">
    <Link href="/" className="text-sm text-white/50 hover:text-white">← Home</Link>
    <div className="mb-9 mt-9"><div className="text-xs uppercase tracking-[0.3em] text-violet-300">Cravatta Collection</div><h1 className="mt-3 text-5xl font-bold">Haul</h1><p className="mt-3 text-white/55">Scopri i pacchi e tutti gli articoli al loro interno.</p></div>
    {error ? <p className="rounded-xl border border-amber-400/30 p-5 text-white/70">Impossibile caricare gli haul. Verifica HAULS_SHEET_ID, il nome della scheda e i permessi Google.</p> : <HaulCards hauls={hauls} />}
  </main>;
}
