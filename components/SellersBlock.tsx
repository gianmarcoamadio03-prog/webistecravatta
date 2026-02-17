// components/SellersBlock.tsx
import Link from "next/link";
import ParallaxDecor from "./ParallaxDecor";

type SellerLike = {
  name?: string;
  verified?: boolean;
  url?: string;
  yupoo?: string;
  yupoo_url?: string;
  specialties?: string[];
  previewImages?: string[];
  preview_images?: string[];
  images?: string[];
  image?: string;
};

function normalizeImg(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return s;
  if (s.includes("/")) return `/${s.replace(/^\/+/, "")}`;
  return `/sellers/${s}`;
}

function pickUrl(s: SellerLike) {
  return (s.url || s.yupoo || s.yupoo_url || "").trim();
}

function pickImages(s: SellerLike) {
  const arr = (s.previewImages || (s as any).preview_images || (s as any).images || []) as string[];
  const fromArr = (Array.isArray(arr) ? arr : []).map(normalizeImg).filter(Boolean);

  const single = normalizeImg(String((s as any).image || ""));
  const merged = single ? [single, ...fromArr] : fromArr;

  return Array.from(new Set(merged)).slice(0, 3);
}

export default function SellersBlock({ sellers }: { sellers: SellerLike[] }) {
  const list = (Array.isArray(sellers) ? sellers : []).slice(0, 3);

  return (
    <div
      data-parallax-root
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-4 shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
    >
      <ParallaxDecor variant="shapes" intensity={16} />

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] tracking-[0.22em] text-white/40">BEST SELLERS</div>
            <div className="mt-1 text-lg font-semibold text-white">Rubrica premium</div>
            <div className="mt-1 text-sm text-white/60">Selezione rapida, accesso diretto, preview pulite.</div>
          </div>

          <Link
            href="/sellers"
            className="shrink-0 rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15 transition"
          >
            Vai ai Sellers →
          </Link>
        </div>

        <div className="mt-4 space-y-2">
          {list.map((s, idx) => {
            const name = (s.name || `Seller ${idx + 1}`).trim();
            const url = pickUrl(s);
            const imgs = pickImages(s);

            return (
              <div
                key={`${name}-${idx}`}
                className="group flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 hover:bg-white/[0.06] transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-full border border-white/10 bg-white/10 overflow-hidden grid place-items-center text-sm font-semibold text-white/80">
                    {imgs[0] ? <img src={imgs[0]} alt="" className="h-full w-full object-cover" /> : name.slice(0, 1).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="truncate font-medium text-white">{name}</div>
                      {s.verified ? (
                        <span className="rounded-full border border-white/10 bg-white/10 px-2 py-[2px] text-[11px] text-white/80">
                          Verificato
                        </span>
                      ) : null}
                    </div>

                    {imgs.length ? (
                      <div className="mt-2 flex items-center gap-2">
                        {imgs.slice(0, 3).map((u, i) => (
                          <img
                            key={`${u}-${i}`}
                            src={u}
                            alt=""
                            className="h-8 w-12 rounded-xl border border-white/10 object-cover bg-white/5"
                            loading="lazy"
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-white/45">Nessuna preview</div>
                    )}
                  </div>
                </div>

                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-full border border-white/10 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15 transition"
                  >
                    Apri →
                  </a>
                ) : (
                  <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/35">
                    No link
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
