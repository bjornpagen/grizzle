# Agents working on grizzle

Read CONTRIBUTING.md before changing anything: its Code rules bind every change, and its "Settled decisions (do not
reopen)" are closed questions. Do not propose, prototype or reintroduce a settled decision's rejected design.

## Settled decisions (do not reopen)

- **No automatic hashing of keys or lookups (2026-11-20).** grizzle holds every key, UNIQUE, family axis, reference
  target and drafted lookup column as itself: it never installs a column over a digest of its own (no SHA-256 image of a
  key's text or numeric, no `md5` lookup expression), and never rewrites a statement to compare digests. A key whose
  widest entry, in any order of its columns, could pass PostgreSQL's B-tree limit (2,704 bytes), or that holds a text of
  no byte bound, is refused at compile as `UnrepresentableKey`, naming the relation, the key, the field and the fix:
  declare a byte bound (`str.bytes(n)`) or a precision, or key by an explicit digest field the schema declares, a
  generated `Crypto.sha256(x)`. A drafted lookup leaves a column that cannot fit out of its index, a filter beside it.
  The rule is README "Keys and indexes". Bjorn, verbatim: "yes, if no one requires automatic hashing, and if it's
  spooky action, hard revert it, get grizzle green, and tell all the subagents to repin. huge keys are almost certainly
  a bug anyways, we should never be getting anywhere near the hash limit for grizzle right? can we please pin and
  document this so this never gets overturned again". Why:
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
