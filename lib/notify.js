'use strict';
/**
 * notify.js - Windows toast notifications with no third-party packages.
 *
 * Three things make this harder than it looks, and all three are handled here:
 *
 *   1. The WinRT XmlDocument type has to be loaded explicitly. Loading only
 *      ToastNotificationManager throws "cannot find type" the moment you build
 *      the document.
 *   2. A toast needs an AppUserModelID that Windows already knows about, or it
 *      is accepted and then never drawn. The agent registers "Mellow" under
 *      HKCU on first run; until then we borrow PowerShell's own ID.
 *   3. powershell -Command re-parses its argument, which mangles the toast XML.
 *      -EncodedCommand takes the script verbatim, so the quoting stops mattering.
 *
 * The other trap is the deployment itself. The scheduled task runs as SYSTEM,
 * in session 0, where a toast is drawn to nobody. So when we detect SYSTEM we
 * do not show anything - we drop the notification in a queue directory and let
 * the per-user agent (ratchet-client.js --notify-agent) draw it in the session
 * where you can actually see it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, isWindows, info, dry, warn } = require('./util');

// Registered by install/install-notify-task.ps1. PowerShell's own ID is the
// fallback: less pretty, but always present.
const RATCHET_AUMID = 'Ratchet.Enforcement';
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

function psEscape(s) {
  // Single-quoted PowerShell strings escape ' by doubling it.
  return String(s).replace(/'/g, "''");
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * True when this process is the SYSTEM account, which cannot draw to the
 * desktop. SYSTEM's profile path is the giveaway and does not vary.
 */
function isSystemAccount() {
  if (!isWindows()) return false;
  const profile = (process.env.USERPROFILE || '').toLowerCase();
  if (profile.includes('config\\systemprofile')) return true;
  try {
    return os.userInfo().username.toLowerCase() === 'system';
  } catch (_) {
    return false;
  }
}

function buildScript(title, body) {
  const t = psEscape(xmlEscape(title));
  const b = psEscape(xmlEscape(body));
  return `
$ErrorActionPreference = 'Stop'
$xmlText = '<toast><visual><binding template="ToastGeneric"><text>${t}</text><text>${b}</text></binding></visual></toast>'
$ids = @('${RATCHET_AUMID}', '${psEscape(PS_AUMID)}')
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$doc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]::new()
$doc.LoadXml($xmlText)
foreach ($id in $ids) {
  try {
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)
    exit 0
  } catch { }
}
exit 3`.trim();
}

/**
 * Windows 10 Home has no msg.exe - that is a Terminal Services component and
 * ships only on Pro and above. A balloon from a tray icon works everywhere and
 * needs nothing installed.
 */
function buildBalloonScript(title, body) {
  const t = psEscape(title);
  const b = psEscape(body);
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Warning
$icon.Visible = $true
$icon.BalloonTipTitle = '${t}'
$icon.BalloonTipText = '${b}'
$icon.ShowBalloonTip(20000)
Start-Sleep -Seconds 12
$icon.Dispose()`.trim();
}

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/* ------------------------------ SYSTEM queue ----------------------------- */

function queueDir(cfg) {
  // cfg here is the notifications section (that is all notify() is handed),
  // which loadConfig stamps with the resolved path.
  return cfg?.notifyQueue || cfg?.paths?.notifyQueue || path.join(__dirname, '..', 'notify-queue');
}

/** SYSTEM cannot draw a toast, so it leaves one for the agent to draw. */
function enqueue(title, body, cfg) {
  const dir = queueDir(cfg);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ title, body, at: new Date().toISOString() }));
    info(`notify: queued for the desktop agent - ${title}`);
  } catch (e) {
    warn(`notify: could not queue notification (${e.message})`);
  }
}

/**
 * Drain the queue and show whatever is in it. Called by --notify-agent.
 * Anything older than an hour is dropped rather than shown late.
 */
async function drainQueue(cfg) {
  const dir = queueDir(cfg);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (_) {
    return 0;
  }

  let shown = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    let item;
    try {
      item = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_) {
      try { fs.unlinkSync(full); } catch (_) {}
      continue;
    }
    try { fs.unlinkSync(full); } catch (_) {}

    const ageMin = (Date.now() - new Date(item.at).getTime()) / 60000;
    if (ageMin > 60) continue;

    await showNow(item.title, item.body);
    shown++;
  }
  return shown;
}

/* -------------------------------- showing -------------------------------- */

async function showNow(title, body) {
  const res = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encode(buildScript(title, body)),
  ]);
  if (res.ok) return;

  warn('Toast failed, falling back to a tray balloon.');
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encode(buildBalloonScript(title, body)),
  ], { timeout: 30000 });
}

/**
 * Show a notification. Never throws.
 */
async function notify(title, body, cfg) {
  if (!cfg || cfg.enabled === false) return;

  if (process.platform === 'darwin') {
    const esc = (s) => String(s).replace(/"/g, '\\"');
    const res = await run('osascript', [
      '-e', `display notification "${esc(body)}" with title "${esc(title)}"`,
    ]);
    if (!res.ok) warn(`macOS notification failed: ${res.stderr.trim()}`);
    return;
  }

  if (!isWindows()) {
    dry(`NOTIFY :: ${title} - ${body}`);
    return;
  }

  if (isSystemAccount()) {
    enqueue(title, body, cfg);
    return;
  }

  await showNow(title, body);
}

/**
 * Turn the server's reasons array into one readable line.
 */
function summarise(payload, stale) {
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
  if (reasons.length === 0) return stale ? 'Shield held (server unreachable).' : 'Something is overdue.';

  const first = reasons[0];
  const extra = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : '';
  // The engine warns before deadlines now, so a reason is either late or
  // coming up. "Overdue" on something due tomorrow would be a lie.
  const when = first.overdueFor ? ` - overdue ${first.overdueFor}`
    : first.dueIn ? ` - due in ${first.dueIn}` : '';
  const fix = first.clearedBy ? ` ${first.clearedBy}.` : '';
  return `${first.title || 'Task'}${when}${extra}.${fix}`;
}

module.exports = { notify, summarise, drainQueue, isSystemAccount, queueDir };
