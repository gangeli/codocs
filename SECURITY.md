# Security

## Service Account (Bot Identity)

Codocs uses a Google service account (`codocs-bot`) to post comment replies so
they appear from a shared "Codocs Bot" identity rather than the user's personal
account. The service account key is **intentionally bundled** in the repository
at `service-account.json` so that all installations share the same bot
identity. A local override can be placed at
`~/.local/share/codocs/service-account.json` (takes precedence over the bundled
key). The account has **no project-level IAM roles** — it can only access
documents that have been explicitly shared with it at the `commenter` level.
When the Codocs server starts, it shares each target document with the bot
using the user's OAuth2 credentials, and revokes that access on shutdown so the
bot does not accumulate permissions across sessions. Before posting any reply,
Codocs also verifies that the current user's OAuth2 token can still access the
document; if the user has lost access the bot will not post on their behalf.

### Residual risks

Because the service account key is bundled in the repository, any holder of the
code can use it to call the Google Drive API directly, bypassing the in-process
access check. The key is a long-lived credential that cannot be scoped
per-user. Mitigations include: (1) the bot's access to each document is revoked
at shutdown, limiting the window of exposure; (2) the bot has no project-level
permissions, so the key cannot access arbitrary GCP resources; (3) the bot can
only act on documents explicitly shared with it — knowing a document ID is not
enough. For higher-assurance deployments, a server-side proxy that validates
the caller's identity before posting replies would eliminate client-side trust
entirely.
