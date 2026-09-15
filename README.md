# Mellow

Two halves. The engine decides; the client obeys. They talk over one HTTP
endpoint and nothing else, so either can be replaced without touching the other.

Zero dependencies on both sides. Node built-ins only.

```
   engine/            GET /api/enforcement            ratchet-client.js
   ─────────    ────────────────────────────────►    ──────────────────
   tasks, cadences,   { level, shieldGroups,          hosts file
   deadlines,           reasons }                     firewall rules
   passes, history                                    process kills
   the dashboard
```

The engine never names an app. It says `shieldGroups: ["distractions"]`, and
`config.json` decides what that means on this machine. Change your mind about
Discord and the contract does not move.

---

## Start here

```
node engine/engine.js
```

Then open **http://localhost:7777/**. That is the dashboard: what is overdue,
what it is about to cost you, and the buttons that clear it.

In another window:

```
node ratchet-client.js --once
```

`safety.dryRun` starts `true`, so this logs what it *would* block and changes
nothing. Read the log. When the right things are listed, you are ready to arm it.

For the full install — boot tasks, notifications, account hardening — see
[SETUP.md](SETUP.md), or run `setup.ps1` from an Administrator PowerShell and
let it walk you through.

---

## On your desktop, and on your phone

```
powershell -ExecutionPolicy Bypass -File .\install\make-desktop-app.ps1
```

That puts Mellow on the desktop and in the Start menu. It opens the dashboard
in app mode: its own window, its own taskbar button, no address bar and no tabs.
It is a shortcut, not a packaged application, and it does not need to be one.
Wrapping the same page in Electron would add 150MB to a project whose entire
premise is that it depends on nothing.

**On an iPhone or iPad**, open the dashboard over Tailscale and use Share then
Add to Home Screen. It gets an icon and launches without Safari's chrome. You
can see what is overdue, mark things done, and spend a pass from the phone.

**What the phone cannot do is enforce.** Blocking apps on iOS needs the Screen
Time / Family Controls API, which is only reachable from a native app, which
needs a Mac with Xcode to build, an Apple Developer Program membership, and
Apple's approval of the entitlement. None of that can happen from a Windows PC.
The phone is a remote control for the engine, not a second enforcement point.

---

## The dashboard

Eight sections, with a sidebar on a desktop and tabs on anything narrow. It is
built to be open all day, so it opens on one day at a time, with the week and
the month a click away. The **Ask Mellow** button (`A`) opens the assistant
from anywhere, and a file dropped anywhere is read and filed in **Files**.

- **Today** opens first. Your greeting and three quiet numbers (this week, your
  streak, anything overdue), then the day itself: the **Schedule** with a line
  where now falls and finished events faded, what is **Due**, anything to
  **Catch up** on, and the rest of the week **Ahead** as one line a day. Step
  through the next two weeks with the day strip or the arrow keys; `T` comes
  back to today. Every course keeps one colour everywhere it appears.
- **Tasks** is only things you have to do, one list at a time: **Homework**
  (assignments), **School** (exams and quizzes), **To do** when there is any,
  **Email** and **Weekly**. It opens on the list you last picked. A blue bubble
  on a tab counts what you haven't opened yet, like unread mail, and those items
  are marked **New** while you look; this is remembered per device. Anything
  found automatically can be confirmed one at a time or all at once.
- **News** is today's biggest stories, ranked.
- **Finance** is your accounts, bills, budgets, holdings and goals, with a
  morning money brief on top.
- **Files** is a library of everything you drop, in folders, with what could
  be added from each (see Files, below).
- **Sleep screen** is where the sleep screen is set up.
- **Accounts** is where Google accounts are connected and synced.
- **Guide** is setup and help, written for a friend opening Mellow for the
  first time: a checklist that reads what is actually set up (name, Google, AI
  key, phone access), install steps for Windows, Mac and Linux, how to reach it
  from an iPhone, iPad or Android phone (with this computer's own Wi-Fi and
  Tailscale addresses, from `/api/setup`), a tour of each section, shortcuts,
  privacy and troubleshooting. Until it is opened, a new install shows a
  welcome card on Today pointing to it.

**Full screen** (`F`, or the button in the sidebar) shows Mellow and nothing
else: no taskbar, no title bar, no scrollbar. The **Mellow (Full screen)**
Start menu shortcut from `make-desktop-app.ps1` opens it that way.

The look is black, white and one blue: white carries the content, blue marks
where you are and what moves you forward (the current section, today, progress,
primary buttons), and red and amber are kept for late and due soon. It is dark
everywhere, whatever the system setting. The type is Instrument Serif for
headings and numbers, Geist for text and Geist Mono for labels, loaded from
Google Fonts. Offline, each falls back to a system font and nothing else
changes. On touch screens keyboard hints are hidden, buttons are larger, and
inputs are sized so iOS does not zoom in on them.

Marking something done offers an Undo for five minutes. The streak
counts days in a row with at least one thing done; passes do not count toward
it. Keyboard: `1` to `8` switch sections (Today, Tasks, News, Finance, Files,
Sleep screen, Accounts, Guide), `A` opens the assistant, `D` `W` `M` pick day, week or month, `←` `→` change day, `T` is today,
`F` is full screen, `S` syncs, `Z` starts the sleep screen, `?` lists shortcuts.

## News

