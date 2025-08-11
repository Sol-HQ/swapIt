import type { Metadata } from "next";
import "./globals.css";
import WalletProviderClient from "./WalletProviderClient";
import * as React from "react";

// Use system fonts instead of Google Fonts to avoid network dependencies
const geistSans = {
  variable: "--font-geist-sans",
};

const geistMono = {
  variable: "--font-geist-mono",
};

export const metadata: Metadata = {
  title: "SwapIt - Solana Token Swap Dashboard",
  description: "Minimal Solana Jupiter integrated swap + wallet dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <WalletProviderClient>{children}</WalletProviderClient>
      </body>
    </html>
  );
}
