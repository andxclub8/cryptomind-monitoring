/**
 * CryptoMind AI - Railway Monitoring Service v3.2.0
 * 
 * This service runs on Railway and handles:
 * 1. Real-time market monitoring via Binance Futures WebSocket
 * 2. Trigger detection (volume spikes, price movements)
 * 3. Position monitoring for active strategies
 * 4. Circuit Breaker for flash crash protection (NEW in v3.2.0)
 * 
 * Changes in v3.2.0:
 * - Added Circuit Breaker (blocks triggers if price moves >5% in 15 min)
 * - Added 15-minute price window tracking for flash crash detection
 * - Telegram alerts for circuit breaker activation
 * - Improved error handling and retry logic
 */

import WebSocket from 'ws';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  
  // Binance WebSocket - FUTURES (not spot!)
  BINANCE_WS_URL: 'wss://fstream.binance.com/stream',
  
  // Scanner settings
  STATUS_CHECK_INTERVAL: 10000,      // 10 seconds
  PAIR_RELOAD_INTERVAL: 60000,       // 60 seconds
  VOLUME_BASELINE_UPDATE: 3600000,   // 1 hour
  PRICE_WINDOW: 300000,              // 5 minutes for trigger detection
  TRIGGER_COOLDOWN: 300000,          // 5 minutes cooldown
  
  // Thresholds (can be overridden from system_config)
  VOLUME_SPIKE_THRESHOLD: 1.20,      // 120%
  PRICE_MOVE_THRESHOLD: 0.005,       // 0.5%
  
  // Position Monitor
  POSITION_RELOAD_INTERVAL: 15000,   // 15 seconds
  EPSILON: 0.001,                    // 0.1% price tolerance
  
  // Circuit Breaker (NEW in v3.2.0)
  CIRCUIT_BREAKER_WINDOW: 900000,    // 15 minutes
  CIRCUIT_BREAKER_THRESHOLD: 0.05,   // 5% price change
  CIRCUIT_BREAKER_COOLDOWN: 1800000, // 30 minutes block
};

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

const supabase: SupabaseClient = createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_ANON_KEY
);

// ============================================================================
// TYPES
// ============================================================================

interface TickerData {
  stream: string;
  data: {
    s: string;    // Symbol
    c: string;    // Close price
    v: string;    // Volume
    q: string;    // Quote volume
    P: string;    // Price change percent
  };
}

interface PricePoint {
  price: number;
  timestamp: number;
}

interface ActiveStrategy {
  id: string;
  analysis_id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_min: number;
  entry_max: number;
  target_1: number;
  target_2: number;
  target_3: number;
  stop_loss: number;
  targets_hit: string[];
  status: string;
  current_price: number;
}

interface CircuitBreakerState {
  symbol: string;
  activatedAt: number;
  expiresAt: number;
  reason: string;
  priceChangePercent: number;
}

// ============================================================================
// BASELINE TRACKER (Volume)
// ============================================================================

class BaselineTracker {
  private baselines: Map<string, number> = new Map();
  private lastUpdate: Map<string, number> = new Map();
  
  initialize(symbol: string, volume: number): void {
    if (!this.baselines.has(symbol)) {
      this.baselines.set(symbol, volume);
      this.lastUpdate.set(symbol, Date.now());
      console.log(`[Baseline] Initialized ${symbol}: ${volume.toFixed(2)}`);
    }
  }
  
  update(symbol: string, currentVolume: number): void {
    const lastUpdateTime = this.lastUpdate.get(symbol) || 0;
    
    if (Date.now() - lastUpdateTime >= CONFIG.VOLUME_BASELINE_UPDATE) {
      const oldBaseline = this.baselines.get(symbol) || currentVolume;
      const newBaseline = oldBaseline * 0.8 + currentVolume * 0.2;
      this.baselines.set(symbol, newBaseline);
      this.lastUpdate.set(symbol, Date.now());
      console.log(`[Baseline] Updated ${symbol}: ${oldBaseline.toFixed(2)} → ${newBaseline.toFixed(2)}`);
    }
  }
  
  check(symbol: string, currentVolume: number, threshold: number): { isSpike: boolean; ratio: number } {
    const baseline = this.baselines.get(symbol);
    if (!baseline) return { isSpike: false, ratio: 0 };
    
    const ratio = currentVolume / baseline;
    return { isSpike: ratio > threshold, ratio };
  }
  
