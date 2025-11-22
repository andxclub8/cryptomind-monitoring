import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const MONITORED_SYMBOLS = (process.env.MONITORED_SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT').split(',');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================================
// BASELINE TRACKER
// ============================================================================

class BaselineTracker {
  private baselines: Map<string, number> = new Map();
  private lastUpdate: Map<string, number> = new Map();
  private readonly UPDATE_INTERVAL = 3600000; // 1 hour

  initialize(symbol: string, volume: number) {
    if (!this.baselines.has(symbol)) {
      this.baselines.set(symbol, volume);
      this.lastUpdate.set(symbol, Date.now());
      console.log(`[Baseline] Initialized for ${symbol}: ${volume.toFixed(0)}`);
    }
  }

  update(symbol: string, currentVolume: number) {
    const lastUpdate = this.lastUpdate.get(symbol) || 0;
    const timeSinceUpdate = Date.now() - lastUpdate;

    if (timeSinceUpdate > this.UPDATE_INTERVAL) {
      const oldBaseline = this.baselines.get(symbol) || currentVolume;
      const newBaseline = oldBaseline * 0.8 + currentVolume * 0.2;
      this.baselines.set(symbol, newBaseline);
      this.lastUpdate.set(symbol, Date.now());
      console.log(`[Baseline] Updated ${symbol}: ${oldBaseline.toFixed(0)} → ${newBaseline.toFixed(0)}`);
    }
  }

  get(symbol: string): number {
    return this.baselines.get(symbol) || 0;
  }
}

// ============================================================================
// PRICE HISTORY TRACKER
// ============================================================================

class PriceHistoryTracker {
  private history: Map<string, Array<{ price: number; timestamp: number }>> = new Map();
  private readonly WINDOW = 300000; // 5 minutes

  add(symbol: string, price: number) {
    if (!this.history.has(symbol)) {
      this.history.set(symbol, []);
    }

    const history = this.history.get(symbol)!;
    const now = Date.now();

    // Add new price
    history.push({ price, timestamp: now });

    // Remove old prices (> 5 min)
    const filtered = history.filter(h => now - h.timestamp <= this.WINDOW);
    this.history.set(symbol, filtered);
  }

  getChange(symbol: string, currentPrice: number): number {
    const history = this.history.get(symbol);
    if (!history || history.length === 0) return 0;

    const oldestPrice = history[0].price;
    return ((currentPrice - oldestPrice) / oldestPrice) * 100;
  }
}

// ============================================================================
// TRIGGER DETECTOR
// ============================================================================

class TriggerDetector {
  private baselineTracker = new BaselineTracker();
  private priceHistory = new PriceHistoryTracker();
  private recentTriggers: Map<string, number> = new Map();
  private readonly TRIGGER_COOLDOWN = 600000; // 10 minutes

  async checkVolumeTrigger(symbol: string, tickerData: any) {
    const currentVolume = parseFloat(tickerData.q); // 24h quote volume

    // Initialize baseline
    this.baselineTracker.initialize(symbol, currentVolume);

    // Update baseline
    this.baselineTracker.update(symbol, currentVolume);

    // Check trigger
    const baseline = this.baselineTracker.get(symbol);
    const volumeRatio = currentVolume / baseline;

    const volumeThreshold = 1.5; // 150%

    if (volumeRatio > volumeThreshold) {
      await this.createTrigger(symbol, 'volume_spike', volumeRatio, volumeThreshold, {
        currentVolume: currentVolume.toFixed(0),
        baseline: baseline.toFixed(0),
        ratio: volumeRatio.toFixed(2)
      });
    }
  }

  async checkPriceTrigger(symbol: string, tickerData: any) {
    const currentPrice = parseFloat(tickerData.c);

    // Add to history
    this.priceHistory.add(symbol, currentPrice);

    // Calculate 5-min change
    const priceChange = this.priceHistory.getChange(symbol, currentPrice);

    const priceThreshold = 2.0; // 2%

    if (Math.abs(priceChange) >= priceThreshold) {
      await this.createTrigger(symbol, 'price_move', priceChange, priceThreshold, {
        priceChange5min: priceChange.toFixed(2),
        currentPrice: currentPrice.toFixed(6)
      });
    }
  }

  async createTrigger(
    symbol: string,
    type: string,
    value: number,
    threshold: number,
    metadata: any
  ) {
    // Check cooldown
    const lastTrigger = this.recentTriggers.get(`${symbol}-${type}`) || 0;
    if (Date.now() - lastTrigger < this.TRIGGER_COOLDOWN) {
      return; // Skip, too soon
    }

    console.log(`[TRIGGER] ${type} detected for ${symbol}: ${value.toFixed(2)} (threshold: ${threshold})`);

    // Record trigger
    this.recentTriggers.set(`${symbol}-${type}`, Date.now());

    // Save to database
    try {
      const { error } = await supabase.from('monitoring_triggers').insert({
        symbol,
        trigger_type: type,
        trigger_value: value.toFixed(3),
        threshold_used: threshold.toString(),
        metadata,
        analysis_started: false
      });

      if (error) {
        console.error('[TRIGGER] Database error:', error.message);
        return;
      }

      // Invoke analyze-full Edge Function
      console.log(`[TRIGGER] Invoking analyze-full for ${symbol}...`);
      
      const { error: invokeError } = await supabase.functions.invoke('analyze-full', {
        body: {
          symbol,
          trigger_type: type,
          trigger_value: value
        }
      });

      if (invokeError) {
        console.error('[TRIGGER] Failed to invoke analyze-full:', invokeError.message);
      } else {
        console.log(`[TRIGGER] ✓ Analysis started for ${symbol}`);
        
        // Update trigger record
        await supabase
          .from('monitoring_triggers')
          .update({ analysis_started: true })
          .eq('symbol', symbol)
          .eq('trigger_type', type)
          .order('triggered_at', { ascending: false })
          .limit(1);
      }
    } catch (err) {
      console.error('[TRIGGER] Error:', err);
    }
  }
}

// ============================================================================
// BINANCE WEBSOCKET MANAGER
// ============================================================================

class BinanceMonitor {
  private ws: WebSocket | null = null;
  private triggerDetector = new TriggerDetector();
  private reconnectTimer: NodeJS.Timeout | null = null;

  start() {
    console.log('[MONITOR] Starting Binance WebSocket monitor...');
    console.log('[MONITOR] Monitored symbols:', MONITORED_SYMBOLS.join(', '));
    this.connect();
  }

  private connect() {
    try {
      // Build streams
      const streams = MONITORED_SYMBOLS.map(symbol => 
        `${symbol.toLowerCase()}@ticker`
      ).join('/');

      const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
      
      console.log('[MONITOR] Connecting to Binance...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[MONITOR] ✓ Connected to Binance WebSocket');
        console.log(`[MONITOR] ✓ Subscribed to ${MONITORED_SYMBOLS.length} symbols`);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('[MONITOR] WebSocket error:', error.message);
      });

      this.ws.on('close', () => {
        console.log('[MONITOR] WebSocket closed. Reconnecting in 5 seconds...');
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('[MONITOR] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: WebSocket.Data) {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.stream && message.data) {
        const symbol = message.stream.replace('@ticker', '').toUpperCase();
        const tickerData = message.data;

        // Check triggers
        this.triggerDetector.checkVolumeTrigger(symbol, tickerData);
        this.triggerDetector.checkPriceTrigger(symbol, tickerData);
      }
    } catch (error) {
      // Ignore parse errors (heartbeats, etc.)
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  stop() {
    console.log('[MONITOR] Stopping monitor...');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

console.log('='.repeat(60));
console.log('CryptoMind AI - Monitoring Service v1.0.0');
console.log('='.repeat(60));

// Validate environment
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[ERROR] Missing environment variables!');
  console.error('[ERROR] Required: SUPABASE_URL, SUPABASE_ANON_KEY');
  process.exit(1);
}

console.log('[CONFIG] Supabase URL:', SUPABASE_URL);
console.log('[CONFIG] Monitored symbols:', MONITORED_SYMBOLS.join(', '));

// Start monitor
const monitor = new BinanceMonitor();
monitor.start();

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT, stopping...');
  monitor.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, stopping...');
  monitor.stop();
  process.exit(0);
});

console.log('[MONITOR] Service started. Press Ctrl+C to stop.');