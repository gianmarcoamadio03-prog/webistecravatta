// data/sellersShared.ts

export type StoreType = "weidian" | "taobao" | "other";

export type Seller = {
  id: string;
  name: string;
  tags: string[];
  yupoo_url?: string | null;
  whatsapp?: string | null;
  store_url?: string | null;
};

export type SellerCard = {
  id: string;
  seller_id: string;
  title: string;
  description?: string | null;
  image?: string | null;
};

export function inferStoreType(url?: string | null): StoreType {
  const u = (url ?? "").toLowerCase();
  if (!u) return "other";
  if (u.includes("weidian.com")) return "weidian";
  if (u.includes("taobao.com") || u.includes("tmall.com")) return "taobao";
  return "other";
}

export function toWhatsAppHref(input?: string | null): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  if (s.includes("wa.me/") || s.includes("whatsapp.com/")) return s;

  let digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);

  return `https://wa.me/${digits}`;
}
