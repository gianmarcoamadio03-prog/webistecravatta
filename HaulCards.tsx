"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Haul } from "@/data/haulsFromSheet";

export default function HaulCards({ hauls }: { hauls: Haul[] }) {
  const [q, setQ] = useState("");

  const matches = useMemo(
    () =>
      hauls.filter((h) =>
        `${h.title} ${h.agent}`
          .toLocaleLowerCase("it")
          .includes(q.toLocaleLowerCase("it").trim())
      ),
    [hauls, q]
  );

  return (
    <>
      <input
        aria-label="Cerca haul"
        placeholder="Cerca un haul..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-8 w-full rounded-2xl border border-white/15 bg-white/[0.05] px-5 py-4 text-white outline-none placeholder:text-white/40 focus:border-violet-400/60"
      />

      <div className="columns-1 gap-5 sm:columns-2 xl:columns-3">
        {matches.map((h) => (
          <Link
            href={`/hauls/${encodeURIComponent(h.id)}`}
            key={h.id}
            className="group mb-5 inline-block w-full overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] align-top transition hover:-translate-y-1 hover:border-violet-400/50 [break-inside:avoid]"
          >
            <div className="px-4 py-4 text-lg font-semibold text-white">
              {h.title}
            </div>

            <div className="bg-white/5">
              <img
                src={h.cover}
                alt={`Copertina ${h.title}`}
                loading="lazy"
                className="block h-auto w-full object-contain transition duration-500 group-hover:scale-[1.02]"
              />
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-4 text-sm">
              <span className="text-white/50">
                {[h.weight && `${h.weight} kg`, h.agent]
                  .filter(Boolean)
                  .join(" · ") || "Scopri il pacco"}
              </span>
              <span className="whitespace-nowrap text-violet-300">
                Apri haul →
              </span>
            </div>
          </Link>
        ))}
      </div>

      {!matches.length && (
        <p className="py-12 text-center text-white/50">Nessun haul trovato.</p>
      )}
    </>
  );
}