  getBaseline(symbol: string): number {
    return this.baselines.get(symbol) || 0;
  }
  
  clear(): void {
    this.baselines.clear();
    this.lastUpdate.clear();
  }
}

// ============================================================================
// PRICE HISTORY TRACKER (5-minute window for triggers)
// ============================================================================

class PriceHistoryTracker {
  private history: Map<string, PricePoint[]> = new Map();
  
  add(symbol: string, price: number): void {
    if (!this.history.has(symbol)) {
      this.history.set(symbol, []);
    }
    
    const points = this.history.get(symbol)!;
    points.push({ price, timestamp: Date.now() });
    
    // Cleanup old points
    this.cleanup(symbol);
  }
  
  private cleanup(symbol: string): void {
    const points = this.history.get(symbol);
    if (!points) return;
    
    const cutoff = Date.now() - CONFIG.PRICE_WINDOW;
    const filtered = points.filter(p => p.timestamp > cutoff);
    this.history.set(symbol, filtered);
  }
  
  getChange(symbol: string, currentPrice: number): number {
    const points = this.history.get(symbol);
    if (!points || points.length === 0) return 0;
    
    const oldestPrice = points[0].price;
    return ((currentPrice - oldestPrice) / oldestPrice) * 100;
  }
  
  check(symbol: string, currentPrice: number, threshold: number): { isTrigger: boolean; change: number } {
    const change = Math.abs(this.getChange(symbol, currentPrice));
    return { isTrigger: change >= threshold * 100, change };
  }
  
  clear(): void {
    this.history.clear();
  }
}

// ============================================================================
// CIRCUIT BREAKER (NEW in v3.2.0)
// ============================================================================

class CircuitBreaker {
  // 15-minute price history for flash crash detection
  private priceHistory15m: Map<string, PricePoint[]> = new Map();
  
  // Active circuit breaker states
  private activeBreakers: Map<string, CircuitBreakerState> = new Map();
  
  /**
   * Add price point and check for circuit breaker trigger
   */
  addPrice(symbol: string, price: number): { shouldBlock: boolean; reason?: string } {
    // Add to 15-minute history
    if (!this.priceHistory15m.has(symbol)) {
      this.priceHistory15m.set(symbol, []);
    }
    
    const points = this.priceHistory15m.get(symbol)!;
    points.push({ price, timestamp: Date.now() });
    
    // Cleanup old points (older than 15 minutes)
    const cutoff = Date.now() - CONFIG.CIRCUIT_BREAKER_WINDOW;
    const filtered = points.filter(p => p.timestamp > cutoff);
    this.priceHistory15m.set(symbol, filtered);
    
    // Check if circuit breaker is currently active
    const activeBreaker = this.activeBreakers.get(symbol);
    if (activeBreaker && Date.now() < activeBreaker.expiresAt) {
      return { 
        shouldBlock: true, 
        reason: `Circuit breaker active until ${new Date(activeBreaker.expiresAt).toISOString()}` 
      };
    } else if (activeBreaker && Date.now() >= activeBreaker.expiresAt) {
      // Expired - remove it
      this.activeBreakers.delete(symbol);
      console.log(`[CIRCUIT_BREAKER] ✓ Expired for ${symbol}, resuming normal operation`);
    }
    
    // Check for flash crash (>5% in 15 minutes)
    if (filtered.length >= 2) {
      const oldestPrice = filtered[0].price;
      const priceChange = ((price - oldestPrice) / oldestPrice);
      const priceChangePercent = priceChange * 100;
      
      if (Math.abs(priceChange) >= CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
        // FLASH CRASH DETECTED!
        const direction = priceChange > 0 ? 'UP' : 'DOWN';
        const reason = `Flash ${direction}: ${priceChangePercent.toFixed(2)}% in 15 minutes`;
        
        console.log(`[CIRCUIT_BREAKER] ⚠️ ACTIVATED for ${symbol}: ${reason}`);
        
        // Activate circuit breaker
        const state: CircuitBreakerState = {
          symbol,
          activatedAt: Date.now(),
          expiresAt: Date.now() + CONFIG.CIRCUIT_BREAKER_COOLDOWN,
          reason,
          priceChangePercent
        };
        
        this.activeBreakers.set(symbol, state);
        
        // Log to database and send Telegram (async, don't await)
        this.logCircuitBreaker(state);
        
        return { shouldBlock: true, reason };
      }
    }
    
    return { shouldBlock: false };
  }
  
