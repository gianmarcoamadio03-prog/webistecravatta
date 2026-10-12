"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Haul } from "@/data/haulsFromSheet";

const HAUL_CARD_COLORS = [
  { rgb: "132, 105, 179", border: "rgba(165, 139, 204, 0.38)" },
  { rgb: "65, 113, 143", border: "rgba(107, 153, 181, 0.38)" },
  { rgb: "77, 120, 97", border: "rgba(119, 165, 134, 0.38)" },
  { rgb: "139, 82, 98", border: "rgba(182, 120, 137, 0.38)" },
  { rgb: "151, 110, 74", border: "rgba(188, 151, 112, 0.38)" },
  { rgb: "94, 102, 128", border: "rgba(140, 150, 178, 0.38)" },
];

function getHaulColor(id: string) {
  let hash = 0;

  for (let i = 0; i < id.length; i++) {
    hash = (Math.imul(31, hash) + id.charCodeAt(i)) | 0;
  }

  return HAUL_CARD_COLORS[
    (hash >>> 0) % HAUL_CARD_COLORS.length
  ];
}

function HaulCard({ haul }: { haul: Haul }) {
  const accent = getHaulColor(String(haul.id));

  return (
    <Link
      href={`/hauls/${encodeURIComponent(haul.id)}`}
      className="group block w-full self-start overflow-hidden rounded-2xl border transition-all duration-300 hover:-translate-y-1 hover:brightness-110"
      style={{
        borderColor: accent.border,
        background: `linear-gradient(
          145deg,
          rgba(${accent.rgb}, 0.22) 0%,
          rgba(${accent.rgb}, 0.10) 38%,
          rgba(9, 9, 12, 0.93) 100%
        )`,
        boxShadow: `0 8px 30px rgba(${accent.rgb}, 0.07)`,
      }}
    >
      <div className="px-4 py-4 text-lg font-semibold text-white">{haul.title}</div>
      <img
        src={haul.cover}
        alt={`Copertina ${haul.title}`}
        loading="lazy"
        className="block h-auto w-full object-contain transition duration-500 group-hover:scale-[1.02]"
      />
      <div className="flex items-center justify-between gap-3 px-4 py-4 text-sm">
        <span className="text-white/50">
          {[haul.weight && `${haul.weight} kg`, haul.agent]
            .filter(Boolean)
            .join(" · ") || "Scopri il pacco"}
        </span>
        <span className="shrink-0 text-violet-300">Apri haul →</span>
      </div>
    </Link>
  );
}

function HaulColumns({ hauls, count }: { hauls: Haul[]; count: number }) {
  return (
    <div className="flex items-start gap-5">
      {Array.from({ length: count }, (_, columnIndex) => (
        <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-5">
          {hauls
            .filter((_, index) => index % count === columnIndex)
            .map((haul) => <HaulCard key={haul.id} haul={haul} />)}
        </div>
      ))}
    </div>
  );
}

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
      <div className="sm:hidden"><HaulColumns hauls={matches} count={1} /></div>
      <div className="hidden sm:block xl:hidden"><HaulColumns hauls={matches} count={2} /></div>
      <div className="hidden xl:block"><HaulColumns hauls={matches} count={3} /></div>
      {!matches.length && (
        <p className="py-12 text-center text-white/50">Nessun haul trovato.</p>
      )}
    </>
  );
}
