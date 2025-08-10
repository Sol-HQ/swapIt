"use client";
import * as React from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

// Prefer environment variable for RPC (do NOT commit real keys). Add NEXT_PUBLIC_HELIUS_API_KEY to .env.local
const HELIUS_KEY = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
const FALLBACK_RPC = process.env.NEXT_PUBLIC_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const ENDPOINT = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : FALLBACK_RPC;

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