Mellow does not rank the news itself. The default source is **Google News Top
stories**, which ranks stories by how widely they are being covered, and each
one arrives with the other outlets covering it. The News section shows that
ranking as it comes: the rank, the headline, who broke it, and who else has
it. **World** and **BBC** are one click away; the BBC's order is the one its
editors gave the front page.

The engine fetches a source at most every thirty minutes and keeps the last
ranking on disk, so a dropped connection shows the last good list with a note
saying so. Sources live in `engine/news.json`. The dashboard picks one by id,
never by address, so the endpoint cannot be used to make the PC fetch anything
else.

**Every source looks like itself.** An outlet's name is set in its own style
wherever it appears: the Times' blackletter, the Journal's capitals, the BBC's
blocks, CNN's red box, Reuters' orange, and so on for about fifteen outlets. In
the morning briefing a story is shown as clippings: the Times' and the
Journal's own headline, standfirst and photo from their feeds, each in that
paper's masthead and type, or a clipping from whoever broke it. These are
recreated from each paper's feed, not screenshots of its website, which would
mostly capture paywalls and cookie banners. The look stays inside the
clippings. Headlines on the sleep screen and in the money brief carry the same
marks.

**Logos.** Your stocks show each company's logo and colour, on the News page,
the Finance page, the sleep screen and the briefing. About ninety well-known
tickers are recognised; for any other, put the company's website under
`domains` in `engine/stocks.json`. The logo is the company site's own icon,
fetched by the browser from Google's public site-icon service (so Google sees
which companies' logos are asked for); a company it can't find gets its initial
in its colour. Anything that came from Google shows where: a Gmail mark on
homework, events and threads found in email, a Google Calendar mark on calendar
entries, a Canvas mark on anything from Canvas, and the Google mark on connected
accounts. Those marks are drawn inside Mellow and load nothing.

**Read it in the Times or the Journal.** For every ranked story, Mellow looks
for the same story in The New York Times' and The Wall Street Journal's own
feeds, matching on the distinctive words the headlines share, and puts a
**Read in The New York Times** or **Read in The Wall Street Journal** button
under it. The links go straight to nytimes.com and wsj.com, so their paywalls
and your subscriptions apply. A story both papers are carrying is marked
**Major story**. Below the ranking, the top five from each paper. The feeds are
listed under `papers` in `engine/news.json` if you want to add another.

**Your subscriptions.** A web page cannot see what you are signed into on
other sites, so Mellow is told which papers you pay for: tap them in the
**Your subscriptions** row on the News page (The Wall Street Journal, the Times,
the Post, the FT, Bloomberg, The Economist, The New Yorker, the LA Times).
Their feeds join the matching, their **Read in** buttons come first and are
marked **Yours**, and the others say they may be paywalled. The sync also
looks, once a day, for receipts and renewal emails from those papers and asks
"Do you subscribe to The Wall Street Journal?" rather than deciding for you.
Only which paper and when is kept, never the email. The list is
`subscriptions` in `engine/news.json`.

**Your stocks** sit at the top of the News page: price, today's change and a
line of the day, for AEVA, LULU, AZN and NKE. Change the list in
`engine/stocks.json`. Prices come from Yahoo Finance's public chart data, can be
up to fifteen minutes behind, and are refreshed every five minutes. It is an
unofficial source, so if it ever stops answering, the last prices stay up. It
shows prices; it does not advise or trade.

## Finance

Everything on the Finance page is typed in by you and kept in
`engine/finance.json`. Mellow never asks for a bank login or an account number,
and it cannot move money. A balance is whatever you last said it was, dated, and
one older than two weeks is marked so you know to update it.

- **Accounts**: checking, savings, cards, loans, brokerage, retirement, cash.
  What you owe on a card or loan counts against your net worth. Net worth is
  recorded once a day, so the line under it fills in over time.
- **Bills and paydays**: monthly, weekly, every two weeks, yearly or once.
  Anything late or due in the next two weeks is listed, then the next one of
  each. **Paid** (or **Received**) marks it and logs it as a transaction; Undo
  takes both back. Autopay bills take care of themselves once the day passes.
- **Spending**: a log of transactions and a monthly budget per category. The bar
  has a tick for how far through the month it is, so "ahead of pace" is visible
  before "over". Logging spending does not change account balances; those come
  from your bank's app.
- **Credit cards**: balance, limit, statement balance, minimum, APR, the day the
  statement closes and the day payment is due, autopay, annual fee, rewards and
  the last four digits (only ever the last four). Each card shows how much of
  its limit is used, what a month of interest would cost if the balance were
  carried, and when it is next due. A card with a due day gets its payment
  added to Bills automatically; **Paid** lowers the card's balance rather than
  logging spending, and Undo puts it back.
- **Holdings**: shares you own, priced from Yahoo Finance like the stocks on the
  News page. Put them under a brokerage account and they are added to its cash.
- **Goals**: a target, what you have saved, and what that means per month.

The weekly **Check on your finances** task sits at the top of the page with its
Done button.

**The morning money brief** is built by the engine once a day at 6 AM (change
`settings.morningHour` in `finance.json`), before the dashboard is even open:

- The markets: S&P 500, Nasdaq, Dow, the 10-year yield, Bitcoin and gold, with
  live prices all day.
- Markets and business headlines, ranked by Google News, plus the Journal's
  markets desk.