  /**
   * Check if symbol is currently blocked
   */
  isBlocked(symbol: string): boolean {
    const activeBreaker = this.activeBreakers.get(symbol);
    if (!activeBreaker) return false;
    
    if (Date.now() >= activeBreaker.expiresAt) {
      this.activeBreakers.delete(symbol);
      return false;
    }
    
    return true;
  }
  
  /**
   * Log circuit breaker activation to database and send Telegram
   */
  private async logCircuitBreaker(state: CircuitBreakerState): Promise<void> {
    try {
      // Insert into circuit_breaker_state table
      await supabase.from('circuit_breaker_state').insert({
        symbol: state.symbol,
        activated_at: new Date(state.activatedAt).toISOString(),
        expires_at: new Date(state.expiresAt).toISOString(),
        reason: state.reason,
        price_change_percent: state.priceChangePercent,
        is_active: true
      });
      
      // Log to system_logs
      await supabase.from('system_logs').insert({
        level: 'WARN',
        category: 'CircuitBreaker',
        message: `Circuit breaker activated for ${state.symbol}`,
        metadata: {
          symbol: state.symbol,
          reason: state.reason,
          priceChangePercent: state.priceChangePercent,
          expiresAt: new Date(state.expiresAt).toISOString()
        },
        source: 'Railway'
      });
      
      // Send Telegram alert via Edge Function
      await this.sendTelegramAlert(state);
      
    } catch (error) {
      console.error('[CIRCUIT_BREAKER] Failed to log:', error);
    }
  }
  
  /**
   * Send Telegram alert for circuit breaker activation
   */
  private async sendTelegramAlert(state: CircuitBreakerState): Promise<void> {
    try {
      const response = await fetch(
        `${CONFIG.SUPABASE_URL}/functions/v1/telegram-bot`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'send_circuit_breaker_alert',
            data: {
              symbol: state.symbol,
              reason: state.reason,
              priceChangePercent: state.priceChangePercent,
              expiresAt: new Date(state.expiresAt).toISOString(),
              cooldownMinutes: CONFIG.CIRCUIT_BREAKER_COOLDOWN / 60000
            }
          })
        }
      );
      
      if (!response.ok) {
        console.error('[CIRCUIT_BREAKER] Telegram alert failed:', response.status);
      } else {
        console.log('[CIRCUIT_BREAKER] ✓ Telegram alert sent');
      }
    } catch (error) {
      console.error('[CIRCUIT_BREAKER] Telegram error:', error);
    }
  }
  
  /**
   * Get all active circuit breakers
   */
  getActiveBreakers(): CircuitBreakerState[] {
    const now = Date.now();
    const active: CircuitBreakerState[] = [];
    
    this.activeBreakers.forEach((state, symbol) => {
      if (now < state.expiresAt) {
        active.push(state);
      } else {
        this.activeBreakers.delete(symbol);
      }
    });
    
    return active;
  }
  
  clear(): void {
    this.priceHistory15m.clear();
    this.activeBreakers.clear();
  }
}

// ============================================================================
// TRIGGER DETECTOR
// ============================================================================

class TriggerDetector {
  private recentTriggers: Map<string, number> = new Map();
  private baselineTracker: BaselineTracker;
  private priceTracker: PriceHistoryTracker;
  private circuitBreaker: CircuitBreaker;
  
  // Thresholds (loaded from config)
  private volumeThreshold: number = CONFIG.VOLUME_SPIKE_THRESHOLD;
  private priceThreshold: number = CONFIG.PRICE_MOVE_THRESHOLD;
  
  constructor() {
    this.baselineTracker = new BaselineTracker();
    this.priceTracker = new PriceHistoryTracker();
    this.circuitBreaker = new CircuitBreaker();
  }
  
