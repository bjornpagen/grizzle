# Agents working on grizzle

Read CONTRIBUTING.md before changing anything: its Code rules bind every change, and its "Settled decisions (do not
reopen)" are closed questions. Do not propose, prototype or reintroduce a settled decision's rejected design.

## Settled decisions (do not reopen)

- **No silent hashing: keys at PostgreSQL's natural limits, explicit SHA-256 digests, never md5 (2026-11-20,
  2026-11-21).** grizzle holds every key, UNIQUE, family axis, reference target and drafted lookup column as itself: it
  never installs a column over a digest of its own (no SHA-256 image of a key's text or numeric, no `md5` lookup
  expression), and never rewrites a statement to compare digests. A key whose widest entry, in any order of its
  columns, could pass PostgreSQL's B-tree limit (2,704 bytes), or that holds a text of no byte bound, is refused at
  compile as `UnrepresentableKey`, naming the relation, the key, the field and the fix. A drafted lookup leaves a bounded
  column that cannot fit out of its index, a filter beside it; one that binds a text of no byte bound by equality seeks
  by the digest its relation declares, or is refused as `UnrepresentableKey` (`undigestedText`) unless its other
  equalities bind a key. The rule is README "Keys and indexes". A schema sizes its keys
  from its data:
  - **Key texts are bounded at PostgreSQL's natural limits.** A key's text takes the byte bound its key's B-tree entry
    leaves it (`str.bytes(keyTextBytes(fields))`), checked against the longest value the real data holds, so almost
    every table keys by its texts as themselves.
  - **Only a field whose real data does not fit spills to an explicit digest**: a field the author declares beside it,
    `generated(sha256, Crypto.sha256(row.text))`, SHA-256's raw 32 bytes, which the key holds like any other field.
    grizzle states the digest's equality wherever a read states the text's (check/checker.ts `#stateDigests`), so the
    read seeks by the digest and rechecks the text. The digest's cost stands in the schema, where its author chose
    it; grizzle never derives one.
  - **Never md5.** Every digest grizzle and its tests compute is SHA-256. md5 stands only where an outside system
    defines the digest (an integration's own, such as Timeback's), never in grizzle.

  Bjorn, verbatim, 2026-11-20: "yes, if no one requires automatic hashing, and if it's spooky action, hard revert it,
  get grizzle green, and tell all the subagents to repin. huge keys are almost certainly a bug anyways, we should never
  be getting anywhere near the hash limit for grizzle right? can we please pin and document this so this never gets
  overturned again". 2026-11-21: "my problem was never hashes, it was SILENT hashes, TRANSPARENT hashes. zig
  philosophy, costs should be EXPLICIT, not implicit. hard refactor it everywhere"; "and never md5. lmfao. sha256";
  "hard cull all md5 … except when we integrate with timeback or externally"; and on the bounds: "so, data driven.
  postgres natural limits, for any fields that don't fit we spill over to explicit digests." Why:
  - **Costs are explicit.** A digest costs a column, a computation on every write and a read that states it. A schema
    that pays them says so; a hidden one changed what every statement over the key cost at a size no one wrote down.
  - **Action at a distance.** A key that crossed an invisible width moved to a hidden column, every statement over it
    changed shape, and a reference listing the same columns in another order could decide differently from the key it
    lands on.
  - **No consumer used it.** edullm's qti, pantry and learning-commons drafts and metis's qti held no key over a digest;
    the only images were md5 lookups beside one unbounded text, which a filter serves.
  - **Its bugs.** On 2026-11-20 alone it shipped six: a first write over an imaged text key compared bytea with text; a
    numeric key's write target bound the raw field; the installed-catalog checker refused the digest function's shape;
    one text carried two images, a key's SHA-256 and a read's md5, so a read by the key scanned its table; a migration
    adding a family's image copy left stored members NULL (23502), then broke the family's CHECK (23514); and a reference deciding images at its
    own column order referenced a column no unique constraint held.
  - **Big keys are a modelling bug.** An identity is a short name, a path or a digest, never a document. A schema that
    needs a long text's identity declares its digest as a field and keys by it, in plain sight.

- **A format change reaches a live installation by rebasing, and leaves stored representations alone (2026-11-21).**
  grizzle converts no committed record of another format. `grizzle upgrade` rebases a live installation onto this
  grizzle's compile of the source it was deployed from: it reads the live database's history (each roster's codes off
  its names constant, each table's attribute numbers, each pattern language's spelling, every fact proven by the drift
  check) and writes either the snapshot's files again, or a folder `grizzle migrate` applies, drafted by the normal diff
  from the target's objects the database holds (README "Upgrading across a format"). It writes nothing to the database.
  So, after edullm's production cutover, a format change must leave grizzle's bookkeeping tables (`__ledger`,
  `__drift_proofs`) and every stored column's type unchanged, unless it ships an explicit carried conversion: their rows
  are no rebase's to rewrite, and migrate reads the ledger before it applies anything. `grizzle upgrade` refuses such a
  change by name (UpgradeRefused, an object that holds stored rows held otherwise). Main's ruling on lane UPGRADE's
  rehearsal of format 5 to 6, which retyped the ledger's digests and could not be rebased. Why:
  - **The database is the authority** on what its stored codes and rows mean; a converted record could disagree with it.
  - **No migrate reads another format's ledger**, so a ledger change has no folder that could carry it.
