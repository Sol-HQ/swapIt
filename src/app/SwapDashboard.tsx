"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { PublicKey, type ParsedAccountData, type AccountInfo } from "@solana/web3.js";
import { ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Metadata as TokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { PublicKey as PK } from '@solana/web3.js';
const METADATA_PROGRAM_ID = new PK('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function deriveMetadataPda(mint: PK): PK {
  const [pda] = PublicKey.findProgramAddressSync([
    Buffer.from('metadata'),
    METADATA_PROGRAM_ID.toBuffer(),
    mint.toBuffer(),
  ], METADATA_PROGRAM_ID);
  return pda;
}

interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  decimals: number;
  verified?: boolean;
  tags?: string[];
}
interface WalletToken {
  mint: string;
  amount: number; // uiAmount
  symbol: string;
  name: string;
  logoURI: string;
  decimals?: number;
  verified?: boolean;
  priceUSD?: number;
  valueUSD?: number; // amount * price
}
interface SwapSuccessRecord {
  inputAmount: string;
  inputSymbol: string;
  outputAmount: string;
  outputSymbol: string;
  timestamp: string;
  [k: string]: any;
}
interface SwapErrorRecord {
  error: string;
  timestamp: string;
}

type SwapRecord = SwapSuccessRecord | SwapErrorRecord;

// Jupiter endpoints
const JUP_SEARCH_BASE = "https://ultra-api.jup.ag/ultra/v1/search-token?query="; // + query
const JUP_PRICE_BASE = "https://price.jup.ag/v6/price?ids="; // + comma separated mints
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DESIRED_INITIAL_UI_AMOUNT = '1'; // (no longer used for Jupiter init – keeping if referenced elsewhere)
// Human-readable initial amount persistence
const DEFAULT_INITIAL_UI_AMOUNT = '1';
// Remove dynamic preferred amount usage (fixed settings requested)
// Initial mint config (still overrideable by env)
const INITIAL_INPUT_MINT = process.env.NEXT_PUBLIC_INITIAL_INPUT_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INITIAL_OUTPUT_MINT = process.env.NEXT_PUBLIC_INITIAL_OUTPUT_MINT || WSOL_MINT; // default SOL
const INITIAL_INPUT_UI_AMOUNT = Number(process.env.NEXT_PUBLIC_INITIAL_SWAP_UI_AMOUNT || '1'); // human-readable amount
const KNOWN_DECIMALS: Record<string, number> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
  'So11111111111111111111111111111111111111112': 9, // WSOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
};
const INITIAL_INPUT_DECIMALS = KNOWN_DECIMALS[INITIAL_INPUT_MINT] ?? 6;
const INITIAL_INPUT_BASE_AMOUNT = (() => {
  if (!Number.isFinite(INITIAL_INPUT_UI_AMOUNT) || INITIAL_INPUT_UI_AMOUNT <= 0) return '1000000'; // fallback 1 * 10^6
  const raw = Math.round(INITIAL_INPUT_UI_AMOUNT * 10 ** INITIAL_INPUT_DECIMALS);
  return String(raw);
})();

