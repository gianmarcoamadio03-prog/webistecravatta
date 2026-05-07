import Link from "next/link";

const VIDEOS = [
  { id: "XMw4UUz7_lk" },
  { id: "OQKb4IqtPZk" },
  { id: "48qUxHyTkZs" },
  { id: "Bo9lrfGRFG8" },
];

export default function TutorialCarousel() {
  return (
    <div className="sheet-fullBleed">
      <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden px-4 justify-center">
        {VIDEOS.map((v) => (
          <a
            key={v.id}
            href={"https://www.youtube.com/watch?v=" + v.id}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex-shrink-0 w-[320px] overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] hover:border-white/25 transition-all duration-300 hover:scale-[1.02]"
          >
            <div className="relative aspect-video w-full overflow-hidden">
              <img
                src={"https://img.youtube.com/vi/" + v.id + "/maxresdefault.jpg"}
                alt="Tutorial"
                className="w-full h-full object-cover transition duration-300 group-hover:scale-105"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/20 transition">
                <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur border border-white/30 flex items-center justify-center group-hover:scale-110 transition">
                  <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
