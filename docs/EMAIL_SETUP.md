# Email Setup

This toolkit uses a standard SMTP + IMAP pattern:

- SMTP to send HTML email
- IMAP append to save the same message to Sent

## Required Inputs

- SMTP host
- SMTP port
- IMAP host
- mailbox username
- mailbox password

## Recommended Pattern

1. Build a temporary `.eml` file with:
   - `From`
   - `To`
   - optional `Cc`
   - `Subject`
   - `MIME-Version`
   - `Content-Type: text/html; charset=UTF-8`
2. Send that `.eml` file via SMTP.
3. Append the same `.eml` file to the Sent folder via IMAP.

## Safety

- Store credentials in your system keychain or secret manager.
- Do not commit credentials, mailbox names, or server passwords.
- Keep example emails generic in the repo.