export default function SwapDashboard() {
  const { connection } = useConnection();
  const solWallet = useWallet();
  const publicKey = solWallet.publicKey;
  const connected = solWallet.connected;
  // Passthrough wallet (ensures required methods availability for Jupiter)
  const passthroughWallet = useMemo(() => {
    if (!solWallet || !solWallet.publicKey) return null;
    const pk = solWallet.publicKey;
    const base: any = solWallet;
    const wrapped = {
      publicKey: pk,
      signTransaction: base.signTransaction ? base.signTransaction.bind(base) : undefined,
      signAllTransactions: base.signAllTransactions ? base.signAllTransactions.bind(base) : (base.signTransaction ? async (txs: any[]) => {
        const out: any[] = [];
        for (const tx of txs) out.push(await base.signTransaction(tx));
        return out;
      } : async () => { throw new Error('signAllTransactions not supported'); }),
      signAndSendTransaction: base.signAndSendTransaction ? base.signAndSendTransaction.bind(base) : undefined,
      signMessage: base.signMessage ? base.signMessage.bind(base) : undefined,
      sendTransaction: async (tx: any, conn: any, opts: any) => {
        try {
          if (base.sendTransaction) return await base.sendTransaction(tx, conn, opts);
          if (base.signAndSendTransaction) return await base.signAndSendTransaction(tx, conn, opts);
          const signed = base.signTransaction ? await base.signTransaction(tx) : tx;
          const raw = signed.serialize();
            return await conn.sendRawTransaction(raw, opts);
        } catch (e) {
          console.error('[Passthrough sendTransaction error]', e);
          throw e;
        }
      },
    } as any;
    console.log('[WALLET CAPS]', { send: !!wrapped.sendTransaction, sign: !!wrapped.signTransaction, signAll: !!wrapped.signAllTransactions, signAndSend: !!wrapped.signAndSendTransaction, signMsg: !!wrapped.signMessage });
    return wrapped;
  }, [solWallet, solWallet.publicKey]);
  const [tokens, setTokens] = useState<WalletToken[]>([]);
  const [swapHistory, setSwapHistory] = useState<SwapRecord[]>([]);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [blockhash, setBlockhash] = useState<string>("");
  const [blockTime, setBlockTime] = useState<string>("");
  const jupiterInitializedRef = useRef(false);
  const jupiterScriptLoadedRef = useRef(false);
  const solSubscriptionIdRef = useRef<number | null>(null);
  const prevWalletPubkeyRef = useRef<string | null>(null);
  const [autoBlockRefresh, setAutoBlockRefresh] = useState(false);
  const metaCacheRef = useRef<Map<string, TokenMeta>>(new Map());
  // NEW UI state additions
  const [tokensLoading, setTokensLoading] = useState(false);
  const [showSmall, setShowSmall] = useState(true);
  const [sortKey, setSortKey] = useState<'value' | 'amount' | 'symbol'>('value');
  const priceCacheRef = useRef<Map<string, number>>(new Map());
  const inFlightMetaRef = useRef<Set<string>>(new Set());
  const metaPersistTimer = useRef<NodeJS.Timeout | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // const [preferredAmount, setPreferredAmount] = useState<string>(DEFAULT_INITIAL_UI_AMOUNT); // removed
  const [priceError, setPriceError] = useState(false);
  const jupiterWalletSetRef = useRef<string | null>(null);
  const [jupStatus, setJupStatus] = useState<{inited:boolean; wallet?:string; error?:string}>({ inited:false });

  // Hydrate meta cache from localStorage (if any)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('tokenMetaCacheV1');
      if (raw) {
        const parsed: TokenMeta[] = JSON.parse(raw);
        parsed.forEach(m => metaCacheRef.current.set(m.address, m));
      }
    } catch {}
  }, []);

  const schedulePersistMeta = useCallback(() => {
    if (metaPersistTimer.current) clearTimeout(metaPersistTimer.current);
    metaPersistTimer.current = setTimeout(() => {
      try {
        const arr = Array.from(metaCacheRef.current.values());
        localStorage.setItem('tokenMetaCacheV1', JSON.stringify(arr.slice(0, 5000)));
      } catch {}
    }, 800);
  }, []);

  const fetchMetaplexMetadataBatch = useCallback(async (mints: string[]) => {
    const need = mints.filter(m => {
      const meta = metaCacheRef.current.get(m);
      return !meta || (!meta.logoURI && (!meta.symbol || meta.symbol === m.slice(0,4)));
    });
    if (!need.length) return;
    const limit = 4;
    let i = 0;
    const tasks: Promise<void>[] = [];
    const run = async (mint: string) => {
      try {
        const mintPk = new PublicKey(mint);
        const pda = deriveMetadataPda(mintPk);
        const acct = await connection.getAccountInfo(pda);
        if (!acct) return;
        // Updated Metaplex deserialize usage
        // The Metadata class has a fromAccountInfo helper in recent versions
        let metadata: any;
        try {
          // @ts-ignore dynamic method
          const decoded = (TokenMetadata as any).deserialize ? (TokenMetadata as any).deserialize(acct.data) : (TokenMetadata as any).fromAccountInfo?.({ data: acct.data });
          metadata = Array.isArray(decoded) ? decoded[0] : decoded?.[0] || decoded;
        } catch {}
        if (!metadata) return;
        const clean = (s: string) => s.replace(/\0/g, '').trim();
        let uri = clean(metadata.uri || '');
        let json: any = null;
        if (uri) { try { const res = await fetch(uri); if (res.ok) json = await res.json(); } catch {} }
        const current = metaCacheRef.current.get(mint) || { address: mint, decimals: 9, logoURI: '', name: mint, symbol: mint.slice(0,4) } as TokenMeta;
        const updated: TokenMeta = { ...current, address: mint, symbol: clean(metadata.symbol) || current.symbol, name: clean(metadata.name) || current.name, logoURI: current.logoURI || json?.image || json?.logo || '', decimals: current.decimals ?? 9, tags: current.tags };
        metaCacheRef.current.set(mint, updated);
      } catch {}
    };
    const next = async () => { if (i >= need.length) return; const mint = need[i++]; await run(mint); await next(); };
    for (let k=0;k<limit;k++) tasks.push(next());
    await Promise.all(tasks);
    schedulePersistMeta();
  }, [connection, schedulePersistMeta]);

  const fetchTokenMetadataBatch = useCallback(async (mints: string[]) => {
    const unknown = mints.filter(m => !metaCacheRef.current.has(m) && !inFlightMetaRef.current.has(m));
    if (!unknown.length) return;
    unknown.forEach(m => inFlightMetaRef.current.add(m));
    try {
      const results = await Promise.allSettled(unknown.map(async mint => {
        const res = await fetch(JUP_SEARCH_BASE + mint);
        if (!res.ok) throw new Error("meta fetch failed " + mint);
        const data = await res.json();
        const token = data?.tokens?.find((t: any) => t.address === mint) || data?.tokens?.[0];
        if (token) {
          const meta: TokenMeta = { address: token.address, symbol: token.symbol || mint.slice(0,4), name: token.name || token.symbol || mint, logoURI: token.logoURI || token.logo || "", decimals: token.decimals ?? 9, verified: token.verified, tags: token.tags };
          metaCacheRef.current.set(mint, meta);
        }
      }));
      unknown.forEach(m => inFlightMetaRef.current.delete(m));
      if (results.some(r => r.status === 'rejected')) console.warn("Some token metadata fetches failed", results.filter(r => r.status === 'rejected'));
      schedulePersistMeta();
      await fetchMetaplexMetadataBatch(mints);
    } catch (err) {
      console.warn("Metadata batch error", err);
      unknown.forEach(m => inFlightMetaRef.current.delete(m));
    }
  }, [fetchMetaplexMetadataBatch, schedulePersistMeta]);

  const fetchPricesBatch = useCallback(async (mints: string[]) => {
    const missing = mints.filter(m => !priceCacheRef.current.has(m));
    if (!missing.length) return;
    try {
      const chunkSize = 10; // reduced to lower risk of network failure
      for (let i=0;i<missing.length;i+=chunkSize) {
        const slice = missing.slice(i, i+chunkSize);
        const url = JUP_PRICE_BASE + encodeURIComponent(slice.join(','));
        console.log('[PRICE] fetch', url, 'online=', navigator.onLine);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('price fetch non-200 '+res.status);
        const data = await res.json();
        const priceData = data?.data || {};
        Object.entries(priceData).forEach(([mint, val]: any) => { const price = val?.price; if (typeof price === 'number') priceCacheRef.current.set(mint, price); });
      }
      setPriceError(false);
    } catch (err) {
      console.warn('Price fetch error', err);
      setPriceError(true);
      if (!priceCacheRef.current.has('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')) priceCacheRef.current.set('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1);
      if (!priceCacheRef.current.has(WSOL_MINT)) priceCacheRef.current.set(WSOL_MINT, 150);
    }
  }, []);

  const fetchWalletTokensDAS = useCallback(async (): Promise<WalletToken[] | null> => {
    if (!connected || !publicKey) return null;
    try {
      const body = { jsonrpc: "2.0", id: "swap-dashboard", method: "getAssetsByOwner", params: { ownerAddress: publicKey.toBase58(), page: 1, limit: 1000, displayOptions: { showFungible: true, showNativeBalance: false, showUnverifiedCollections: false } } };
      const res = await fetch(connection.rpcEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('DAS fetch failed');
      const json = await res.json();
      const assets: any[] = json?.result?.items || [];
      if (!assets.length) return [];
      const out: WalletToken[] = [];
      const mints: string[] = [];
      for (const a of assets) {
        const ti = a.token_info; if (!ti) continue; const mint = ti?.mint || a.id; const decimals = ti?.decimals ?? 0; const rawBal = Number(ti?.balance ?? 0); const amount = decimals ? rawBal / 10 ** decimals : rawBal; const symbol = ti?.symbol || a.content?.metadata?.symbol || mint.slice(0,4); const name = ti?.name || a.content?.metadata?.name || symbol; const logoURI = ti?.image || a.content?.files?.[0]?.uri || a.content?.links?.image || ''; const meta: TokenMeta = { address: mint, symbol, name, logoURI, decimals, verified: ti?.verified, tags: ti?.tags || a.content?.metadata?.attributes?.map((att: any)=>att.trait_type).filter(Boolean) }; if (!metaCacheRef.current.has(mint)) metaCacheRef.current.set(mint, meta); mints.push(mint); out.push({ mint, amount, symbol, name, logoURI, decimals, verified: meta.verified }); }
      schedulePersistMeta();
      await fetchTokenMetadataBatch(mints);
      await fetchPricesBatch(mints);
      return out.map(t => { const meta = metaCacheRef.current.get(t.mint) || t; const price = priceCacheRef.current.get(t.mint); return { ...t, symbol: meta.symbol || t.symbol, name: meta.name || t.name, logoURI: meta.logoURI || t.logoURI, priceUSD: price, valueUSD: price ? t.amount * price : undefined }; }).sort((a,b) => (b.valueUSD||0) - (a.valueUSD||0));
    } catch (e) {
      console.warn('DAS fallback to RPC balances', e);
      return null;
    }
  }, [connected, publicKey, connection.rpcEndpoint, fetchPricesBatch, fetchTokenMetadataBatch, schedulePersistMeta]);

  const fetchWalletTokens = useCallback(async () => {
    if (!connected || !publicKey) { setTokens([]); return; }
    setTokensLoading(true);
    try {
      const dasTokens = await fetchWalletTokensDAS();
      if (dasTokens) { setTokens(dasTokens); return; }
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
      type ParsedTokenAccount = { account: { data: ParsedAccountData } };
      const parsed: { mint: string; amount: number }[] = (accounts.value as ParsedTokenAccount[]).map(({ account }: ParsedTokenAccount) => {
        const info = (account.data as ParsedAccountData).parsed.info as any;
        const mint: string = info.mint;
        const amount: number = info.tokenAmount.uiAmount;
        return { mint, amount };
      });
      const mints: string[] = parsed.map((p: { mint: string }) => p.mint);
      await fetchTokenMetadataBatch(mints);
      await fetchPricesBatch(mints);
      const enriched: WalletToken[] = parsed.map(({ mint, amount }: { mint: string; amount: number }) => {
        const meta = metaCacheRef.current.get(mint);
        const price = priceCacheRef.current.get(mint);
        return { mint, amount, symbol: meta?.symbol || mint.slice(0,4), name: meta?.name || meta?.symbol || mint, logoURI: meta?.logoURI || "", decimals: meta?.decimals, verified: meta?.verified, priceUSD: price, valueUSD: price ? amount * price : undefined };
      }).sort((a: WalletToken, b: WalletToken) => (b.valueUSD || 0) - (a.valueUSD || 0));
      setTokens(enriched);
    } catch (e) { console.warn("Token balance fetch failed", e); } finally { setTokensLoading(false); }
  }, [connected, publicKey, connection, fetchTokenMetadataBatch, fetchPricesBatch, fetchWalletTokensDAS]);

  // Initial + on connect token fetch
  useEffect(() => { fetchWalletTokens(); }, [fetchWalletTokens]);

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(()=>{}); }, [publicKey]);

  const [mounted, setMounted] = useState(false); useEffect(()=>{ setMounted(true); },[]);

  // -------- Ultra API Fallback Swap Flow (reliable landing attempts) --------
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase:string; attempt:number; message?:string; signature?:string; requestId?:string; error?:string }|null>(null);
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9)); // keep 0.002 SOL for fees
  const priorityEscalation = (attempt:number) => {
    // simple escalating microLamports suggestion (not injected yet – placeholder for future compute budget insertion)
    return [5000, 10000, 20000, 40000][attempt-1] || 50000; // microLamports
  };

  const getJupiterState = () => {
    try { const w:any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; }
  };

  const deriveInputInfo = () => {
    const st = getJupiterState();
    const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT;
    const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT;
    const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; // base units string
    return { inputMint, outputMint, rawAmount };
  };

  const clampAmountToBalance = (inputMint:string, rawAmount:string) => {
    try {
      if (!tokens.length) return rawAmount;
      const t = tokens.find(tk => tk.mint === inputMint);
      if (!t || t.decimals == null) return rawAmount;
      const balBase = Math.floor(t.amount * 10 ** t.decimals);
      const wanted = Number(rawAmount);
      if (!Number.isFinite(wanted)) return rawAmount;
      if (inputMint === WSOL_MINT) {
        // Reserve SOL for fees
        const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined;
        if (solAvailLamports != null && solAvailLamports < wanted) {
          return String(Math.max(0, solAvailLamports));
        }
      }
      if (wanted > balBase) return String(Math.max(0, balBase));
      return rawAmount;
    } catch { return rawAmount; }
  };

  const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready','err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true);
    setUltraStatus({ phase:'start', attempt:1, message:'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const inputDecimals = (tokens.find(t=>t.mint===inputMint)?.decimals) ?? KNOWN_DECIMALS[inputMint] ?? 6;
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount);
      if (amountBaseStr === '0') throw new Error('Amount zero after clamp');

      let attempt = 0;
      let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const priorityMicroLamports = priorityEscalation(attempt);
        setUltraStatus({ phase:'quote', attempt, message:`Fetching quote (priority ${priorityMicroLamports})` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(defaultSlippageBps) });
        const quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
        if (!quoteRes.ok) throw new Error('Quote HTTP '+quoteRes.status);
        const quote = await quoteRes.json();
        if (!quote || !quote.routePlan) throw new Error('Invalid quote');
        console.log('[ULTRA][QUOTE]', { attempt, quote });

        setUltraStatus({ phase:'order', attempt, message:'Creating order' });
        const orderBody:any = { quoteResponse: quote, userPublicKey: publicKey.toBase58() };
        // Placeholder for future priority fee parameter if supported by API (document check needed)
        try { orderBody.priorityFeeMicroLamports = priorityMicroLamports; } catch {}
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(orderBody) });
        if (!orderResRaw.ok) throw new Error('Order HTTP '+orderResRaw.status);
        const orderRes = await orderResRaw.json();
        if (!orderRes.transaction) throw new Error('No transaction in order response');
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });

        setUltraStatus({ phase:'sign', attempt, message:'Signing transaction', requestId: orderRes.requestId });
        const rawTx = Buffer.from(orderRes.transaction, 'base64');
        let tx: VersionedTransaction;
        try { tx = VersionedTransaction.deserialize(rawTx); } catch (e) { throw new Error('Deserialize failed: '+(e as any)?.message); }
        // (Optional future) inject compute budget here if needed
        try { await passthroughWallet.signTransaction(tx as any); } catch (e) { throw new Error('Sign failed: '+(e as any)?.message); }
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        setUltraStatus({ phase:'execute', attempt, message:'Submitting (execute)', requestId: orderRes.requestId });
        const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
        if (!execRaw.ok) throw new Error('Execute HTTP '+execRaw.status);
        const execRes = await execRaw.json();
        console.log('[ULTRA][EXECUTE]', execRes);
        const signature = execRes.signature || execRes.txid || execRes.transactionId;
        setUltraStatus({ phase:'confirm', attempt, message:'Polling status', signature, requestId: orderRes.requestId });

        // Poll Jupiter Ultra status endpoint first
        let filled = false; let failed = false;
        for (let i=0;i<24;i++) { // ~36s (1.5s * 24) or adapt
          await sleep(1500);
          let statusJson:any = null;
          try {
            const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
            if (stRaw.ok) statusJson = await stRaw.json();
          } catch {}
          console.log('[ULTRA][STATUS]', { attempt, statusJson });
          if (statusJson?.status === 'filled') { filled = true; break; }
          if (['failed','cancelled'].includes(statusJson?.status)) { failed = true; lastError = new Error('Status '+statusJson.status); break; }
          // Fallback direct signature status
          if (signature) {
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { failed = true; lastError = new Error('Transaction error'); break; }
              if (v?.confirmationStatus === 'finalized') { filled = true; break; }
            } catch {}
          }
        }
        if (filled) {
          setUltraStatus(s=> s ? { ...s, phase:'done', message:'Filled', signature } : null);
          pushToast('Ultra swap filled','ok');
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((lamports:number)=> setSolBalance(lamports/1e9)).catch(()=>{}); }
          return;
        }
        if (!filled) {
          setUltraStatus(s=> s ? { ...s, phase:'retry', message:'Not filled, retrying…', signature } : null);
          lastError = lastError || new Error('Not filled before timeout');
          console.warn('[ULTRA] attempt not filled, will retry', { attempt, signature });
          // brief backoff before retry
          await sleep(1000 + attempt*500);
          continue;
        }
      }
      throw lastError || new Error('All attempts failed');
    } catch (err:any) {
      console.error('[ULTRA][FAIL]', err);
      setUltraStatus(s => s ? { ...s, phase:'error', error: err?.message || String(err) } : { phase:'error', attempt:1, error: err?.message || String(err) });
      pushToast('Ultra swap failed','err');
    } finally {
      setUltraBusy(false);
    }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast]);
  // -------- End Ultra API Fallback --------

  // SOL balance via account change subscription (no polling)
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{});
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(()=>{}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  const refreshBlockData = useCallback(async () => { try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {} }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  useEffect(() => {
    if (document.getElementById("jupiter-plugin-script")) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement("script");
    script.id = "jupiter-plugin-script";
    script.src = "https://plugin.jup.ag/plugin-v1.js";
    script.async = true;
    script.onload = () => { jupiterScriptLoadedRef.current = true; console.log("Jupiter script loaded"); };
    script.onerror = (e) => console.error("Failed to load Jupiter plugin script", e);
    document.head.appendChild(script);
  }, []);

  // Poll for Jupiter readiness
  useEffect(() => {
    if (jupiterInitializedRef.current) return;
    let tries = 0;
    const id = setInterval(() => {
      const w: any = window as any;
      if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); /* next effect will run */ }
      if (++tries > 40) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const forceSetWallet = useCallback(() => {
    // Retained as internal helper if needed in future; not exposed via button
    try {
      const w: any = window as any;
      if (!w.Jupiter || !solWallet || !publicKey) return;
      if (w.Jupiter.setWallet) {
        w.Jupiter.setWallet(solWallet);
        setJupStatus(s => ({ ...s, wallet: publicKey.toBase58() }));
      }
    } catch {}
  }, [solWallet, publicKey]);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus(s=>({...s, wallet: currentPk })); } catch{}
      }
      prevWalletPubkeyRef.current = currentPk;
      return;
    }
    try {
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet, // keep context state for adapter UI
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); }},
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      w.__JUP_INIT_DONE = true;
      jupiterInitializedRef.current = true;
      setJupStatus({ inited:true, wallet: publicKey ? publicKey.toBase58() : undefined });
      prevWalletPubkeyRef.current = currentPk;
    } catch (err) { setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens]);

  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  const totalUSD = tokens.reduce((acc, t) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const totalTokenValueInSOL = solPrice ? totalUSD / solPrice : undefined;
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined;
  const displayTokens = tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())).slice().sort((a,b)=>{ if (sortKey==='value') return (b.valueUSD||0)-(a.valueUSD||0); if (sortKey==='amount') return (b.amount||0)-(a.amount||0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback