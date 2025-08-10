"use client";

import React, { useEffect, useState, useRef, useCallback, useMemo } from "react"; // added React explicit import for types
import { PublicKey, type ParsedAccountData, type AccountInfo, VersionedTransaction } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey as PK } from '@solana/web3.js';
import { Buffer } from 'buffer'; // polyfill for client usage

// Provide minimal type for process.env when used client-side (Next injects at build time)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

// Fallback JSX intrinsic elements declaration to avoid 'JSX.IntrinsicElements' missing errors (relaxed for now)
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX { interface IntrinsicElements { [elemName: string]: any } }
}

/******************** Constants & Helpers ********************/ 
const METADATA_PROGRAM_ID = new PK('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
function deriveMetadataPda(mint: PK): PK {
  const [pda] = PublicKey.findProgramAddressSync([
    Buffer.from('metadata'),
    METADATA_PROGRAM_ID.toBuffer(),
    mint.toBuffer(),
  ], METADATA_PROGRAM_ID);
  return pda;
}

interface TokenMeta { address: string; symbol: string; name: string; logoURI: string; decimals: number; verified?: boolean; tags?: string[]; }
interface WalletToken { mint: string; amount: number; symbol: string; name: string; logoURI: string; decimals?: number; verified?: boolean; priceUSD?: number; valueUSD?: number; }
interface SwapSuccessRecord { inputAmount: string; inputSymbol: string; outputAmount: string; outputSymbol: string; timestamp: string; [k: string]: any; }
interface SwapErrorRecord { error: string; timestamp: string; code?: any; raw?: any; }
type SwapRecord = SwapSuccessRecord | SwapErrorRecord;

const JUP_SEARCH_BASE = "https://ultra-api.jup.ag/ultra/v1/search-token?query="; // + query
const JUP_PRICE_BASE = "https://price.jup.ag/v6/price?ids="; // + comma separated mints
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DESIRED_INITIAL_UI_AMOUNT = '1';
const INITIAL_INPUT_MINT = process.env.NEXT_PUBLIC_INITIAL_INPUT_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const INITIAL_OUTPUT_MINT = process.env.NEXT_PUBLIC_INITIAL_OUTPUT_MINT || WSOL_MINT;
const KNOWN_DECIMALS: Record<string, number> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
  'So11111111111111111111111111111111111111112': 9, // SOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
};
const INITIAL_INPUT_DECIMALS = KNOWN_DECIMALS[INITIAL_INPUT_MINT] ?? 6;
const INITIAL_INPUT_BASE_AMOUNT = (() => {
  const ui = Number(process.env.NEXT_PUBLIC_INITIAL_SWAP_UI_AMOUNT || '1');
  if (!Number.isFinite(ui) || ui <= 0) return '1000000';
  const raw = Math.round(ui * 10 ** INITIAL_INPUT_DECIMALS);
  return String(raw);
})();

