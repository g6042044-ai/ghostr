# Ghostr

End-to-end encrypted messenger for iOS and Android. No phone number, no email,
no address book. Post-quantum Triple Ratchet, sealed sender, split-trust
routing so that no single server sees both who you are and what you send.

- Website: https://g6042044-ai.github.io/ghostr-website/
- Source: https://github.com/g6042044-ai/ghostr
- Security reports: see [`SECURITY.md`](SECURITY.md)
- License: [AGPL-3.0-only](LICENSE)

The app is published on the App Store and Google Play. This repository holds
the complete client and every server it talks to. What is **not** here is
listed at the end.

## Architecture in one page

```
                 sees IP, never content                sees content*, never IP
┌────────┐   ┌─────────────────────┐   ┌──────────────────────┐   ┌──────────────┐
│ Client │──▶│ Cloudflare relay    │──▶│ OHTTP gateway        │──▶│ Supabase     │
│        │   │ (Worker)            │   │ (Node, Cloud Run)    │   │ (PostgreSQL) │
└────────┘   └─────────────────────┘   └──────────┬───────────┘   └──────────────┘
                                                  │ encrypted push blob
                                        ┌─────────▼───────────┐   ┌──────────────┐
                                        │ Push proxy (Fly.io) │──▶│ FCM / APNs   │
                                        └─────────────────────┘   └──────────────┘

Calls: Client ──▶ Entry relay (Worker) ──▶ Exit relay (Fly.io) ──▶ SFU (Worker)
```

\* "Content" means the end-to-end encrypted payload and the recipient's
**daily tag**, a pseudonym that rotates every 24 hours. The gateway cannot
read messages; it needs the tag to route them.

| Component | Path | Runs on | Sees | Never sees |
|---|---|---|---|---|
| Mobile app | `src/`, `App.tsx` | iOS, Android (React Native / Expo) | everything, locally | — |
| Anonymous relay | `cloudflare-relay/worker.js` | Cloudflare Workers | client IP | request content |
| OHTTP gateway | `ohttp-gateway/` | Google Cloud Run (`europe-north1`) | encrypted payload, recipient tag, timing and size bucket | client IP, sender, plaintext |
| Database | `supabase/schema.sql` | Supabase (PostgreSQL) | tags, encrypted payloads, encrypted blobs, 48 h retention | IP, identities |
| Push proxy | `push-proxy/` | Fly.io (`cdg`) | native push token, for the time of one send | IP, message, who talks to whom |
| Entry relay | `cloudflare-relay/entry-relay-worker.js` | Cloudflare Workers | client IP | call content |
| Exit relay | `exit-relay/` | Fly.io (`cdg`) | SFU address | client IP |
| SFU (1-to-1 calls) | `cloudflare-relay/sfu-worker.js` | Cloudflare Durable Objects | encrypted media frames | client IP, keys |
| Invite landing | `cloudflare-relay/invite-worker.js` | Cloudflare Workers | nothing: the invite secret stays in the URL fragment | the secret |

### Cryptography

| Layer | What | Where |
|---|---|---|
| Key agreement | PQXDH: X25519 + ML-KEM-768 (FIPS 203), hybrid | `src/services/tripleRatchet/pqxdh.ts` |
| Messaging | Triple Ratchet: double ratchet plus SPQR, a sparse post-quantum ratchet that re-encapsulates ML-KEM every 20 messages | `src/services/tripleRatchet/` |
| Deniability | Ed25519 signatures replaced after the handshake by a MAC both parties can compute | `pqxdh.ts` |
| Sender privacy | Sealed sender: short-lived HMAC certificates, the server never learns who sent a message | `ohttp-gateway/server.js`, `src/services/sealedSenderCache.ts` |
| Routing | OHTTP-style split trust: requests are NaCl-boxed to the gateway and carried by a relay that only sees the IP | `src/services/relayTransport.ts`, `cloudflare-relay/worker.js` |
| Addressing | Daily rotating tags, decoy tags and constant-rate polling so that traffic patterns do not reveal conversations | `src/services/epochTags.ts`, `decoyService.ts`, `constantTraffic.ts` |
| Media | Encrypted blobs uploaded through the gateway only, purged after 48 h | `src/services/encryptedBlobService.ts`, `ohttp-gateway/blobSweep.js` |
| Backups | Argon2id-derived key, secretbox | `src/services/kdf.ts`, `migrationService.ts` |
| Key transparency | Safety numbers and key pinning in the client; Merkle tree of gateway keys | `src/services/keyTransparency.ts`, `ohttp-gateway/keyTransparencyTree.js` |

