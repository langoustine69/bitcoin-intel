import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'bitcoin-intel',
  version: '1.0.0',
  description: 'Bitcoin blockchain intelligence - wallet lookups, transaction details, fees, and network stats',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPERS ===
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

// === FREE ENDPOINT: Network Overview (via direct route) ===
app.post('/entrypoints/overview/invoke', async (c) => {
  try {
    const [fees, stats, blocks] = await Promise.all([
      fetchJSON('https://mempool.space/api/v1/fees/recommended'),
      fetchJSON('https://api.blockchair.com/bitcoin/stats'),
      fetchJSON('https://mempool.space/api/v1/blocks'),
    ]);
    
    const latestBlock = blocks[0];
    const networkStats = stats.data;
    
    return c.json({
      status: 'succeeded',
      output: {
        network: {
          blockHeight: latestBlock.height,
          difficulty: networkStats.difficulty,
          hashrate: networkStats.hashrate_24h,
          mempoolTxs: networkStats.mempool_transactions,
          mempoolSize: networkStats.mempool_size,
        },
        fees: {
          fastest: fees.fastestFee,
          halfHour: fees.halfHourFee,
          hour: fees.hourFee,
          economy: fees.economyFee,
          minimum: fees.minimumFee,
          unit: 'sat/vB',
        },
        price: {
          usd: networkStats.market_price_usd,
        },
        latestBlock: {
          height: latestBlock.height,
          timestamp: new Date(latestBlock.timestamp * 1000).toISOString(),
          txCount: latestBlock.tx_count,
          size: latestBlock.size,
        },
        fetchedAt: new Date().toISOString(),
        dataSources: ['mempool.space', 'blockchair.com'],
      },
    });
  } catch (err: any) {
    return c.json({ status: 'failed', error: err.message }, 500);
  }
});