  async loadThresholds(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('system_config')
        .select('key, value')
        .in('key', ['volume_spike_threshold', 'price_move_threshold']);
      
      if (data) {
        for (const config of data) {
          if (config.key === 'volume_spike_threshold') {
            this.volumeThreshold = parseFloat(config.value) || CONFIG.VOLUME_SPIKE_THRESHOLD;
          }
          if (config.key === 'price_move_threshold') {
            this.priceThreshold = parseFloat(config.value) || CONFIG.PRICE_MOVE_THRESHOLD;
          }
        }
      }
      
      console.log(`[CONFIG] Thresholds: volume=${this.volumeThreshold}, price=${this.priceThreshold}`);
    } catch (error) {
      console.error('[CONFIG] Failed to load thresholds:', error);
    }
  }
  
  async processTicker(ticker: TickerData['data']): Promise<void> {
    const symbol = ticker.s;
    const price = parseFloat(ticker.c);
    const volume = parseFloat(ticker.q); // Quote volume in USDT
    
    // Initialize baseline if needed
    this.baselineTracker.initialize(symbol, volume);
    
    // Update baseline periodically
    this.baselineTracker.update(symbol, volume);
    
    // Add to price trackers
    this.priceTracker.add(symbol, price);
    
    // Check circuit breaker (15-minute window)
    const circuitCheck = this.circuitBreaker.addPrice(symbol, price);
    if (circuitCheck.shouldBlock) {
      // Circuit breaker is active - skip trigger detection
      return;
    }
    
    // Check for volume spike
    const volumeCheck = this.baselineTracker.check(symbol, volume, this.volumeThreshold);
    if (volumeCheck.isSpike) {
      await this.createTrigger(symbol, 'volume_spike', volumeCheck.ratio, {
        baseline: this.baselineTracker.getBaseline(symbol),
        currentVolume: volume,
        ratio: volumeCheck.ratio
      });
    }
    
    // Check for price movement
    const priceCheck = this.priceTracker.check(symbol, price, this.priceThreshold);
    if (priceCheck.isTrigger) {
      await this.createTrigger(symbol, 'price_move', priceCheck.change, {
        priceChange: priceCheck.change,
        currentPrice: price
      });
    }
  }
  
  private async createTrigger(
    symbol: string, 
    type: string, 
    value: number, 
    metadata: Record<string, any>
  ): Promise<void> {
    // Check cooldown
    const key = `${symbol}-${type}`;
    const lastTrigger = this.recentTriggers.get(key) || 0;
    
    if (Date.now() - lastTrigger < CONFIG.TRIGGER_COOLDOWN) {
      return; // Skip - too soon
    }
    
    // Double-check circuit breaker before creating trigger
    if (this.circuitBreaker.isBlocked(symbol)) {
      console.log(`[TRIGGER] Blocked by circuit breaker: ${symbol}`);
      return;
    }
    
    // Record trigger time
    this.recentTriggers.set(key, Date.now());
    
    try {
      // Create trigger in database
      const { data, error } = await supabase
        .from('monitoring_triggers')
        .insert({
          symbol,
          trigger_type: type,
          trigger_value: value.toFixed(3),
          threshold_used: type === 'volume_spike' 
            ? this.volumeThreshold.toString() 
            : this.priceThreshold.toString(),
          metadata,
          analysis_started: false
        })
        .select('id')
        .single();
      
      if (error) {
        console.error(`[TRIGGER] Database error:`, error.message);
        return;
      }
      
      console.log(`[TRIGGER] ✓ Created ${type} for ${symbol}: ${value.toFixed(2)}%`);
      console.log(`[TRIGGER] → ID: ${data.id}`);
      console.log(`[TRIGGER] → Database trigger will invoke analyze-full`);
      
    } catch (error) {
      console.error(`[TRIGGER] Error creating trigger:`, error);
    }
  }
  
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }
  
  clear(): void {
    this.recentTriggers.clear();
    this.baselineTracker.clear();
    this.priceTracker.clear();
    this.circuitBreaker.clear();
  }
}

// ============================================================================
// POSITION MONITOR
// ============================================================================

class PositionMonitor {
  private strategies: Map<string, ActiveStrategy[]> = new Map();
  private latestPrices: Map<string, number> = new Map();
  private reloadInterval: NodeJS.Timeout | null = null;
  private isActive: boolean = false;
  