Every primitive comes from a published specification or standard. There is no
custom cipher. The `src/services/tripleRatchet/README.md` file goes deeper.

### What the architecture does not hide

Written down so nobody has to discover it:

- The gateway sees the **recipient tag** (rotates daily), the **time** and the
  **size bucket** of each send. Constant-rate traffic drowns these signals, it
  does not remove them.
- Cloudflare sees the **IP address** of every client. The gateway never does.
- Push notifications go through Apple and Google. They carry no content and no
  sender; the push proxy only ever sees a token, not who it belongs to.
- Metadata retention on the server is 48 hours for messages and blobs,
  30 days for pending invitations.

## Repository layout

```
App.tsx, src/            React Native / Expo client (TypeScript)
  services/              crypto, transport, tags, calls, push, storage
  screens/, components/  UI
  i18n/, locales/        French and English strings (checked by npm run i18n:check)
ohttp-gateway/           OHTTP gateway: Node server, Dockerfile, key tools
cloudflare-relay/        Cloudflare Workers: relay, entry relay, SFU, invite landing
exit-relay/              Second hop for calls (Node, Fly.io)
push-proxy/              Split-trust push proxy (Node, Fly.io)
supabase/                schema.sql (tables, RLS, functions, cron) and migrations
plugins/                 Expo config plugins (call notifications, ringtones)
patches/                 patch-package patches applied by npm ci
scripts/                 i18n check, test runner, notice signing
```

## Building

Prerequisites: Node 20 or later, npm, Docker for the gateway image and database
replica. Cloudflare's `wrangler` needs Node 22.

```
npm ci                         # also applies patches/ via postinstall
cp .env.example .env           # fill in the URLs and keys of YOUR deployment
npx expo start                 # development client
npx expo export --platform ios --output-dir /tmp/ghostr-export   # production bundle
```

Store builds use [EAS](https://docs.expo.dev/build/introduction/) with the
profiles in `eas.json`. The values there are public by design: they are
compiled into the binary.

Servers run with `npm start` in their own directory, or from their
`Dockerfile`. The database is built from scratch with
`psql -v ON_ERROR_STOP=1 -f supabase/schema.sql` against a
`supabase/postgres:17` image; it ends with `ALL CHECKS PASSED`.

## Verifying

```
npm run test          # protocol codecs and cross-version interoperability
npm run i18n:check    # missing keys, placeholder parity between fr and en
npx tsc --noEmit      # type check; 63 known legacy errors are tracked and shrinking
node --check ohttp-gateway/server.js
```

## What is not in this repository

- Private keys of any server (gateway, push proxy, notice signing), store
  credentials and keystores, Apple and Google service account files.
- The configuration of the production Supabase project. `supabase/schema.sql`
  builds an equivalent database; the migrations folder records what was
  applied to production, in order.
- The project's internal planning documents.

Everything you need to run your own instance is in the code and in
`.env.example`. If something is missing, open an issue.

## Contributing

Issues and pull requests are welcome. Please read `SECURITY.md` before
reporting anything that could affect users of the published app. Changes to
cryptography must state which security property they preserve and which they
move. The published app and its servers must stay interoperable: never change a
wire format without a versioned migration path.

## License

Ghostr is free software under the GNU Affero General Public License,
version 3 only. If you run a modified version of any Ghostr server for others,
you must publish your changes. See [`LICENSE`](LICENSE).

The Ghostr name and logo are not covered by the license.
