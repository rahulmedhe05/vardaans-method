# Vardaan's Method

A dashboard for sending personalized WhatsApp messages to your own opted-in
business contacts, via your own WhatsApp account (using `whatsapp-web.js`,
which drives WhatsApp Web).

**Use responsibly:** only message contacts who expect to hear from you.
Every message should include an opt-out instruction, and numbers that ask to
stop must be added to `optout.csv`.

## Setup

1. Copy `contacts.sample.csv` to `contacts.csv` and fill in your real
   contacts — columns `name,phone` (phone in international format, digits
   only, e.g. `919812345678`).
2. Edit `message.txt` (or use the Message tab in the dashboard) — your
   message template. Use `{{name}}` (or any other CSV column) as a
   placeholder.
3. Add any numbers that opted out to `optout.csv`.

## Run (dashboard)

```
npm install
node server.js
```

Open the printed URL in your browser. From there:
- **Connect** tab — scan the QR code with WhatsApp > Linked Devices.
- **Message** tab — edit and save your message template.
- **Contacts** tab — paste numbers or upload a CSV; delete individual
  numbers or strip invalid ones.
- **Send** tab — set delay between messages and between batches, then Dry
  Run or Start Sending.
- **Log** tab — live send progress.

The WhatsApp session is saved to `.wwebjs_auth/` so you won't need to
re-scan on every restart — don't delete that folder unless you want to log
out.

## Run (CLI, no dashboard)

```
node send.js --dry-run
node send.js --min=20 --max=60
```

## Deploying on Railway

This app needs a **long-running process with a persistent filesystem** for:

- the WhatsApp Chromium profile in `.wwebjs_auth/`
- `contacts.csv`
- `message.txt`
- `optout.csv`
- `sent-log.json`

On Railway, attach a **Volume** to the service and mount it at `/app/data`.
Railway documents that relative app data should be mounted under `/app/...`,
and exposes the mount path at runtime as `RAILWAY_VOLUME_MOUNT_PATH`.

This app will automatically use:

- `APP_DATA_DIR`, if you set it explicitly
- otherwise `RAILWAY_VOLUME_MOUNT_PATH`, if a Railway volume is attached
- otherwise the local app folder

Recommended Railway setup:

1. Add a Volume to the service.
2. Mount it at `/app/data`.
3. Redeploy.
4. Open the app, click **Connect WhatsApp**, and scan the QR code again.
5. After that, future restarts should reuse the saved session from the volume.

If no volume is attached, the app may appear to work briefly but will lose the
WhatsApp session and local files on restart or redeploy.

## Deploying on Replit

This app needs a **long-running process with a persistent filesystem** (for
the Chromium session and the WhatsApp login) — it will not run on
serverless platforms like Vercel. Replit works if you enable an "Always
On" / Reserved VM deployment so the process (and your WhatsApp session)
doesn't get killed when you close the tab.

## Notes

- `sent-log.json` tracks who's been messaged so re-running won't
  double-send — delete a contact's entry from that file to resend to them.
- Numbers not on WhatsApp are skipped automatically and logged as
  `not_registered`.
- `whatsapp-web.js` is an unofficial library that automates your personal
  WhatsApp Web session. It's against WhatsApp's Terms of Service for bulk/
  automated messaging, and using it carries a real risk of your number being
  banned. For anything beyond a small, genuinely opted-in contact list,
  consider migrating to the official WhatsApp Business Platform (Cloud API).
