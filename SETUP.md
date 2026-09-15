# Mellow — installing it on the PC

The PC hosts everything: the engine that decides, the client that enforces, and
the dashboard. A Mac, if you add one later, is a thin client over the same
endpoint.

```
   ┌────────────────────────────┐   Tailscale   ┌──────────────┐
   │  PC (host)                 │ ◄───────────► │     Mac      │
   │                            │               │              │
   │  engine  - decides         │               │  client only │
   │  client  - enforces        │               │              │
   │  agent   - notifies        │               │              │
   │  dashboard                 │               │              │
   └────────────────────────────┘               └──────────────┘
        one source of truth                       thin client
```

## Why the PC hosts

Something has to be canonical. If both machines can write "I read my book
today", the history file can disagree with itself and the verification argument
collapses. One engine, one history file, one truth.

The PC wins because it is on when you are not there. A system that stops
watching when you close your laptop is one you learn to evade by closing your
laptop.

**The gap this leaves:** PC off or asleep, no engine. `failClosed` covers it for
any other machine, but it is real. Step 2 below is about not creating that gap.

---

## The fast path

From an **Administrator** PowerShell, in this folder:

```
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

It checks Node, stops the PC sleeping, offers Tailscale, runs both test suites,
shows you a dry run, and registers the boot tasks. It does **not** turn
enforcement on — `dryRun` stays `true` until you change it yourself.

The rest of this file is the same thing, by hand, with the reasoning.

---

## 1. Node

Install the LTS from nodejs.org. Nothing else. Both halves are dependency-free.

## 2. Power settings — do this before anything else

A PC that sleeps is a PC that is not hosting.

```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Leave the display timeout alone. The screen turning off is fine; the machine
suspending is not.

## 3. Your tasks

Edit `engine/tasks.json`. Three examples ship in it — a daily reading habit, a
weekday email sweep that demands a written note, and a move-every-two-days.
Delete what you will not do. A ladder you do not believe in is worse than none,
because the first time you override it you have learned that you can.

Start the engine and look at the dashboard before going any further:

```
node engine/engine.js
```

http://localhost:7777/

## 4. What a group means on this machine

Edit `config.json`. `groups.distractions` and `groups.games` are where the real
app names go.

- `processes` takes image names — `Discord.exe`.
- `firewall` takes full paths — `D:\Steam\steam.exe`. A path that does not exist
  is skipped with a warning, so a stale entry degrades rather than breaks.
- `domains` are shared across platforms, because a website is a website.

`safety.neverBlock` is a hard allowlist that wins over everything, even
`shield_all`. Keep one browser in it so you can always reach the dashboard and
spend a pass.

## 5. Test before arming it

```
node engine/test-engine.js        45 tests - when things get blocked
node test-logic.js                27 tests - what gets blocked

node mock-server.js shield_all    one window
node ratchet-client.js --once     another
```

The mock forces the worst case so you can see the full block list at once. Read
the DRY lines. Set `safety.dryRun` to `false` only when they are right.

## 6. Boot tasks

Administrator PowerShell:

```
powershell -ExecutionPolicy Bypass -File .\install\install-engine-task.ps1
powershell -ExecutionPolicy Bypass -File .\install\install-task.ps1
Start-ScheduledTask -TaskName Ratchet-Engine
Start-ScheduledTask -TaskName Mellow
```

Both run as SYSTEM so a standard-user session cannot stop them.

## 7. Notifications — from a NORMAL window

Not elevated. This one matters: a task registered by the admin account runs in
the admin account's session, and you will never see a single toast.

```
powershell -ExecutionPolicy Bypass -File .\install\install-notify-task.ps1
Start-ScheduledTask -TaskName Ratchet-Notify
node ratchet-client.js --test-notify
```

The installer also registers a toast app id under `HKCU` so notifications say
"Mellow". Windows silently declines to draw a toast from an app id it does not
recognise, which is a fun afternoon to lose.

## 8. The account split

See the section in [README.md](README.md#making-it-hard-to-escape). Short
version, in this order:

```
powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -CreateAdmin
```

Sign out. Sign in as the new account. Prove the password works. Then from there:

```
powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -MakeStandard <your-name>
```

The script refuses to demote your only administrator, and refuses to demote the
account you are currently signed into. Both refusals are load-bearing.

---

## Adding a Mac later

1. Tailscale on both machines, same account.
2. On the PC, set `engine/engine-config.json` `bindHost` to the PC's Tailscale
   address, **and set a `token` in the same edit**.
3. Copy this folder to the Mac. Set `server.url` in the Mac's `config.json` to
   `http://<pc-tailscale-name>:7777/api/enforcement`.
4. `sudo bash install/install-launchd.sh`

### What differs between the two machines

| | Windows | macOS |
|---|---|---|
| Block sites | hosts file | hosts file |
| Block an app's network | Firewall rule per `.exe` | **Not available** |
| Close an app | `taskkill` | graceful quit, then `pkill` |
| Runs at boot as | SYSTEM (scheduled task) | root (launchd) |
| Notifications | WinRT toast via a user agent | `osascript` |

**The macOS gap is real.** Apple's firewall only blocks incoming connections and
pf rules cannot target an app, so there is no equivalent of "Steam opens but
cannot connect". It just gets quit. Two layers instead of three.

---

## Break glass

```
node ratchet-client.js --clear     remove every block (needs admin)
node ratchet-client.js --status    show what is currently applied
```

Stopping the client does **not** clear the shield. That is deliberate — closing
the app should not be an exit.

---

## Next: the part that handles forgetting

Everything here addresses procrastination. It does nothing for the second
problem, and enforcement is the wrong tool for that one — blocking Steam over an
assignment you never wrote down punishes a capture failure with an avoidance
remedy, which is how you stop trusting the system.

That needs the email phase: three Gmail accounts plus calendar, scanned on a
schedule, with anything carrying a deadline or awaiting your reply written into
`engine/tasks.json` automatically.

The structural rule it needs is already built and tested: **auto-captured tasks
arrive with `confirmed: false`, which caps them at `persistent` no matter what
their ladder says.** They can nag. They cannot take your machine away until you
have confirmed one once.
