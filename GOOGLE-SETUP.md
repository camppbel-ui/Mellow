# Connecting your Google accounts

Mellow reads your school and personal Gmail and Google Calendar, so it can fill
in your classes, deadlines, exams and emails waiting on a reply.

**The easy way:** open Mellow, go to **Accounts**, and follow the checklist
there. Every step has a button that opens the exact page in Google Cloud, and
at the end you choose the file you downloaded. This page is the same steps, for
reading ahead or if something goes wrong.

**What Mellow gets:** read-only access. It can't send, delete, archive or label
an email, and can't change a calendar. Your sign-ins stay on your computer, in
`engine/google-tokens.json`, and only ever go back to Google.

---

## Why there are steps at all

Google makes every app that reads Gmail register its own sign-in. Mellow has no
server and no company behind it, so you register it yourself, in your own free
Google Cloud account. It takes about ten minutes, once, and covers all your
Google accounts.

(If whoever gave you Mellow set up a shared sign-in, Accounts just shows
**Connect** buttons and you can skip to step 7.)

## The steps

Do these on the computer running Mellow, signed in to Google with your
**personal** account. School accounts often aren't allowed to make projects;
your personal one works for your school account too.

1. **Make a project.** Open
   [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
   Name it `Mellow`, click **Create**. It's free: ignore anything about billing
   or a free trial.

2. **Turn on Gmail and Calendar.** Open
   [this link](https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com).
   Check the project picker at the top says **Mellow**, click **Next**, then
   **Enable**. Both switch on at once.

3. **Name the sign-in screen.** Open
   [Branding](https://console.cloud.google.com/auth/branding) and click
   **Get started**. App name `Mellow`, your email, **Next**. Audience
   **External**, **Next**. Your email again, **Next**. Agree, **Create**.

4. **Publish it.** Open [Audience](https://console.cloud.google.com/auth/audience),
   click **Publish app**, then **Confirm**. This lets any of your Google accounts
   connect without a test-user list, and stops Google signing you out every
   week. Nothing becomes public.

5. **Make a Desktop client.** Open [Clients](https://console.cloud.google.com/auth/clients),
   click **Create client**. Application type **Desktop app** (not "Web
   application"), any name, **Create**, then **Download JSON**. You get a file
   named like `client_secret_1234-abcd.apps.googleusercontent.com.json`.

6. **Give the file to Mellow.** On **Accounts**, click **Choose file** and pick
   it from Downloads, or drag it anywhere onto Mellow. Mellow keeps it in its
   engine folder and never puts it in Files.

   *Using the plain zip, or an older Mellow?* Move the file into the `engine`
   folder inside your Mellow folder instead (the Guide shows the exact path),
   without renaming it, and reload.

7. **Connect.** On Accounts, click **Connect school account**:
   - Pick the account in Google's window.
   - Google says **"Google hasn't verified this app."** That's expected for an
     app you made yourself. Click **Advanced**, then **Go to Mellow**.
   - Tick both boxes and click **Continue**. You land on "Connected".

   Then **Connect personal account** the same way. The first sync starts
   straight away; homework and calendar entries show up within a minute.

Keep the downloaded file out of screenshots and anywhere public: it's what lets
Mellow ask Google for sign-ins.

---

## If something goes wrong

- **"Access blocked" or "access denied" when connecting.** The app is probably
  still in Testing. Do step 4 (Publish app) and connect again.
- **"Needs reconnecting" every week.** Same cause: publish the app, then
  **Reconnect** once.
- **Sync says the Gmail API or Calendar API "has not been used" or is disabled.**
  Accounts shows a **Turn on Gmail and Calendar** button for your project.
  Click it, **Enable**, then **Sync now**.
- **"That client is a Web application."** Make another client in step 5 with
  the type **Desktop app**, and choose that file.
- **Your school blocks it** ("blocked by your administrator"). Nothing is wrong
  on your end. Two ways around it:
  - **Forward school mail to your personal Gmail.** In school Gmail: Settings,
    **Forwarding and POP/IMAP**, add your personal address. Then on Accounts,
    turn on **Find homework** for the personal account.
  - **Subscribe to the school calendar as a feed.** In Google Calendar on a
    computer, open the school calendar's **Settings and sharing** and copy the
    **secret address in iCal format**. Put it in `engine/calendars.json` under
    the `school` entry and set `disabled` to `false`.

## Changing your mind

- **Stop using one account:** Accounts, **Disconnect**. Its sign-in is deleted,
  and anything captured from it that you hadn't confirmed is forgotten.
- **Revoke from Google's side:** [myaccount.google.com/permissions](https://myaccount.google.com/permissions),
  find Mellow, **Remove access**. Works even with the computer off.
- **Delete everything:** delete the project in Google Cloud. Every sign-in it
  issued stops working at once.

---

## Letting friends skip this (a shared sign-in)

This part is for whoever publishes Mellow, not for someone setting it up.

Mellow can come with one shared Desktop client, so friends only click
**Connect**. If `engine/google-shared-client.json` exists, Accounts skips the
checklist, and a friend's own client still wins if they add one. Each friend's
sign-ins stay on their own computer: sharing the client doesn't share anyone's
mail with you.

1. Make a **separate** Google Cloud project for it, for example `Mellow
   shared`. Don't reuse your personal project: the packager refuses a shared
   client from the project your own sign-ins use.
2. Do steps 2 to 5 above in that project, and publish it.
3. Save the downloaded file as `engine/google-shared-client.json` in your
   Mellow folder, then build a release with `install/prepare-release.ps1`.

   Windows hides file extensions, so renaming can leave you with
   `google-shared-client.json.json`, which nothing picks up. Check the name in
   the folder, or run `dir engine\google-shared*` and make sure there is only
   one `.json`. The engine log says `Google: client …` at startup, and the
   packager prints "Including the shared Google client" when it finds it.

The file goes into the release downloads, but it is left out of the GitHub
repository (the repo's `.gitignore` skips `engine/*.json`). Google treats a
Desktop app's client secret as not truly secret, but it is still public once
it's in a download.

What Google allows, as of September 2026:

- **Up to 100 people.** Until the app passes Google's verification, the first
  100 accounts that connect are all it will ever take, and each one sees the
  "hasn't verified this app" screen.
- **More than that needs verification.** Gmail read access is a *restricted*
  scope. Google requires a verified app (home page, privacy policy, a demo
  video) and, for apps that can reach the data through a server, an annual
  third-party security assessment. Mellow runs on each person's computer, but
  it sends some email content to Claude (billing emails, and anything the
  assistant is asked to read), and Google may count that. Check the current
  rules before going past 100:
  [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- **School accounts** may still be blocked by their school, whichever client
  is used.
