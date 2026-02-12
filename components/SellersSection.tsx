// components/SellersSection.tsx
import Link from "next/link";
import ParallaxSection from "@/components/ParallaxSection";
import SellersSectionClient from "@/components/SellersSectionClient";

type Props = {
  id?: string;
  sellers: any[];
};

export default function SellersSection({ id = "sellers", sellers }: Props) {
  return (
    <ParallaxSection
      id={id}
      eyebrow="BEST"
      title="Sellers"
      description="I migliori seller selezionati, con card premium e accesso veloce."
      childrenWidth="wide"
      decorMode="mobile" // ✅ così su desktop NON si vede, su mobile sì
    >
      <div className="sheet-ctaRow">
        <Link href="/sellers" className="sheet-cta">
          Vai ai Sellers →
        </Link>
        <div className="sheet-ctaSub">Scopri quelli consigliati.</div>
      </div>

      <SellersSectionClient sellers={sellers} />
    </ParallaxSection>
  );
}
