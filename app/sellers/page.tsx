import "server-only";
import type { Metadata } from "next";
import SellersDirectory from "@/components/sellers/SellersDirectory";
import { getBrandSellerDirectory } from "@/data/sellerDirectoryFromSheet";

export const runtime = "nodejs";
export const revalidate = 300;
export const metadata: Metadata = { title: "Seller per Brand — Cravatta", description: "Esplora tutti i seller organizzati per brand." };
export default async function SellersPage() {
  try {
    const brands = await getBrandSellerDirectory();
    return <SellersDirectory brands={brands} />;
  } catch (error) {
    console.error("Seller directory:", error);
    return <main className="mx-auto max-w-6xl px-5 py-28 text-center text-white"><h1 className="text-3xl font-semibold">Seller per Brand</h1><p className="mt-5 text-white/60">Impossibile caricare la directory. Controlla le schede seller_brand e seller_directory su Google Sheets.</p></main>;
  }
}
