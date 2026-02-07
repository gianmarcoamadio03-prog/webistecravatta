import "server-only";
import type { Metadata } from "next";
import SellersDirectory from "@/components/sellers/SellersDirectory";
import { getSellersFromSheet } from "@/data/sellersFromSheet";

export const runtime = "nodejs";
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Sellers — Cravatta",
  description: "Rubrica premium dei migliori seller.",
};

export default async function SellersPage() {
  const sellers = await getSellersFromSheet();
  return <SellersDirectory sellers={sellers} />;
}
