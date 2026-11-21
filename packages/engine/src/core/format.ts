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
 * @formatConstant grizzle's artifact format: 7. Format 7 (pin+1): a session table, a rule judge's delta (physical/ddl/rules.ts
 * emptied) or a write program's carrier (sql/print.ts carrierStandUp), is emptied by DELETE, and by TRUNCATE only once
 * its heap or its TOAST table's heap holds more than its one page (sql/print.ts sessionTableEmptied), where format 6
 * truncated each written delta at every judged COMMIT and each carrier at every use, so each judge function's body and
 * each served carrier stand-up read the table's size before they empty it. A whole rule's judged statement spells each
 * definition its containment's sides read at one set of values once: a relational filter's SELECT holds its region's
 * shared CTEs (lower/shapes/index.ts filteredRegion), an import a nested rule reads at a re-exposed value is bound at
 * its outermost re-exposure (check/checker.ts Checker held), a whole rule's unit channel keeps its name at every depth
 * (analysis/theory/navigate.ts received) and a filter passes a term its rule fixes as that term (pinnedBy), where format
 * 6 spelled such a definition again at each read inside the negation of the met side. A judge's delta whose relation's
 * every field has a bound and whose widest row fits one heap tuple holds every value in its row, each column STORAGE
 * PLAIN, with no TOAST table (physical/ddl/rules.ts deltaStorage, sql/ast.ts SessionTableStorage), and a delta's name
 * digests its storage beside its columns, so every delta's name moves. A fold whose body joins is read, by each judge
 * function and each served write program, over an import of its body's every bound variable, which navigation reads
 * as a chain of steps (analysis/theory/navigate.ts foldedOverBody), where format 6 left the fold's join as written for
 * PostgreSQL to order. An import or a call a query or a write binds to outer values is one node for every read of it at
 * those values (check/checker.ts importedKey), and a parameter an importer bound to a value a region holds from outside
 * it, a region's parameter or parent slot or a parent's column an attachment reads, is bound to that column in every
 * reading (Checker held, RuleCheck #bindValue), where format 6 did so in a rule judge's region reads alone and built
 * every other such import at each read: a judge function or a served statement that reads one lookup under several
 * imports reads it once, correlated to the region that holds its values, and reads a value such a region holds as the
 * outer column it re-exposes. A key's constraint (a primary key, a UNIQUE, a WITHOUT OVERLAPS) maps, in snapshot.json's
 * constraintToLaw, a served file's constraints above and meta.json's folder laws, to the laws its refusal breaks: every
 * law it serves but a containment or a rule whose foreign key references it (laws/model/model.ts refusedLaws), where
 * format 6 mapped it to every law it serves, so a duplicate under a superkey a containment references named that
 * containment beside its key. An installation plans a domain, and grants a role USAGE on one, only where something
 * names it: a contract's domain rests on its base's own domain (an inner contract's, a closed id's roster domain, a
 * set's bits domain, the digest domain), never a refined base's text domain, whose pattern the contract's own CHECK
 * carries over text (physical/ddl/domains.ts restingDomains, typeRefinements); a persistent expression names a text
 * domain only as a cast's target; and a law's violation query only where a statement lowers it, a migration-discharged
 * law's or a rule's (physical/install/plan.ts artifactObjects), where format 6 created the text domain of every
 * contract's refined base and of every persistent and law term's refined type, and granted a role USAGE on its
 * contracts' base text domains: those CREATE DOMAINs, their COMMENTs, PUBLIC revokes and USAGE grants go, and
 * snapshot.json's derived.textDomains holds them no more. A probed rule's judge block over one side of a table is one
 * statement: the rule's meeting part, a containment's negation of its target, a key's other fact or a check's
 * predicate, read once over the union of every row the write may break the rule at, each over its region
 * (analysis/theory/query.ts probe), and a negation of a definition of several arms is one anti-join of the definition as
 * declared (absentsOf), where format 6 compiled a statement for each occurrence of the touched relation, each spelling
 * the whole target again, and spelled a negated definition once for each arm of its flattening, the product of the
 * widths of the unions it matches at every depth. Format 6's snapshot.json records each schema level's fingerprint over its
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
export const artifactFormat = 7

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
