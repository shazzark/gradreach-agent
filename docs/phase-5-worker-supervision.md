# Phase 5 — Worker supervision and heartbeat (R8)

Date: 2026-11-20
Audit items: `AUDIT.md` A-06 ("Outbound sending has no supervised runtime") and `R8` ("Add worker supervision +
heartbeat for `outreach:scheduler` and surface it in `outreach-runtime-status.ts`").

## Problem

Both schedulers are long-running terminal scripts:

- `npm run outreach:scheduler` → `src/interfaces/outreach-scheduler.ts` (polls every 60 seconds)
- `npm run discovery:scheduler` → `src/interfaces/discovery-scheduler.ts` (polls every 60 seconds)

If the process crashes, the terminal is closed, or a deployed supervisor never restarts it, the website keeps
rendering "enabled and unpaused" while nothing is delivered. There was no way to tell a healthy worker from an
absent one by looking at `/outreach`.

## What the heartbeat is

| Element | Value |
|---|---|
| Collection | `scheduler_heartbeat` (created lazily by the first write; no migration step) |
| Document id | `scheduler-heartbeat:outreach` and `scheduler-heartbeat:discovery` |
| Field | `lastHeartbeatAt` — ISO 8601 string of the tick that wrote it (plus the adapter's `updatedAt`) |
| Written | `pulseSchedulerHeartbeat(...)` at the **start** of every 60-second tick, before any delivery attempt or search |
| Stale threshold | `SCHEDULER_HEARTBEAT_STALE_MS = 120_000` (two minutes, i.e. two missed ticks) |
| Failure behaviour | The write is attempted in a try/catch; a failure prints one line to stderr and the loop continues |

Pieces:

- `src/domain/scheduler-heartbeat.ts` — pure classification (`schedulerHeartbeatStatus`) and the threshold constant.
- `src/infrastructure/mongo-storage.ts` — `SchedulerHeartbeatRepository.updateSchedulerHeartbeat(worker, at?)` and
  `getSchedulerHeartbeat(worker)`. An unknown worker name is rejected before any document is written.
- `src/interfaces/scheduler-heartbeat-pulse.ts` — `pulseSchedulerHeartbeat(writer, worker, now)`, the only code that
  turns a heartbeat failure into a log line instead of an exception.
- `src/web/outreach-runtime-status.ts` — `getOutreachRuntimeStatus` gained the `worker_down` state.

Each worker writes **its own** document. A single shared document would let a live discovery worker hide a dead
outreach worker, which is exactly the failure the owner needs to see on `/outreach`.

## What the website shows

`getOutreachRuntimeStatus({ sendingEnabled, control, heartbeat, now })` evaluates in this order:

1. `disabled` — `OUTREACH_SENDING_ENABLED` is not `true`. The worker is *supposed* to exit, so a stale heartbeat is
   not reported as an outage.
2. `worker_down` — sending is enabled and the stored heartbeat is `missing` (worker never ran on this deployment) or
   `stale` (older than two minutes). A heartbeat exactly two minutes old still counts as live.
3. `paused` — enabled, worker alive, pause control set.
4. `armed` — enabled, unpaused, worker checked in within the last two minutes.

`worker_down` is checked before `paused` on purpose: a paused queue with a dead worker silently delivers nothing the
moment the owner resumes it, so the dead supervisor is the more urgent fact. `/outreach` renders a red banner with
`role="alert"`:

> **Worker is not running. Please start the scheduler process.**
> The last scheduler heartbeat was recorded 7 minutes ago, so the worker loop has stopped. Start the outreach worker
> process and check `docs/phase-5-worker-supervision.md`.

The delivery-safeguards panel reuses the same label/detail. The banner disappears on the next page load after the
worker's next tick.

Deployment note: the website reads this collection through the same MongoDB connection it already uses. Deploy the
worker and the website together — a website newer than the worker will correctly show `worker_down` until the worker's
first tick writes a heartbeat.

## Supervision recipes

All three recipes assume the repository is checked out at a fixed path and `.env` (or the supervisor environment)
provides `MONGODB_URI`, `MONGODB_DATABASE`, `OUTREACH_SENDING_ENABLED=true`, and, for discovery,
`GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true`. Both workers load `.env` themselves, and a real OS-level environment
variable wins over `.env`, so a supervisor may supply either.

Keep **one** instance of each worker. Delivery is idempotent through the attempt claim, but two processes only double
the polls, the logs, and the chance of overlapping provider calls.

### Windows Task Scheduler (owner's platform)

Create one task per worker, running whether or not the owner is signed in, restarted on failure, with no time limit:

```powershell
$repo = 'C:\Users\chido\Developer\gradreach-agent'
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node `
  -Argument '--experimental-strip-types src/interfaces/outreach-scheduler.ts' `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -DontStopOnIdleEnd
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
Register-ScheduledTask -TaskName 'GradReach outreach worker' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description 'Polls approved outreach drafts every 60 seconds.'
```

Then:

```powershell
Start-ScheduledTask -TaskName 'GradReach outreach worker'
Get-ScheduledTaskInfo -TaskName 'GradReach outreach worker'   # LastRunTime / LastTaskResult
```

Repeat with `discovery-scheduler.ts` and the task name `GradReach discovery worker`. Notes:

- `-AtStartup` plus `-RestartCount 999` covers both a reboot and a crash; an unlimited execution time prevents Task
  Scheduler from killing a process that is meant to run forever.
- `-LogonType S4U` runs without a stored password but has no network drive access; keep the repository and `.env` on
  the local disk (the current setup).
- Task Scheduler does not capture stdout/stderr. Wrap the command in `powershell.exe` with a shell redirect if the
  lines are wanted in a file. The heartbeat, not the log, is the signal the website reads.
- Verify with `(Get-ScheduledTask -TaskName 'GradReach outreach worker').State` and by confirming the
  `scheduler_heartbeat` document advances.

### systemd (Linux host / small VM)

`/etc/systemd/system/gradreach-outreach.service`:

```ini
[Unit]
Description=GradReach outreach worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gradreach
WorkingDirectory=/srv/gradreach-agent
EnvironmentFile=/srv/gradreach-agent/.env
Environment=OUTREACH_SENDING_ENABLED=true
ExecStart=/usr/bin/node --experimental-strip-types src/interfaces/outreach-scheduler.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gradreach-outreach
systemctl status gradreach-outreach
journalctl -u gradreach-outreach -f
```

Copy the unit to `gradreach-discovery.service` with `Environment=GRADREACH_DISCOVERY_SCHEDULER_ENABLED=true` and the
discovery entry point. `Restart=always` is safe: neither worker exits on its own while enabled, so any exit is a
failure worth restarting.

### PM2 (any platform, extra dependency)

PM2 is not a project dependency; install it globally only if the owner accepts that extra tool.

```bash
pm2 start --name gradreach-outreach --interpreter node \
  --node-args '--experimental-strip-types' src/interfaces/outreach-scheduler.ts
pm2 start --name gradreach-discovery --interpreter node \
  --node-args '--experimental-strip-types' src/interfaces/discovery-scheduler.ts
pm2 save
pm2 startup          # prints the command that re-registers the list after a reboot
pm2 logs gradreach-outreach
```

PM2 restarts on crash by default and keeps a restart count per process, which doubles as a supervision log. It does
not repair a machine that is off; pair it with an always-on host.

### Checking health without the website

```bash
node --experimental-strip-types -e "import('./src/infrastructure/mongo-storage.ts').then(async ({ connectMongoStorage }) => { const storage = await connectMongoStorage(); console.log(await storage.repositories.schedulerHeartbeat.getSchedulerHeartbeat('outreach')); await storage.close(); })"
```

An absent document or a timestamp older than two minutes means the worker is not running.

## What this does not do

- No alerting channel. The banner is a pull signal: it is visible when the owner opens `/outreach`. Email, SMS, or
  push alerting is out of scope for R8 and would need a provider decision.
- No restart-on-stale logic. The website never starts, stops, or restarts a worker; it only reports.
- No change to the daily sending cap (five per configured local day), the discovery limits, or provider backoff.
- The discovery heartbeat is recorded for the same supervision purpose, but only `/outreach` renders it today. A
  `/discovery` banner is a possible follow-up, not part of this change.

## Verification

- `npm run typecheck` — exit 0.
- `npm test` — see `deepseek.md` Batch 5 for the exact counts; the suite stays green and the opt-in MongoDB test
  remains skipped without `RUN_MONGODB_INTEGRATION`/`MONGODB_TEST_URI`.
- `test/scheduler-heartbeat.test.ts` — threshold boundary, missing/unreadable heartbeat, clock skew, invalid
  reference time, per-worker document ids, unknown-worker and invalid-timestamp rejection, pulse success and the
  swallowed failure path.
- `test/outreach-runtime-status.test.ts` — `worker_down` for stale and never-recorded heartbeats, the two-minute
  boundary, dead-worker-before-pause ordering, and the existing gate states.
- `test/outreach-scheduler.test.ts` / `test/discovery-scheduler.test.ts` — each gate still returns before connecting
  (`OUTREACH_SENDING_ENABLED`, `GRADREACH_DISCOVERY_SCHEDULER_ENABLED`), and the loop records its heartbeat before
  the delivery attempt / discovery cycle.
- `test/mongo-storage.integration.test.ts` — adds the `scheduler_heartbeat` round trip; runs only with
  `npm run test:mongodb` against an isolated database.
- No worker was started, no heartbeat was written to a live database, and no guard changed for this record. The
  banner has not been observed in a running deployment.
