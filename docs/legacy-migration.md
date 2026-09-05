# Migrate a legacy book

Videobook discovers schema-v4 books without opening their catalogs with the current engine. Discovery leaves the source unchanged. Migration requires an explicit confirmation through the MCP tools.

1. Call `list_legacy_books`. Review the source book ID, source head revision, migration key, counts, and reported issues. Resolve errors such as missing media before migrating.
2. Call `migrate_legacy_book` with `book_id`, `expected_source_head`, and `expected_migration_key` from that preview. The response contains the durable job and migration status. A changed source requires a fresh preview and confirmation.
3. Poll `get_legacy_migration` with `book_id` and `migration_key`. The phases are `copying`, `switching`, `indexing`, and `complete`. Copy progress includes the engine phase and completed/total units. The final result includes the migrated book, conversion report reference, original source head, `legacyArchiveRoot`, and `reindexJobIds`.

Migration copies current notebook, media, and timeline state into a separate destination. It validates the destination before replacing the library entry. The original source moves to the returned archive location with its catalog and media bytes preserved. The conversion report records the historical import link and conversion decisions, including legacy generation models. Unsupported old generation tools remain visible for review; migration does not submit generation requests.

Video and audio streams are registered from the original media, including media outside the old timeline. Each media artifact receives one durable job for current search indexing. These jobs appear in the migrated book's `list_jobs` results. Video indexing prepares missing sampled frames without replacing the original media. A completed migration means indexing has been scheduled; check the index jobs and search coverage for readiness. Local model availability can leave semantic indexing deferred.

## Cancel or recover

Call `cancel_legacy_migration` with `book_id` and `migration_key` to cancel queued or copying work. Cancellation is unavailable once the final switch begins. A cancelled job stays cancelled across restarts. Submit the same confirmed migration again to retry it explicitly.

Shutdown stops copying safely. After restart, interrupted jobs resume through the durable queue, with up to three attempts per submission. If attempts are exhausted, inspect the job error, resolve its cause, and submit the confirmed migration again. Repeated active or completed submissions return the existing work; they do not duplicate the book or its index jobs.

The switch journal handles interruption between archiving the old source and publishing the new book. Recovery restores an archived source when publication did not finish, then validates the source and destination before retrying. Source edits detected before the switch leave the old book available; reopen the library to obtain a fresh preview.

Back up the entire library while Videobook is stopped, including `.migration-runtime`, `.legacy-v4`, and any `.migrating-*` directories. These hidden directories contain durable jobs, archived sources, and recovery candidates. Retain them during migration and recovery. Migration does not remove the original archive after success.
