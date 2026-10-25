# Security policy

Ghostr is an end-to-end encrypted messenger. Its security claims are only worth
something if they can be checked and challenged. If you find a flaw, please
tell us before you tell anyone else.

## Reporting a vulnerability

Email **g6042044@gmail.com** with the subject line `[ghostr-security]`.

Please include:

- what is affected (client, gateway, relay, push proxy, database schema);
- how to reproduce it, or the reasoning that shows the flaw;
- the impact you believe it has (which security property is broken, for whom).

You should receive an acknowledgement within **5 working days**. We will keep
you informed as we confirm, fix and release. We ask for **90 days** before
public disclosure, or less once a fix has shipped.

There is no bug bounty programme. Credit is given in the release notes unless
you prefer to stay anonymous.

## Scope

In scope: everything in this repository, and the production services it
describes (OHTTP gateway, Cloudflare relays, exit relay, push proxy, database
schema and policies).

Out of scope: denial of service by volume, issues that require a compromised
device or operating system, social engineering, and third-party services
(Supabase, Cloudflare, Google Cloud, Fly.io, Apple, Google) themselves.

## What we consider a vulnerability

Anything that breaks a property the application claims:

- a party other than the recipient can read a message or listen to a call;
- a server can link a message to its sender, or two messages to one another
  beyond what the architecture already documents (see `README.md`);
- an attacker can impersonate a contact, or the server can swap keys unnoticed;
- data that should have been deleted (48-hour retention) is still retrievable;
- a client can be made to leak its IP address to the gateway or the database.

## Hardening the report

Please do not test against production in ways that affect other users. The
Node servers run locally with `npm start`, and `supabase/schema.sql` builds the
database from scratch on a `supabase/postgres` Docker image.
