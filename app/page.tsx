// app/page.tsx
import Link from "next/link";

import HeroCarousel from "@/components/HeroCarousel";
import ParallaxSection from "@/components/ParallaxSection";
import SpreadsheetPreviewCarousel from "@/components/SpreadsheetPreviewCarousel";

import SellersHomeTeaser from "@/src/lib/components/home/SellersHomeTeaser";
import QualityCheckHomeTeaser from "@/src/lib/components/home/QualityCheckHomeTeaser";

import { getSellersFromSheet } from "@/data/sellersFromSheet";
import LanguageMenu from "@/components/LanguageMenu";

export const runtime = "nodejs";
export const revalidate = 300;

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
      {/* ✅ MENU LINGUA (fixed, non rompe layout) */}
      <LanguageMenu />

      {/* 1) HERO */}
      <section className="cc-section cc-section--hero">
        <HeroCarousel />
        <div className="cc-scrollHint">SCROLL ↓</div>
      </section>

      {/* 2) SPREADSHEET (decor solo orbs, NO sagome) */}
      <ParallaxSection id="spreadsheet" eyebrow="" title="Spreadsheet" childrenWidth="wide" decor="orbs">
        <div className="sheet-ctaRow">
          <Link href="/spreadsheet" className="sheet-cta">
            Entra nella Spreadsheet →
          </Link>
        </div>

        <div className="sheet-fullBleed">
          <SpreadsheetPreviewCarousel variant="home" />
        </div>
      </ParallaxSection>

      {/* 3) SELLERS (qui restano le sagome / parallax) */}
      <SellersHomeTeaser sellers={preview} />

      {/* 4) QUALITY CHECK (sezione normale) */}
      <section className="cc-section" id="quality-check">
        <div className="cc-section-wrap">
          <div className="cc-container">
            <div className="ps-header">
              <div className="ps-eyebrow">AI</div>
              <h2 className="ps-title">AI Quality Check</h2>

              <div className="sheet-ctaRow">
                <Link href="/quality-check" className="sheet-cta">
                  Ispeziona articoli →
                </Link>
                <div className="sheet-ctaSub"> </div>
              </div>
            </div>

            <QualityCheckHomeTeaser />
          </div>
        </div>
      </section>

      {/* 5) COUPON (decor solo orbs, NO sagome) */}
      <ParallaxSection id="coupons" eyebrow="SAVINGS" title="Coupon" decor="orbs">
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

      {/* 6) TUTORIAL (decor solo orbs, NO sagome) */}
      <ParallaxSection id="tutorials" eyebrow="GUIDE" title="Tutorial" decor="orbs">
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
