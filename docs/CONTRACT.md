# Contract with claude-terminal

loon is a separate app and repo from claude-terminal, but it plugs into the same
per-user hosting model. This is the whole boundary between them. claude-terminal
and the claude-router only need to know what is written here.

The typed version lives in `shared/src/contract.ts`.

## Hosting model

Each user gets a loon instance on a port, the same way guest-claude maps a user
to a ttyd port in `guests.tsv`. The claude-router points a user at their port on
login. loon can run in its own container or co-located beside a user's
claude-terminal. Only the port and the workspace path differ.

The code stays separate. The two apps talk only through the manifest below and
through the shared `claude` binary.

## Discovery

A running loon instance serves a manifest at:

```
GET /.well-known/loon
```

```json
{
  "contract": "0.1.0",
  "name": "loon",
  "version": "0.1.0",
  "workspace": "/abs/path/to/user/projects",
  "user": "ian",
  "aiAvailable": true
}
```

The router health-checks and routes with this. No loon internals leak across.

## AI and auth

loon does not own authentication and has no API key. It reuses the user's Claude
subscription by invoking the local `claude` binary in headless mode inside the
user's workspace, exactly as claude-terminal does for a ttyd session. If the
binary is missing, `aiAvailable` is false and the assistant is disabled, but the
editor still works.

## Per-user binding

The router needs three things to bring up or point at an instance:

```
user      matches the guests.tsv name
port      the instance's port
workspace the user's project directory (an ncdata path syncs to Nextcloud)
```
