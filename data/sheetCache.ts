import { unstable_cache } from "next/cache";
import { getItemsFromSheet } from "@/data/itemsFromSheet";
import { getSellersFromSheet } from "@/data/sellersFromSheet";
// se hai anche seller_cards:
// import { getSellerCardsFromSheet } from "@/data/sellerCardsFromSheet";

export const getItemsCached = unstable_cache(
  async () => getItemsFromSheet(),
  ["sheet-items-v1"],
  { revalidate: 60 } // 60s: abbatti le richieste di ~60x
);

export const getSellersCached = unstable_cache(
  async () => getSellersFromSheet(),
  ["sheet-sellers-v1"],
  { revalidate: 300 } // sellers cambiano meno spesso
);

// export const getSellerCardsCached = unstable_cache(
//   async () => getSellerCardsFromSheet(),
//   ["sheet-seller-cards-v1"],
//   { revalidate: 300 }
// );