/******************** Component ********************/ 
export default function SwapDashboard() {
  const { connection } = useConnection();
  const solWallet = useWallet();
  const publicKey = solWallet.publicKey;
  const connected = solWallet.connected;

  /******** Wallet Passthrough ********/ 
  const passthroughWallet = useMemo(() => {
    if (!solWallet || !solWallet.publicKey) return null;
    const base: any = solWallet;
    const wrapped = {
      publicKey: base.publicKey,
      signTransaction: base.signTransaction?.bind(base),
      signAllTransactions: base.signAllTransactions ? base.signAllTransactions.bind(base) : (base.signTransaction ? async (txs: any[]) => { const out: any[] = []; for (const tx of txs) out.push(await base.signTransaction(tx)); return out; } : async () => { throw new Error('signAllTransactions not supported'); }),
      signAndSendTransaction: base.signAndSendTransaction?.bind(base),
      signMessage: base.signMessage?.bind(base),
      sendTransaction: async (tx: any, conn: any, opts: any) => {
        try {
          if (base.sendTransaction) return await base.sendTransaction(tx, conn, opts);
          if (base.signAndSendTransaction) return await base.signAndSendTransaction(tx, conn, opts);
          const signed = base.signTransaction ? await base.signTransaction(tx) : tx;
          const raw = signed.serialize();
          return await conn.sendRawTransaction(raw, opts);
        } catch (e) { console.error('[Passthrough sendTransaction error]', e); throw e; }
      }
    } as any;
    console.log('[WALLET CAPS]', { send: !!wrapped.sendTransaction, sign: !!wrapped.signTransaction, signAll: !!wrapped.signAllTransactions, signAndSend: !!wrapped.signAndSendTransaction, signMsg: !!wrapped.signMessage });
    return wrapped;
  }, [solWallet, solWallet.publicKey]);

  /******** State ********/ 
  const [tokens, setTokens] = useState<WalletToken[]>([]);
  const [swapHistory, setSwapHistory] = useState<SwapRecord[]>([]);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [blockhash, setBlockhash] = useState<string>("");
  const [blockTime, setBlockTime] = useState<string>("");
  const [autoBlockRefresh, setAutoBlockRefresh] = useState(false);
  const [showSmall, setShowSmall] = useState(true);
  const [sortKey, setSortKey] = useState<'value' | 'amount' | 'symbol'>('value');
  const [searchQuery, setSearchQuery] = useState("");
  const [priceError, setPriceError] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [jupStatus, setJupStatus] = useState<{ inited: boolean; wallet?: string; error?: string }>({ inited: false });
  const [ultraBusy, setUltraBusy] = useState(false);
  const [ultraStatus, setUltraStatus] = useState<{ phase: string; attempt: number; message?: string; signature?: string; requestId?: string; error?: string } | null>(null);

  /******** Refs ********/ 
  const jupiterInitializedRef = useRef(false);
  const jupiterScriptLoadedRef = useRef(false);
  const solSubscriptionIdRef = useRef<number | null>(null);
  const prevWalletPubkeyRef = useRef<string | null>(null);
  const metaCacheRef = useRef<Map<string, TokenMeta>>(new Map());
  const priceCacheRef = useRef<Map<string, number>>(new Map());
  const inFlightMetaRef = useRef<Set<string>>(new Set());
  const metaPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ultraSwapRef = useRef<(() => Promise<void>) | null>(null);

  /******** Toast + Logging Helpers ********/ 
  const pushToast = useCallback((msg: string, type: 'ok' | 'err' | 'info' = 'info'): void => {
    console.log('[TOAST]', type, msg);
  }, []);

  const logJupState = useCallback((label: string) => {
    try {
      const w: any = window as any; const st = w?.Jupiter?.getState?.();
      if (!st) { console.warn('[JUP_STATE]['+label+'] no state'); return; }
      console.log('[JUP_STATE]['+label+']', {
        form: st.form,
        routePresent: !!st.route,
        lastError: st.lastError && (st.lastError.message || st.lastError.code || st.lastError.toString?.()),
        endpoint: st.endpoint || w?.Jupiter?.connection?.rpcEndpoint
      });
    } catch (e) { console.warn('[JUP_STATE][fail]', e); }
  }, []);

  /******** Meta Cache Hydration ********/ 
  useEffect(() => {
    setMounted(true);
    try { const raw = localStorage.getItem('tokenMetaCacheV1'); if (raw) { const parsed: TokenMeta[] = JSON.parse(raw); parsed.forEach(m => metaCacheRef.current.set(m.address, m)); } } catch {}
  }, []);

  const schedulePersistMeta = useCallback(() => {
    if (metaPersistTimer.current) clearTimeout(metaPersistTimer.current);
    metaPersistTimer.current = setTimeout(() => {
      try { const arr = Array.from(metaCacheRef.current.values()); localStorage.setItem('tokenMetaCacheV1', JSON.stringify(arr.slice(0, 5000))); } catch {}
    }, 800);
  }, []);

  /******** Metadata Fetching ********/ 
  const fetchMetaplexMetadataBatch = useCallback(async (mints: string[]) => {
    const need = mints.filter(m => {
      const meta = metaCacheRef.current.get(m);
      return !meta || (!meta.logoURI && (!meta.symbol || meta.symbol === m.slice(0, 4)));
    });
    if (!need.length) return;
    const limit = 4; let i = 0; const tasks: Promise<void>[] = [];
    const run = async (mint: string) => {
      try {
        const mintPk = new PublicKey(mint); const pda = deriveMetadataPda(mintPk); const acct = await connection.getAccountInfo(pda); if (!acct) return;
        // Simplified: skip mpl-token-metadata binary decode to avoid client bundle bloat / type issues
        let metadata: any = null;
        // Attempt very naive UTF-8 parse to find URI (optional)
        try {
          const utf = new TextDecoder().decode(acct.data);
          const uriMatch = utf.match(/https?:[^\u0000\s"]+/);
          if (uriMatch) metadata = { uri: uriMatch[0] };
        } catch {}
        if (!metadata) return; const clean = (s: string) => s?.replace?.(/\0/g, '')?.trim?.() || '';
        let uri = clean(metadata.uri || ''); let json: any = null; if (uri) { try { const res = await fetch(uri); if (res.ok) json = await res.json(); } catch {} }
        const current = metaCacheRef.current.get(mint) || { address: mint, decimals: 9, logoURI: '', name: mint, symbol: mint.slice(0, 4) } as TokenMeta;
        const updated: TokenMeta = { ...current, address: mint, symbol: current.symbol, name: current.name, logoURI: current.logoURI || json?.image || json?.logo || '', decimals: current.decimals ?? 9, tags: current.tags };
        metaCacheRef.current.set(mint, updated);
      } catch {}
    };
    const next = async () => { if (i >= need.length) return; const mint = need[i++]; await run(mint); await next(); };
    for (let k = 0; k < limit; k++) tasks.push(next());
    await Promise.all(tasks);
    schedulePersistMeta();
  }, [connection, schedulePersistMeta]);

  const fetchTokenMetadataBatch = useCallback(async (mints: string[]) => {
    const unknown = mints.filter(m => !metaCacheRef.current.has(m) && !inFlightMetaRef.current.has(m));
    if (!unknown.length) return;
    unknown.forEach(m => inFlightMetaRef.current.add(m));
    try {
      const results = await Promise.allSettled(unknown.map(async mint => {
        const res = await fetch(JUP_SEARCH_BASE + mint); if (!res.ok) throw new Error('meta fetch failed ' + mint); const data = await res.json();
        const token = data?.tokens?.find((t: any) => t.address === mint) || data?.tokens?.[0];
        if (token) {
          const meta: TokenMeta = { address: token.address, symbol: token.symbol || mint.slice(0, 4), name: token.name || token.symbol || mint, logoURI: token.logoURI || token.logo || '', decimals: token.decimals ?? 9, verified: token.verified, tags: token.tags };
          metaCacheRef.current.set(mint, meta);
        }
      }));
      unknown.forEach(m => inFlightMetaRef.current.delete(m));
      if (results.some(r => r.status === 'rejected')) console.warn('Some token metadata fetches failed');
      schedulePersistMeta();
      await fetchMetaplexMetadataBatch(mints);
    } catch (err) {
      console.warn('Metadata batch error', err);
      unknown.forEach(m => inFlightMetaRef.current.delete(m));
    }
  }, [fetchMetaplexMetadataBatch, schedulePersistMeta]);

  /******** Price Fetching ********/ 
  const fetchPricesBatch = useCallback(async (mints: string[]) => {
    const missing = mints.filter(m => !priceCacheRef.current.has(m));
    if (!missing.length) return;
    try {
      const chunkSize = 10;
      for (let i = 0; i < missing.length; i += chunkSize) {
        const slice = missing.slice(i, i + chunkSize);
        const url = JUP_PRICE_BASE + encodeURIComponent(slice.join(','));
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('price fetch non-200 ' + res.status);
        const data = await res.json();
        const priceData = data?.data || {};
        Object.entries(priceData).forEach(([mint, val]: any) => { const price = val?.price; if (typeof price === 'number') priceCacheRef.current.set(mint, price); });
      }
      setPriceError(false);
    } catch (err) {
      console.warn('Price fetch error', err); setPriceError(true);
      if (!priceCacheRef.current.has('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')) priceCacheRef.current.set('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1);
      if (!priceCacheRef.current.has(WSOL_MINT)) priceCacheRef.current.set(WSOL_MINT, 150);
    }
  }, []);

  /******** Wallet Tokens ********/ 
  const fetchWalletTokensDAS = useCallback(async (): Promise<WalletToken[] | null> => {
    if (!connected || !publicKey) return null;
    try {
      const body = { jsonrpc: '2.0', id: 'swap-dashboard', method: 'getAssetsByOwner', params: { ownerAddress: publicKey.toBase58(), page: 1, limit: 1000, displayOptions: { showFungible: true, showNativeBalance: false, showUnverifiedCollections: false } } };
      const res = await fetch(connection.rpcEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('DAS fetch failed');
      const json = await res.json();
      const assets: any[] = json?.result?.items || [];
      if (!assets.length) return [];
      const out: WalletToken[] = []; const mints: string[] = [];
      for (const a of assets) {
        const ti = a.token_info; if (!ti) continue; const mint = ti?.mint || a.id; const decimals = ti?.decimals ?? 0; const rawBal = Number(ti?.balance ?? 0); const amount = decimals ? rawBal / 10 ** decimals : rawBal; const symbol = ti?.symbol || a.content?.metadata?.symbol || mint.slice(0, 4); const name = ti?.name || a.content?.metadata?.name || symbol; const logoURI = ti?.image || a.content?.files?.[0]?.uri || a.content?.links?.image || '';
        const meta: TokenMeta = { address: mint, symbol, name, logoURI, decimals, verified: ti?.verified, tags: ti?.tags };
        if (!metaCacheRef.current.has(mint)) metaCacheRef.current.set(mint, meta); mints.push(mint); out.push({ mint, amount, symbol, name, logoURI, decimals, verified: meta.verified });
      }
      schedulePersistMeta();
      await fetchTokenMetadataBatch(mints);
      await fetchPricesBatch(mints);
      return out.map(t => { const meta = metaCacheRef.current.get(t.mint) || t; const price = priceCacheRef.current.get(t.mint); return { ...t, symbol: meta.symbol || t.symbol, name: meta.name || t.name, logoURI: meta.logoURI || t.logoURI, priceUSD: price, valueUSD: price ? t.amount * price : undefined }; }).sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
    } catch (e) { console.warn('DAS fallback to RPC balances', e); return null; }
  }, [connected, publicKey, connection.rpcEndpoint, fetchPricesBatch, fetchTokenMetadataBatch, schedulePersistMeta]);

  const fetchWalletTokens = useCallback(async () => {
    if (!connected || !publicKey) { setTokens([]); return; }
    try {
      const dasTokens = await fetchWalletTokensDAS(); if (dasTokens) { setTokens(dasTokens); return; }
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
      type ParsedTokenAccount = { account: { data: ParsedAccountData } };
      const parsed: { mint: string; amount: number }[] = (accounts.value as ParsedTokenAccount[]).map(({ account }: ParsedTokenAccount) => {
        const info = (account.data as ParsedAccountData).parsed.info as any; const mint: string = info.mint; const amount: number = info.tokenAmount.uiAmount; return { mint, amount };
      });
      const mints: string[] = parsed.map(p => p.mint);
      await fetchTokenMetadataBatch(mints);
      await fetchPricesBatch(mints);
      const enriched: WalletToken[] = parsed.map(({ mint, amount }) => {
        const meta = metaCacheRef.current.get(mint); const price = priceCacheRef.current.get(mint);
        return { mint, amount, symbol: meta?.symbol || mint.slice(0, 4), name: meta?.name || meta?.symbol || mint, logoURI: meta?.logoURI || '', decimals: meta?.decimals, verified: meta?.verified, priceUSD: price, valueUSD: price ? amount * price : undefined };
      }).sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
      setTokens(enriched);
    } catch (e) { console.warn('Token balance fetch failed', e); }
  }, [connected, publicKey, connection, fetchTokenMetadataBatch, fetchPricesBatch, fetchWalletTokensDAS]);

  useEffect(() => { fetchWalletTokens(); }, [fetchWalletTokens]);

  /******** SOL Balance Subscription ********/ 
  useEffect(() => {
    if (!connected || !publicKey) {
      setSolBalance(null);
      if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; }
      return;
    }
    connection.getBalance(publicKey).then((l: number) => setSolBalance(l / 1e9)).catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection.getAccountInfo(publicKey).then((info: AccountInfo<Buffer> | null) => { if (info) setSolBalance(info.lamports / 1e9); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subId = connection.onAccountChange(publicKey, (acc: AccountInfo<Buffer>) => { setSolBalance(acc.lamports / 1e9); });
    solSubscriptionIdRef.current = subId;
    return () => { if (solSubscriptionIdRef.current !== null) { connection.removeAccountChangeListener(solSubscriptionIdRef.current).catch(() => {}); solSubscriptionIdRef.current = null; } };
  }, [connected, publicKey, connection]);

  /******** Blockhash ********/ 
  const refreshBlockData = useCallback(async () => {
    try { const latest = await connection.getLatestBlockhash(); setBlockhash(latest.blockhash); const slot = await connection.getSlot(); const ts = await connection.getBlockTime(slot); if (ts) setBlockTime(new Date(ts * 1000).toLocaleString()); } catch {}
  }, [connection]);
  useEffect(() => { refreshBlockData(); }, [refreshBlockData]);
  useEffect(() => { if (!autoBlockRefresh) return; const id = setInterval(refreshBlockData, 180000); return () => clearInterval(id); }, [autoBlockRefresh, refreshBlockData]);

  /******** Jupiter Script Load + Init ********/ 
  useEffect(() => {
    if (document.getElementById('jupiter-plugin-script')) { jupiterScriptLoadedRef.current = true; return; }
    const script = document.createElement('script'); script.id = 'jupiter-plugin-script'; script.src = 'https://plugin.jup.ag/plugin-v1.js'; script.async = true; script.onload = () => { jupiterScriptLoadedRef.current = true; console.log('Jupiter script loaded'); }; script.onerror = (e) => console.error('Failed to load Jupiter plugin script', e); document.head.appendChild(script);
  }, []);

  // Poll for global object
  useEffect(() => {
    if (jupiterInitializedRef.current) return; let tries = 0;
    const id = setInterval(() => { const w: any = window as any; if (w.Jupiter && jupiterScriptLoadedRef.current) { clearInterval(id); } if (++tries > 40) clearInterval(id); }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!connected || !publicKey || !passthroughWallet) return;
    if (!jupiterScriptLoadedRef.current) return;
    const w: any = window as any; if (!w.Jupiter) return;
    const currentPk = publicKey.toBase58();
    if (w.__JUP_INIT_DONE || jupiterInitializedRef.current) {
      if (prevWalletPubkeyRef.current !== currentPk && w.Jupiter?.setWallet) {
        try { w.Jupiter.setWallet(passthroughWallet); setJupStatus((s) => ({ ...s, wallet: currentPk })); } catch {}
      }
      prevWalletPubkeyRef.current = currentPk; return;
    }
    try {
      w.Jupiter.init({
        displayMode: 'integrated',
        integratedTargetId: 'target-container',
        enableWalletPassthrough: true,
        passthroughWalletContextState: solWallet,
        wallet: passthroughWallet,
        endpoint: connection.rpcEndpoint,
        cluster: 'mainnet-beta',
        formProps: { fixedInputMint: true, fixedOutputMint: false, initialAmount: '1000000', initialInputMint: INITIAL_INPUT_MINT, initialOutputMint: INITIAL_OUTPUT_MINT },
        onSwapStart: () => {},
        onSwapSuccess: (swapInfo: any) => {
          console.log('[JUP] swapSuccess', swapInfo); logJupState('afterSuccess');
          setSwapHistory((prev: SwapRecord[]) => [{ ...(swapInfo as any), timestamp: new Date().toLocaleString() }, ...prev]);
          fetchWalletTokens();
          if (publicKey) { connection.getBalance(publicKey).then((l: number) => setSolBalance(l / 1e9)).catch(() => {}); }
        },
        onSwapError: (error: any) => {
          const safe = (e: any) => { try { return typeof e === 'string' ? e : JSON.stringify(e, (k, v) => (typeof v === 'function' ? undefined : v), 2); } catch { return String(e); } };
          const st = (window as any)?.Jupiter?.getState?.();
            console.error('[JUP][swapError]', safe(error));
            console.warn('[JUP][swapError][state]', { form: st?.form, routeNull: !st?.route, lastError: st?.lastError && safe(st.lastError), endpoint: st?.endpoint || (window as any)?.Jupiter?.connection?.rpcEndpoint });
          logJupState('afterError');
          setSwapHistory((prev: SwapRecord[]) => [{ error: error?.message || String(error), code: (error && (error.code || error.type)) || undefined, raw: safe(error), timestamp: new Date().toLocaleString() }, ...prev]);
          setJupStatus((s) => ({ ...s, error: error?.message || String(error) }));
          // Auto fallback to Ultra if landing failure
          if (!ultraBusy && /failed to land/i.test(error?.message || '')) {
            console.log('[JUP][fallback->ULTRA] triggering ultraSwap after landing failure');
            setTimeout(() => { try { ultraSwapRef.current && ultraSwapRef.current(); } catch(e){ console.warn('Ultra fallback call failed', e); } }, 250);
          }
        }
      });
      w.__JUP_INIT_DONE = true; jupiterInitializedRef.current = true; setJupStatus({ inited: true, wallet: currentPk }); prevWalletPubkeyRef.current = currentPk;
      // Patch sendRawTransaction once for resend + confirmation loop
      if (!w.__PATCHED_SEND && w.Jupiter?.connection) {
        try {
          const conn = w.Jupiter.connection;
          const origSend = conn.sendRawTransaction.bind(conn);
          w.__SWAP_SIGS = w.__SWAP_SIGS || [];
          w.__RAW_TX_CACHE = w.__RAW_TX_CACHE || new Map();
          const maxResendMs = Number(process.env.NEXT_PUBLIC_RESEND_WINDOW_MS || '35000');
          const resendIntervalMs = Number(process.env.NEXT_PUBLIC_RESEND_INTERVAL_MS || '4000');
          const statusPollMs = Number(process.env.NEXT_PUBLIC_STATUS_POLL_MS || '3000');
          async function pollAndMaybeResend(sig: string, raw: Buffer | Uint8Array, firstAt: number) {
            const now = Date.now();
            if (now - firstAt > maxResendMs) return;
            try {
              const st = await conn.getSignatureStatuses([sig]);
              const v = st?.value?.[0];
              if (!v || (!v.err && !v.confirmationStatus)) {
                // still unknown, resend raw
                try {
                  await origSend(raw, { skipPreflight: true, maxRetries: 0 });
                  console.log('[RESEND_LOOP]', sig, 'age', (now - firstAt) + 'ms');
                } catch (e) { console.log('[RESEND_LOOP_ERR]', sig, e); }
                setTimeout(() => pollAndMaybeResend(sig, raw, firstAt), resendIntervalMs);
              } else {
                console.log('[SIG_STATUS_FINAL]', sig, v);
              }
            } catch (e) {
              console.log('[STATUS_POLL_ERR]', sig, e);
              setTimeout(() => pollAndMaybeResend(sig, raw, firstAt), statusPollMs);
            }
          }
          conn.sendRawTransaction = async (raw: Buffer | Uint8Array, opts: any = {}) => {
            const start = Date.now();
            const sig = await origSend(raw, { ...opts, maxRetries: 2 });
            w.__SWAP_SIGS.push({ sig, at: start, opts });
            w.__RAW_TX_CACHE.set(sig, raw);
            console.log('[PATCH][sendRawTransaction]', sig, opts);
            setTimeout(() => pollAndMaybeResend(sig, raw, start), resendIntervalMs);
            return sig;
          };
          w.__PATCHED_SEND = true;
          console.log('[PATCH] sendRawTransaction with resend loop active');
        } catch (e) { console.warn('Patch sendRawTransaction failed', e); }
      }
    } catch (err: any) { setJupStatus({ inited: false, error: err?.message }); }
  }, [connected, publicKey, passthroughWallet, solWallet, connection, fetchWalletTokens, logJupState, ultraBusy]);

  /******** Ultra API Fallback ********/ 
  const maxUltraAttempts = Number(process.env.NEXT_PUBLIC_ULTRA_MAX_ATTEMPTS || '3');
  const defaultSlippageBps = Number(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS || '50');
  const feeReserveLamports = Number(process.env.NEXT_PUBLIC_FEE_RESERVE_LAMPORTS || (0.002 * 1e9));
  const priorityEscalation = (attempt: number) => [5000, 10000, 20000, 40000][attempt - 1] || 50000;
  const getJupiterState = () => { try { const w: any = window as any; return w?.Jupiter?.getState?.(); } catch { return null; } };
  const deriveInputInfo = () => { const st = getJupiterState(); const inputMint = st?.form?.inputMint || INITIAL_INPUT_MINT; const outputMint = st?.form?.outputMint || INITIAL_OUTPUT_MINT; const rawAmount = st?.form?.amount || INITIAL_INPUT_BASE_AMOUNT; return { inputMint, outputMint, rawAmount }; };
  const clampAmountToBalance = (inputMint: string, rawAmount: string) => { try { if (!tokens.length) return rawAmount; const t = tokens.find((tk: WalletToken) => tk.mint === inputMint); if (!t || t.decimals == null) return rawAmount; const balBase = Math.floor(t.amount * 10 ** t.decimals); const wanted = Number(rawAmount); if (!Number.isFinite(wanted)) return rawAmount; if (inputMint === WSOL_MINT) { const solAvailLamports = solBalance != null ? Math.floor(solBalance * 1e9) - feeReserveLamports : undefined; if (solAvailLamports != null && solAvailLamports < wanted) { return String(Math.max(0, solAvailLamports)); } } if (wanted > balBase) return String(Math.max(0, balBase)); return rawAmount; } catch { return rawAmount; } };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const getPerformanceSample = useCallback(async () => {
    try {
      const samples: any = await (connection as any).getRecentPerformanceSamples?.(1);
      if (Array.isArray(samples) && samples[0]) return samples[0];
    } catch {}
    return null;
  }, [connection]);

  const computeDynamicPriorityFee = useCallback(async (attempt: number) => {
    // attempt starts at 1
    const baseFallback = [5000, 12000, 24000, 40000, 60000][attempt - 1] || 80000; // micro lamports per CU fallback
    let dyn = baseFallback;
    const perf = await getPerformanceSample();
    if (perf) {
      // perf: numTransactions, numSlots, samplePeriodSecs, slot
      const tps = perf.numTransactions / perf.samplePeriodSecs;
      // Map TPS to multiplier (rough heuristic)
      const mult = tps < 2000 ? 0.6 : tps < 3000 ? 0.8 : tps < 4000 ? 1.0 : tps < 5000 ? 1.3 : tps < 6000 ? 1.6 : 2.0;
      dyn = Math.round(baseFallback * mult);
    }
    // escalate further with attempt exponential factor
    dyn = Math.round(dyn * Math.pow(1.35, attempt - 1));
    // clamp
    if (dyn > 150000) dyn = 150000;
    console.log('[ULTRA][PRIO]', { attempt, dyn, baseFallback });
    return dyn;
  }, [getPerformanceSample]);

  const ultraSwap = useCallback(async () => {
    if (!publicKey || !passthroughWallet) { pushToast('Wallet not ready', 'err'); return; }
    if (ultraBusy) return;
    setUltraBusy(true); setUltraStatus({ phase: 'start', attempt: 1, message: 'Preparing quote' });
    try {
      const { inputMint, outputMint, rawAmount } = deriveInputInfo();
      const amountBaseStr = clampAmountToBalance(inputMint, rawAmount); if (amountBaseStr === '0') throw new Error('Amount zero after clamp');
      let attempt = 0; let lastError: any = null;
      while (attempt < maxUltraAttempts) {
        attempt += 1;
        const slippageBps = defaultSlippageBps + (attempt - 1) * 25; // escalate slippage each retry
        const priorityMicroLamports = await computeDynamicPriorityFee(attempt);
        setUltraStatus({ phase: 'quote', attempt, message: `Quote prio ${priorityMicroLamports} slip ${slippageBps}` });
        const params = new URLSearchParams({ inputMint, outputMint, amount: amountBaseStr, slippageBps: String(slippageBps) });
        let quote: any = null; let quoteRes: Response | null = null;
        for (let qTry = 0; qTry < 3; qTry++) {
          quoteRes = await fetch(`https://lite-api.jup.ag/ultra/v1/quote?${params.toString()}`);
            if (quoteRes.ok) { try { quote = await quoteRes.json(); } catch {} }
          if (quote?.routePlan) break; await sleep(150 * (qTry + 1));
        }
        if (!quote || !quote.routePlan) { lastError = new Error('Quote failed'); console.warn('[ULTRA][QUOTE_FAIL]', { attempt, status: quoteRes && quoteRes.status }); continue; }
        console.log('[ULTRA][QUOTE]', { attempt, slippageBps, priorityMicroLamports, outAmount: quote.outAmount, priceImpact: quote.priceImpactPct });
        setUltraStatus({ phase: 'order', attempt, message: 'Creating order' });
        const orderBody: any = { quoteResponse: quote, userPublicKey: publicKey.toBase58(), priorityFeeMicroLamports: priorityMicroLamports };
        const orderResRaw = await fetch('https://lite-api.jup.ag/ultra/v1/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderBody) }); if (!orderResRaw.ok) { lastError = new Error('Order HTTP ' + orderResRaw.status); console.warn('[ULTRA][ORDER_FAIL]', attempt); continue; }
        const orderRes = await orderResRaw.json(); if (!orderRes.transaction) { lastError = new Error('No transaction in order response'); continue; }
        console.log('[ULTRA][ORDER]', { attempt, requestId: orderRes.requestId, txLen: orderRes.transaction.length });
        setUltraStatus({ phase: 'sign', attempt, message: 'Signing transaction', requestId: orderRes.requestId });
        const rawTxBuf = Buffer.from(orderRes.transaction, 'base64'); let tx: VersionedTransaction; try { tx = VersionedTransaction.deserialize(rawTxBuf); } catch (e: any) { lastError = new Error('Deserialize failed: ' + e?.message); continue; }
        try { await passthroughWallet.signTransaction(tx as any); } catch (e: any) { lastError = new Error('Sign failed: ' + e?.message); continue; }
        const signedSerialized = tx.serialize();
        const signedB64 = Buffer.from(signedSerialized).toString('base64');
        setUltraStatus({ phase: 'execute', attempt, message: 'Submitting execute + cluster broadcast', requestId: orderRes.requestId });
        // Fire execute (Jupiter broadcast path)
        const execPromise = (async () => {
          const execRaw = await fetch('https://lite-api.jup.ag/ultra/v1/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTransaction: signedB64, requestId: orderRes.requestId }) });
          if (!execRaw.ok) throw new Error('Execute HTTP ' + execRaw.status);
          return await execRaw.json();
        })();
        // Also broadcast ourselves directly to cluster (redundancy)
        const clusterPromise = (async () => {
          try {
            const sig = await connection.sendRawTransaction(signedSerialized, { skipPreflight: false, maxRetries: 2 });
            return { clusterSig: sig };
          } catch (e) { console.warn('[ULTRA][CLUSTER_BROADCAST_FAIL]', e); return { clusterSig: null }; }
        })();
        let execRes: any = null; let clusterRes: any = null;
        try { [execRes, clusterRes] = await Promise.allSettled([execPromise, clusterPromise]).then(arr => arr.map(r => r.status === 'fulfilled' ? r.value : r.reason)); } catch {}
        console.log('[ULTRA][EXECUTE]', { execRes, clusterRes });
        const signature = execRes?.signature || execRes?.txid || execRes?.transactionId || clusterRes?.clusterSig;
        if (!signature) { lastError = new Error('No signature from execution'); continue; }
        setUltraStatus({ phase: 'confirm', attempt, message: 'Confirming', signature, requestId: orderRes.requestId });
        const startTime = Date.now();
        let filled = false;
        const confirmLoop = async () => {
          for (let i = 0; i < 30; i++) {
            await sleep(1200);
            try {
              const st = await connection.getSignatureStatuses([signature]);
              const v = st?.value?.[0];
              console.log('[ULTRA][SIGSTATUS]', signature, v);
              if (v?.err) { lastError = new Error('Transaction error'); return; }
              if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') { filled = true; return; }
            } catch {}
            // Jupiter order status endpoint
            try {
              const stRaw = await fetch(`https://lite-api.jup.ag/ultra/v1/status?requestId=${orderRes.requestId}`);
              if (stRaw.ok) { const statusJson = await stRaw.json(); console.log('[ULTRA][STATUS]', { attempt, statusJson }); if (statusJson?.status === 'filled') { filled = true; return; } if (['failed', 'cancelled'].includes(statusJson?.status)) { lastError = new Error('Status ' + statusJson.status); return; } }
            } catch {}
            if (Date.now() - startTime > 45000) { lastError = new Error('Timeout waiting confirmation'); return; }
          }
        };
        await confirmLoop();
        if (filled) { setUltraStatus((s) => s ? { ...s, phase: 'done', message: 'Filled', signature } : null); pushToast('Ultra swap filled', 'ok'); fetchWalletTokens(); if (publicKey) { connection.getBalance(publicKey).then((l: number) => setSolBalance(l / 1e9)).catch(() => {}); } return; }
        setUltraStatus((s) => s ? { ...s, phase: 'retry', message: 'Retrying', signature } : null); console.warn('[ULTRA] not filled, retry', { attempt, signature, lastError: lastError?.message }); await sleep(600 + attempt * 400);
      }
      throw lastError || new Error('All attempts failed');
    } catch (err: any) {
      console.error('[ULTRA][FAIL]', err); setUltraStatus((s) => s ? { ...s, phase: 'error', error: err?.message || String(err) } : { phase: 'error', attempt: 1, error: err?.message || String(err) }); pushToast('Ultra swap failed', 'err');
    } finally { setUltraBusy(false); }
  }, [publicKey, passthroughWallet, ultraBusy, maxUltraAttempts, defaultSlippageBps, tokens, solBalance, connection, fetchWalletTokens, pushToast, computeDynamicPriorityFee, clampAmountToBalance, deriveInputInfo]);

  /******** Formatting Helpers ********/ 
  const fmt = useCallback((n: number | undefined, opts: Intl.NumberFormatOptions = {}) => { if (n === undefined || isNaN(n)) return '-'; return n.toLocaleString(undefined, { maximumFractionDigits: 4, ...opts }); }, []);
  const fmtUSD = useCallback((n: number | undefined) => { if (n === undefined || isNaN(n)) return '-'; return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }, []);

  /******** Derived Values ********/ 
  const totalUSD = tokens.reduce<number>((acc: number, t: WalletToken) => acc + (t.valueUSD || 0), 0);
  const solPrice = priceCacheRef.current.get(WSOL_MINT);
  const walletSolUSD = solPrice && solBalance !== null ? solBalance * solPrice : undefined;
  const grandTotalUSD = (walletSolUSD || 0) + totalUSD;
  const grandTotalSOL = solPrice ? grandTotalUSD / solPrice : undefined; // eslint-disable-line @typescript-eslint/no-unused-vars
  const displayTokens = tokens
    .filter((t: WalletToken) => showSmall || (t.valueUSD || 0) > 1 || t.mint === WSOL_MINT)
    .filter((t: WalletToken) => !searchQuery || t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || t.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice()
    .sort((a: WalletToken, b: WalletToken) => { if (sortKey === 'value') return (b.valueUSD || 0) - (a.valueUSD || 0); if (sortKey === 'amount') return (b.amount || 0) - (a.amount || 0); return a.symbol.localeCompare(b.symbol); });

  const copyAddress = useCallback(() => { if (!publicKey) return; navigator.clipboard.writeText(publicKey.toBase58()).catch(() => {}); }, [publicKey]);

  /******** Debug Panel ********/ 
  const JupDebugPanel = () => {
    const [snap, setSnap] = useState<any>(null); const [busy, setBusy] = useState(false);
    const grab = useCallback(() => { try { const w: any = window as any; const st = w?.Jupiter?.getState?.(); setSnap(st ? { inputMint: st.form?.inputMint, outputMint: st.form?.outputMint, amount: st.form?.amount, route: !!st.route, lastError: st.lastError && (typeof st.lastError === 'string' ? st.lastError : (st.lastError.message || st.lastError.code || JSON.stringify(st.lastError).slice(0, 140))), endpoint: st.endpoint || w?.Jupiter?.connection?.rpcEndpoint } : null); } catch {} }, []);
    useEffect(() => { grab(); const id = setInterval(grab, 6000); return () => clearInterval(id); }, [grab]);
    const manualQuote = async () => { if (busy) return; setBusy(true); try { const w: any = window as any; const st = w?.Jupiter?.getState?.(); if (!st) { setSnap({ error: 'No state' }); return; } const qUrl = `https://lite-api.jup.ag/ultra/v1/quote?inputMint=${st.form?.inputMint}&outputMint=${st.form?.outputMint}&amount=${st.form?.amount}&slippageBps=50`; const r = await fetch(qUrl); const j = await r.json().catch(() => ({ raw: 'non-json' })); console.log('[JUP][ManualQuote]', qUrl, j); setSnap((s: any) => ({ ...s, manualQuoteOk: r.ok, manualQuoteStatus: r.status, manualQuoteSample: (j && j.routePlan ? 'routePlanOK' : JSON.stringify(j).slice(0, 120)) })); } catch (e: any) { setSnap((s: any) => ({ ...s, manualQuoteErr: e?.message || String(e) })); } finally { setBusy(false); } };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 4 }}>
          <div style={{ color: '#777' }}>In</div><div style={{ fontFamily: 'monospace' }}>{snap?.inputMint?.slice(0, 6)}…</div>
          <div style={{ color: '#777' }}>Out</div><div style={{ fontFamily: 'monospace' }}>{snap?.outputMint?.slice(0, 6)}…</div>
          <div style={{ color: '#777' }}>Amt</div><div>{snap?.amount || '-'}</div>
          <div style={{ color: '#777' }}>Route</div><div>{snap?.route ? 'yes' : 'no'}</div>
          <div style={{ color: '#777' }}>Err</div><div style={{ color: '#f87171' }}>{snap?.lastError || '-'}</div>
          <div style={{ color: '#777' }}>RPC</div><div style={{ fontSize: 9 }}>{snap?.endpoint ? snap.endpoint.replace(/^https?:\/\//, '').slice(0, 38) + '…' : ''}</div>
        </div>
        <button onClick={manualQuote} disabled={busy} style={{ marginTop: 4, fontSize: 10, padding: '4px 6px', background: '#27272a', border: '1px solid #333', color: '#fff', borderRadius: 4 }}>{busy ? '…' : 'Test Quote'}</button>
        {snap?.manualQuoteStatus && <div style={{ fontSize: 10 }}>Q {snap.manualQuoteStatus}: {snap.manualQuoteOk ? 'ok' : 'fail'} {snap.manualQuoteSample}</div>}
        {snap?.manualQuoteErr && <div style={{ fontSize: 10, color: '#f87171' }}>Q Err: {snap.manualQuoteErr}</div>}
      </div>
    );
  };

  /******** Render ********/ 
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: 'auto 1fr', gap: 24, padding: 24, maxWidth: 1200, margin: '0 auto', position: 'relative' }}>
      <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <div style={{ gridColumn: '1 / 2', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>Swap Dashboard</div>
            <div style={{ fontSize: 12, color: '#ccc' }}>Manage your token swaps on Solana</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ color: '#777', fontSize: 12 }}>Input:</div>
                  <WalletMultiButton style={{ borderRadius: 16, paddingInline: 12, paddingBlock: 8, fontSize: 14 }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                  <div style={{ color: '#777', fontSize: 12 }}>Output:</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#fff' }}>{(tokens.length && tokens[0].symbol) || '-'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button onClick={refreshBlockData} style={{ flex: 1, background: '#27272a', border: '1px solid #444', borderRadius: 16, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#ccc' }}>Refresh</div>
                  </div>
                </button>
                <button onClick={() => setAutoBlockRefresh(r => !r)} style={{ flex: 1, background: autoBlockRefresh ? '#f43f5e' : '#4ade80', border: '1px solid #444', borderRadius: 16, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#fff' }}>{autoBlockRefresh ? 'Auto-Refresh ON' : 'Auto-Refresh OFF'}</div>
                  </div>
                </button>
              </div>
            </div>
          </div>
          <div style={{ gridColumn: '2 / 3', gridRow: '1 / 3', background: '#141416', borderRadius: 16, minHeight: 120, boxShadow: '0 2px 10px #0005', border: '1px solid #222', display: 'flex', flexDirection: 'column', gap: 6, padding: 12, color: '#ccc', fontSize: 11 }}>
            <div style={{ fontWeight: 600, fontSize: 11, letterSpacing: 0.5 }}>Jupiter Debug</div>
            <JupDebugPanel />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Swap History</div>
            <div style={{ fontSize: 12, color: '#ccc' }}>Recent swaps on your account</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {swapHistory.length === 0 && <div style={{ color: '#777', fontSize: 12, textAlign: 'center', padding: '12px 0' }}>No swap history found</div>}
              {swapHistory.map((record, idx) => {
                const isError = 'error' in record; const time = new Date(record.timestamp).toLocaleString();
                return (
                  <div key={idx} style={{ background: isError ? '#3c3c3e' : '#141416', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid #222' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: 12, color: '#ccc' }}>{time}</div>
                      {isError ? <div style={{ fontSize: 12, color: '#f87171', fontWeight: 500 }}>Error</div> : <div style={{ fontSize: 12, color: '#4ade80', fontWeight: 500 }}>Success</div>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 14, color: '#fff', fontWeight: 500 }}>{isError ? 'Swap Failed' : `Swapped ${record.inputAmount} ${record.inputSymbol} for ${record.outputAmount} ${record.outputSymbol}`}</div>
                      {isError && <div style={{ color: '#f87171', fontSize: 12 }}>{(record as SwapErrorRecord).error}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div id="target-container" style={{ gridColumn: '1 / -1', position: 'relative', minHeight: 400 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.8) 100%)', borderRadius: 16 }} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>Swap Tokens</div>
              <div style={{ fontSize: 14, color: '#ccc' }}>Select tokens and enter the amount to swap</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ color: '#777', fontSize: 12 }}>From</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <select value={INITIAL_INPUT_MINT} onChange={() => { /* placeholder */ }} style={{ flex: 1, padding: '8px 12px', borderRadius: 16, border: '1px solid #333', background: '#141416', color: '#fff', fontSize: 14, appearance: 'none' }}>
                      <option value="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v">USDC</option>
                      <option value="So11111111111111111111111111111111111111112">SOL</option>
                      <option value="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB">USDT</option>
                    </select>
                    <button onClick={() => { /* max */ }} style={{ padding: '8px 12px', borderRadius: 16, background: '#4ade80', border: '1px solid #333', color: '#141416', fontSize: 14, fontWeight: 500 }}>MAX</button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ color: '#777', fontSize: 12 }}>To</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <select value={INITIAL_OUTPUT_MINT} onChange={() => { /* placeholder */ }} style={{ flex: 1, padding: '8px 12px', borderRadius: 16, border: '1px solid #333', background: '#141416', color: '#fff', fontSize: 14, appearance: 'none' }}>
                      <option value="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v">USDC</option>
                      <option value="So11111111111111111111111111111111111111112">SOL</option>
                      <option value="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB">USDT</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ color: '#777', fontSize: 12 }}>Amount</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" value={DESIRED_INITIAL_UI_AMOUNT} onChange={() => { /* placeholder */ }} style={{ flex: 1, padding: '8px 12px', borderRadius: 16, border: '1px solid #333', background: '#141416', color: '#fff', fontSize: 14 }} />
                    <div style={{ color: '#777', fontSize: 12 }}>≈ {fmtUSD(totalUSD)}</div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button onClick={refreshBlockData} style={{ flex: 1, background: '#27272a', border: '1px solid #444', borderRadius: 16, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><div style={{ fontSize: 12, color: '#ccc' }}>Refresh</div></div>
                </button>
                <button onClick={() => setAutoBlockRefresh(r => !r)} style={{ flex: 1, background: autoBlockRefresh ? '#f43f5e' : '#4ade80', border: '1px solid #444', borderRadius: 16, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><div style={{ fontSize: 12, color: '#fff' }}>{autoBlockRefresh ? 'Auto-Refresh ON' : 'Auto-Refresh OFF'}</div></div>
                </button>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Swap Status</div>
            <div style={{ fontSize: 12, color: '#ccc' }}>Monitor the status of your swap</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ color: '#777', fontSize: 12 }}>Last Blockhash:</div>
              <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#fff' }}>{blockhash}</div>
              <div style={{ color: '#777', fontSize: 12 }}>Block Time:</div>
              <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#fff' }}>{blockTime}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}