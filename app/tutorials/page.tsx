import Link from "next/link";

export const metadata = {
  title: "Tutorial • Cravatta",
  description: "Guide rapide per comprare senza perdere tempo.",
};

const VIDEOS = [
  { id: "XMw4UUz7_lk", title: "Tutorial 1" },
  { id: "OQKb4IqtPZk", title: "Tutorial 2" },
  { id: "48qUxHyTkZs", title: "Tutorial 3" },
  { id: "Bo9lrfGRFG8", title: "Tutorial 4" },
];

export default function TutorialsPage() {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-10">
          <div className="text-[11px] tracking-[0.28em] text-white/40 uppercase mb-2">Guide</div>
          <h1 className="text-4xl font-semibold text-white/95">Tutorial</h1>
          <p className="mt-3 text-sm text-white/50">Guarda i nostri video su come comprare, usare gli agent e altro.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {VIDEOS.map((v) => (
            <a
              key={v.id}
              href={"https://www.youtube.com/watch?v=" + v.id}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] hover:border-white/25 transition-all duration-300 hover:scale-[1.02]"
            >
              <div className="relative aspect-video w-full overflow-hidden">
                <img
                  src={"https://img.youtube.com/vi/" + v.id + "/maxresdefault.jpg"}
                  alt={v.title}
                  className="w-full h-full object-cover transition duration-300 group-hover:scale-105"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition">
                  <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur border border-white/30 flex items-center justify-center group-hover:scale-110 transition">
                    <svg className="w-7 h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
        <div className="mt-10">
          <Link href="/" className="inline-flex items-center justify-center h-10 px-4 rounded-full border border-white/15 bg-white/10 hover:bg-white/12 text-sm">
            ← Home
          </Link>
        </div>
      </div>
    </main>
  );
}
