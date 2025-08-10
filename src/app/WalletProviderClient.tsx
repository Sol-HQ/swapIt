"use client";
import * as React from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

// Prefer environment variable for RPC (do NOT commit real keys). Add NEXT_PUBLIC_HELIUS_API_KEY to .env.local
const RAW_HELIUS = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
const FALLBACK_RPC = process.env.NEXT_PUBLIC_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

function buildHeliusEndpoint(raw?: string): { endpoint: string; key?: string } | null {
  if (!raw) return null;
  // If full URL pasted
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const k = u.searchParams.get('api-key') || undefined;
      return { endpoint: raw, key: k };
    } catch {
      return { endpoint: raw };
    }
  }
  // Assume just key string
  return { endpoint: `https://mainnet.helius-rpc.com/?api-key=${raw}`, key: raw };
}
const helius = buildHeliusEndpoint(RAW_HELIUS);
// Explicit RPC endpoint (if provided) takes absolute precedence
const ENDPOINT = process.env.NEXT_PUBLIC_RPC_ENDPOINT || helius?.endpoint || FALLBACK_RPC;

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_DEBUG_RPC === '1') {
  // Lightweight one-time debug
  (window as any).__SWAPIT_RPC_DEBUG__ = { RAW_HELIUS, resolvedEndpoint: ENDPOINT };
  console.log('[RPC] endpoint', ENDPOINT);
}

const wallets = [
  new PhantomWalletAdapter(),
  new SolflareWalletAdapter(),
];

export default function WalletProviderClient({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={ENDPOINT} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