- What is being written about each stock you hold or follow.
- Money stories that reach a person rather than a fund: rates, inflation,
  student loans, credit cards, gas prices. The search is `settings.moneyQuery`.

Refresh builds a new edition at any time. The briefing gets a **Money** page
after your stocks (net worth, bills due, the markets and the top money
headlines), and bills due today or tomorrow, overdue bills and blown budgets
show up in **Worth knowing**.

The engine's other pages answer without the token on the local network, and so
does this one, so anyone who can open the dashboard can read the numbers on it.
Changing them from another device needs the token, as everywhere else.

## The calendar: day, week, month

The Today page has **Day**, **Week** and **Month** (`D`, `W`, `M`). Day is the
page as it has always been. Week lays the seven days side by side, Monday to
Sunday; Month is the whole month with the first few things on each day. Arrows
move a week or a month; clicking a day opens it. Deadlines have a dashed edge,
late ones are red. To fill the month, the sync now keeps five weeks behind and
two months ahead of your Google calendars (`calendarDaysBehind` and
`calendarDaysAhead` in `engine/google.json`).

## Files

Drop a file anywhere in Mellow, on the **Files** page, or with **Scan a file**
on Today, Tasks or Finance. Three things happen, and none of them changes your
calendar, tasks or money:

1. **It is filed.** Claude gives it a readable title ("ECO 112 Syllabus, Fall
   2026") and puts it in a folder: Syllabus, School, Work, Notes, Finance,
   Personal or Other, or a folder you made with **New folder**. Move it with the
   folder menu and it stays there, even if it is read again.
2. **It is summarised,** with up to six key facts kept at hand: office hours,
   grading weights, a professor's email, an amount owed.
3. **Mellow looks for what could be added:** class meetings, events,
   deadlines, exams, to-dos, bills, paydays, transactions and credit cards. Each
   is checked against what is already in Mellow; one already on your calendar,
   already a deadline, or already a bill that day is marked so and left
   unticked. Tick what is right, fix anything wrong, and press **Add ticked
   items**. **To review** lists every file with suggestions you haven't decided
   on, and the Files tab counts them.

- **Syllabi, schedules, flyers, assignment sheets** (PDF, photo, Word, text,
  web page, email) are read by Claude. A class that meets MWF until December
  becomes each meeting on the calendar. Dates Claude had to guess are marked
  **Check the date** and left unticked.
- **Calendar files (.ics)** and **bank exports (.csv, .ofx, .qfx)** are read on
  this PC and never sent anywhere.
- **Deadlines arrive unconfirmed**, like ones found in email: they remind you
  but cannot block anything, unless you switch on "Deadlines can block when late"
  before adding.
- **On the Finance page**, a PDF or photo of a statement is only sent to Claude
  if "Read dropped statements" is on under AI access. Otherwise it is kept but
  not read, and a CSV export is the private way in.

Files are kept in `engine/drops/` until you delete one, so last term's syllabus
is still there next term, and the assistant can answer questions about any of
them. **Open** shows the original (PDFs and pictures in the browser, anything
textual as plain text, never run as a web page). Deleting a file keeps anything
you already added from it.

## The assistant

**Ask Mellow** (`A`) is a conversation with Claude that can see your schedule,
tasks, email waiting on you, news, the files you drop, the finances you share,
and Mellow's own code, and can change all of it:

- "What's due this week, and what should I start on?"
- "Put the class times from my syllabus on the calendar."
- "Add my phone bill, $45 on the 15th every month."
- "Make the News page show 10 stories" or "add a dark red theme to the
  sleep screen", and it edits the app.

**It looks on its own; it changes nothing on its own.** Every change stops and
shows you exactly what will happen, with a line-by-line diff for code, and
waits for **Approve**. Code with a syntax error is refused before it is shown to
you. Every file it changes is backed up in `engine/assistant/backups/`, and
**Undo** in the conversation puts it back. Changes to `dashboard.html` show on
reload; changes to the engine's `.js` files need an engine restart.

What it can never do, approved or not:

- read or change sign-ins and keys (Google tokens, the OAuth client, the AI
  key, the engine token) or its own settings in `engine/ai.json`;
- read the finance, mail and dropped-file data files directly, so the privacy
  switches cannot be read around; it gets those through tools that apply them;
- change `history.json`, mark tasks done, or spend passes;
- change app files from a phone; that has to be approved on the PC;
- change the files that decide what gets blocked (`config.json`, the client,
  `tasks.json`, the ladders, `schedule.js`, the install scripts) or its own
  guards in `engine/lib/ai/`, **unless** you set
  `assistantCanEditEnforcement` to `true` in `engine/ai.json` by hand. It can
  still propose edits to `engine.js` and the dashboard, which you approve.

Text inside a dropped file, an email or a headline is treated as content, never
as instructions; a document that says "ignore your rules" is just a document
that says that. Conversations are kept in `engine/assistant/conversations/`, and
from another device they need the token even to read.

## AI and your privacy

The assistant and file scanning use Claude with **your own Anthropic API key**,
added under **Accounts → AI** (from the PC; it is stored in
`engine/ai-key.txt` and sent only to Anthropic). Mellow talks to the API
directly over HTTPS, with no packages to install.

- **A monthly limit** (default $20): every request is priced as it comes back,
  and nothing is sent once the month's limit is spent.
- **Model**: Claude Opus 5 by default; Sonnet 5 and Haiku 4.5 cost less.
- **Masking**: card numbers (keeping the last four), Social Security numbers,
  and labelled account and routing numbers are masked in all text Mellow
  sends: email subjects, Word documents, transaction descriptions.
- **Finance, part by part.** Finance → **AI access** decides what Claude may
  read. By default it sees bills and paydays, budgets and spending by category,
  and savings goals. It does **not** see account balances, credit cards,
  individual transactions, holdings or net worth, and does not read dropped
  statements, until you switch them on. Anything switched off is left out
  entirely, and **Hide from AI** on any single account, card, bill, budget,
  goal, holding or transaction keeps that one out whatever the switches say.
  The last four digits of a card never go to Claude at all.

If Claude declines a request, the API retries it on its recommended fallback
model (the `fallbacks` setting) instead of failing.

## Morning alarm and briefing

Set an alarm in **Sleep screen → Morning alarm**: a time, the days, and whether
to chime. At that time the screen wakes from the sleep screen into a **morning
briefing** that plays by itself, one page every ten to fifteen seconds:

1. Good morning, and the shape of the day: how many events, what's due, what's
   overdue, and what's first.
2. Your stocks, with the day's change and a line for each.
3. Your money: net worth, bills due, the markets and the morning's money
   headlines.
4. The five biggest stories, major ones first, each with buttons to read it in
   the Times and the Journal.
5. Today in full.

Arrows or Back and Next move through it, space pauses, Done or `Esc` closes it.
Left alone, it loops with fresh news and prices, then after twenty minutes
(adjustable) the sleep screen returns. `B` plays it any time.

Things to know: the page has to be left open overnight and Windows must not
sleep, since a web page can wake a screen but not a computer. Browsers allow
sound only after you have clicked in the page at least once since it opened, so
give Mellow a click before bed if you want the chime. News and prices are
fetched fresh ten minutes before the alarm.

## The sleep screen

Leave Mellow untouched for ten minutes, or press `Z`, and it becomes a quiet
standby display over a painting: the time, a museum label for the painting,
**Worth knowing**, what is up next, the rest of today, your stocks and the top
three stories. Worth knowing is the short list of what matters right now, most
urgent first: anything blocked, something starting within two hours, an exam in
the next two days, anything overdue or due today, an event found in email, a
major story, and any of your stocks moving 3% or more.
Any key, click, tap or real mouse movement wakes it, and that key or click is
spent on waking rather than also pressing whatever was underneath.

Everything is set in the **Sleep screen** section, with a live preview:

- **Widgets.** Each one goes on the left, the right, or off, in the order you
  choose. When a side runs out of room the lowest ones are left out whole.
  Greeting, progress and passes are there too, off by default.
- **Artwork.** Van Gogh (Café Terrace at Night is the default), then art history
  in order: Renaissance, Baroque, Neoclassical & Romantic, Realism,
  Impressionism, Post-Impressionism, Ukiyo-e, Art Nouveau, Expressionism,
  Abstraction; then Pop art, Styled, a plain background, or your own. Pick one,
  or shuffle a collection with a slow fade between them. Surrealism is missing
  only because Dalí, Magritte and their circle are still under copyright.
- **Appearance.** How the painting fills the screen, how much it is dimmed, the
  clock style (Serif, Soft watch, Grotesk, Mono, Stacked, Analog or Minimal), 12 or 24-hour,
  and whether widgets are **Quiet** (text and a hairline, the default) or sit on
  glass **Panels**.
- **Behaviour.** How long before it starts, how many headlines, drift, full
  screen, and keeping the display awake.

Settings are kept in each browser, so the monitor and the iPad can differ.

**Filling the screen.** Three choices:

- **Fill screen** (default). The painting is cropped around its subject to fill
  the screen, but never loses more than a fifth of itself. If filling would
  cut deeper, as with a tall painting on a wide monitor, the strips either side
  are filled after Ellsworth Kelly: hard-edged panels of flat colour on one
  side, a field cut by one of his curves on the other, all taken from the
  painting's own palette, warm against cool, set off from the painting by a
  thin dark line. Nothing is blurred and nothing is invented.
- **Crop.** Cropped around its subject to fill, nothing added.
- **Whole painting.** Never cropped, on a gallery wall, a blurred copy, or black.

Each built-in painting has a point of interest the crop centres on, so Café
Terrace keeps both the terrace and the stars. The widgets move a few pixels each
minute, so nothing sits still long enough to burn in.

**Night mode** is for when you are actually asleep. Press `N` on the sleep
screen (or `N` / the Night mode button anywhere in Mellow) and everything goes
black except the time, small, dim and warm, moving to a new spot each minute.
`N` again brings the painting and widgets back without waking. In night mode a
nudged mouse or scroll wheel is ignored; only a key or a click wakes it. When
the morning alarm goes off, night mode ends and the full sleep screen comes
back, freshly painted with this morning's news and prices. Choose **Morning
briefing** under **When it goes off** if you would rather it played that instead.
**Test the alarm** goes into night mode and brings the sleep screen back four
seconds later.

**The Soft watch** clock is a nod to Dalí's The Persistence of Memory, drawn
from scratch: a gold pocket watch draped over a ledge, its lower half sliding
off, with a fly on the face. It keeps real time, and the hands bend as they pass
the ledge. The time is also written underneath, so it is readable at a glance.

**The paintings** are public domain (a few are CC0) and load from Wikimedia
Commons, so the sleep screen needs the internet to show them.

**Pop art** needs a word. Lichtenstein's and Warhol's own canvases are still
under copyright and cannot ship inside Mellow. But both built series by
remaking famous paintings, so Mellow remakes the same public-domain originals,
in the browser, in their manner. The **Pop art** tab holds only paintings they
actually remade:

- **Lichtenstein:** Rouen Cathedral and Haystacks after Monet, as three screens
  of overlapping Ben-Day dots.
- **Warhol:** Mona Lisa, Botticelli's Venus and Munch's The Scream, as
  silkscreen grids, each panel inked differently, the black screen off register.

**Styled** holds famous paintings in the manner of an artist who never made
them: Vermeer's Girl with a Pearl Earring and Hokusai's Great Wave as
Lichtenstein comic panels, Van Gogh's self-portrait as a Warhol grid, and four
colour fields **after Ellsworth Kelly**. Kelly's work is under copyright too,
so these are new hard-edged compositions (panels, a curve, a diptych, a grid),
each built from the palette of a painting in the collection.

Everything drawn by Mellow takes under a second and is kept for the session.
Digital copies of originals that you own can go in Your pictures.

**Your own pictures** go in `engine/art/`. Any `.jpg`, `.png`, `.webp` or `.gif`
dropped there appears under Your pictures, captioned with its filename. That
folder stays writable after `lock-folder.ps1`, since a picture decides nothing.
You can also paste the address of any image on the web.

**A late completion still counts.** Laundry due Sunday and done on Monday clears
Sunday. Done early on Saturday, it counts for Sunday. A completion always pays
off the oldest missed occurrence first, so the debt shrinks one at a time.

## Google: homework, email and calendars

Connect your school and personal Google accounts once, following
[GOOGLE-SETUP.md](GOOGLE-SETUP.md). After that the engine re-reads them every
ten minutes, with read-only access.

**Homework** comes from the school account. An email or calendar entry becomes
an assignment when it reads as schoolwork and carries a deadline: a Canvas
notification, a professor's "HW 4 is due Friday by 5pm", an exam on the calendar.
Graded notices, submission receipts, newsletters and anything in Promotions are
ignored. The deadline is taken from the date nearest a word like "due", so the
date an email was sent or a quoted reply header does not become the deadline.

Everything it finds arrives **unconfirmed**. Unconfirmed homework reminds you but
can never block anything. Click **It's real** once and it follows its ladder;
click **Not homework** and it never comes back, even when the next reminder email
arrives. When a calendar entry and an email disagree about a date, the calendar
wins. Between two emails, the newer one wins, since a "due date changed" notice
is always the later message.

Homework starts nagging the day before it is due, not after. Exams warn two days
ahead and simply disappear once they have started, since there is nothing to do
late.

**Email** comes from both accounts. A thread counts as waiting on you when a real
person wrote last, sent it to you rather than to a list you are on, and it is
still in your inbox. Reply or archive and it clears on the next sync. Unanswered
email can nag but cannot block anything unless you set `repliesCanShield` in
`engine/google.json`, because deciding a message needs a reply is guesswork.

**Events from email** come from both accounts. Mellow reads recent mail for
things you attend: an interview confirmed for Thursday at 2, coffee tomorrow at
10, a club meeting moved to 7 to 9pm, a reservation. It needs an event word, a
date and a time close together in the same message, reads end times ("3-5pm")
and locations ("Location:", Zoom and Meet links), and skips promotions,
newsletters, cancellations, receipts, quoted replies and Google or Outlook
invitations (those are already on your calendar once accepted).

What it finds appears on **Today** under **From your email**, with the line it
was read from one hover away. **Add to calendar** puts it on Mellow's calendar
beside your Google events, with a link back to the email; **Not an event** hides
it for good. If a newer email moves an event you have added, it moves too and
is marked **Time changed**. Nothing is added without a click. The switch is
**Events from email** on each account.

These events live in Mellow, not in Google Calendar. Mellow's Google access is
read-only on purpose; writing to Google Calendar would mean asking for more
permission and reconnecting both accounts.

**Weekly** tasks are in `engine/tasks.json`: laundry and finances, due Sunday at
8pm, with a heads-up at 4pm.

**One assignment, one entry.** The same homework can arrive more than once: a
course calendar's "ECO112 — Homework 1", the reader's cleaner "Homework 1"
(ECO 112), and "Homework 1 due" from a syllabus added in Files. Whenever
captured homework is saved, entries due the same day, of the same kind, for the
same class and with matching titles are folded into one. The one kept is the
one you marked done, then one you confirmed, then one from your calendar; it
takes the clearest title, every source and your confirmation. The others are
set aside with `mergedInto`, never deleted, and a date that later moves on
one of them moves the one kept. Two different classes are never merged, and a
different number ("Problem Set 3" and "4") keeps them apart. Class meetings
added from a syllabus are left off the calendar where your Google or .ics
calendar already has that class at that time.

What it cannot see: assignments that are only on a course website and never
emailed or put on a calendar, and an email with a deadline but no date written in
it. If your course site can add deadlines to your Google Calendar, turn that on,
and Mellow picks them up from there.

### Other calendars

`engine/calendars.json` subscribes to `.ics` URLs, read-only, for any calendar
that is not in a connected Google account. It is also the fallback if your school
blocks Mellow from reading the account directly.

Feeds are cached on disk and refreshed on a timer. A calendar you cannot reach
shows yesterday's schedule rather than an empty week, which is the same
fail-closed instinct as the enforcement client.

Weekly and daily recurrence is expanded, including `BYDAY`, `INTERVAL`, `UNTIL`,
`COUNT` and `EXDATE`, because a class timetable is one long recurrence rule and a
cancelled lecture is an `EXDATE`. Monthly and yearly rules yield their first
occurrence only: better a missing repeat than a confidently wrong date.

The one real limitation is `VTIMEZONE`. Resolving an arbitrary `TZID` properly
needs the full timezone database. A `TZID`-qualified time is read as local time,
which is right whenever the calendar's timezone matches the machine's, and off
by an offset if not. Times in UTC, which is what most exports actually emit, are
exact.

---

## The engine

Everything it knows lives in two files you can read.

**`engine/tasks.json`** is what you have committed to. A task has a cadence, a
deadline, and a ladder:

```json
{
  "id": "read",
  "title": "Read a book for 30 minutes",
  "clearedBy": "Run the 30-minute timer, then mark it here",
  "cadence": { "type": "daily", "dueBy": "21:00" },
  "escalation": [
    { "afterMinutes": 0,   "level": "nudge" },
    { "afterMinutes": 45,  "level": "persistent" },
    { "afterMinutes": 90,  "level": "shield_social", "groups": ["distractions"] },
    { "afterMinutes": 240, "level": "shield_all" }
  ]
}
```

`afterMinutes` counts from the deadline, not from midnight. Omit `escalation`
entirely and the task gets a default ladder.

Cadences: `daily`, `weekdays`, `days` with a list, and `everyNDays` which counts
from the last time you actually did it rather than from the calendar.

**`engine/history.json`** is every completion and every pass, append-only, in
plain JSON. Nothing here is encoded or hidden. A thing that takes your games
away should not also hold your data hostage.

### Rules worth knowing about

**The union rule.** Levels take the highest across all tasks and groups take the
union. Finishing your reading does not unlock Steam while the email is still
three days late.

**The debt is the oldest miss.** Miss three days and it says three days. A
system that quietly resets to "one day late" every midnight is one you stop
believing.

**A new task is not retroactively late.** Add something on a Friday and it
starts on Friday. Set `startedOn` to backdate it deliberately.

**Passes.** Two a week by default, on a rolling seven-day window, not a calendar
week. A pass clears a task exactly as doing it would. That is the escape valve
that stops the whole thing collapsing the first time you get flu.

**Notes.** A task with `requiresNote` refuses a bare Done. `clearedBy` says
"Write 10 words on what you actioned" and the engine actually counts them.

**The confirmation cap.** A task with `confirmed: false` can nag but can never
shield, whatever its ladder says. Anything captured automatically should start
there — a misparsed email that locks your machine teaches you to distrust the
whole system inside a week.

**Undo** works for five minutes after a click. Longer than that is not fixing a
misclick, it is rewriting history to get Steam back.

---

## The client

iOS has one blunt, excellent tool — the Screen Time API. Windows has no
equivalent, so this uses three layers instead, weakest to strongest:

| Layer | Blocks | Needs admin | Notes |
|---|---|---|---|
| hosts file | Websites, browser-wide | Yes | Survives incognito and browser switching |
| Firewall rule | One `.exe` reaching the network | Yes | Steam opens but cannot connect — gentler than killing it |
| Process kill | The app itself | Sometimes | Re-kills every 10s while shielded |

**Windows 10 Home matters here.** Home has no Group Policy, so AppLocker and
Software Restriction Policies — the clean, kernel-level way to stop a program
launching — are not available to you. That is a Pro/Enterprise feature. The
three layers above are the honest best available on Home, and they are what
commercial PC blockers use too.

Two groups ship in `config.json`, `distractions` and `games`. Put your real app
names in them. Firewall entries need full `.exe` paths; process entries just
need the image name.

---

## Notifications

The scheduled task runs as SYSTEM, in session 0, where a toast is drawn to
nobody at all. So the client does not try. It writes notifications to
`notify-queue/` and a second, per-user task draws them in the session where you
can actually see them.

That is why there are two installers. Register the agent from **your own**
PowerShell window, not an elevated one — a task registered by the admin account
runs in the admin account's session, which is the one you are trying not to live
in.

```
powershell -ExecutionPolicy Bypass -File .\install\install-notify-task.ps1
node ratchet-client.js --test-notify
```

Windows 10 Home has no `msg.exe` either — that ships with Terminal Services on
Pro and above — so the fallback when a toast fails is a tray balloon.

---

## Commands

```
node engine/engine.js                    the engine and dashboard
node engine/test-engine.js               72 tests: cadences, deadlines, the ladder
node engine/test-extract.js              79 tests: homework and reply detection
node engine/test-calendar.js             33 tests: the .ics parser
node engine/test-google-e2e.js           47 tests: sign-in and sync against a fake Google
node engine/test-news.js                 19 tests: the news feed parser
node engine/test-events.js               29 tests: events from email, stocks, the Times and the Journal
node engine/test-files.js                40 tests: folders, filing a scan, spotting what's already on the calendar

node ratchet-client.js                   run forever
node ratchet-client.js --once            one cycle then exit
node ratchet-client.js --status          show what is currently applied
node ratchet-client.js --clear           remove every block (break glass)
node ratchet-client.js --test-notify     prove notifications work
node test-logic.js                       27 tests on the obeying half

node mock-server.js shield_all           fake engine, for testing the client
```

`--clear` needs admin. That is deliberate, and the next section is about who
holds it.

---

## Making it hard to escape

Everything above is trivially defeatable if your daily Windows session has admin
rights. You would just stop the task. Same problem as deleting the iOS app, and
mostly the same answer — except Windows gives you a better one than iOS does,
because you do not need to involve another person.

**Run your daily account as a Standard user.** Make a second, admin-only account
you do not log into normally. The tasks run as SYSTEM, so your day-to-day
session cannot stop them, edit the hosts file, or delete firewall rules without
switching accounts and typing the admin password.

```
powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -CreateAdmin
```

Sign in as that account once to prove the password works, then from there:

```
powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -MakeStandard <your-name>
```

Both steps refuse to run if they would leave you locked out.

That reintroduces exactly the friction gap this is built around: not impossible,
just a deliberate minute. Which is the whole product.

**The half that demotion does not cover.** Your standard account can still open
`tasks.json` in Notepad and delete every task, which defeats all of the above
without needing admin at all. Once you are happy with your task list, close it:

```
powershell -ExecutionPolicy Bypass -File .\install\lock-folder.ps1
```

That makes the files that *decide* read-only to standard users, while leaving
the files that *record* writable, so clicking Done on the dashboard still works.
`-Unlock` puts it back.

**The honest catch, same as the iOS one:** you can boot into safe mode, or use a
recovery disk, or reinstall Windows. Nothing in software stops a determined
person with physical access. The goal was never impossibility, it was cost.

---

## Fail-closed, and the failure mode worth thinking about

`safety.failClosed` is `true`. If the engine is unreachable, the last known
shield stays up rather than falling open.

Three mitigations are built in:

- The client never invents a shield. If it has *never* reached the engine this
  run, it stays clear rather than guessing.
- After `staleWarnAfterMinutes` (default 30), notifications are tagged
  `[STALE — no contact with engine]`, so you can tell a dead engine from real
  enforcement at a glance.
- `--clear` from an admin prompt is the break glass.

With both halves on the same PC this is a much smaller risk than it was with a
Raspberry Pi — if the machine is off, the client is off too. It matters again
the moment a second machine points at this one.

---

## Exposing the engine to another machine

`engine-config.json` binds to `127.0.0.1`. That is right while the PC is the only
client, and it means the write endpoints need no authentication.

To let a Mac reach it over Tailscale, change `bindHost` to your Tailscale address
and **set a token in the same edit**. Without one, anyone who can reach the port
can mark your tasks done. The engine logs a warning at startup if you open the
port and leave the token empty.

---

## Sharing Mellow with friends

```
powershell -ExecutionPolicy Bypass -File .\install\package-for-friends.ps1
```

That writes `dist\Mellow-<date>.zip`: the app, with none of you in it. It is
built from a list of the app's own files, never by copying the folder and
deleting things, and before the zip is written every file is searched for your
email addresses, name, engine token, Tailscale address, Google client id, API
keys and refresh tokens. If any turns up, nothing is packaged.

What your friend gets: a clean `engine-config.json` (no name, localhost only),
two example weekly tasks, example stocks, no news subscriptions, enforcement
back in dry run, and `START-HERE.md` (from `FRIENDS.md`), which takes them
through installing Node.js and double-clicking **`start-ratchet.cmd`**. They
make their own Google client (`GOOGLE-SETUP.md`) and use their own Anthropic
key.

Mellow is shared under the **PolyForm Noncommercial License 1.0.0**
(`LICENSE.txt`): anyone you give it to can use it, change it and pass it on,
and nobody can sell it. Put your name in `LICENSE.txt` if you want the credit.

## What is not here yet

- **The phone.** The dashboard works over Tailscale and adds to a Home Screen,
  but it has not been tuned for daily phone use yet.
- **Smarter reading of email.** Homework is found with rules, which handle Canvas
  and plainly written reminders well and miss anything phrased loosely. Sending
  candidate emails to Claude for extraction would catch far more, at the cost of
  an API key and a small per-email charge.
- **A Windows shield screen.** Right now a blocked app closes or fails to
  connect; there is no equivalent of the iOS shield UI explaining why. Doable as
  a small always-on-top window if the silent failure feels confusing.

---

## Files

| File | What it does |
|---|---|
| `engine/tasks.json` | **Your weekly tasks.** |
| `engine/google.json` | **How often to sync, and the homework and email ladders.** |
| `engine/engine-config.json` | Port, binding, pass budget. |
| `engine/calendars.json` | Extra .ics calendar feeds. |
| `engine/news.json` | Where the news ranking comes from, and which papers to link to. |
| `engine/stocks.json` | **The stocks you follow**, with their colours and websites (for logos). |
| `engine/stocks-cache.json` | The last prices. Written by the engine. |
| `engine/finance.json` | **Your accounts, bills, budgets, holdings and goals**, and the brief's settings. |
| `engine/finance-brief.json` | This morning's money brief. Written by the engine. |
| `engine/ai.json` | **AI on or off, the monthly limit, the model**, and whether the assistant may change blocking rules. |
| `engine/ai-key.txt` | Your Anthropic API key. Never served, never read by the assistant. |
| `engine/ai-usage.json` | This month's AI spend. Written by the engine. |
| `engine/drops/`, `engine/drops.json` | **Files:** everything you dropped, your folders, and what was found in each. |
| `engine/assistant/` | Conversations, and backups of every file the assistant changed. |
| `engine/news-detected.json` | Papers your inbox suggests you subscribe to: which, and when. |
| `engine/lib/ai/claude.js` | The Messages API over HTTPS: the key, retries, spend and the monthly limit. |
| `engine/lib/ai/privacy.js` | Masking numbers, and what of your finances Claude may see. |
| `engine/lib/ai/assistant.js` | The assistant: its tools, what it may touch, approvals, backups and undo. |
| `engine/lib/drops.js` | Reading dropped files, and adding what you tick. |
| `engine/lib/zip.js` | Reads the text out of Word documents. |
| `install/package-for-friends.ps1` | Builds the zip to share, with none of your data in it. |
| `start-ratchet.cmd` | Starts the engine in a window and opens the dashboard. No admin. |
| `start-ratchet.command` | The same on a Mac (double-click) or Linux (`bash start-ratchet.command`). |
| `FRIENDS.md`, `LICENSE.txt` | The first page a friend reads, and the noncommercial licence. |
| `engine/art/` | **Your own pictures for the sleep screen.** |
| `engine/news-cache/` | The last ranking from each news source. Written by the engine. |
| `engine/history.json` | Append-only record of everything you cleared. |
| `engine/auto-tasks.json` | What the sync found, and what you confirmed or dismissed. Written by the engine. |
| `engine/google-accounts.json` | Connected accounts and their roles. Written by the engine. |
| `engine/google-tokens.json` | Google sign-ins. Never served, locked to SYSTEM by `lock-folder.ps1`. |
| `engine/client_secret_*.json` | Your Google OAuth client, from GOOGLE-SETUP.md. |
| `engine/engine.js` | The HTTP server and the API. |
| `engine/lib/schedule.js` | Cadences, deadlines, the ladder, the union rule. |
| `engine/lib/store.js` | Reading and writing those files, atomically. |
| `engine/lib/autotasks.js` | Merging captured homework and email into tasks. |
| `engine/lib/sync.js` | Pulls from each Google account on a timer. |
| `engine/lib/google/oauth.js` | Google sign-in: loopback redirect with PKCE. |
| `engine/lib/google/api.js` | The Gmail and Calendar calls. |
| `engine/lib/extract/dates.js` | Finds the due date in email text. |
| `engine/lib/extract/homework.js` | Decides whether an email or event is schoolwork. |
| `engine/lib/extract/replies.js` | Decides whether a thread is waiting on you. |
| `engine/lib/ics.js` | iCalendar parser, including recurrence. |
| `engine/lib/calendar.js` | Fetches, caches and merges the .ics feeds. |
| `engine/lib/news.js` | Fetches, parses and caches the news ranking, and finds each story in the Times and the Journal. |
| `engine/lib/stocks.js` | Fetches and caches stock prices. |
| `engine/lib/finance.js` | The Finance page's data, totals and due dates, and the morning money brief. |
| `engine/lib/extract/events.js` | Finds appointments in email. |
| `engine/dashboard.html` | The dashboard: Calendar, Tasks, News, Finance, Accounts, and the sleep screen. |
| `engine/test-*.js` | The engine test suites. |
| `GOOGLE-SETUP.md` | **Connecting your Google accounts, step by step.** |
| `config.json` | **What a group means on this machine.** |
| `ratchet-client.js` | The poll loop and watchdog. |
| `lib/blockset.js` | Resolves a level to a block set. |
| `lib/enforce.js` | Picks a platform backend and applies it. |
| `lib/platform/windows.js` | hosts file, firewall, taskkill. |
| `lib/platform/macos.js` | hosts file, osascript quit. |
| `lib/notify.js` | Toasts, and the queue that makes them visible. |
| `lib/util.js` | Logging and safe command execution. |
| `mock-server.js` | Fake engine for testing the client alone. |
| `test-logic.js` | 27 tests on the obeying half. |
| `install/install-all-tasks.ps1` | Both SYSTEM tasks, registered and started. |
| `install/install-engine-task.ps1` | Engine at boot, as SYSTEM. |
| `install/install-task.ps1` | Client at boot, as SYSTEM. |
| `install/install-notify-task.ps1` | Notification agent at logon, as you. |
| `install/harden-account.ps1` | The standard-user setup. |
| `install/lock-folder.ps1` | Makes the deciding files read-only to you. |
| `install/find-node.ps1` | Locates node.exe when the PATH is stale. |
| `install/make-desktop-app.ps1` | Desktop and Start menu shortcuts. |
| `install/make-icon.ps1` | Redraws the icon and the phone PNGs. |
| `ratchet.ico` | The Windows icon, six sizes. |

Client state lives in `applied-state.json`, in plain readable JSON, so teardown
removes exactly what was added.
