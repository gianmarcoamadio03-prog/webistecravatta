// app/page.tsx
import Link from "next/link";

import HeroCarousel from "@/components/HeroCarousel";
import ParallaxSection from "@/components/ParallaxSection";
import SpreadsheetPreviewCarousel from "@/components/SpreadsheetPreviewCarousel";

import SellersHomeTeaser from "@/src/lib/components/home/SellersHomeTeaser";
import QualityCheckHomeTeaser from "@/src/lib/components/home/QualityCheckHomeTeaser";

import { getSellersFromSheet } from "@/data/sellersFromSheet";

export const runtime = "nodejs";
export const revalidate = 300;

// ✅ Tipo locale: non importiamo più Seller da SellersHomeTeaser (non è esportato)
type Seller = {
  name: string;
  verified?: boolean;
  specialties: string[];
  previewImages: string[];
  whatsapp?: string;
};

function toStringArr(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

function toPlainSeller(r: any): Seller | null {
  const name = String(r?.name ?? r?.Name ?? r?.seller ?? r?.Seller ?? "").trim();
  if (!name) return null;

  return {
    name,
    verified: Boolean(r?.verified ?? r?.Verified ?? r?.verificato ?? r?.Verificato ?? false),
    specialties: toStringArr(r?.specialties ?? r?.Specialties ?? r?.tags),
    previewImages: toStringArr(r?.previewImages ?? r?.preview_images ?? r?.images ?? r?.preview),
    whatsapp: String(r?.whatsapp ?? r?.wa ?? r?.whatsappUrl ?? r?.contact ?? r?.whats ?? "").trim(),
  };
}

function ComingSoonPill() {
  return (
    <div className="inline-flex items-center rounded-full border border-white/12 bg-white/5 px-3 py-1 text-[11px] tracking-[0.28em] text-white/70 uppercase backdrop-blur">
      Coming soon
    </div>
  );
}

export default async function HomePage() {
  let raw: any[] = [];
  try {
    const res = await getSellersFromSheet();
    raw = Array.isArray(res) ? res : [];
  } catch (e) {
    console.error("getSellersFromSheet failed:", e);
    raw = [];
  }

  const sellers: Seller[] = raw.map(toPlainSeller).filter(Boolean) as Seller[];
  const preview: Seller[] = sellers.slice(0, 8);

  return (
    <main className="cc-home">
      {/* 1) HERO (ellisse/hero) */}
      <section className="cc-section cc-section--hero">
        <HeroCarousel />
        <div className="cc-scrollHint">SCROLL ↓</div>
      </section>

      {/* 2) SPREADSHEET */}
      <ParallaxSection
        id="spreadsheet"
        eyebrow=""
        title="Spreadsheet"
        description="I migliori finds per tutti i tuoi haul."
        childrenWidth="wide"
      >
        <div className="sheet-ctaRow">
          <Link href="/spreadsheet" className="sheet-cta">
            Entra nella Spreadsheet →
          </Link>
          <div className="sheet-ctaSub">Scorri l’anteprima qui sotto.</div>
        </div>

        <div className="sheet-fullBleed">
          <SpreadsheetPreviewCarousel variant="home" />
        </div>
      </ParallaxSection>

      {/* 3) SELLERS */}
      <SellersHomeTeaser sellers={preview} />

      {/* 4) QUALITY CHECK (✅ NO PARALLAX: sezione normale) */}
      <section className="cc-section" id="quality-check">
        <div className="cc-section-wrap">
          <div className="cc-container">
            <div className="ps-header">
              <div className="ps-eyebrow">AI</div>
              <h2 className="ps-title">AI Quality Check</h2>
              <p className="ps-desc">
                Controllo qualità automatico: ti dice se un item è valido prima di comprare.
              </p>

              <div className="sheet-ctaRow">
                <Link href="/quality-check" className="sheet-cta">
                  Ispeziona articoli →
                </Link>
                <div className="sheet-ctaSub"> </div>
              </div>
            </div>

            {/* ✅ Animazione SEMPRE attiva (gestita dal componente) */}
            <QualityCheckHomeTeaser />
          </div>
        </div>
      </section>

      {/* 5) COUPON (COMING SOON) */}
      <ParallaxSection
        id="coupons"
        eyebrow="SAVINGS"
        title="Coupon"
        description="Codici sconto aggiornati e link rapidi per risparmiare subito."
      >
        <div className="sheet-ctaRow" style={{ alignItems: "center" }}>
          <ComingSoonPill />
          <div className="sheet-ctaSub">Stiamo completando la sezione.</div>
        </div>

        <div className="sheet-ctaRow">
          <Link href="/coupons" className="sheet-cta">
            Apri i Coupon →
          </Link>
          <div className="sheet-ctaSub">In arrivo a breve.</div>
        </div>
      </ParallaxSection>

      {/* 6) TUTORIAL (COMING SOON) */}
      <ParallaxSection
        id="tutorials"
        eyebrow="GUIDE"
        title="Tutorial"
        description="Guide snelle per comprare senza perdere tempo: agent, spedizioni, QC e tips."
      >
        <div className="sheet-ctaRow" style={{ alignItems: "center" }}>
          <ComingSoonPill />
          <div className="sheet-ctaSub">Stiamo preparando le guide.</div>
        </div>

        <div className="sheet-ctaRow">
          <Link href="/tutorials" className="sheet-cta">
            Vai ai Tutorial →
          </Link>
          <div className="sheet-ctaSub">In arrivo a breve.</div>
        </div>
      </ParallaxSection>
    </main>
  );
}
