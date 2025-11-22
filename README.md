# CryptoMind AI - Monitoring Service

WebSocket monitoring service for real-time cryptocurrency market analysis.

## Features

- 24/7 WebSocket connection to Binance
- Real-time volume spike detection
- Real-time price move detection (5-min window)
- Automatic baseline tracking
- Triggers CryptoMind AI analysis on market events

## Environment Variables

Required:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anon key
- `MONITORED_SYMBOLS` - Comma-separated list (e.g., "BTCUSDT,ETHUSDT,BNBUSDT")

## Deployment on Railway

1. Connect this repository to Railway
2. Add environment variables
3. Railway will automatically build and deploy

## Local Development
```bash
npm install
npm run dev
```

## Architecture
```
Binance WebSocket → Monitoring Service → Supabase Edge Function (analyze-full)
                                      ↓
                                 Database (monitoring_triggers)
```

## Monitoring

Service logs will show:
- Connection status
- Baseline initialization
- Trigger detection
- Analysis invocation

## Version

1.0.0
