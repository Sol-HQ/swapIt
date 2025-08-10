"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { PublicKey, type ParsedAccountData, type AccountInfo } from "@solana/web3.js";
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

  const manualRetryPrices = useCallback(() => {
    try {
      const currentMints = tokens.map(t=>t.mint);
      setPriceError(false);
      fetchPricesBatch(currentMints);
    } catch {}
  }, [tokens, fetchPricesBatch]);

  // --- Jupiter deep debug helpers ---
  function logJupState(tag: string) {
    try {
      const w:any = window as any;
      const st = w?.Jupiter?.getState?.();
      const snap = st ? {
        form: st.form,
        wallet: st.wallet,
        route: st.route,
        lastError: st.lastError,
        priceFetched: !!st.priceMap,
        inputAmount: st.form?.amount,
        inputMint: st.form?.inputMint,
        outputMint: st.form?.outputMint,
      } : null;
      console.log('[JUP][STATE]', tag, snap);
    } catch(e){ console.warn('[JUP][STATE] fail', tag, e); }
  }

  // Extra periodic snapshot when debug flag enabled
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEBUG_SWAP !== '1') return;
    const id = setInterval(()=>logJupState('interval'), 7000);
    return () => clearInterval(id);
  }, []);

  // Capture console.error temporarily to surface hidden plugin errors (restore after 20s)
  useEffect(() => {
    const orig = console.error;
    (console as any).error = function(...args:any[]) {
      if (args?.[0] && typeof args[0] === 'string' && args[0].includes('Jupiter')) {
        try { logJupState('consoleError'); } catch {}
      }
      orig.apply(console, args);
    };
    const to = setTimeout(()=>{ console.error = orig; }, 20000);
    return () => { clearTimeout(to); console.error = orig; };
  }, [logJupState]);

  // Manual Jupiter re-init button (for dev/testing)
  const [jupReinitKey, setJupReinitKey] = useState(0);
  const reinitJupiter = useCallback(() => {
    setJupReinitKey(k => k+1);
    jupiterInitializedRef.current = false;
    setJupStatus({ inited:false });
    const w: any = window as any;
    if (w.Jupiter?.reset) {
      try { w.Jupiter.reset(); console.log('[JUP] Jupiter reset'); } catch(e) { console.warn('[JUP] Jupiter reset fail', e); }
    }
  }, []);

  useEffect(() => {
    if (jupReinitKey === 0) return;
    const w: any = window as any;
    if (!w.Jupiter) return;
    try {
      console.log('[JUP] re-initializing');
      w.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "target-container",
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet,
        wallet: passthroughWallet || solWallet,
        endpoint: connection.rpcEndpoint,
        cluster: "mainnet-beta",
        refetchIntervalForTokenAccounts: 10,
        strictTokenList: false,
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: "1000000", initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: (info: any) => { console.log('[JUP] swapStart', info); },
        onSwapSuccess: (swapInfo: any) => { console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess'); setSwapHistory(prev=>[{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((lamports: number) => setSolBalance(lamports / 1e9)).catch(()=>{}); } },
        onSwapError: (error: any) => { console.error('[JUP] swapError', error); logJupState('afterError'); setSwapHistory(prev=>[{ error: error?.message || String(error), code: (error && (error.code||error.type)) || undefined, raw: JSON.stringify(error, (k,v)=> (typeof v === 'function'? undefined : v)), timestamp: new Date().toLocaleString() }, ...prev]); setJupStatus(s=>({...s, error: error?.message || String(error)})); }
      });
      setJupStatus({ inited:true, wallet: publicKey?.toBase58() || undefined });
      console.log('[JUP] re-init done');
    } catch (err) { console.error('[JUP] re-init error', err); setJupStatus({ inited:false, error: (err as any)?.message }); }
  }, [jupReinitKey, passthroughWallet, solWallet, connection, publicKey]);

  // --- Token meta copy & Jupiter selection helpers ---
  const [lastTokenAction, setLastTokenAction] = useState<{ mint:string; ts:number; mode:'in'|'out' }|null>(null);
  // New state for asset table enhancements
  const [assetSort, setAssetSort] = useState<{key:'symbol'|'name'|'amount'|'usd'|'sol'|'pct'; dir:1|-1}>({ key:'usd', dir:-1 });
  const [assetPage, setAssetPage] = useState(0);
  const [assetPageSize, setAssetPageSize] = useState(25);
  const [isNarrow, setIsNarrow] = useState(false);
  const [assetPanelOpen, setAssetPanelOpen] = useState(true);
  const [toasts, setToasts] = useState<{ id:number; msg:string; tone:'ok'|'err'|'info' }[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((msg:string, tone:'ok'|'err'|'info'='info') => {
    setToasts(t => [...t, { id: ++toastIdRef.current, msg, tone }]);
  }, []);
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map(t => setTimeout(()=>{ setToasts(curr => curr.filter(c => c.id !== t.id)); }, 2600));
    return () => { timers.forEach(clearTimeout); };
  }, [toasts]);

  // New effect to handle window resize and update isNarrow state
  useEffect(() => {
    function handleResize() {
      const narrow = window.innerWidth < 1280; // breakpoint
      setIsNarrow(narrow);
      if (narrow) setAssetPanelOpen(false);
      else setAssetPanelOpen(true);
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Asset table processing (independent of sidebar small list sort)
  const baseFiltered = useMemo(() => tokens.filter(t => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT).filter(t => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase())), [tokens, showSmall, searchQuery]);
  const assetSorted = useMemo(() => {
    const clone = baseFiltered.slice();
    clone.sort((a,b) => {
      const pctA = totalUSD ? ((a.valueUSD||0)/totalUSD) : 0; const pctB = totalUSD ? ((b.valueUSD||0)/totalUSD) : 0;
      switch(assetSort.key){
        case 'symbol': return a.symbol.localeCompare(b.symbol)*assetSort.dir;
        case 'name': return a.name.localeCompare(b.name)*assetSort.dir;
        case 'amount': return ((a.amount||0)-(b.amount||0))*assetSort.dir;
        case 'usd': return ((a.valueUSD||0)-(b.valueUSD||0))*assetSort.dir;
        case 'sol': return (((a.valueUSD||0)/(solPrice||1))-((b.valueUSD||0)/(solPrice||1)))*assetSort.dir;
        case 'pct': return (pctA-pctB)*assetSort.dir;
      }
    });
    return clone;
  }, [baseFiltered, assetSort, totalUSD, solPrice]);
  const totalPages = Math.max(1, Math.ceil(assetSorted.length / assetPageSize));
  const pageSafe = Math.min(assetPage, totalPages-1);
  const assetPageSlice = assetSorted.slice(pageSafe*assetPageSize, pageSafe*assetPageSize + assetPageSize);
  useEffect(()=>{ if (assetPage>=totalPages) setAssetPage(totalPages-1); }, [totalPages, assetPage]);

  function toggleSort(key: 'symbol'|'name'|'amount'|'usd'|'sol'|'pct') {
    setAssetSort(s => s.key===key ? { key, dir: (s.dir===1?-1:1) } : { key, dir: (key==='usd'||key==='amount'||key==='sol'||key==='pct'?-1:1) });
  }

  function exportJSON() {
    try {
      const data = assetSorted.map(t => {
        const mintPk = new PublicKey(t.mint); const pda = deriveMetadataPda(mintPk).toBase58();
        return { symbol:t.symbol, name:t.name, amount:t.amount, usd:t.valueUSD, sol: solPrice && t.valueUSD ? t.valueUSD/solPrice : undefined, pct: totalUSD? (t.valueUSD||0)/totalUSD : 0, mint:t.mint, metadataPda:pda };
      });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='assets.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 500);
    } catch(e){ console.warn('exportJSON failed', e); }
  }
  function exportCSV() {
    try {
      const header = ['symbol','name','amount','usd','sol','pct','mint','metadataPda'];
      const rows = assetSorted.map(t => { const mintPk = new PublicKey(t.mint); const pda = deriveMetadataPda(mintPk).toBase58(); const solv = solPrice && t.valueUSD ? t.valueUSD/solPrice : undefined; const pct = totalUSD? (t.valueUSD||0)/totalUSD : 0; return [t.symbol, t.name.replace(/,/g,' '), t.amount, t.valueUSD??'', solv??'', pct, t.mint, pda]; });
      const csv = [header.join(','), ...rows.map(r=>r.join(','))].join('\n');
      const blob = new Blob([csv], { type:'text/csv' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='assets.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 500);
    } catch(e){ console.warn('exportCSV failed', e); }
  }

  useEffect(() => {
    if (!lastTokenAction) return;
    const id = setTimeout(() => {
      // auto-clear feedback after 4s
      setLastTokenAction(curr => (curr && Date.now() - curr.ts > 3500 ? null : curr));
    }, 4000);
    return () => clearTimeout(id);
  }, [lastTokenAction]);

  const handleTokenMetaClick = useCallback((token: WalletToken, e: React.MouseEvent) => {
    try {
      const mintPk = new PublicKey(token.mint);
      const metaPda = deriveMetadataPda(mintPk).toBase58();
      const payload = {
        mint: token.mint,
        metadataPda: metaPda,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        priceUSD: token.priceUSD,
        valueUSD: token.valueUSD,
        timestamp: new Date().toISOString()
      };
      navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(()=>pushToast(`Meta copied: ${token.symbol}`,'ok')).catch(()=>pushToast('Copy failed','err'));
      const w: any = window as any;
      const mode: 'in'|'out' = e.shiftKey || e.altKey ? 'out' : 'in';
      let setOk = false;
      try {
        if (w?.Jupiter?.setFormValue) {
          if (mode==='in') { w.Jupiter.setFormValue({ inputMint: token.mint }); setOk = true; }
          else { w.Jupiter.setFormValue({ outputMint: token.mint }); setOk = true; }
        } else if (w?.Jupiter?.setInputMint && mode==='in') { w.Jupiter.setInputMint(token.mint); setOk = true; }
        else if (w?.Jupiter?.setOutputMint && mode==='out') { w.Jupiter.setOutputMint(token.mint); setOk = true; }
        // Fallback: mutate state if exposed
        else if (w?.Jupiter?.getState && w?.Jupiter?.setState) {
          const st = w.Jupiter.getState();
            w.Jupiter.setState({ ...st, form: { ...st.form, [mode==='in'?'inputMint':'outputMint']: token.mint } });
            setOk = true;
        }
      } catch (selErr) { console.warn('[TokenSelect] Jupiter set mint failed', selErr); }
      // Post-check after a short delay
      setTimeout(()=>{
        try {
          const st = w?.Jupiter?.getState?.();
          const selected = mode==='in' ? st?.form?.inputMint : st?.form?.outputMint;
          if (selected === token.mint) pushToast(`${token.symbol} set as ${mode==='in'?'input':'output'}`,'ok');
          else if (setOk) pushToast('Selection not reflected','err');
        } catch {}
      }, 350);
      setLastTokenAction({ mint: token.mint, ts: Date.now(), mode });
    } catch (err) { console.warn('Token meta copy/select failure', err); pushToast('Meta action failed','err'); }
  }, [pushToast]);

  return !mounted ? (<div style={{ width: '100%', display:'flex', justifyContent:'center', padding:32, color:'#888', fontFamily:'Inter, sans-serif' }}>Loading…</div>) : (
    <div style={{ display: 'flex', flexDirection:'column', gap: 16, fontFamily: 'Inter, sans-serif', paddingBottom:48 }}>
      <div style={{ display:'grid', gridTemplateColumns:'520px 360px 220px', gridTemplateRows:'auto auto', gap:20, alignItems:'start' }}>
        <div style={{ gridColumn:'1 / 2', gridRow:'1 / span 2', minWidth: 520, background: '#18181b', borderRadius: 16, padding: 20, color: '#fff', boxShadow: '0 2px 14px #0006' }}>
          <WalletMultiButton />
          <div style={{ marginTop: 12 }}><strong>Status:</strong> {connected ? 'Connected' : 'Not connected'}</div>
          {connected && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Wallet:</strong>
                <div style={{ display:'flex', gap:6 }}>
                  <button onClick={refreshBlockData} title="Refresh block" style={{ fontSize: 11, padding: '2px 6px', background: '#27272a', color: '#fff', border: '1px solid #333', borderRadius: 6 }}>Block</button>
                  <button onClick={copyAddress} title="Copy address" style={{ fontSize: 11, padding: '2px 6px', background: '#27272a', color: '#fff', border: '1px solid #333', borderRadius: 6 }}>Copy</button>
                </div>
              </div>
              <div style={{ wordBreak: 'break-all', fontSize: 12 }}>{publicKey?.toBase58()}</div>
              <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:4 }}>
                <div><strong>SOL:</strong> {solBalance !== null ? fmt(solBalance,{maximumFractionDigits:4}) : '-'} </div>
                <div><strong>Portfolio:</strong> {fmtUSD(totalUSD)}{totalTokenValueInSOL!==undefined && <span style={{ color:'#888', marginLeft:4 }}>({totalTokenValueInSOL.toFixed(3)} SOL)</span>}</div>
                <div><strong>SOL Bal:</strong> {solBalance!==null? fmt(solBalance,{maximumFractionDigits:4}):'-'}{walletSolUSD!==undefined && <span style={{ color:'#888', marginLeft:4 }}>{fmtUSD(walletSolUSD)}</span>}</div>
                <div><strong>Total Net:</strong> {fmtUSD(grandTotalUSD)}{grandTotalSOL!==undefined && <span style={{ color:'#888', marginLeft:4 }}>({grandTotalSOL.toFixed(3)} SOL)</span>}</div>
                <div><strong>Blockhash:</strong> {blockhash || '-'}</div>
                <div><strong>Time:</strong> {blockTime || '-'}</div>
              </div>
              <div style={{ marginTop: 8, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                <label style={{ fontSize: 12, display:'flex', alignItems:'center', gap:4 }}>
                  <input type="checkbox" checked={autoBlockRefresh} onChange={e => setAutoBlockRefresh(e.target.checked)} /> Auto Block (3m)
                </label>
                <label style={{ fontSize: 12, display:'flex', alignItems:'center', gap:4 }}>
                  <input type="checkbox" checked={showSmall} onChange={e => setShowSmall(e.target.checked)} /> Show Small
                </label>
                <div style={{ display:'flex', gap:4 }}>
                  {(['value','amount','symbol'] as const).map(k => (
                    <button key={k} onClick={()=>setSortKey(k)} style={{ fontSize:10, padding:'2px 6px', background: sortKey===k?'#334155':'#27272a', color:'#fff', border:'1px solid #333', borderRadius:4 }}>{k}</button>
                  ))}
                </div>
                <button onClick={fetchWalletTokens} style={{ fontSize: 11, padding: '2px 8px', background: '#3f3f46', color: '#fff', border: '1px solid #333', borderRadius: 6 }}>Tokens</button>
              </div>
            </div>
          )}
        </div>
        <div style={{ gridColumn:'2 / 3', gridRow:'1 / 2', display:'flex', justifyContent:'center' }}>
          <div id="target-container" style={{ width: 360, height: 520, minHeight: 520, borderRadius: 16, overflow: 'hidden', boxShadow: '0 2px 14px #0006', background:'#101012' }} />
        </div>
        <div style={{ gridColumn:'2 / 3', gridRow:'2 / 3', background:'#141416', borderRadius:16, minHeight:120, boxShadow:'0 2px 10px #0005', border:'1px solid #222', display:'flex', alignItems:'center', justifyContent:'center', color:'#444', fontSize:12 }}>
          {/* Reserved lower panel under Jupiter modal */}
          Coming soon…
        </div>
        <div style={{ gridColumn:'3 / 4', gridRow:'1 / span 2', width: '100%', display:'flex', flexDirection:'column' }}>
          <div style={{ background: '#18181b', borderRadius: 16, padding: '12px 14px', flex:1, display:'flex', flexDirection:'column', boxShadow: '0 2px 12px #0004' }}>
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight:600, letterSpacing:0.5, color:'#fafafa', textTransform:'uppercase' }}>Swaps</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin:0, overflowY: 'auto', fontSize:11, lineHeight:1.25 }}>
              {swapHistory.length > 0 ? (
                swapHistory.map((swap, idx) => {
                  const isErr = (swap as SwapErrorRecord).error;
                  return (
                    <li key={idx} style={{
                      marginBottom: 8,
                      background: isErr ? 'linear-gradient(90deg,#3b0d0d,#2a0a0a)' : 'linear-gradient(90deg,#0f1e2a,#132b33)',
                      border: '1px solid ' + (isErr ? '#7f1d1d' : '#1e3a5f'),
                      color: isErr ? '#fecaca' : '#e2f3ff',
                      padding: '8px 10px',
                      borderRadius: 10,
                      boxShadow: '0 0 0 1px #000 inset',
                      display:'flex',
                      flexDirection:'column'
                    }}>
                      {isErr ? (
                        <span style={{ fontWeight:500 }}>❌ {(swap as SwapErrorRecord).error}</span>
                      ) : (
                        <span style={{ fontWeight:500 }}>✅ {(swap as SwapSuccessRecord).inputAmount} {(swap as SwapSuccessRecord).inputSymbol} → {(swap as SwapSuccessRecord).outputAmount} {(swap as SwapSuccessRecord).outputSymbol}</span>
                      )}
                      <span style={{ fontSize:10, opacity:0.6 }}>{swap.timestamp}</span>
                    </li>
                  );
                })
              ) : (
                <li style={{ color:'#666', fontSize:11 }}>No swaps yet</li>
              )}
            </ul>
          </div>
        </div>
      </div>
      {/* Expanded Asset Meta Panel */}
      {connected && (
        <div style={{ width: '100%', background:'#18181b', borderRadius:18, padding:'16px 20px 22px', boxShadow:'0 2px 24px -4px #0006', display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <button onClick={()=>setAssetPanelOpen(o=>!o)} style={{ background:'#101012', border:'1px solid #2a2a2f', color:'#fff', padding:'6px 10px', borderRadius:8, fontSize:11, cursor:'pointer' }}>{assetPanelOpen? (isNarrow? 'Hide Assets ▲':'Collapse ▲') : 'Assets ▼'}</button>
              <h3 style={{ margin:0, fontSize:16, fontWeight:600, letterSpacing:0.5, textTransform:'uppercase', background:'linear-gradient(90deg,#60a5fa,#34d399,#fbbf24)', WebkitBackgroundClip:'text', color:'transparent' }}>Asset Metadata</h3>
            </div>
            {assetPanelOpen && (
              <div style={{ display:'flex', gap:8, fontSize:11, flexWrap:'wrap' }}>
                <input value={searchQuery} onChange={e=>{ setSearchQuery(e.target.value); setAssetPage(0); }} placeholder='Search symbol / name / mint' style={{ background:'#101012', border:'1px solid #2a2a2f', borderRadius:6, padding:'4px 8px', fontSize:11, color:'#fff', minWidth:220 }} />
                <button onClick={fetchWalletTokens} style={{ fontSize:11, padding:'4px 10px', background:'#27272a', border:'1px solid #333', color:'#fff', borderRadius:6 }}>Refresh</button>
                {priceError && <button onClick={manualRetryPrices} style={{ fontSize:11, padding:'4px 10px', background:'#7f1d1d', border:'1px solid #b91c1c', color:'#fff', borderRadius:6 }}>Retry Prices</button>}
                <button onClick={exportJSON} style={{ fontSize:11, padding:'4px 10px', background:'#1e3a5f', border:'1px solid #1e3a5f', color:'#fff', borderRadius:6 }}>Export JSON</button>
                <button onClick={exportCSV} style={{ fontSize:11, padding:'4px 10px', background:'#334155', border:'1px solid #334155', color:'#fff', borderRadius:6 }}>Export CSV</button>
                <label style={{ display:'flex', alignItems:'center', gap:4 }}>Page Size
                  <select value={assetPageSize} onChange={e=>{ setAssetPageSize(Number(e.target.value)); setAssetPage(0); }} style={{ background:'#101012', border:'1px solid #2a2a2f', color:'#fff', fontSize:11, padding:'4px 6px', borderRadius:6 }}>
                    {[10,25,50,100].map(s=> <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                  <button disabled={pageSafe===0} onClick={()=>setAssetPage(p=>Math.max(0,p-1))} style={{ fontSize:11, padding:'4px 8px', background:'#27272a', border:'1px solid #333', color: pageSafe===0?'#555':'#fff', borderRadius:6, cursor:pageSafe===0?'default':'pointer' }}>Prev</button>
                  <div style={{ fontSize:11 }}>Page {pageSafe+1} / {totalPages}</div>
                  <button disabled={pageSafe>=totalPages-1} onClick={()=>setAssetPage(p=>Math.min(totalPages-1,p+1))} style={{ fontSize:11, padding:'4px 8px', background:'#27272a', border:'1px solid #333', color: pageSafe>=totalPages-1?'#555':'#fff', borderRadius:6, cursor:pageSafe>=totalPages-1?'default':'pointer' }}>Next</button>
                </div>
              </div>
            )}
          </div>
          {assetPanelOpen && (
            <div style={{ overflowX:'auto', border:'1px solid #242427', borderRadius:12, background:'#101012', boxShadow:'0 0 0 1px #000 inset' }}>
              <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, fontSize:12, lineHeight:1.3 }}>
                <thead style={{ background:'#1f1f23' }}>
                  <tr style={{ textAlign:'left' }}>
                    <th style={{ padding:'8px 10px', fontWeight:500 }}>#</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, cursor:'pointer' }} onClick={()=>toggleSort('symbol')}>Asset {assetSort.key==='symbol'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, minWidth:120, cursor:'pointer' }} onClick={()=>toggleSort('name')}>Name {assetSort.key==='name'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, cursor:'pointer' }} onClick={()=>toggleSort('amount')}>Amount {assetSort.key==='amount'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, cursor:'pointer' }} onClick={()=>toggleSort('usd')}>USD {assetSort.key==='usd'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, cursor:'pointer' }} onClick={()=>toggleSort('sol')}>SOL {assetSort.key==='sol'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, cursor:'pointer' }} onClick={()=>toggleSort('pct')}>% {assetSort.key==='pct'?(assetSort.dir===1?'▲':'▼'):''}</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, minWidth:200 }}>Mint</th>
                    <th style={{ padding:'8px 10px', fontWeight:500, minWidth:200 }}>Metadata PDA</th>
                    <th style={{ padding:'8px 10px', fontWeight:500 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assetPageSlice.map((token, idx) => {
                    const pct = totalUSD ? ((token.valueUSD||0)/ totalUSD)*100 : 0;
                    const mintPk = new PublicKey(token.mint);
                    const pda = deriveMetadataPda(mintPk).toBase58();
                    return (
                      <tr key={token.mint} style={{ background: ((pageSafe*assetPageSize)+idx) % 2 ? '#16161a':'#131316', transition:'background .15s' }}>
                        <td style={{ padding:'6px 10px', color:'#666' }}>{(pageSafe*assetPageSize)+idx+1}</td>
                        <td style={{ padding:'6px 10px', display:'flex', alignItems:'center', gap:6 }}>
                          <img src={token.logoURI} alt={token.symbol} style={{ width:20, height:20, borderRadius:10, background:'#222', objectFit:'contain' }} />
                          <strong>{token.symbol}</strong>
                          {token.verified && <span style={{ fontSize:9, background:'#14532d', color:'#4ade80', padding:'1px 4px', borderRadius:4 }}>✔</span>}
                        </td>
                        <td style={{ padding:'6px 10px', maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#888' }}>{token.name}</td>
                        <td style={{ padding:'6px 10px' }} title={token.amount.toString()}>{fmt(token.amount)}</td>
                        <td style={{ padding:'6px 10px' }}>{token.valueUSD!==undefined? fmtUSD(token.valueUSD):'-'}</td>
                        <td style={{ padding:'6px 10px' }}>{(token.valueUSD && solPrice)? (token.valueUSD/solPrice).toFixed(5):'-'}</td>
                        <td style={{ padding:'6px 10px', color:'#888' }}>{pct>0? pct.toFixed(pct>0.1?1:2):''}</td>
                        <td style={{ padding:'6px 10px', fontFamily:'monospace', fontSize:11 }}>
                          <span>{token.mint.slice(0,6)}…{token.mint.slice(-4)}</span>
                          <button onClick={()=>{ navigator.clipboard.writeText(token.mint).then(()=>pushToast('Mint copied','ok')).catch(()=>pushToast('Copy failed','err')); }} title='Copy mint' style={{ marginLeft:6, background:'none', border:'1px solid #333', color:'#bbb', fontSize:9, borderRadius:4, padding:'2px 4px', cursor:'pointer' }}>copy</button>
                        </td>
                        <td style={{ padding:'6px 10px', fontFamily:'monospace', fontSize:11 }}>
                          <span>{pda.slice(0,6)}…{pda.slice(-4)}</span>
                          <button onClick={()=>{ navigator.clipboard.writeText(pda).then(()=>pushToast('PDA copied','ok')).catch(()=>pushToast('Copy failed','err')); }} title='Copy metadata PDA' style={{ marginLeft:6, background:'none', border:'1px solid #333', color:'#bbb', fontSize:9, borderRadius:4, padding:'2px 4px', cursor:'pointer' }}>copy</button>
                        </td>
                        <td style={{ padding:'6px 10px' }}>
                          <button onClick={(e)=>handleTokenMetaClick(token,e)} title='Copy full meta & set as input (shift=output)' style={{ background:'#27272a', border:'1px solid #333', color:'#eee', fontSize:10, padding:'3px 8px', borderRadius:6, cursor:'pointer' }}>{lastTokenAction?.mint===token.mint? (lastTokenAction.mode==='in'? '✓ in':'✓ out') : 'meta'}</button>
                        </td>
                      </tr>
                    );
                  })}
                  {assetPageSlice.length===0 && (
                    <tr><td colSpan={10} style={{ padding:'14px 12px', textAlign:'center', color:'#555' }}>No assets match filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {assetPanelOpen && (
            <div style={{ fontSize:10, color:'#555', display:'flex', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
              <div>Shift/Alt click "meta" sets as output. Sorting: click headers. Export includes all filtered rows.</div>
              <div>Page {pageSafe+1}/{totalPages} • {assetSorted.length} assets • {assetPageSize} per page.</div>
            </div>
          )}
        </div>
      )}
      {/* Toast layer */}
      <div style={{ position:'fixed', bottom:16, left:16, display:'flex', flexDirection:'column', gap:8, zIndex:9999 }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            background: t.tone==='ok'? 'linear-gradient(90deg,#14532d,#064e3b)' : t.tone==='err'? 'linear-gradient(90deg,#7f1d1d,#5b1212)' : '#27272a',
            border:'1px solid ' + (t.tone==='ok'? '#15803d' : t.tone==='err'? '#dc2626' : '#3f3f46'),
            color:'#fff',
            padding:'6px 10px',
            fontSize:12,
            borderRadius:8,
            boxShadow:'0 2px 6px #0008',
            minWidth:160
          }}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
