# Authentication & Authorization Flow

## Token Management

1. **Long-lived refresh token**: Stored as an HTTP-only cookie with a 30-day TTL
2. **Token exchange**: User sends refresh token to the API server, receives a short-lived JWT in return, and the refresh token is rotated
3. **JWT properties**:
   - 15-minute TTL (limits damage window if compromised)
   - Contains the persistentID
   - Stored in memory only (lost on page refresh)

## WebSocket Authorization

1. **WebSocket connection**: When user connects, server validates the JWT and creates a `clientID => persistentID` mapping, establishing that this client is authorized to act on behalf of this persistent identity

2. **Post-connection authorization**: Once WebSocket connection is established, no further token verification is needed. For actions like pause requests, simple ownership checks suffice.

## Key Insight

JWT verification happens once at WebSocket connection time. After that, the established mapping allows for lightweight authorization checks based on clientID rather than repeated token validation.

## Development Mode

When running the game in development, the API server is not active, so the game falls back to checking only persistentIDs for verification instead of JWTs. This is less secure, as stealing a persistentID means the attacker has indefinite control of the victim's account.

## Desktop client

The Electron client serves its renderer from a stable local HTTP origin and
copies the OAuth broker's HTTP-only refresh cookie into that origin. The main
renderer confirms `/auth/refresh` before the broker window closes; the short-
lived JWT remains in memory and is refreshed when it becomes stale.

The local persistent UUID is a device identifier only. It is accepted by the
development server but must never be sent as the production play token. A
production desktop build requires an API-issued JWT and a real production
Turnstile sitekey configured through `OPENFRONT_TURNSTILE_SITE_KEY` when the
desktop bundle is built. The widget must allow the desktop renderer's
`127.0.0.1` hostname (and the server's Turnstile secret must belong to the
same widget); a website-only hostname configuration will reject desktop
tokens. Turnstile response tokens are generated immediately before a first
join, are single-use, and are never persisted.