  async start(): Promise<void> {
    if (this.isActive) return;
    
    this.isActive = true;
    console.log('[POSITION_MONITOR] ✓ Started');
    
    // Initial load
    await this.loadStrategies();
    
    // Reload every 15 seconds
    this.reloadInterval = setInterval(async () => {
      await this.loadStrategies();
    }, CONFIG.POSITION_RELOAD_INTERVAL);
  }
  
  stop(): void {
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }
    this.strategies.clear();
    this.isActive = false;
    console.log('[POSITION_MONITOR] ✓ Stopped');
  }
  
  private async loadStrategies(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('active_strategies')
        .select('*')
        .in('status', ['waiting_entry', 'in_position']);
      
      if (error) {
        console.error('[POSITION_MONITOR] Load error:', error.message);
        return;
      }
      
      // Group by symbol
      this.strategies.clear();
      for (const strategy of (data || [])) {
        const symbol = strategy.symbol;
        if (!this.strategies.has(symbol)) {
          this.strategies.set(symbol, []);
        }
        this.strategies.get(symbol)!.push(strategy);
      }
      
      const totalStrategies = data?.length || 0;
      if (totalStrategies > 0) {
        console.log(`[POSITION_MONITOR] Loaded ${totalStrategies} strategies for ${this.strategies.size} symbols`);
      }
      
    } catch (error) {
      console.error('[POSITION_MONITOR] Load error:', error);
    }
  }
  
  /**
   * Called on each ticker update
   */
  async checkPrice(symbol: string, price: number): Promise<void> {
    this.latestPrices.set(symbol, price);
    
    const strategies = this.strategies.get(symbol);
    if (!strategies || strategies.length === 0) return;
    
    for (const strategy of strategies) {
      await this.checkStrategy(strategy, price);
    }
  }
  
  private async checkStrategy(strategy: ActiveStrategy, currentPrice: number): Promise<void> {
    const isLong = strategy.direction === 'LONG';
    const targetsHit = new Set(strategy.targets_hit || []);
    let hasUpdate = false;
    let eventType: string | null = null;
    
    // Check targets (T3 → T2 → T1 for price jumps)
    const targets = [
      { name: 'target_3', value: strategy.target_3 },
      { name: 'target_2', value: strategy.target_2 },
      { name: 'target_1', value: strategy.target_1 }
    ];
    
    for (const target of targets) {
      if (targetsHit.has(target.name)) continue;
      
      const hit = isLong
        ? currentPrice >= target.value * (1 - CONFIG.EPSILON)
        : currentPrice <= target.value * (1 + CONFIG.EPSILON);
      
      if (hit) {
        targetsHit.add(target.name);
        hasUpdate = true;
        eventType = target.name;
        console.log(`[POSITION_MONITOR] 🎯 ${target.name.toUpperCase()} hit for ${strategy.symbol}!`);
      }
    }
    
    // Check stop loss
    const stopLossHit = isLong
      ? currentPrice <= strategy.stop_loss * (1 + CONFIG.EPSILON)
      : currentPrice >= strategy.stop_loss * (1 - CONFIG.EPSILON);
    
    if (stopLossHit && !targetsHit.has('stop_loss')) {
      targetsHit.add('stop_loss');
      hasUpdate = true;
      eventType = 'stop_loss';
      console.log(`[POSITION_MONITOR] 🛑 STOP LOSS hit for ${strategy.symbol}!`);
    }
    
    // Update database if something changed
    if (hasUpdate) {
      const newStatus = targetsHit.has('target_3') || targetsHit.has('stop_loss')
        ? 'completed'
        : 'in_position';
      
      try {
        const { data, error } = await supabase
          .from('active_strategies')
          .update({
            targets_hit: Array.from(targetsHit),
            status: newStatus,
            current_price: currentPrice,
            last_check_at: new Date().toISOString()
          })
          .eq('id', strategy.id)
          .select()
          .single();
        
        if (error) {
          console.error('[POSITION_MONITOR] Update error:', error.message);
          return;
        }
        
        // Send Telegram notification
        if (eventType) {
          await this.sendNotification(strategy, eventType, currentPrice);
        }
        
      } catch (error) {
        console.error('[POSITION_MONITOR] Update error:', error);
      }
    } else {
      // Silent price update (less frequent)
      // Only update every 5 price changes or if price changed significantly
      const lastPrice = strategy.current_price || 0;
      const priceChange = Math.abs((currentPrice - lastPrice) / lastPrice);
      
      if (priceChange > 0.001) { // 0.1% change
        await supabase
          .from('active_strategies')
          .update({
            current_price: currentPrice,
            last_check_at: new Date().toISOString()
          })
          .eq('id', strategy.id);
      }
    }
  }
  
  private async sendNotification(
    strategy: ActiveStrategy, 
    eventType: string, 
    currentPrice: number
  ): Promise<void> {
    try {
      const response = await fetch(
        `${CONFIG.SUPABASE_URL}/functions/v1/notify-strategy-event`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            strategyId: strategy.id,
            symbol: strategy.symbol,
            eventType,
            currentPrice,
            direction: strategy.direction,
            targets: {
              target_1: strategy.target_1,
              target_2: strategy.target_2,
              target_3: strategy.target_3,
              stop_loss: strategy.stop_loss
            }
          })
        }
      );
      
      if (!response.ok) {
        console.error('[POSITION_MONITOR] Notification error:', response.status);
      } else {
        console.log(`[POSITION_MONITOR] ✓ Notification sent for ${eventType}`);
      }
    } catch (error) {
      console.error('[POSITION_MONITOR] Notification error:', error);
    }
  }
  
  hasActiveStrategies(): boolean {
    return this.strategies.size > 0;
  }
  
  getMonitoredSymbols(): string[] {
    return Array.from(this.strategies.keys());
  }
}

