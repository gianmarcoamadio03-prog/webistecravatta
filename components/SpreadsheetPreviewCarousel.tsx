import SpreadsheetPreviewCarouselClient from "@/components/SpreadsheetPreviewCarouselClient";
import { getItemsHead } from "@/data/itemsFromSheet";
import { imgProxy } from "@/src/lib/imgProxy";

type Variant = "home" | "default" | "sellers";

type Card = {
  slug: string;
  title: string;
  subtitle: string;
  cover: string;
  badge: string;
  priceEur?: number | null;
};

type YupooSize = "small" | "medium" | "big";

/**
 * ✅ PERFORMANCE: in home/carousel servono immagini SUPER leggere.
 * Yupoo tipicamente espone /small.jpg /medium.jpg /big.jpg (o /thumb.jpg).
 * Qui forziamo SEMPRE a "small" riscrivendo la parte finale del pathname.
 */
function yupooListSize(u: string, size: YupooSize = "small") {
  const raw = (u || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!host.includes("yupoo.com")) return raw;

    // riscrive /small|medium|big|thumb.ext -> /{size}.ext
    const re = /\/(small|medium|big|thumb)\.(jpg|jpeg|png|webp)$/i;
    if (re.test(url.pathname)) {
      url.pathname = url.pathname.replace(re, `/${size}.$2`);
      return url.toString();
    }

    // fallback (casi semplici)
    url.pathname = url.pathname
      .replace(/\/big\.(jpg|jpeg|png|webp)$/i, `/${size}.$1`)
      .replace(/\/medium\.(jpg|jpeg|png|webp)$/i, `/${size}.$1`)
      .replace(/\/small\.(jpg|jpeg|png|webp)$/i, `/${size}.$1`);

    return url.toString();
  } catch {
    return raw;
  }
}

function toProxyIfNeeded(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  const low = u.toLowerCase();

  const isYupoo =
    low.includes("photo.yupoo.com") ||
    low.includes("yupoo.com") ||
    low.includes("u.yupoo.com") ||
    low.includes("wd.yupoo.com");

  // ✅ QUI: forziamo SEMPRE small nel proxy
  return isYupoo ? imgProxy(u, "small") : u;
}

function normTag(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function splitTags(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return String(v)
    .split(/[,;|/\n]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** prende tag da più campi + fallback: scansiona stringhe della row */
function getTagsAny(it: any): string[] {
  const candidates = [it?.tags, it?.tag, it?.badge, it?.home_tag, it?.showcase, it?.HOME];

  const out: string[] = [];
  for (const c of candidates) out.push(...splitTags(c));

  // fallback ultra-robusto: se la colonna ha nome “strano”
  try {
    for (const v of Object.values(it || {})) {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
      if (Array.isArray(v)) {
        for (const x of v) {
          if (typeof x === "string" && x.trim()) out.push(x.trim());
        }
      }
    }
  } catch {}

  const seen = new Set<string>();
  return out.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickCoverSmart(it: any) {
  const raw: string[] = [];

  const pushAny = (v: any) => {
    if (!v) return;

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return;

      if (s.includes(",") && s.includes("http")) {
        s.split(",").forEach((x) => {
          const t = x.trim();
          if (t) raw.push(t);
        });
      } else {
        raw.push(s);
      }
      return;
    }

    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.trim()) raw.push(x.trim());
      }
    }
  };

  pushAny(it?.images);
  pushAny(it?.pics);
  for (let i = 1; i <= 8; i++) pushAny(it?.[`img${i}`]);
  pushAny(it?.img_extra);
  pushAny(it?.cover);

  const seen = new Set<string>();
  const pics: string[] = [];
  for (const u of raw) {
    if (!seen.has(u)) {
      seen.add(u);
      pics.push(u);
    }
  }

  if (!pics.length) return "";
  return pics[5] || pics[6] || pics[3] || pics[2] || pics[1] || pics[0] || "";
}

export default async function SpreadsheetPreviewCarousel({
  variant = "default",
}: {
  variant?: Variant;
}) {
  const limit = (() => {
    const n = Number(process.env.HOME_SHOWCASE_LIMIT || "12");
    return Number.isFinite(n) && n > 0 ? n : 12;
  })();

  const badge = (process.env.HOME_SHOWCASE_BADGE || "WEEKLY BEST").toString();

  const tagsEnvRaw =
    process.env.HOME_SHOWCASE_TAGS || process.env.HOME_SHOWCASE_TAG || "WEEKLY BEST";

  const tagsEnv = tagsEnvRaw
    .split(/[,;|]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(normTag);

  // ✅ PERFORMANCE: non carichiamo mai tutta la sheet.
  // Prendiamo un “pool” piccolo dalla prima pagina (sufficiente per la home).
  const poolSize = Math.max(limit * 6, 120);
  let items: any[] = [];

  try {
    items = await getItemsHead(poolSize);
  } catch (e) {
    console.error("[SpreadsheetPreviewCarousel] getItemsHead failed:", e);
    return <div className="lg-empty">Anteprima momentaneamente non disponibile.</div>;
  }

  let chosen = items;

  if (variant === "home" && tagsEnv.length) {
    const filtered = items.filter((it) => {
      const t = (Array.isArray(it?.tags) ? it.tags : getTagsAny(it)).map(normTag);
      return tagsEnv.some((want) => t.includes(want));
    });
    chosen = filtered.length ? filtered : items;
  }

  chosen = (chosen || []).slice(0, limit);

  const cards: Card[] = chosen
    .map((it) => {
      // ✅ cover: forziamo a SMALL se Yupoo lo supporta (small/medium/big/thumb)
      const rawCover = String(it?.cover || it?.images?.[0] || pickCoverSmart(it) || "");
      const cover = toProxyIfNeeded(yupooListSize(rawCover, "small"));

      const subtitle = `${it.category || "Item"} • ${it.seller || ""}`.trim();

      return {
        slug: String(it.slug || "").trim(),
        title: String(it.title || "").trim() || "Articolo",
        subtitle,
        cover,
        badge,
        priceEur: typeof it.price_eur === "number" ? it.price_eur : null,
      };
    })
    .filter((c) => !!c.cover && !!c.slug);

  if (!cards.length) return <div className="lg-empty">Nessun item da mostrare.</div>;

  return <SpreadsheetPreviewCarouselClient items={cards} variant={variant} />;
}
