# Sync

`sync(app, since)` pulls what the harness adapters read into `sessions` and `events`, then records each live session's state. Sync owns every write to those two tables; other features read them with their own Drizzle queries.

## The run

For each adapter in `app.adapters`, in order:
1. `listSources(since)`.
2. For each source, `readSource(path, ingested)`, where `ingested` is the stored record and `read_offset` for that `source_path`, or `null`. A `null` read stores nothing.
3. Store the read in **one transaction per source**: the session row with its new `read_offset`, then its events. A source that fails to store rolls back whole, so its offset never runs ahead of its events.
4. Snapshot the adapter's recently active sessions and write their state.

## The report

`sync` returns a `SyncReport` and never throws for an adapter's failure:
- `sources`: reads that returned, `null` included; `sessions`: reads stored; `events`: events stored (dropped tool results aren't counted).
- `warnings`: each read's `warnings`, plus tool results that had no call and snapshot entries for sessions it wasn't asked about.
- `failures`: each `SyncIssue` names the harness, the step (`list`, `read` or `snapshot`), the source when there is one, and the message.

**A non-empty `failures` means the run is half-finished,** and the commands must exit non-zero on it after printing what did sync. Until streams A and B merge, both real adapters throw "not implemented", so every real run reports two `list` and two `snapshot` failures.

## Failure isolation

Each step fails on its own and the rest carry on, because one broken transcript shouldn't hide every other session:
- **`listSources` throws:** that adapter reads nothing, but its snapshot still runs over the sessions already stored.
- **`readSource` throws, or its read can't be stored:** that source keeps its old offset and is retried next run; the other sources still sync.
- **`snapshot` throws:** no state changes for that adapter. Sync doesn't mark sessions `ended` when it couldn't look.
- **Two sources claim one session id:** the second fails instead of moving the session to its path. The contract says this never happens, so it's an adapter bug.
- **A source's transaction begins `immediate`,** because it reads the stored row before it writes. In WAL mode, a deferred transaction that has read fails its first write with `SQLITE_BUSY_SNAPSHOT` when another run committed in between, and `busy_timeout` doesn't retry that. `immediate` takes the write lock up front, so two runs at once wait for each other instead of failing.

## Sessions

- **A new session starts `ended`,** with `observed_at` set to its `last_event_at`: until a snapshot sees it live, the transcript is the only witness, and the snapshot that runs right after corrects it.
- **A read overwrites the transcript fields** (title, `cwd`, `branch`, parent, start time) but never `state` or `observed_at`. Adapters carry the stored record forward and change only what new lines change, so a snapshot's `cwd` survives a read with nothing new.
- **`last_event_at` is the newest `at` seen,** across the stored value and the read's events, tool results included: a finished call is activity. A session without events uses `started_at`.

## Events

- **Events upsert on `(session_id, key)` with `onConflictDoUpdate`,** in the order the adapter returned them, because `events.id` is ingest order.
- **A conflicting `tool_call` updates its text, time, name and target but not `tool_status`,** so re-reading a rewritten file never resets a finished call to `pending`.
- **A `tool_result` updates only `tool_status`** of the stored call with its key. One without a stored call is dropped with a warning: calls precede results in a transcript and offsets only advance past complete lines, so a missing call means the adapter lost it, and storing a call-less row would invent an event.

## Snapshots

- **"Recently active" is the adapter's sessions whose source this run listed, or whose `last_event_at` is at or after `since`, or that are still marked `busy` or `idle`.**
  - Listed sources count because `listSources` goes by file modification time: a live session whose recent lines carry no events (a title, a hook) would otherwise be stored `ended` and never looked at.
  - Still-live sessions count so a long-idle one that fell out of the window can still be seen to end.
- **A live entry overwrites `state`, `cwd` and `branch`** and sets `observed_at` to `app.now()`.
- **A candidate the snapshot leaves out becomes `ended`,** with `observed_at` set to now, only when it wasn't `ended` already. Repeated runs then leave ended sessions untouched.