// === PAID ENDPOINT 1: Address Lookup ($0.001) ===
addEntrypoint({
  key: 'address',
  description: 'Look up Bitcoin address balance and transaction count',
  input: z.object({
    address: z.string().describe('Bitcoin address (legacy, segwit, or taproot)'),
  }),
  price: '1000',
  handler: async (ctx) => {
    const data = await fetchJSON(`https://mempool.space/api/address/${ctx.input.address}`);
    
    const chainBalance = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const mempoolBalance = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
    const totalBalance = chainBalance + mempoolBalance;
    
    return {
      output: {
        address: ctx.input.address,
        balance: {
          confirmed: satsToBtc(chainBalance),
          unconfirmed: satsToBtc(mempoolBalance),
          total: satsToBtc(totalBalance),
          sats: totalBalance,
        },
        transactions: {
          confirmed: data.chain_stats.tx_count,
          unconfirmed: data.mempool_stats.tx_count,
          total: data.chain_stats.tx_count + data.mempool_stats.tx_count,
        },
        received: satsToBtc(data.chain_stats.funded_txo_sum),
        spent: satsToBtc(data.chain_stats.spent_txo_sum),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Transaction Details ($0.002) ===
addEntrypoint({
  key: 'transaction',
  description: 'Get full transaction details by txid',
  input: z.object({
    txid: z.string().describe('Transaction ID (64 character hex)'),
  }),
  price: '2000',
  handler: async (ctx) => {
    const tx = await fetchJSON(`https://mempool.space/api/tx/${ctx.input.txid}`);
    
    const totalInput = tx.vin.reduce((sum: number, v: any) => sum + (v.prevout?.value || 0), 0);
    const totalOutput = tx.vout.reduce((sum: number, v: any) => sum + v.value, 0);
    
    return {
      output: {
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height || null,
        blockTime: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
        size: tx.size,
        weight: tx.weight,
        vsize: Math.ceil(tx.weight / 4),
        fee: {
          sats: tx.fee,
          btc: satsToBtc(tx.fee),
          satPerVb: (tx.fee / Math.ceil(tx.weight / 4)).toFixed(2),
        },
        inputs: {
          count: tx.vin.length,
          totalBtc: satsToBtc(totalInput),
        },
        outputs: {
          count: tx.vout.length,
          totalBtc: satsToBtc(totalOutput),
        },
        addresses: {
          inputs: tx.vin.slice(0, 5).map((v: any) => v.prevout?.scriptpubkey_address).filter(Boolean),
          outputs: tx.vout.slice(0, 5).map((v: any) => v.scriptpubkey_address).filter(Boolean),
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Fee Estimates ($0.002) ===
addEntrypoint({
  key: 'fees',
  description: 'Current fee estimates and mempool analysis',
  input: z.object({}),
  price: '2000',
  handler: async () => {
    const [fees, mempool, blocks] = await Promise.all([
      fetchJSON('https://mempool.space/api/v1/fees/recommended'),
      fetchJSON('https://mempool.space/api/mempool'),
      fetchJSON('https://mempool.space/api/v1/blocks').then((b: any[]) => b.slice(0, 6)),
    ]);
    
    const avgBlockTime = blocks.length > 1 
      ? (blocks[0].timestamp - blocks[blocks.length - 1].timestamp) / (blocks.length - 1) / 60
      : 10;
    
    return {
      output: {
        recommended: {
          fastest: { satsPerVb: fees.fastestFee, estimatedMinutes: 10 },
          halfHour: { satsPerVb: fees.halfHourFee, estimatedMinutes: 30 },
          hour: { satsPerVb: fees.hourFee, estimatedMinutes: 60 },
          economy: { satsPerVb: fees.economyFee, estimatedMinutes: 120 },
          minimum: { satsPerVb: fees.minimumFee, estimatedMinutes: 'variable' },
        },
        mempool: {
          count: mempool.count,
          vsize: mempool.vsize,
          totalFee: mempool.total_fee,
          sizeMb: (mempool.vsize / 1_000_000).toFixed(2),
        },
        costEstimates: {
          note: 'Estimates for typical P2PKH transaction (225 vbytes)',
          fastest: `${(fees.fastestFee * 225)} sats`,
          economy: `${(fees.economyFee * 225)} sats`,
        },
        recentBlocks: blocks.map((b: any) => ({
          height: b.height,
          txCount: b.tx_count,
          size: b.size,
          weight: b.weight,
        })),
        avgBlockTime: `${avgBlockTime.toFixed(1)} minutes`,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Recent Blocks ($0.003) ===
addEntrypoint({
  key: 'blocks',
  description: 'Recent blocks with stats and details',
  input: z.object({
    limit: z.number().optional().default(10).describe('Number of blocks (1-15)'),
  }),
  price: '3000',
  handler: async (ctx) => {
    const limit = Math.min(ctx.input.limit, 15);
    const blocks = await fetchJSON('https://mempool.space/api/v1/blocks');
    
    const recentBlocks = blocks.slice(0, limit);
    const totalTxs = recentBlocks.reduce((sum: number, b: any) => sum + b.tx_count, 0);
    const totalSize = recentBlocks.reduce((sum: number, b: any) => sum + b.size, 0);
    
    return {
      output: {
        blocks: recentBlocks.map((b: any) => ({
          height: b.height,
          hash: b.id,
          timestamp: new Date(b.timestamp * 1000).toISOString(),
          txCount: b.tx_count,
          size: b.size,
          weight: b.weight,
          miner: b.extras?.pool?.name || 'Unknown',
          reward: b.extras?.reward ? satsToBtc(b.extras.reward) : null,
          fees: b.extras?.totalFees ? satsToBtc(b.extras.totalFees) : null,
        })),
        summary: {
          blocksReturned: recentBlocks.length,
          totalTransactions: totalTxs,
          avgTxPerBlock: Math.round(totalTxs / recentBlocks.length),
          totalSizeMb: (totalSize / 1_000_000).toFixed(2),
          heightRange: `${recentBlocks[recentBlocks.length - 1].height} - ${recentBlocks[0].height}`,
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Address Report ($0.005) ===
addEntrypoint({
  key: 'address-report',
  description: 'Comprehensive address analysis with recent transactions',
  input: z.object({
    address: z.string().describe('Bitcoin address'),
  }),
  price: '5000',
  handler: async (ctx) => {
    const [addressData, txs, ticker] = await Promise.all([
      fetchJSON(`https://mempool.space/api/address/${ctx.input.address}`),
      fetchJSON(`https://mempool.space/api/address/${ctx.input.address}/txs`).catch(() => []),
      fetchJSON('https://blockchain.info/ticker'),
    ]);
    
    const chainBalance = addressData.chain_stats.funded_txo_sum - addressData.chain_stats.spent_txo_sum;
    const btcPrice = ticker.USD.last;
    const usdValue = (chainBalance / 100_000_000) * btcPrice;
    
    const recentTxs = (txs as any[]).slice(0, 10).map((tx: any) => {
      const isIncoming = tx.vout.some((v: any) => v.scriptpubkey_address === ctx.input.address);
      const isOutgoing = tx.vin.some((v: any) => v.prevout?.scriptpubkey_address === ctx.input.address);
      
      let amount = 0;
      if (isIncoming) {
        amount = tx.vout
          .filter((v: any) => v.scriptpubkey_address === ctx.input.address)
          .reduce((sum: number, v: any) => sum + v.value, 0);
      }
      
      return {
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height,
        timestamp: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
        type: isOutgoing ? 'outgoing' : 'incoming',
        amount: satsToBtc(amount),
      };
    });
    
    return {
      output: {
        address: ctx.input.address,
        balance: {
          btc: satsToBtc(chainBalance),
          sats: chainBalance,
          usd: usdValue.toFixed(2),
        },
        activity: {
          totalTransactions: addressData.chain_stats.tx_count,
          totalReceived: satsToBtc(addressData.chain_stats.funded_txo_sum),
          totalSpent: satsToBtc(addressData.chain_stats.spent_txo_sum),
          utxoCount: addressData.chain_stats.funded_txo_count - addressData.chain_stats.spent_txo_count,
        },
        classification: {
          isActive: addressData.chain_stats.tx_count > 10,
          isWhale: chainBalance > 100_000_000_000,
          hasRecentActivity: (txs as any[]).some((tx: any) => 
            tx.status.block_time && (Date.now() / 1000 - tx.status.block_time) < 86400 * 30
          ),
        },
        recentTransactions: recentTxs,
        pricing: {
          btcUsd: btcPrice,
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === FREE ANALYTICS ENDPOINTS (via direct routes) ===
app.post('/entrypoints/analytics/invoke', async (c) => {
  const tracker = agent.analytics?.paymentTracker;
  if (!tracker) {
    return c.json({ status: 'succeeded', output: { error: 'Analytics not available', payments: [] } });
  }
  const body = await c.req.json().catch(() => ({}));
  const summary = await getSummary(tracker, body.windowMs);
  return c.json({
    status: 'succeeded',
    output: {
      ...summary,
      outgoingTotal: summary.outgoingTotal.toString(),
      incomingTotal: summary.incomingTotal.toString(),
      netTotal: summary.netTotal.toString(),
    },
  });
});

app.post('/entrypoints/analytics-transactions/invoke', async (c) => {
  const tracker = agent.analytics?.paymentTracker;
  if (!tracker) {
    return c.json({ status: 'succeeded', output: { transactions: [] } });
  }
  const body = await c.req.json().catch(() => ({}));
  const txs = await getAllTransactions(tracker, body.windowMs);
  return c.json({ status: 'succeeded', output: { transactions: txs.slice(0, body.limit || 50) } });
});

app.post('/entrypoints/analytics-csv/invoke', async (c) => {
  const tracker = agent.analytics?.paymentTracker;
  if (!tracker) {
    return c.json({ status: 'succeeded', output: { csv: '' } });
  }
  const body = await c.req.json().catch(() => ({}));
  const csv = await exportToCSV(tracker, body.windowMs);
  return c.json({ status: 'succeeded', output: { csv } });
});

// === ERC-8004 Registration Endpoint ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://bitcoin-intel-production.up.railway.app';
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'bitcoin-intel',
    description: 'Bitcoin blockchain intelligence - wallet lookups, transaction details, fee estimates, and network stats. 1 free + 5 paid x402 endpoints.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

// === Icon Endpoint ===
app.get('/icon.png', async (c) => {
  try {
    const fs = await import('fs');
    const icon = fs.readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Bitcoin Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
