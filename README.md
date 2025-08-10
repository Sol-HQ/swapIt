# SwapIt

Minimal Solana Jupiter integrated swap + wallet dashboard (Next.js App Router) ready for Vercel deployment.

## Features

- Next.js 15 App Router
- Solana wallet adapters (Phantom, Solflare)
- Jupiter integrated swap widget (passthrough wallet)
- Portfolio / token metadata & pricing (Jupiter price API + Metaplex metadata PDA fetch)
- Responsive asset table with export (CSV / JSON)

## Quick Start (Local)

1. Copy example env file:
   cp .env.local.example .env.local  (Windows PowerShell: copy .env.local.example .env.local)
2. Add your (public) Helius API key in `.env.local` (rate-limited public key only).
3. Install deps:
   npm install
4. Run dev server:
   npm run dev
5. Open <http://localhost:3000>

## Deploy to Vercel

1. Push this repository to GitHub (e.g. `Sol-HQ/swapIt`).
2. In Vercel, import the repo.
3. Set Environment Variables (Project Settings > Environment Variables):
   - NEXT_PUBLIC_HELIUS_API_KEY
   - (Optional) NEXT_PUBLIC_RPC_ENDPOINT
   - NEXT_PUBLIC_INITIAL_INPUT_MINT
   - NEXT_PUBLIC_INITIAL_OUTPUT_MINT
   - NEXT_PUBLIC_INITIAL_SWAP_UI_AMOUNT
4. Framework Preset: Next.js
5. Build Command: (default) `next build`
6. Output Directory: `.next` (default)
7. Deploy.

## Environment Variables

See `.env.local.example` for all available public vars.
Never commit real secret keys. Only use public / rate-limited keys client-side.

## Scripts

- dev: next dev --turbopack
- build: next build
- start: next start (production)

## Production Notes

- All wallet & swap logic executes client-side.
- Ensure any RPC keys used here are safe for public exposure.
- For stricter rate limiting / auth, proxy RPC through your own backend (not included in this minimal deployment).

## License

MIT (add a LICENSE file if needed).
