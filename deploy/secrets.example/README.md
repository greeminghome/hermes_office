# Runtime secrets

Do not put real credentials in this example directory. The installer creates
`deploy/secrets/`, which is ignored by Git and mounted read-only at
`/run/secrets`.

Supported files:

- `reservation_sources.json`: private Hourplace and SpaceCloud iCal URLs
- `google_client_secret.json`: Google Drive read-only OAuth client
- `google_office_readonly_token.json`: Google Drive read-only OAuth token
- `telegram.json`: optional Telegram bot configuration

Reservation Google OAuth credentials and refreshed tokens are written to the
private `office-reservations` Docker volume by the authenticated Office UI.
