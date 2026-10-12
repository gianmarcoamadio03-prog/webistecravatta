import Link from "next/link";
import { getHauls } from "@/data/haulsFromSheet";

export default async function HaulPreview() {
  let hauls;
  try {
    hauls = (await getHauls()).slice(0, 5);
  } catch (error) {
    console.error("Haul preview:", error);
    return (
      <p className="text-center text-sm text-white/45">
        Gli haul saranno disponibili presto.
      </p>
    );
  }

  if (!hauls.length) {
    return (
      <p className="text-center text-sm text-white/45">
        I primi haul arriveranno presto.
      </p>
    );
  }

  return (
    <div className="columns-2 gap-4 lg:columns-5">
      {hauls.map((h) => (
        <Link
          href={`/hauls/${encodeURIComponent(h.id)}`}
          key={h.id}
          className="group mb-4 inline-block w-full overflow-hidden rounded-xl border border-white/10 bg-white/5 align-top [break-inside:avoid]"
        >
          <div className="p-3 text-sm font-semibold text-white line-clamp-2">
            {h.title}
          </div>
          <div>
            <img
              src={h.cover}
              alt={h.title}
              loading="lazy"
              className="block h-auto w-full object-contain transition group-hover:scale-[1.02]"
            />
          </div>
        </Link>
      ))}
    </div>
  );
}
