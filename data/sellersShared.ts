// data/sellersShared.ts
export type Seller = {
  id: string;
  name: string;
  tags: string[];
  yupoo_url: string | null;
  whatsapp: string | null;
  store_url: string | null;
  image: string | null; // ✅ NEW
};

export type SellerCard = {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  image: string | null;
};

export function toWhatsAppHref(input?: string | null): string {
  const raw = (input ?? "").toString().trim();
  if (!raw) return "";

  // già un link wa
  if (raw.startsWith("https://wa.me/") || raw.includes("api.whatsapp.com")) return raw;

  // normalizza numero (tieni solo cifre)
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  return `https://wa.me/${digits}`;
}

export function inferStoreType(
  url?: string | null
): "weidian" | "taobao" | "yupoo" | "other" | null {
  const u = (url ?? "").toString().toLowerCase().trim();
  if (!u) return null;
  if (u.includes("weidian.com")) return "weidian";
  if (u.includes("taobao.com")) return "taobao";
  if (u.includes("yupoo.com")) return "yupoo";
  return "other";
}
