# Mellow — start here

Mellow is a personal dashboard for school and life: your calendar by day, week
or month, homework and exams pulled from your email, today's news, your money,
a Files library that sorts whatever you drop into folders and suggests dates to
add, and an assistant you can ask to add things or change how the app works. It runs
on your own computer. Nothing about you is sent anywhere unless you connect it.

It was made by a friend, for themselves, and shared with you to use for free.
You can change it however you like. You can't sell it: see `LICENSE.txt`.

---

## 1. Run it (five minutes)

1. Install **Node.js** (the LTS version) from [nodejs.org](https://nodejs.org).
2. Unzip this folder somewhere it can stay, like `Documents/Mellow`.
3. Start it:
   - **Windows:** double-click **`start-ratchet.cmd`**. If Windows says it
     protected your PC, click More info, then Run anyway.
   - **Mac:** double-click **`start-ratchet.command`**. If your Mac won't open
     it, go to System Settings → Privacy & Security → Open Anyway.
   - **Linux:** `bash start-ratchet.command` in a terminal.

Your browser opens **http://localhost:7777/**. That's Mellow. Leave the window
that opened running while you use it; closing it stops Mellow.

**Then open the Guide** (the last section, or press `9`). It checks what you've
set up, lets you add your name, and walks you through everything below with
exact steps for your computer, your iPhone, iPad or Android phone.

## 2. Connect your Google accounts (optional, 20 minutes, once)

This is what fills in your classes, deadlines and emails waiting on a reply.
Google makes every app that reads Gmail get its own sign-in client, so you
make your own (it's free): follow **`GOOGLE-SETUP.md`**, then press Connect on
the Accounts page. Mellow can read your mail and calendar; it can't send,
delete or change anything.

## 3. Turn on the AI (optional)

Dropping files (a syllabus, a flyer, a screenshot of your schedule) and the
assistant use Claude, with **your own** Anthropic API key:

1. Make a key at [console.anthropic.com](https://console.anthropic.com/settings/keys) and add a little credit.
2. In Mellow, Accounts → AI → paste the key → Save.
3. Set a monthly limit. Mellow stops sending anything once it is spent.

Without a key everything else still works, and `.ics` calendar files and bank
`.csv` exports are still read, on your computer.

**Your money stays private by default.** On the Finance page, under Privacy,
you choose which parts Claude may see. Card numbers, account numbers and Social
Security numbers are masked in anything Mellow sends. Each Finance tab has a
**What to drop** button that says which file to use and what to cover first.

**Subscriptions find themselves.** With a key and Gmail connected, Mellow reads
receipt, renewal, trial and cancellation emails and keeps Finance → Subscriptions
current: what you pay, from which card or account, when each renews, and every
charge. New ones wait for you to confirm. Turn it off under Finance → Privacy.

## 4. The blocking part (optional, and off)

Mellow can also block distracting apps and sites when something is overdue.
That part is **off**: `config.json` ships with `"dryRun": true`, so it only
logs what it would block. If you want it, read `SETUP.md` first. It needs an
administrator PowerShell and is deliberately hard to switch off again.

---

## Things to know

- **Everything stays in this folder.** Your tasks, history, finances,
  conversations and dropped files are plain files in `engine\`. Back up the
  folder to keep them; delete it to remove everything.
- **The assistant asks first.** It can look at your schedule, tasks and news
  on its own, but every change (an event, a bill, an edit to the app) shows you
  exactly what will change and waits for Approve. App changes can be undone.
- **Make it yours, and go back any time.** Ask the assistant to change how
  Mellow looks or works. Accounts → Versions keeps **Original** (Mellow as it
  came to you), and you can save your own versions before trying something big.
  Going back only changes the app's code, never your tasks, money or health log.
- **Talk to it.** Press **Ctrl + Space** (or the mic in the assistant panel),
  say what you need, and it answers out loud. Say "stop" when you're done.
  Works in Chrome or Edge on the computer running Mellow.
- **Health.** Log food and calories, sleep, weight and other numbers, and tick
  off your gummies and vitamins, or just tell the assistant. Whoop and Apple
  Health data can be imported from their exports on the Health page.
- **Starting with Windows:** `install\install-engine-task.ps1` from an
  administrator PowerShell runs Mellow at boot. Only do this if you want the
  blocking part; otherwise `start-ratchet.cmd` is all you need.
- **On your phone or tablet:** the computer runs Mellow and the phone opens it.
  Put your computer's Wi-Fi address (or its [Tailscale](https://tailscale.com)
  address, to reach it away from home) in `bindHost` in `engine-config.json`,
  **and set a `token`** in the same file. Then open `http://<that address>:7777/`
  on the phone and Add to Home Screen. The Guide shows your computer's exact
  addresses.
- **Stuck?** `README.md` explains every part in detail.
