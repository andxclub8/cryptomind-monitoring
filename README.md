# CryptoMind AI - Railway Monitoring Service v3.2.0

Real-time cryptocurrency market monitoring service for CryptoMind AI trading system.

## What's New in v3.2.0

### ðŸ›¡ï¸ Circuit Breaker (Flash Crash Protection)
- Detects extreme price movements (>5% in 15 minutes)
- Automatically blocks new triggers for affected symbols
- Sends Telegram alerts when activated
- 30-minute cooldown before resuming

### ðŸ”§ Improved Reliability
- Retry logic for database trigger invocations
- Better error handling and logging
- Performance index optimizations

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                     Railway Container                        â”‚
â”‚                                                              â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”               â”‚
â”‚  â”‚  Scanner        â”‚     â”‚  Position       â”‚               â”‚
â”‚  â”‚  Process        â”‚     â”‚  Monitor        â”‚               â”‚
â”‚  â”‚                 â”‚     â”‚                 â”‚               â”‚
â”‚  â”‚  â€¢ Volume spikesâ”‚     â”‚  â€¢ T1/T2/T3     â”‚               â”‚
â”‚  â”‚  â€¢ Price moves  â”‚     â”‚  â€¢ Stop Loss    â”‚               â”‚
â”‚  â”‚  â€¢ Circuit      â”‚     â”‚  â€¢ Telegram     â”‚               â”‚
â”‚  â”‚    Breaker      â”‚     â”‚    notificationsâ”‚               â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜               â”‚
â”‚           â”‚                       â”‚                         â”‚
â”‚           â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                         â”‚
â”‚                       â”‚                                      â”‚
â”‚           â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”                         â”‚
â”‚           â”‚  Binance Futures      â”‚                         â”‚
â”‚           â”‚  WebSocket            â”‚                         â”‚
â”‚           â”‚  wss://fstream...     â”‚                         â”‚
â”‚           â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                         â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                        â”‚
                        â–¼
              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚    Supabase     â”‚
              â”‚    Database     â”‚
              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## Features

### Scanner Process
- **Volume Spike Detection**: Triggers when 24h volume exceeds 120% of baseline
- **Price Movement Detection**: Triggers on >0.5% moves in 5-minute window
- **Circuit Breaker**: Blocks triggers if price moves >5% in 15 minutes
- **Dynamic Pair Management**: Reloads monitored pairs every 60 seconds

### Position Monitor
- **Target Tracking**: Monitors T1, T2, T3 levels with 0.1% tolerance
- **Stop Loss Monitoring**: Tracks stop loss for both LONG and SHORT positions
- **Price Jump Handling**: Can detect multiple targets hit simultaneously
- **Telegram Notifications**: Sends alerts via Edge Function

## Environment Variables

Required in Railway dashboard:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
```

## Deployment

### Automatic (Recommended)
1. Push to `main` branch on GitHub
2. Railway auto-detects changes
3. Builds TypeScript â†’ JavaScript
4. Restarts container

### Manual
```bash
# Build
npm run build

# Start
npm start
```

## Database Requirements

Before deploying v3.2.0, run the SQL migration:

```sql
-- See migrations/v3.2.0_circuit_breaker.sql
```

This creates:
- `circuit_breaker_state` table
- Improved trigger function with retry logic
- Performance indexes

## Configuration

Settings are stored in `system_config` table:

| Key | Default | Description |
|-----|---------|-------------|
| `scanner_status` | `"stopped"` | Scanner state ("running" or "stopped") |
| `monitored_pairs` | `[]` | Array of pairs to monitor |
| `volume_spike_threshold` | `1.20` | 120% of baseline triggers volume spike |
| `price_move_threshold` | `0.005` | 0.5% triggers price movement |
| `circuit_breaker_config` | `{...}` | Circuit breaker settings |

### Circuit Breaker Config

```json
{
  "threshold_percent": 5,
  "window_minutes": 15,
  "cooldown_minutes": 30
}
```

## Logs

View logs in Railway dashboard â†’ Service â†’ Logs

Log categories:
- `[CONFIG]` - Configuration loading/changes
- `[MONITOR]` - WebSocket status
- `[TRIGGER]` - Trigger creation
- `[CIRCUIT_BREAKER]` - Flash crash protection
- `[POSITION_MONITOR]` - Strategy monitoring

## Troubleshooting

### Service not starting
1. Check environment variables in Railway dashboard
2. Verify Supabase URL is accessible
3. Check logs for connection errors

### Triggers not creating
1. Verify `scanner_status` is "running"
2. Check `monitored_pairs` is not empty
3. Look for circuit breaker blocks
4. Check trigger cooldown (5 minutes per symbol/type)

### Circuit Breaker always active
1. Check `circuit_breaker_state` table
2. Run cleanup: `SELECT cleanup_expired_circuit_breakers();`
3. Verify price data is correct

### WebSocket disconnecting
- Auto-reconnect after 5 seconds
- Check Binance API status
- Verify Railway outbound network

## Version History

### v3.2.0 (Current)
- Added Circuit Breaker for flash crash protection
- Improved trigger function with retry logic
- Added performance indexes

### v3.1.0
- Added Position Monitor
- Telegram notifications for targets
- Dynamic pair management

### v3.0.0
- Initial Railway integration
- Volume and price trigger detection
- Database trigger architecture

## Files

```
cryptomind-monitoring/
â”œâ”€â”€ src/
â”‚   â””â”€â”€ index.ts          # Main service (all-in-one)
â”œâ”€â”€ migrations/
â”‚   â””â”€â”€ v3.2.0_circuit_breaker.sql
â”œâ”€â”€ package.json
â”œâ”€â”€ tsconfig.json
â””â”€â”€ README.md
```

## License

Proprietary - CryptoMind AI
