# MongoDB Atlas Setup

The application connects to Atlas with the MongoDB Node.js driver from its server routes. The browser never connects directly to Atlas. A database username, password, connection string, and an allowed application-server IP address are sufficient; an Atlas Administration API key is not needed for normal application storage.

## Create the Atlas Resources

1. Sign in to [MongoDB Atlas](https://cloud.mongodb.com/) and create or choose the intended organization and project.
2. Create a cluster in a suitable region. The Free cluster is adequate for a small demo. Confirm the tier before creating anything with billing implications.
3. Under database access, create a dedicated application database user. Give it `readWrite` on the `rentescrow` database only, and restrict it to this cluster where available. Do not give the application an Atlas administrator or `readWriteAnyDatabase` role.
4. Under network access, add the development machine's current public egress IP address. A deployed server needs its own allowed egress address or supported private networking. Do not use permanent `0.0.0.0/0` access as the default setup.
5. Open the cluster's **Connect > Drivers** connection instructions, select Node.js, and obtain the `mongodb+srv://` connection string. Use the database user's credentials, not the Atlas website login.

See MongoDB's official [connection prerequisites](https://www.mongodb.com/docs/atlas/connect-to-database-deployment/), [database-user configuration](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/), and [IP access-list documentation](https://www.mongodb.com/docs/atlas/security/ip-access-list/).

## Configure This Application

Set these server-only variables in the ignored `.env.local` file at the project root, or in the hosting provider's secret environment settings:

```dotenv
RENTESCROW_STORAGE=mongodb
MONGODB_DATABASE=rentescrow
MONGODB_URI=mongodb+srv://APP_USER:URL_ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority&appName=RentEscrow
```

Replace the placeholders with the connection information from Atlas. Percent-encode reserved characters in the username and password, not the entire URI. Keep the URI out of source control, client-side code, `NEXT_PUBLIC_*` variables, screenshots, and chat. MongoDB documents [connection-string escaping and common connection failures](https://www.mongodb.com/docs/atlas/troubleshoot-connection/).

Run the connection check, then restart the application so it loads the new environment:

```sh
pnpm db:check
pnpm dev
```

`db:check` loads `.env.local`, connects, initializes the application indexes, pings the database, and inserts/reads/deletes its own temporary probe in `_connection_checks`. It is not an Atlas provisioning command. A successful check does not establish that backups, production authentication, or every application workflow is configured. Next, create a case, upload a small test file, refresh, and confirm both persist. Test this with non-sensitive data first.

When MongoDB storage is selected, failures are reported to the application. There is no silent fallback to local files. If a connection fails, check the database user's permissions, IP access list, URI escaping, DNS, and outbound network access before retrying. Avoid sharing the full connection string in diagnostic output.

## What Is Stored

| Collection | Contents |
| --- | --- |
| `sessions` | Session ownership, cases, addresses, landlord contacts, messages, expenses, rent records, escrow audit history, evidence metadata, and file references |
| `evidence.files` | GridFS file metadata, including owner/case/evidence binding, byte length, MIME type, and SHA-256 integrity information |
| `evidence.chunks` | Uploaded image and PDF bytes |

Uploaded documents, including supported filing PDFs, are persisted in Atlas when attached to a case. This does not create a separate court-filing submission workflow. Bundled public demo images and application code remain static application assets, not user uploads.

The implementation is in `src/lib/server/mongodb.ts` and `src/lib/server/mongodb-store.ts`. Connections are reused with a bounded pool. Startup initializes the unique session-owner index and GridFS indexes. File reads verify the expected owner, case, evidence identifier, MIME type, length, and SHA-256 digest before returning bytes. Session updates use a revision check to reject conflicting writes.

Current application limits are 5 MiB per uploaded PNG, JPEG, WebP, or PDF; 32 MiB per hydrated session; and 12 MiB of MongoDB session metadata. GridFS keeps uploaded file bytes out of the session document's BSON size budget. The API currently hydrates evidence back into its existing response shape, so GridFS does not remove the application-level session limit or the cost of returning large sessions.

## Existing Local Data and User Identity

Switching `RENTESCROW_STORAGE` does **not** automatically import `.data/sessions` files. Existing local data is retained on disk. An existing browser session that has no matching Atlas record starts a new session. Export any cases you need before switching, and plan an explicit, backed-up migration if existing records must move into Atlas. Do not bulk overwrite Atlas session documents or merge owners without a reviewed migration.

The current application identifies owners using a secure browser-session cookie, not registered accounts. Its cookie expires after 30 days, and losing it loses access to that session even though Atlas still retains the records. Atlas persistence does not provide sign-in, password recovery, cross-device access, or automatic deletion. Add authenticated user identity and an explicit retention policy before accepting production tenant records.

Reverting to local storage is a configuration rollback only; it does not move Atlas records back to disk. Preserve both data sets and use an explicit migration if records need to be consolidated.

## Backups and File Cleanup

The Atlas Free cluster currently has 0.5 GB of total storage, including indexes, and no managed backups. It is intended here for development, not as the sole durable archive for sensitive filings. Monitor capacity, select a backup-capable tier when needed, and validate restoration before relying on the deployment. See the official [Free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) and [backup documentation](https://www.mongodb.com/docs/atlas/backup-restore-cluster/).

A backup must include `sessions`, `evidence.files`, and `evidence.chunks` from the same database. Backing up only `sessions`, or only the GridFS metadata collection, loses file content. For a manual backup on a Free cluster, stop application writes while taking a database-scoped `mongodump`, protect the backup as sensitive data, and rehearse a `mongorestore` into an isolated database. Do not restore over the live database without a separately reviewed recovery procedure.

GridFS does not participate in multi-document transactions. The application uploads immutable file versions before updating a session reference. A definite revision conflict triggers best-effort cleanup of only the newly uploaded files from that attempt. When a database acknowledgement is ambiguous, new files are retained because the session write may have committed. Superseded files and files removed by a demo reset are also retained to avoid breaking in-flight readers. See MongoDB's [GridFS consistency guidance](https://www.mongodb.com/docs/manual/core/gridfs/).

There is deliberately no automatic retention or orphan-deletion job yet. Until one is implemented, perform cleanup only as an operator-controlled maintenance task:

1. Stop all application writers and allow in-flight reads/uploads to finish. Take a full backup.
2. Collect all GridFS file IDs referenced by all `sessions` documents, not just the current browser's session.
3. Review unreferenced `evidence.files` records and any `evidence.chunks` entries without a corresponding file record. Partial uploads or interrupted cleanup can leave these behind.
4. Recheck references immediately before deleting approved orphan files and their chunks. Do not delete by filename, user-supplied identifier, upload age alone, or an unreviewed query.
5. Verify retained files can be read, their integrity checks pass, and the backup can restore a sample case and attachment.

Demo reset is not a secure-erasure or legal-retention feature. Establish retention, deletion, recovery, and access-control requirements before storing real user filings.
