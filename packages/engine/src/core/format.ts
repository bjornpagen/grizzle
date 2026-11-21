/**
 * The format of every file grizzle writes and reads back: a committed snapshot's two files (snapshot.json records it,
 * and the seal manifest.json carries digests under it) and a served file. A file of any other format, or of none, is
 * refused before anything of it is read, never read in part or converted: grizzle reads exactly this format, so a live
 * installation whose committed snapshot holds another is rebased onto this grizzle's compile of its source by `grizzle
 * upgrade`, which reads its history off the database and no committed record (the shell's cli/upgrade.ts), one with no
 * database is drafted afresh, and a served file is written again by `grizzle generate`. A change of what any of those
 * files holds is a change of this format, and nothing reads the format before it.
 *
 * After a production cutover a change of this format leaves grizzle's bookkeeping tables (the ledger and the drift
 * proofs, deploy/ledger/ledger.ts bookkeepingTables) and every stored column's type as they are, unless it ships a
 * carried conversion of its own: their rows are no rebase's to rewrite, and migrate reads the ledger before it applies
 * anything, so `grizzle upgrade` refuses such a change by name (CONTRIBUTING.md, Settled decisions). Format 6 retyped
 * the ledger's and the proofs' digests, so no format 5 installation is rebased onto it: each is drafted afresh.
 *
 * @formatConstant grizzle's artifact format: 6. Its snapshot.json records each schema level's fingerprint over its
 * identity text, every part the level holds written once as its identity digest's token (core/fingerprint.ts
 * schemaFingerprint), and each level's statements in their identity digests' order; its index keys hold every column as
 * itself, never an image of it, a lookup's index naming the columns it leaves out as filters in its identity; its row
 * functions are named by their bodies over positional parameters (physical/ddl/row-functions.ts called), so no declared
 * rename of a column one reads names it anew, where format 5 named each parameter by its caller's column; each roster's
 * live-codes constant by its live codes, which its domain's CHECK reads, so a rename of its handles replaces its names
 * constant alone (physical/ddl/constants.ts rosterConstants); each judge function by the digest of a source whose rule
 * statements read every import a rule's unfolding multiplies whole, one node, never inlined again at each read nor
 * distributed into the rule's conjunctions (analysis/theory/navigate.ts ImportSharing), each occurrence a whole rule's
 * region proves by its least-reading witness, a key's before a root's (analysis/theory/unit.ts witnessOrder); the
 * installation's function owner by the installed identifier of its root (identity.functionOwner); and each constraint
 * by every law it serves, a set in code point order (deploy/snapshot/types.ts ConstraintLaws), where format 5 kept the
 * one law its statement order met last, as the served file's constraints above and meta.json's folder laws do. Its
 * served file records each role's context by its source (ir/desc.ts ContextFactSource), a token's with the claim object
 * its fields are read from or one its server attests, where format 5 recorded the claim object alone; its files may
 * hold the network types inet and cidr, their literals and their containment (scalar/values/net.ts); it records how
 * each read is called (served/forms.ts ServedReadLive): `answered`, at its call's instant alone and never live, an
 * answered(...) or a clocked member, beside a live read's `constant` or `routed`, where format 5 served a clocked read
 * as a member of a kind of its own (`instant`) and its answer's shape as `instantSet` or `instantList`, now
 * `answeredSet` or `answeredList`; each paged member's window at a position (its page's `at` request, whose statement's
 * offset placeholder is an `offset` page fill) beside its four keyset windows; a read's bytes columns delivered in
 * chunks from a derived table whose column list alone names the read's columns, its targets unnamed inside it
 * (lower/delivery.ts deliveredRows), where format 5's named each inner target by its public name as well; and each
 * write program's carriers named by the role the program runs as beside their declaration (sql/naming.ts carrierScope),
 * each stand-up refusing a session table of its name that CURRENT_USER does not own; and each ChangeSet's decoder of
 * its read-backs as one record in name order, built from its set of read-backs (write/changeset/value.ts readsDecoder),
 * where format 5 held a merge tree in the order its read-backs were read, unioned and sequenced. A primary key's
 * generated field is recorded as a key generation, its writing `keyGenerated`, a column grizzle writes and its key's
 * CHECK proves (deploy/snapshot/types.ts SnapshotWriting). An instant field's description records its writing as
 * `instant`, so a schema fingerprint over an instant field moves. Each drafted folder's meta.json records every file's
 * lock demand (`locks`, deploy/locks/demand.ts), which migrate holds the server's lock table to before anything runs. A
 * SHA-256 digest is a carrier of its own, 32 bytes of bytea under the installation's __sha256 domain, which every Setup
 * creates and grizzle's ledger and drift proofs type their digests by; Crypto.sha256 yields it, where format 5 held 64
 * hex digits as text. Format 5's snapshot.json first recorded the library functions the installation installs
 * (derived.library), each one any artifact over it or any program it serves calls, beside every structural text domain
 * it holds (derived.textDomains), each refinement any artifact or served program types a value by, and every contract
 * outside the base they type a value by (derived.params.contracts). Format 3's files were written in several shapes,
 * changes of what they hold riding its number (a constant recorded with no language before 56f26ca01), so a reader that
 * trusted a sealed record of 3 met shapes it never wrote; every one is refused here
 */
export const artifactFormat = 6

/** The member of a snapshot.json or a served file that records its format (artifactFormat). */
export const formatKey = "format"

/** Whether a file's recorded format, as read, is this grizzle's (artifactFormat). */
export const isArtifactFormat = (recorded: unknown): boolean => recorded === artifactFormat

/** The files that record their format: a committed snapshot, by its snapshot.json, and a login's served file. */
export type FormattedFile = "snapshot" | "served"

/**
 * What a file records of its format, as read and never trusted: none, where it holds no format member, or a value, by
 * its JSON text (`0`, `2`, any value a hand edit left there).
 */
export type RecordedFormat =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "recorded"; text: string }>

/** What a file's format member holds, as RecordedFormat reads it: undefined where the file holds no such member. */
export const recordedFormat = (value: unknown): RecordedFormat =>
	value === undefined ? { kind: "none" } : { kind: "recorded", text: JSON.stringify(value) }

/** How a served file of another format is put right, which a served file out of date shares: write it again. */
export const servedFileFix = "run grizzle generate, which writes the served file again"

/**
 * Each formatted file's refusal of a format other than this grizzle's, and its fix: the one text the engine's readers
 * refuse by (deploy/snapshot/build.ts joinedSnapshot and served.ts servedSnapshot for a snapshot, served/json.ts
 * servedFile for a served file) and the command line prints (the shell's cli/refusals.ts). No grizzle converts a
 * committed snapshot of another format: its installation is drafted afresh by this grizzle; a served file is written
 * again.
 */
export const formatRefusal: {
	readonly [F in FormattedFile]: Readonly<{ problem: string; fix: string }>
} = {
	snapshot: {
		problem: "snapshot.json records another format than this grizzle's",
		fix: "run grizzle upgrade against the live database, which rebases the installation onto this grizzle's compile of the source it was deployed from; an installation with no database is drafted afresh, from an empty migrations directory: no grizzle reads another format's records"
	},
	served: {
		problem: "the served file records another format than this grizzle's",
		fix: servedFileFix
	}
}

/** What a refused file records of its format, against the format this grizzle reads and writes, in words. */
export const recordedFormatText = (recorded: RecordedFormat, expected: number): string =>
	`${recorded.kind === "none" ? "it records none" : `it records format ${recorded.text}`}, where this grizzle reads and writes format ${expected}`
