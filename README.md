# Peeap Terminal

Vendor-agnostic merchant-terminal control plane for Peeap. Production at **https://terminal.peeap.com**.

Currently implements the HEMI Y68 / soundbox device family via cloud-speaker.com. Naming convention:
- **Public domain + Vercel project + repo** are vendor-agnostic (`terminal.peeap.com`, `peeap-terminal`).
- **Code, env vars** are vendor-specific (`lib/handlers/hemi.ts`, `HEMI_USER_TOKEN`, `HEMI_BASE_URL`).
- When a second vendor lands (Sunmi etc.), add `lib/handlers/sunmi.ts` and `SUNMI_*` env vars alongside — the public surface stays put.

Split out of the main Peeap API (`Card/api-deploy/`) for deploy isolation: a payments deploy can no longer break a terminal, and a terminal deploy cannot break payments.

## What's in here

- `api/router.ts` — single Vercel function entry point dispatching all routes
- `lib/handlers/hemi.ts` — claim, release, update, end-shift, bind-event, factory-reset, cron, audio, asset review
- `lib/handlers/event-gate.ts` — `/api/events/gate-verify` for the device-scan ticket validation flow
- `lib/services/device-reconciler.ts` — single source of truth for what a device should be displaying. Idempotent. Called by every mutation handler and the fleet-ping cron.
- `lib/services/rate-limit.ts` — Postgres-backed fixed-window limiter shared with the main API (same `rate_limit_buckets` table)
- `lib/_shared.ts` — trimmed to just `supabase`, `getAuthenticatedUserId`, `logAlert`, `getClientIp`. Duplicates the equivalents in `Card/api-deploy/lib/_shared.ts`. When auth changes, change in both.
- `migrations/` — HEMI / event-gate schema migrations (`001` to `009`)

## Why share Card's Supabase

Unlike `peeap-pos` / `peeap-cards` (which each have their own Supabase project), Terminal must share Card's Supabase because:
- `merchant_devices`, `events`, `event_tickets`, `merchant_terminal_assets` all live there
- Auth runs through `sso_tokens` issued by the main API

So this service has its own deploy lifecycle but reads/writes the same tables as `api.peeap.com`.

## Required env vars

| Var | Source |
|-----|--------|
| `SUPABASE_URL` | same as Card |
| `SUPABASE_SERVICE_KEY` | same as Card |
| `SUPABASE_ANON_KEY` | same as Card |
| `HEMI_USER_TOKEN` | cloud-speaker.com session token (auto-refreshed) |
| `HEMI_LOGIN_ACCOUNT` | cloud-speaker login |
| `HEMI_LOGIN_PASSWORD` | cloud-speaker password |
| `FRONTEND_URL` | `https://my.peeap.com` (used in claim + gate URLs painted on devices) |
| `CRON_SECRET` | bearer token for `/api/cron/hemi-ping` |

## Local dev

```bash
npm install
npm run typecheck
```

## Deploy

Connected to Vercel project `peeap-terminal`, served at `terminal.peeap.com`. Production deploys via:

```bash
npx vercel --prod --yes
```

Smoke test after deploy:
```bash
curl https://terminal.peeap.com/api/health
# {"ok":true,"service":"peeap-terminal"}
```

## Self-healing

Every 5 minutes the cron `/api/cron/hemi-ping`:
1. Pulls the entire fleet's state from cloud-speaker
2. Bulk-writes fresh `cloud_state` to `merchant_devices`
3. Calls the reconciler for every online device

If a device's screen drifts from its DB state — paint failed, manual SQL change, missed handler call — it self-corrects within one tick. No SQL, no support intervention.

## Customer escape hatch

`POST https://terminal.peeap.com/api/hemi/devices/:sn/factory-reset` — auth required, allowed when device is unowned OR caller is owner. Routes through the reconciler. Surface this in the merchant Terminal UI as a "Force reset" button so a stuck merchant fixes themselves in one tap.

## Future: vendor-agnostic routes

Routes today are `/api/hemi/*` (vendor-prefixed). Migration path when a second vendor arrives:

1. Mount `/api/terminal/*` alias dispatching to the same handlers.
2. Update `apps/web` clients to call `/api/terminal/*`.
3. Drop `/api/hemi/*` after a soak period.

Until then, vendor-agnosticism is honoured at the *domain* layer (`terminal.peeap.com`) and *implementation* boundary; routes will catch up when the trigger arrives.
