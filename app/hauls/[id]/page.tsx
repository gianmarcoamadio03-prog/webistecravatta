import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import HaulGallery from "@/components/HaulGallery";
import { getHauls } from "@/data/haulsFromSheet";

export const runtime = "nodejs";
export const revalidate = 60;
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const haul = (await getHauls()).find(h => h.id === id);
    return { title: haul ? `${haul.title} — Cravatta` : "Haul — Cravatta" };
  } catch {
    return { title: "Haul — Cravatta" };
  }
}

export default async function HaulDetail({ params }: Props) {
  const { id } = await params;
  const haul = (await getHauls()).find(h => h.id === id);
  if (!haul) notFound();

  return <main className="mx-auto min-h-screen max-w-6xl px-5 py-10 text-white md:px-8 md:py-14">
    <Link href="/hauls" className="text-sm text-white/60 transition hover:text-white">← Torna agli haul</Link>
    <h1 className="mb-6 mt-7 text-3xl font-bold md:text-4xl">{haul.title}</h1>
    <div className="mb-5 flex max-h-[440px] items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-3 sm:p-5">
      <img src={haul.cover} alt={haul.title} className="block max-h-[390px] max-w-full object-contain" />
    </div>
    <div className="mb-10 flex flex-wrap gap-2 text-xs sm:text-sm">
      {haul.weight && <span className="rounded-full border border-white/15 px-3 py-1.5">Peso: {haul.weight} kg</span>}
      {haul.dimensions && <span className="rounded-full border border-white/15 px-3 py-1.5">Dimensioni: {haul.dimensions} cm</span>}
      {haul.agent && <span className="rounded-full border border-white/15 px-3 py-1.5">Agent: {haul.agent}</span>}
    </div>

    {haul.photos.length > 0 && <section className="mb-10">
      <h2 className="mb-4 text-xl font-semibold">Foto dell'haul <span className="text-white/40">({haul.photos.length})</span></h2>
      <HaulGallery photos={haul.photos} title={haul.title} />
    </section>}

    <section>
      <h2 className="mb-4 text-xl font-semibold">Articoli nel pacco <span className="text-white/40">({haul.items.length})</span></h2>
      {haul.items.length === 0 ? <p className="text-sm text-white/50">Gli articoli saranno aggiunti presto.</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {haul.items.map((item, i) => <article key={`${item.title}-${i}`} className="flex min-h-28 flex-col justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-4">
          <h3 className="break-words text-sm font-medium leading-snug">{item.title}</h3>
          {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg bg-violet-600 px-3 py-2 text-center text-xs font-semibold transition hover:bg-violet-500">Apri articolo ↗</a> : <span className="block rounded-lg bg-white/5 px-3 py-2 text-center text-xs text-white/45">Link non disponibile</span>}
        </article>)}
      </div>}
    </section>
  </main>;
}