// ============================================================================
// BINANCE MONITOR (Main WebSocket Handler)
// ============================================================================

class BinanceMonitor {
  private ws: WebSocket | null = null;
  private monitoredSymbols: string[] = [];
  private isMonitoring: boolean = false;
  private triggerDetector: TriggerDetector;
  private positionMonitor: PositionMonitor;
  
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private pairReloadInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.triggerDetector = new TriggerDetector();
    this.positionMonitor = new PositionMonitor();
  }
  
  async initialize(): Promise<void> {
    console.log('[MONITOR] Initializing CryptoMind AI v3.2.0...');
    console.log(`[MONITOR] Supabase URL: ${CONFIG.SUPABASE_URL ? '✓' : '✗'}`);
    
    // Load thresholds from config
    await this.triggerDetector.loadThresholds();
    
    // Start status check loop
    this.startStatusCheckLoop();
    
    // Start position monitor
    await this.positionMonitor.start();
    
    console.log('[MONITOR] ✓ Initialization complete');
  }
  
  private startStatusCheckLoop(): void {
    this.statusCheckInterval = setInterval(async () => {
      await this.checkAndUpdateStatus();
    }, CONFIG.STATUS_CHECK_INTERVAL);
    
    // Also run immediately
    this.checkAndUpdateStatus();
  }
  
  private async checkAndUpdateStatus(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'scanner_status')
        .single();
      
      if (error) {
        console.error('[STATUS] Error fetching status:', error.message);
        return;
      }
      
      // Supabase returns jsonb already parsed - no JSON.parse needed
      const status = data.value;
      
      if (status === 'running' && !this.isMonitoring) {
        console.log('[STATUS] Scanner starting...');
        await this.startMonitoring();
      } else if (status === 'stopped' && this.isMonitoring) {
        console.log('[STATUS] Scanner stopping...');
        this.stopMonitoring();
      }
    } catch (error) {
      console.error('[STATUS] Check error:', error);
    }
  }
  
  private async startMonitoring(): Promise<void> {
    // Load monitored pairs
    this.monitoredSymbols = await this.loadMonitoredPairs();
    
    if (this.monitoredSymbols.length === 0) {
      console.log('[MONITOR] No pairs configured - waiting...');
      return;
    }
    
    // Connect to Binance
    this.connect();
    
    // Start pair reload loop
    this.startPairReloadLoop();
    
    this.isMonitoring = true;
    console.log(`[MONITOR] ✓ Started monitoring ${this.monitoredSymbols.length} pairs`);
  }
  
  private stopMonitoring(): void {
    // Disconnect WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    // Stop pair reload loop
    if (this.pairReloadInterval) {
      clearInterval(this.pairReloadInterval);
      this.pairReloadInterval = null;
    }
    
    // Clear trackers
    this.triggerDetector.clear();
    
    this.isMonitoring = false;
    console.log('[MONITOR] ✓ Stopped');
  }
  
  private async loadMonitoredPairs(): Promise<string[]> {
    try {
      const { data, error } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', 'monitored_pairs')
        .single();
      
      if (error) {
        console.error('[CONFIG] Error loading pairs:', error.message);
        return [];
      }
      
      // Supabase returns jsonb already parsed - no JSON.parse needed
      const pairs = Array.isArray(data.value) ? data.value : [];
      console.log(`[CONFIG] ✓ Loaded pairs: ${pairs.join(', ')}`);
      return pairs;
    } catch (error) {
      console.error('[CONFIG] Load pairs error:', error);
      return [];
    }
  }
  
  private startPairReloadLoop(): void {
    this.pairReloadInterval = setInterval(async () => {
      await this.checkAndUpdatePairs();
    }, CONFIG.PAIR_RELOAD_INTERVAL);
  }
  
  private async checkAndUpdatePairs(): Promise<void> {
    const newPairs = await this.loadMonitoredPairs();
    
    // Check if pairs changed
    const changed = newPairs.length !== this.monitoredSymbols.length ||
      newPairs.some((p, i) => p !== this.monitoredSymbols[i]);
    
    if (changed) {
      console.log('[CONFIG] Pairs changed - reconnecting...');
      
      if (newPairs.length === 0) {
        // No pairs - disconnect
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.monitoredSymbols = [];
        console.log('[CONFIG] No pairs configured');
      } else {
        // Reconnect with new pairs
        this.monitoredSymbols = newPairs;
        if (this.ws) {
          this.ws.close();
        }
        this.connect();
      }
    }
  }
  
  private connect(): void {
    if (this.monitoredSymbols.length === 0) return;
    
    // Build stream URL for all pairs (FUTURES WebSocket)
    const streams = this.monitoredSymbols
      .map(s => `${s.toLowerCase()}@ticker`)
      .join('/');
    
    const url = `${CONFIG.BINANCE_WS_URL}?streams=${streams}`;
    
    console.log(`[WS] Connecting to Binance Futures...`);
    
    this.ws = new WebSocket(url);
    
    this.ws.on('open', () => {
      console.log(`[WS] ✓ Connected to Binance Futures`);
      console.log(`[WS] Monitoring: ${this.monitoredSymbols.join(', ')}`);
    });
    
    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const message: TickerData = JSON.parse(data.toString());
        
        if (message.data && message.data.s) {
          // Process for trigger detection
          await this.triggerDetector.processTicker(message.data);
          
          // Process for position monitoring
          const price = parseFloat(message.data.c);
          await this.positionMonitor.checkPrice(message.data.s, price);
        }
      } catch (error) {
        console.error('[WS] Message parse error:', error);
      }
    });
    
    this.ws.on('close', () => {
      console.log('[WS] Disconnected');
      
      // Auto-reconnect if still monitoring
      if (this.isMonitoring && this.monitoredSymbols.length > 0) {
        console.log('[WS] Reconnecting in 5 seconds...');
        setTimeout(() => this.connect(), 5000);
      }
    });
    
    this.ws.on('error', (error) => {
      console.error('[WS] Error:', error);
    });
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('[MONITOR] Shutting down...');
    
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }
    
    this.stopMonitoring();
    this.positionMonitor.stop();
    
    console.log('[MONITOR] ✓ Shutdown complete');
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  CryptoMind AI - Railway Monitoring Service v3.2.0');
  console.log('='.repeat(60));
  console.log('');
  console.log('Features:');
  console.log('  ✓ Real-time market monitoring (Binance Futures WebSocket)');
  console.log('  ✓ Volume spike detection');
  console.log('  ✓ Price movement detection');
  console.log('  ✓ Position monitoring (T1/T2/T3, Stop Loss)');
  console.log('  ✓ Circuit Breaker (flash crash protection)');
  console.log('  ✓ Telegram notifications');
  console.log('');
  
  const monitor = new BinanceMonitor();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await monitor.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await monitor.shutdown();
    process.exit(0);
  });
  
  // Start monitoring
  await monitor.initialize();
}

// Run
main().catch((error) => {
  console.error('[FATAL] Startup error:', error);
  process.exit(1);
});
