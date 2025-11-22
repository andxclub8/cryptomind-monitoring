import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================================
// CONFIGURATION HELPERS
// ============================================================================

async function getScannerStatus(): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'scanner_status')
      .single();
    
    if (error || !data) {
      return 'stopped';
    }
    
    return data.value;
  } catch (err) {
    console.error('[CONFIG] Error loading scanner_status:', err);
    return 'stopped';
  }
}

async function loadMonitoredPairs(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'monitored_pairs')
      .single();
    
    if (error) {
      console.error('[CONFIG] Error loading monitored_pairs:', error.message);
      return [];
    }
    
    if (!data || !data.value) {
      console.warn('[CONFIG] No monitored_pairs in database');
      return [];
    }
    
    // Handle both string and already-parsed JSON (jsonb type)
    const pairs = typeof data.value === 'string' 
      ? JSON.parse(data.value) 
      : data.value;
    
    if (!Array.isArray(pairs)) {
      console.error('[CONFIG] monitored_pairs is not an array:', pairs);
      return [];
    }
    
    if (pairs.length === 0) {
      console.warn('[CONFIG] Monitored pairs array is empty');
      return [];
    }
    
    console.log('[CONFIG] ✓ Loaded monitored pairs:', pairs.join(', '));
    return pairs;
    
  } catch (err) {
    console.error('[CONFIG] Exception loading monitored pairs:', err);
    return [];
  }
}

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

  clear() {
    this.baselines.clear();
    this.lastUpdate.clear();
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

  clear() {
    this.history.clear();
  }
}

// ============================================================================
// TRIGGER DETECTOR
// ============================================================================

class TriggerDetector {
  private baselineTracker = new BaselineTracker();
  private priceHistory = new PriceHistoryTracker();
  private recentTriggers: Map<string, number> = new Map();
  private readonly TRIGGER_COOLDOWN = 60000; // 1 minute (lowered for testing)

  async checkVolumeTrigger(symbol: string, tickerData: any) {
    const currentVolume = parseFloat(tickerData.q); // 24h quote volume

    // Initialize baseline
    this.baselineTracker.initialize(symbol, currentVolume);

    // Update baseline
    this.baselineTracker.update(symbol, currentVolume);

    // Check trigger
    const baseline = this.baselineTracker.get(symbol);
    const volumeRatio = currentVolume / baseline;

    const volumeThreshold = 1.01; // 101% (lowered for testing)

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

    const priceThreshold = 0.1; // 0.1% (lowered for testing)

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

    // Save to database and get the trigger ID
    try {
      console.log(`[TRIGGER] Creating trigger record in database...`);
      
      const { data: triggerData, error: insertError } = await supabase
        .from('monitoring_triggers')
        .insert({
          symbol,
          trigger_type: type,
          trigger_value: value.toFixed(3),
          threshold_used: threshold.toString(),
          metadata,
          analysis_started: false
        })
        .select()
        .single();

      if (insertError || !triggerData) {
        console.error('[TRIGGER] Database error:', insertError?.message);
        return;
      }

      const triggerId = triggerData.id;
      console.log(`[TRIGGER] ✓ Trigger record created with ID: ${triggerId}`);

      // Invoke analyze-full Edge Function with correct parameters
      console.log(`[TRIGGER] Invoking analyze-full for ${symbol} (trigger ID: ${triggerId})...`);
      
      const { data: analysisData, error: invokeError } = await supabase.functions.invoke('analyze-full', {
        body: {
          symbol,
          triggerId  // Pass the trigger ID so analyze-full can link the analysis
        }
      });

      if (invokeError) {
        console.error('[TRIGGER] Failed to invoke analyze-full:', invokeError.message);
        console.error('[TRIGGER] Error details:', invokeError);
        
        // Update trigger to show invocation failed
        await supabase
          .from('monitoring_triggers')
          .update({ 
            analysis_started: false,
            metadata: { 
              ...metadata, 
              invocation_error: invokeError.message 
            }
          })
          .eq('id', triggerId);
        
        return;
      }

      console.log(`[TRIGGER] ✓ analyze-full invoked successfully`);
      
      // Log the response if available
      if (analysisData) {
        console.log(`[TRIGGER] Analysis response:`, JSON.stringify(analysisData).substring(0, 200));
      }
      
      // Update trigger record to mark analysis as started
      const { error: updateError } = await supabase
        .from('monitoring_triggers')
        .update({ analysis_started: true })
        .eq('id', triggerId);
      
      if (updateError) {
        console.error('[TRIGGER] Failed to update trigger record:', updateError.message);
      } else {
        console.log(`[TRIGGER] ✓ Trigger record updated (analysis_started = true)`);
      }

    } catch (err) {
      console.error('[TRIGGER] Exception in createTrigger:', err);
    }
  }

