// app/quality-check/page.tsx
import QCClient from "./QCClient";

export const runtime = "nodejs";

export default function QualityCheckPage() {
  return (
    <main className="min-h-screen w-full px-4 pt-5 pb-10 md:py-8 flex justify-center items-start md:items-center">
      <QCClient />
    </main>
  );
}
