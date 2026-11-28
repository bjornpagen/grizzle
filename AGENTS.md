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
  equalities bind a key. The rule is docs/limits.md "Keys and indexes". A schema sizes its keys
  from its data:
  - **Key texts are bounded at PostgreSQL's natural limits.** A key's text takes the byte bound its key's B-tree entry
    leaves it (`str.bytes(keyTextBytes(fields))`), checked against the longest value the real data holds, so almost
    every table keys by its texts as themselves.
  - **Only a field whose real data does not fit spills to an explicit digest**: a field the author declares beside it,
    `generated(sha256, Crypto.sha256(row.text))`, SHA-256's raw 32 bytes, which the key holds like any other field.
    grizzle states the digest's equality wherever a read states the text's (check/checker.ts `#stateDigests`), so the
    read seeks by the digest and rechecks the text, and a query whose head copies the text carries the declared digest
    beside it, by lineage, wherever its reader equates the text (check/carry.ts): the carried column is the relation's
    own digest field, never one grizzle computes. The digest's cost stands in the schema, where its author chose it;
    grizzle never derives one.
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

- **Migration bankruptcy: no installation crosses a format; purge and regenerate (2026-11-26).** grizzle reads exactly
  its own format (core/format.ts) and carries nothing of another forward: no command reads, converts or rebases another
  format's snapshot, manifest, meta.json or ledger, and no code cleans up what an older format left in a database.
  An artifact or installation of another format is refused, with one remedy: drop the installation (`grizzle
  uninstall`), empty its migrations directory, and regenerate, `grizzle generate` drafting the schema afresh as one
  init migration that `grizzle migrate` installs. A format change ships no converter, no rebase and no tolerance of the
  format before it. `grizzle generate` and `grizzle migrate` between versions of a consumer's own schema (the diff, data
  steps, renames, drift, the ledger of applied folders) are the product and stay. This replaces the 2026-11-21 ruling
  that a format change reaches a live installation by rebasing (`grizzle upgrade`, deleted with its readers). Bjorn,
  verbatim, 2026-11-26: "no need to keep migration backwards compat btw. there is too much defensive migration logic,
  let's just declare migration bankruptcy, sweep all the code to remove and purge all branches that are now moot, and
  for all of our apps like qti-pie, qti app in edullm, metis, just fully purge and regen all the schemas." Why:
  - **No app has a student**, so no installation holds rows a purge would lose.
  - **Every compatibility path is code that never runs again**: a rebase, a converter or a leftover's cleanup serves
    one crossing and then stands, tested and maintained, against states no installation of this format reaches.
