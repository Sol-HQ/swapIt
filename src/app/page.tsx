import Image from "next/image";
import SwapDashboard from "./SwapDashboard";

export default function Home() {
  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-neutral-950 text-neutral-100 selection:bg-amber-400/30 selection:text-amber-200">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(244,114,182,0.08),transparent_60%),radial-gradient(circle_at_80%_40%,rgba(129,140,248,0.08),transparent_55%),radial-gradient(circle_at_50%_80%,rgba(251,191,36,0.05),transparent_65%)]" />
      <main className="relative flex flex-col gap-10 items-center sm:items-start max-w-5xl mx-auto px-6 pt-16 pb-28">
        <header className="space-y-4 w-full">
          <h1 className="relative text-[clamp(2.75rem,6vw,5.25rem)] font-semibold tracking-tight leading-[0.9] px-2 py-3">
            <span className="absolute inset-0 bg-gradient-to-r from-blue-500 via-emerald-400 to-amber-400 opacity-25 blur-2xl rounded-full pointer-events-none" />
            <span className="relative bg-[linear-gradient(120deg,#60a5fa_0%,#34d399_25%,#fbbf24_50%,#f87171_75%,#818cf8_100%)] bg-clip-text text-transparent drop-shadow-[0_0_6px_rgba(255,255,255,0.08)]">
              Jup <span className="font-light">Swapit’er</span>
            </span>
            <span className="block mt-2 text-xs sm:text-sm font-mono tracking-[0.35em] text-neutral-500/60 uppercase">
              Liquidity • Alchemy • Flux
            </span>
          </h1>
          <p className="text-sm sm:text-base font-mono tracking-wide text-neutral-400/90 leading-relaxed">
            <span className="pr-2 text-amber-300/80">◬</span>On‑chain alchemy: route, refine & transmute – a ritual of liquidity.
          </p>
          <div className="h-px w-full bg-gradient-to-r from-transparent via-neutral-700/50 to-transparent" />
        </header>

        <ol className="font-mono list-decimal list-inside text-xs sm:text-sm space-y-1 bg-neutral-900/40 border border-neutral-800/60 rounded-lg px-4 py-3 backdrop-blur-sm shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
          <li className="tracking-tight"><span className="text-amber-300/80 mr-1">1.</span>Get started by getting acquainted at <code className="px-1 py-0.5 rounded bg-neutral-800/70 text-rose-300/90">kite.earth</code></li>
          <li className="tracking-tight"><span className="text-amber-300/80 mr-1">2.</span>Site adaptations & innovations ongoing.</li>
        </ol>

        <div className="flex flex-col sm:flex-row gap-4 w-full">
          <a
            className="group relative rounded-xl border border-neutral-800/70 bg-neutral-900/60 hover:border-rose-400/40 hover:bg-neutral-900/80 transition-colors px-6 h-12 inline-flex items-center gap-3 font-medium text-sm tracking-wide backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
            href="https://kite.earth"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="text-rose-300/80 group-hover:text-rose-200 transition-colors">✶</span>
            <span>Coming Soon</span>
            <span className="text-[10px] uppercase tracking-[0.2em] font-light text-neutral-500 group-hover:text-neutral-300">Portal</span>
          </a>
          <a
            className="group relative rounded-xl border border-neutral-800/70 bg-gradient-to-br from-indigo-600/20 via-indigo-500/10 to-fuchsia-500/10 hover:from-indigo-500/30 hover:via-indigo-400/20 hover:to-fuchsia-500/20 transition-colors px-6 h-12 inline-flex items-center gap-3 font-medium text-sm tracking-wide backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
            href="https://affirmamint.cloud"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="text-indigo-300/80 group-hover:text-indigo-200 transition-colors">ᚨ</span>
            <span>MINT KITE NFT</span>
            <span className="text-[10px] uppercase tracking-[0.25em] font-light text-neutral-400 group-hover:text-neutral-200">Mint</span>
          </a>
        </div>

        <div className="w-full max-w-full rounded-2xl border border-neutral-800/60 bg-neutral-900/40 backdrop-blur-md px-4 py-6 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.5)]">
          <SwapDashboard />
        </div>
      </main>
      <footer className="relative row-start-3 flex gap-8 flex-wrap items-center justify-center py-8 text-xs text-neutral-500">
        <a className="hover:text-neutral-300 transition-colors flex items-center gap-2" href="https://" target="_blank" rel="noopener noreferrer">
          <Image aria-hidden src="/file.svg" alt="File icon" width={14} height={14} />
          <span>Learn</span>
        </a>
        <a className="hover:text-neutral-300 transition-colors flex items-center gap-2" href="https://" target="_blank" rel="noopener noreferrer">
          <Image aria-hidden src="/window.svg" alt="Window icon" width={14} height={14} />
          <span>Examples</span>
        </a>
        <a className="hover:text-neutral-300 transition-colors flex items-center gap-2" href="https://kite.earth" target="_blank" rel="noopener noreferrer">
          <Image aria-hidden src="/globe.svg" alt="Globe icon" width={14} height={14} />
          <span>Go to kite.earth →</span>
        </a>
      </footer>
    </div>
  );
}
