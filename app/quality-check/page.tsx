// app/quality-check/page.tsx
import QCClient from "./QCClient";

export const runtime = "nodejs";

export default function QualityCheckPage() {
  return (
    <main className="min-h-screen w-full px-4 py-6 md:py-8 flex items-center justify-center">
      <QCClient />
    </main>
  );
}