  reset() {
    this.baselineTracker.clear();
    this.priceHistory.clear();
    this.recentTriggers.clear();
  }
}

// ============================================================================
// BINANCE WEBSOCKET MANAGER
// ============================================================================

class BinanceMonitor {
  private ws: WebSocket | null = null;
  private triggerDetector = new TriggerDetector();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusCheckTimer: NodeJS.Timeout | null = null;
  private pairCheckTimer: NodeJS.Timeout | null = null;
  private monitoredSymbols: string[] = [];
  private isMonitoring: boolean = false;

  async start() {
    console.log('[MONITOR] Monitoring service started');
    console.log('[MONITOR] Waiting for scanner to be activated...');
    
    // Don't load pairs on startup - wait for scanner to start
    // Pairs will be loaded when scanner_status becomes 'running'
    
    // Start status check loop
    this.startStatusCheckLoop();
  }

  private async startStatusCheckLoop() {
    // Check immediately
    await this.checkAndUpdateStatus();
    
    // Then check every 10 seconds
    this.statusCheckTimer = setInterval(async () => {
      await this.checkAndUpdateStatus();
    }, 10000);
  }

  private startPairCheckLoop() {
    // Only start pair checking when monitoring is active
    if (this.pairCheckTimer) {
      return; // Already running
    }
    
    console.log('[MONITOR] Starting pair check loop (every 60 seconds)');
    
    // Check immediately
    this.checkAndUpdatePairs();
    
    // Then check every 60 seconds
    this.pairCheckTimer = setInterval(async () => {
      await this.checkAndUpdatePairs();
    }, 60000);
  }

  private stopPairCheckLoop() {
    if (this.pairCheckTimer) {
      clearInterval(this.pairCheckTimer);
      this.pairCheckTimer = null;
      console.log('[MONITOR] Stopped pair check loop');
    }
  }

  private async checkAndUpdatePairs() {
    // Only check pairs if monitoring is active
    if (!this.isMonitoring) {
      return;
    }
    
    console.log('[CONFIG] Checking for pair updates...');
    const newPairs = await loadMonitoredPairs();
    
    // Compare with current pairs
    const pairsChanged = JSON.stringify(newPairs.sort()) !== JSON.stringify(this.monitoredSymbols.sort());
    
    if (pairsChanged) {
      console.log('[CONFIG] Monitored pairs changed!');
      console.log('[CONFIG] Old pairs:', this.monitoredSymbols.join(', ') || 'none');
      console.log('[CONFIG] New pairs:', newPairs.join(', ') || 'none');
      
      this.monitoredSymbols = newPairs;
      
      if (newPairs.length === 0) {
        // Pairs became empty - disconnect from Binance
        console.log('[MONITOR] All pairs removed - disconnecting from Binance...');
        this.stopMonitoring();
        console.log('[MONITOR] Waiting for trading pairs to be added...');
      } else {
        // Pairs changed - reconnect
        console.log('[MONITOR] Reconnecting with new pairs...');
        this.stopMonitoring();
        // Small delay before reconnecting
        setTimeout(() => {
          this.startMonitoring();
        }, 1000);
      }
    }
  }

