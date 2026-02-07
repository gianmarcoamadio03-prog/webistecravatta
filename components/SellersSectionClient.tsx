// components/SellersSectionClient.tsx
"use client";

import SellersBlock from "./SellersBlock";

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
};

export default function SellersSectionClient({ sellers }: { sellers: SellerLike[] }) {
  return (
    <section className="cc-section">
      <div className="mx-auto w-full max-w-5xl px-4">
        <SellersBlock sellers={(Array.isArray(sellers) ? sellers : []).slice(0, 3)} />
      </div>
    </section>
  );
}
