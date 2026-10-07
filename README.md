# pont
Bridging the context between humans and agents

See [USER-STORY.md](USER-STORY.md) for the product vision, MVP scope, and user stories.

## Quickstart

Requires Docker with Compose v2.

```sh
docker compose up -d --wait
```

The first start takes about a minute. No configuration is needed. To change ports or passwords, copy `.env.example` to `.env` and edit it.

| What | URL | Default login |
|---|---|---|
| pont | http://localhost:3000 | — |
| Keycloak admin console (create pont user accounts in the `pont` realm) | http://localhost:8080/admin | `admin` / `admin` |
| MinIO console (knowledge files) | http://localhost:9001 | `pont` / `pont-minio-dev` |

Check that every service is up:

```sh
curl http://localhost:3000/api/health
```

The default passwords are for local development only. Change them in `.env` before running pont anywhere else.

## Services

| Service | Role |
|---|---|
| `frontend` | React app, served by nginx, which also proxies `/api` to the server |
| `server` | Node.js REST API for the frontend, and later the MCP endpoint for agents |
| `minio` | Stores knowledge files as Markdown, with bucket versioning for history (`minio-init` creates the bucket on startup) |
| `redis` | Redis Stack: document chunks and vectors for hybrid search |
| `postgres` | Databases for Keycloak and pont |
| `keycloak` | Login and user accounts (the `pont` realm is imported on startup) |

## Development

```sh
docker compose up -d --build   # rebuild after code changes
docker compose logs -f server  # follow server logs
docker compose down            # stop (keeps data)
docker compose down -v         # stop and delete all data
```