  private async checkAndUpdateStatus() {
    const status = await getScannerStatus();
    
    if (status === 'running' && !this.isMonitoring) {
      console.log('[MONITOR] ✓ Scanner status: RUNNING - Starting monitoring...');
      
      // Load pairs now (only when starting)
      console.log('[CONFIG] Loading monitored pairs from Supabase...');
      this.monitoredSymbols = await loadMonitoredPairs();
      
      if (this.monitoredSymbols.length === 0) {
        console.warn('[MONITOR] Cannot start - no trading pairs configured');
        console.log('[MONITOR] Waiting for trading pairs to be added...');
        return;
      }
      
      console.log('[MONITOR] Monitored symbols configured:', this.monitoredSymbols.join(', '));
      
      // Start monitoring
      this.startMonitoring();
      
      // Start pair check loop
      this.startPairCheckLoop();
      
    } else if (status === 'stopped' && this.isMonitoring) {
      console.log('[MONITOR] ✗ Scanner status: STOPPED - Stopping monitoring...');
      this.stopMonitoring();
      this.stopPairCheckLoop();
    } else if (status === 'stopped' && !this.isMonitoring) {
      // Still stopped, waiting (log less frequently)
      // Only log every 6th check (once per minute)
      const now = Date.now();
      if (!this.lastStoppedLog || now - this.lastStoppedLog > 60000) {
        console.log('[MONITOR] Waiting for scanner to start... (status: stopped)');
        this.lastStoppedLog = now;
      }
    }
  }
  
  private lastStoppedLog: number = 0;

  private startMonitoring() {
    if (this.isMonitoring) return;
    
    // Double-check we have pairs
    if (this.monitoredSymbols.length === 0) {
      console.warn('[MONITOR] Cannot start monitoring - no trading pairs configured');
      return;
    }
    
    this.isMonitoring = true;
    console.log('[MONITOR] Starting Binance WebSocket connection...');
    this.connect();
  }

  private stopMonitoring() {
    if (!this.isMonitoring) {
      // Already stopped, just clean up
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      return;
    }
    
    this.isMonitoring = false;
    console.log('[MONITOR] Stopping Binance WebSocket connection...');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    // Reset detector state when stopping
    this.triggerDetector.reset();
    
    console.log('[MONITOR] ✓ Monitoring stopped');
  }

  private connect() {
    if (!this.isMonitoring) return;
    
    if (this.monitoredSymbols.length === 0) {
      console.warn('[MONITOR] Cannot connect - no pairs configured');
      return;
    }
    
    try {
      // Build streams
      const streams = this.monitoredSymbols.map(symbol => 
        `${symbol.toLowerCase()}@ticker`
      ).join('/');

      const wsUrl = `wss://data-stream.binance.vision/stream?streams=${streams}`;
      
      console.log('[MONITOR] Connecting to Binance...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[MONITOR] ✓ Connected to Binance WebSocket');
        console.log(`[MONITOR] ✓ Subscribed to ${this.monitoredSymbols.length} symbols`);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('[MONITOR] WebSocket error:', error.message);
      });

      this.ws.on('close', () => {
        console.log('[MONITOR] WebSocket closed');
        
        // Only reconnect if still monitoring
        if (this.isMonitoring) {
          console.log('[MONITOR] Reconnecting in 5 seconds...');
          this.scheduleReconnect();
        }
      });

    } catch (error) {
      console.error('[MONITOR] Connection error:', error);
      if (this.isMonitoring) {
        this.scheduleReconnect();
      }
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
      if (this.isMonitoring && this.monitoredSymbols.length > 0) {
        this.connect();
      }
    }, 5000);
  }

  stop() {
    console.log('[MONITOR] Shutting down monitoring service...');
    
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = null;
    }
    
    this.stopPairCheckLoop();
    this.stopMonitoring();
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
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

  // Start monitor
  const monitor = new BinanceMonitor();
  await monitor.start();

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

  console.log('[MONITOR] Service running. Checking scanner status every 10 seconds...');
}

// Start
main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
