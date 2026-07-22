// app/favorites/page.tsx
import FavoritesClient from "./FavoritesClient";

export const runtime = "nodejs";

export default function FavoritesPage() {
  return (
    <main className="ss-page">
      <FavoritesClient />
    </main>
  );
}
