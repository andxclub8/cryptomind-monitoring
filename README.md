# CryptoMind AI - Monitoring Service

WebSocket monitoring service for real-time cryptocurrency market analysis and position tracking.

## Features

### Scanner (Market Monitoring)
- 24/7 WebSocket connection to Binance
- Real-time volume spike detection
- Real-time price move detection (5-min window)
- Automatic baseline tracking
- Triggers CryptoMind AI analysis on market events

### Position Monitor (NEW in v2.0)
- Real-time tracking of active trading positions
- Automatic target hit detection (T1, T2, T3)
- Stop-loss monitoring
- Price jump support (catches all targets at once)
- Telegram notifications via Edge Function
- Silent price updates (reduces database load)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Binance WebSocket                         │
│                  (Real-time @ticker data)                    │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ├──► Scanner (TriggerDetector)
                 │    └──► monitoring_triggers → analyze-full → Telegram
                 │
                 └──► Position Monitor
                      └──► Checks: T1/T2/T3, Stop-Loss
                           └──► Updates active_strategies
                                └──► HTTP → notify-strategy-event → Telegram
```

## Two Parallel Processes

### 1. Scanner Process
- Monitors: Volume spikes, Price moves
- Creates: monitoring_triggers
- Triggers: analyze-full (8 agents)
- Output: Telegram signals with analysis

### 2. Position Monitor Process
- Monitors: Active positions (waiting_entry, in_position)
- Checks: Target prices (T1/T2/T3), Stop-loss
- Updates: active_strategies (targets_hit, status)
- Calls: notify-strategy-event (HTTP)
- Output: Telegram notifications (Target hit, Stop-loss hit)

## Log Prefixes

- `[CONFIG]` - Configuration loading
- `[MONITOR]` - WebSocket connection status
- `[TRIGGER]` - Scanner detections (volume/price)
- `[POSITION]` - Position monitor events
  - 🎯 - Target hit
  - ⚠️ - Stop-loss hit
  - ✓ - Success operations

## Environment Variables

Required:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anon key

## Database Integration

### Reads From:
- `system_config` (scanner_status, monitored_pairs)
- `active_strategies` (for position monitoring)

### Writes To:
- `monitoring_triggers` (scanner detections)
- `active_strategies` (position updates)

### Calls:
- `notify-strategy-event` Edge Function (HTTP POST)

## Deployment on Railway

1. Connect this repository to Railway
2. Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
3. Railway will automatically build and deploy

## Local Development

```bash
npm install
npm run dev
```

## Position Monitor Details

### Reload Interval
- Reloads strategies every 15 seconds
- Only logs changes (avoids spam)
- Groups strategies by symbol

### Price Checking
- EPSILON: 0.1% tolerance (0.001)
- Checks all targets simultaneously (supports price jumps)
- Separate logic for LONG vs SHORT

### Target Detection (LONG)
```
T1: price >= target_1 * 0.999
T2: price >= target_2 * 0.999
T3: price >= target_3 * 0.999
```

### Target Detection (SHORT)
```
T1: price <= target_1 * 1.001
T2: price <= target_2 * 1.001
T3: price <= target_3 * 1.001
```

### Stop-Loss Detection (LONG)
```
SL: price <= stop_loss * 1.001
```

### Stop-Loss Detection (SHORT)
```
SL: price >= stop_loss * 0.999
```

### Database Updates
- `targets_hit`: Incremental (1 → 2 → 3)
- `status`: Changes to 'completed' or 'stopped'
- `current_price`: Always updated
- `last_check_at`: Timestamp of check

### HTTP Call to Edge Function
```typescript
POST {SUPABASE_URL}/functions/v1/notify-strategy-event
Authorization: Bearer {SUPABASE_ANON_KEY}
Body: {
  strategy_id, event_type, symbol, position_type,
  current_price, targets, stop_loss, status, label
}
```

## Monitoring

Service logs will show:
- Connection status
- Scanner detections ([TRIGGER])
- Position updates ([POSITION])
- Strategy loading ([POSITION])
- Telegram notifications sent

## Version

2.0.0 - Added Position Monitor

## Changes from v1.0

- Added `PositionMonitor` class (~350 lines)
- Added `ActiveStrategy` interface
- Integrated with `BinanceMonitor`
- Added HTTP calls to Edge Function
- Added parallel monitoring processes
- Improved logging with prefixes

## Testing

### Test Scanner:
1. Wait for volume spike or price move
2. Check logs: `[TRIGGER]` messages
3. Check database: `monitoring_triggers` table
4. Check Telegram: Signal received

### Test Position Monitor:
1. Create strategy via Dashboard
2. Check logs: `[POSITION] Loaded X strategies`
3. Wait for target hit
4. Check logs: `[POSITION] 🎯 Target X HIT!`
5. Check database: `targets_hit` updated
6. Check Telegram: Notification received

## Troubleshooting

**Position Monitor not loading strategies:**
- Check `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Check database has strategies with status 'waiting_entry' or 'in_position'
- Check logs for `[POSITION]` messages

**Targets not hitting:**
- Check EPSILON value (0.001 = 0.1%)
- Check price vs target in logs
- Check strategy.position_type (LONG vs SHORT)

**Telegram not sending:**
- Check Edge Function `notify-strategy-event` deployed
- Check logs for HTTP errors
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Supabase

## License

MIT
