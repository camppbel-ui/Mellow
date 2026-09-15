# Connecting your Google accounts

Mellow reads your school and personal Gmail and Google Calendar. To do that,
Google needs Mellow registered as an app. That registration is yours, lives in
your own Google Cloud project, costs nothing, and takes about ten minutes. You do
it once, and it covers both accounts.

**What Mellow gets:** read-only access to mail and calendars. It cannot send,
delete, archive or label an email, and cannot change a calendar. Google's consent
screen will list exactly those two read permissions and nothing else.

**What stays on your PC:** the sign-ins, in `engine/google-tokens.json`. They are
never sent anywhere except back to Google.

---

## 1. Create the project

Do this signed in as your **personal** account, `you@gmail.com`. School
Google accounts are often not allowed to create Cloud projects.

1. Go to **console.cloud.google.com**. Accept the terms if it asks.
2. Click the project picker at the top, then **New project**.
3. Name it `Mellow` and click **Create**. Make sure it is selected afterwards.

## 2. Turn on the two APIs

1. In the search bar at the top, type **Gmail API**, open it, click **Enable**.
2. Search **Google Calendar API**, open it, click **Enable**.

If you skip this, connecting works but syncing fails with a message telling you
which API is off.

## 3. Set up the sign-in screen

Google has renamed this area a few times. Look for **Google Auth Platform**, or
**OAuth consent screen** under APIs and Services.

1. **Branding** (or App information): app name `Mellow`, and your personal email
   for both support and developer contact. Save.
2. **Audience** (or User type): choose **External**.
3. Under **Test users**, click **Add users** and add **both**:
   - `you@gmail.com`
   - your school email address

   An account that is not on this list gets "access denied" when it tries to
   connect, which is the most common thing to trip over.

You do not need to add scopes on this screen. Mellow asks for them itself when
you connect.

## 4. Create the client and download it

1. Go to **Clients** (or **Credentials**, then **Create credentials**, then
   **OAuth client ID**).
2. Application type: **Desktop app**. Not "Web application", which cannot send
   the sign-in back to your PC. Name it `Mellow desktop`.
3. Click **Create**, then **Download JSON**.

You get a file named something like
`client_secret_1234-abcd.apps.googleusercontent.com.json`.

4. Move that file into the `engine` folder inside your Mellow folder. The
   Guide in Mellow shows the full path on your computer.

   Do not rename it. Mellow finds it by name.

That file is what lets Mellow ask Google for sign-ins. Keep it out of screenshots
and anywhere public.

## 5. Connect the accounts

1. Open Mellow from the desktop icon and go to **Accounts**. The setup notice is
   gone once the client file is found.
2. Click **Connect school account**. Pick your school account in Google's chooser.
3. Google shows **"Google hasn't verified this app."** That is expected: it is your
   own app and nobody has reviewed it, including Google. Click **Advanced**, then
   **Go to Mellow**.
4. Tick both permissions and click **Continue**. You land back on Mellow with
   "Connected".
5. Click **Connect personal account** and repeat with your personal address.

The first sync starts straight away. Homework and calendar entries appear within
a minute.

---

## The 7-day catch, and how to avoid it

While the app's publishing status is **Testing**, Google expires its sign-ins
after **7 days**. Mellow will mark the account "Needs reconnecting" rather than
failing silently, and reconnecting takes ten seconds, but it is avoidable.

Under **Audience**, click **Publish app** and confirm. Publishing does not make
anything public. It only changes how long Google honours the sign-in. Because
Mellow asks for Gmail access, Google keeps showing the "hasn't verified" screen
when you connect, and that is fine for an app only you use.

If Google will not let you publish without going through verification, leave it
in Testing and reconnect once a week when Mellow asks.

---

## If your school blocks it

Universities can stop unapproved apps reading school accounts. You will know,
because connecting the school account ends with a message saying it is blocked by
your administrator, or with "access denied" even though you added it as a test
user.

Nothing is broken on your end if that happens. Two ways around it, and Mellow
supports both:

**Forward school mail to your personal Gmail.** In school Gmail, Settings, then
**Forwarding and POP/IMAP**, add your personal address. Some schools disable this
too. If it works, go to Mellow's Accounts page and tick **Find homework** on the
personal account, so assignments are picked up from the forwarded copies.

**Subscribe to the school calendar as a feed.** In Google Calendar on a computer,
open the school calendar's **Settings and sharing** and copy the **secret address
in iCal format**. Paste it into `engine/calendars.json` under the `school` entry
and set `disabled` to `false`. Calendar deadlines, exams included, are still
picked up, just without email.

---

## Changing your mind

- **Stop using one account:** Accounts, then **Disconnect**. Its saved sign-in is
  deleted, and anything captured from it that you had not confirmed is forgotten.
- **Revoke from Google's side:** myaccount.google.com/permissions, find Mellow,
  **Remove access**. This works even if the PC is off.
- **Delete everything:** remove the project in Cloud Console. Every sign-in it
  ever issued stops working at once.
