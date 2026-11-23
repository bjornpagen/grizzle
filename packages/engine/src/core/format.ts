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
 * @formatConstant grizzle's artifact format: 8. Format 8 (pin+2): a drafted folder's meta.json records a drafted
 * statement by its text only where a reader reads its text: a loss's statement and each statement of a confirmed group,
 * the decisions `grizzle check` reads a review by, and a statement that holds a placeholder, which a reviewer fills;
 * every other statement is the step `{ kind: "digest", digest }`, the SHA-256 digest of its tokens as PostgreSQL's
 * scanner reads them (deploy/render/markers.ts statementDigest, core/fingerprint.ts digest under the domain
 * "statement-tokens"), which a written statement's tokens give exactly when it is written as drafted, where format 7
 * recorded every drafted statement's whole text, past V8's longest string in a large installation's draft, whose
 * meta.json no seal could then digest and no reader read back. `grizzle generate` proves the record over every drafted
 * statement's text before it records it (deploy/render/folder.ts provedRecord), and meta.json's seal carries that proof
 * to every reader, so no reader proves it again (readDecodedMeta), where format 7 proved it at every read of a
 * meta.json; a written statement is held to a digest by its tokens' digest (recordsAsWritten, statedLocks). A meta.json
 * records no format, and `grizzle upgrade` reads a format 7 folder's, every statement by its text, as it reads its own.
 * A write's single statement holds the evaluation of a call its parts read as one statement over every argument of the
 * call, so a sub-query two arguments read is one MATERIALIZED CTE of the evaluation's WITH, and builds its parts lowest
 * first, so an evaluation reads the sub-queries the statement carries as parts of their own and a carried sub-query
 * reads the evaluations below it (lower/shapes/share/statements.ts StatementSharing evaluation,
 * write/program/compile.ts heldParts), where format 7 lowered each argument as a statement of its own and built every
 * evaluation before the carried sub-queries; and an existence test whose right side is no scan of one source,
 * restricted at every relation by its join columns and derived anew by the statement, is read per left row, a step
 * correlated inside its EXISTS (lower/conservative/semi-join/exists.ts readPerLeftRow, step/index.ts fencedRead), where
 * format 7 left every right side in a bare EXISTS. A write's read bound to a column of a derived table of a context's
 * fact, one row of values the call holds once, binds one group for the call, as one bound to the context itself does,
 * and the row an INSERT's arbitration met, read through a query CTE that holds its met rows whole, is read as the row
 * met (program/isolation/extract.ts callRow, namedIn), where format 7 read each as a read of one group per own row and
 * as an outside read of its relation, so a role that reads by a claim, or beside a SERIALIZABLE inserter of what it
 * reads, may certify READ COMMITTED where format 7 left it SERIALIZABLE: its served level, its relations' guards and
 * its login's fences move. A rule judge's delta reader returns its delta's rows as they stand, deduplicating nothing
 * (physical/ddl/deltas.ts addReaders), where format 7 returned them DISTINCT, so every reader's body moves. A shared
 * join the statement's own values restrict is computed once, a carried part, a MATERIALIZED CTE of a write's statement
 * or of a read's (lower/optimize/cte-policy restrictedByValues, rule 5d; lower/shapes/share/statements.ts sharedOnce),
 * where format 7 restated it at each read of a write and left it NOT MATERIALIZED in a read. A call an attachment's
 * child reads at its parent's values alone is evaluated once for each parent key, a MATERIALIZED CTE of the statement
 * every attachment under the parent's rows reads at its parent's values (lower/conservative/call/index.ts
 * parentEvaluations), where format 7 evaluated it again in each attachment's child; and each block of a rule judge's
 * part is a function of its own (physical/ddl/rules.ts partBody, identity.ruleJudgeBlock), which the part calls under
 * the block's guard, where format 7 held every block's statement in its part, so 04-validate.sql creates a function per
 * block and 05-publish.sql comments each. Each clock's and place's head is a table of its children's last stamps beside
 * its relation, with the stamp function that advances it, one manifest object of kind `head` (physical/ddl/stamps.ts),
 * which a statement that stamps calls in its stamps' CTE and a migration fills from its relation as it creates it,
 * where format 7 read each child's head from the relation's primary key backwards and had no such object. A call's
 * evaluation a write's single statement holds is one statement of its share planning, its arguments read by it alone,
 * and a sub-query whose only stage that is no scan is a carried part is read where it stands
 * (lower/shapes/share/statements.ts planStatementShares, HeldEvaluation, statementCtes), where format 7 counted every
 * member reading a field of the call as reading its arguments, each argument a MATERIALIZED CTE of the statement, and
 * gave a read of a carried part a CTE of its own; and no block probes a relation's added rows that a sibling stored
 * match of the probed arm covers through one of the schema's containments (analysis/theory/query.ts covered), where
 * format 7 probed every touched side, so a judge holds fewer blocks; and a judged statement's step looks its relation
 * up by every column an equality chain of its rule fixes to a value the steps before it hold
 * (analysis/theory/navigate.ts implied), where format 7 bound only the columns equated with such a value directly, so a
 * read of an import inlined into an arm of a definition read at a written row's keys gains the equality of each key
 * column the arm equates with its channel. An installation sets no database default and its snapshot records none
 * (physical/ddl/isolation.ts), where format 7 set default_transaction_isolation SERIALIZABLE on the database, its
 * snapshot's `databaseDefault` object, so an owner's session starts SERIALIZABLE by its startup options
 * (adapter/wire/session.ts ownerOptions) and `grizzle upgrade` resets the former default (adapter/admission/upgrade.ts
 * formerDefault). A probe whose every row reads a stored relation keyed by no field of the unit its arms bind, at that
 * unit, runs inside a guard of that relation's rows at the written rows' units, carried along the ways that yield a row
 * of the probe's side alone (analysis/theory/query.ts probeGuard, Carry), where format 7 ran every probe of a written
 * side: a guarded block's function holds the guard's PERFORM and IF FOUND around the probe's (physical/ddl/rules.ts
 * probedBlocks). Every login's role stores plan_cache_mode at force_generic_plan beside its other fixed defaults
 * (physical/ddl/roles.ts genericPlans, roleDefaultSettings), so each installation's roles gain an ALTER ROLE ... SET
 * and each served file's startup options the setting, and its session texts the generic plans an owner's session starts
 * under beside its default level (served/forms.ts ServedSession ownerStartup, roles.ts ownerStartupOptions), so every
 * session of a login's pool and every owner's session plan generically. A join no value of a write's single statement
 * restricts, which its parts read joined to a carried part by its columns, is one part of the statement, its rows kept
 * by an EXISTS over that part (lower/shapes/share/statements.ts restrictedShares), where format 7 restated it at each
 * read. A family statement that reads a held owner copy from a stamped nesting's rows it does not stamp reads them as
 * the host sends them, without the stamped columns (write/family/additions.ts sentOf), where format 7 declared a
 * placeholder for each stamped column, which no nested row sends. Every schema installs its borrow function,
 * `__borrow(bigint[], boolean[])`, which takes a call's borrowed locks in the order it is handed them, each a
 * transaction-scoped advisory lock, exclusive or shared, one manifest object of kind `borrowFunction`
 * (write/borrow/function.ts) every role executes, where format 7 had none. A live source's replication slot is named
 * by the source and the database it decodes, `__live_<digest>_<digest of the database's name>` (core/identity.ts
 * liveSlotOf), so two databases of one installation on one cluster each hold their own, where format 7's leader named
 * it by its decoder login alone, one cluster-wide name for both, and the second database's leader met the first's slot
 * (42710); a migration that removes a live source drops the slot of its database that begins with the source's stem
 * and `_` (physical/ddl/live.ts dropLiveSlot), where format 7 matched one that ended in the stem, and `grizzle
 * uninstall` drops the slot of its database by that name. A slot an earlier grizzle's leader made under its decoder
 * login's name is none of this grizzle's: a leader of this grizzle makes its own beside it, and the earlier one holds
 * its WAL until it is dropped by hand.
 * A put of a relation whose primary key holds a span displaces every occupant of its fact's scalars whose span overlaps
 * its fact's, which the key's WITHOUT OVERLAPS would refuse beside it: its displacing deletion joins the occupants at
 * the key's scalars and by `&&` at its span and compares the span beside the payload (write/delete/exact.ts
 * collidingAtKey, write/put/choose.ts differingOf), a pure set's put included, where format 7 deleted only an occupant
 * at an equal span, a pure set's none, and refused every other on the key, so each served span-keyed put's deletion
 * moves and a span-keyed pure set's put gains one. A role holds USAGE on a span's endpoint contract only where a column
 * it holds is typed by the contract itself (physical/ddl/domains.ts typeDomains), where format 7 granted it to every role
 * that read or wrote a span over the contract, whose column is its builtin range and which no value cast needs, so such
 * a role's GRANT USAGE ON DOMAIN loses the endpoint's domain.
 * A served binding's fresh stratum names the columns its fresh fills leave to the statements writing their rows, their
 * stamps' and the generated fields over them (runtime/write/binding.ts FreshStratum `left`), and a counted family's
 * fresh layout leaves out its members' key and group fields a stamp fills, the call's one value of each, which its
 * additions statement stamps the host's members with (write/family/additions.ts hostDrawnOf), where format 7 drew every
 * fresh group on the host from fields no row the host held held.
 * ChangeSet.insertAllComputed(rows, computed) is the one computed insert: insertAll's record, every relation it names
 * computing each field of one record of terms over the call, a relation lacking one refused at its key, where format 7
 * had insertComputed(R, rows, computed) of one relation alone.
 * grizzle.config.ts states `rolePrefixBytes`, the bytes of the longest role prefix an installation of it is under (0
 * where none is), and every command refuses a login or role whose PostgreSQL role would pass 63 bytes under a prefix
 * that long (core/identity.ts longestRoleBytes; the shell's cli/config.ts, LoginEntryRefused `roleTooLong`), and a
 * connection whose prefix is longer, where format 7's configuration stated none and generate drafted a role a
 * prefixed installation's migrate then cut short: metis's harness, under 13-byte prefixes, failed at 05-publish.sql
 * on role stems of 51 to 56 bytes.
 * A served file compiled for a moved clock (compileServedMoved) declares the clock's instant, `clock:instant`, a count of
 * microseconds since the Unix epoch that every reading and stamp of a call reads exactly (check/clock.ts clockInstant,
 * sql/print.ts printInstant), where format 7's declared the clock's offset, `clock:offset`, which moved the instant its
 * call's transaction began, so a stamp was the test's aim plus the latency to BEGIN.
 * A served read records no `deferrable`, and a served session's read BEGIN is one text, SERIALIZABLE READ ONLY
 * (served/forms.ts ServedRead, ServedSession), where format 7 recorded whether a read's member was declared
 * deferrable(...) and keyed the read BEGINs `immediate` and `deferrable`, without and with DEFERRABLE.
 * manifest.json states each object's edges on the object, its `after`, the identities of the objects it is created after
 * in code point order, and lists no edges of its own, which its reader gives back from the objects
 * (deploy/snapshot/build.ts laidOutManifestForm, joinedManifest); the record the seal digests holds the edges by their
 * dependents, each object's in install order and an object's in code point order (recordedManifestForm), where format 7
 * listed every edge with both its ends, the dependent's identity once per dependency, in the compile's order: metis's
 * suite manifest.json of 327,449 edges, 44.7 MB of its 107.9 MB, is 78.8 MB laid out so. And a file generate writes
 * that is larger than GitHub's warning size, 50 MiB (deploy/render/parts.ts generatedFileMaxBytes), is written as its
 * parts, `<stem>.<n><extension>` from 1, each within it and cut at the text's coarsest joint within it, after a blank
 * line, else a line, else a code point (grizzle-text partsOf), which every reader joins back into the one text before
 * it reads it: manifest.json and each migration folder's meta.json and SQL files (laidOut, laidOutFiles, the shell's
 * adapter/boundary/files.ts readLaidOut), where format 7 wrote each whole, whatever its size, so metis's 107.9 MB
 * manifest.json and 96.9 MB 04-validate.sql were files GitHub refuses, now parts of 52.4 MB and 26.3 MB, and of 52.4 MB
 * and 44.5 MB; parts that lay out no file (one missing, one alone, parts beside the whole) are refused by name
 * (TreeRefused `brokenParts`). snapshot.json, a served file and an OpenAPI document, which an application imports whole
 * by its path, are never laid out in parts: generate refuses one past the bound, before writing anything
 * (FileTooLarge, the shell's cli/files.ts unsplitWithin).
 * A relation a role holds whole has one view, its whole view, `__<level>.<relation>` in its level's schema of whole
 * views (core/identity.ts identity.wholeSchema, wholeView; physical/ddl/roles.ts addWholeViews), which every role
 * holding it whole is granted SELECT on, with USAGE on its schema, and which served statements name
 * (physical/ddl/names.ts worldNames), where format 7 installed a copy of it in the schema of each role holding it,
 * byte-identical but for its schema: metis's suite installation's 30,773 views over 1,560 relations held whole and its
 * 22 query entries are 1,582, its manifest's 327,449 edges about 142,900 and its views' statements 26.6 MB of AST
 * 1.7 MB. A role's own schema holds its query entries' views alone, and stands exactly when it holds one, where format
 * 7 created one for every role; the drift check reads each theory role's schema whether or not the manifest creates it
 * (deploy/admission/roles.ts judgedSchemas), so `grizzle upgrade` of a format 7 installation drops every per-role copy
 * and every role schema left with no query view as objects the target lacks, and creates the schemas of whole views
 * and their views, and every role's grants name them. `grizzle uninstall` drops each level's schema of whole views with
 * its levels'.
 * A projection that only picks and renames the columns of the one derived table it reads, a core of no WHERE, GROUP BY,
 * HAVING or DISTINCT ON whose every target is a column of a derived table that names its columns, over a query of one
 * core with no DISTINCT, GROUP BY, HAVING, WITH, ORDER BY, LIMIT or OFFSET, prints as the core it reads, each target the
 * inner target its column names, under the name its reader reads it by where that reader reads rows by name; never
 * under its query's ORDER BY, which reads its FROM, and never where it would compute a target twice or leave out a
 * placeholder or a call of a core that computes one (sql/print.ts passedThrough, foldedCore), where format 7 printed
 * every such projection as a level of its own, which PostgreSQL pulled up at the cost of a range table entry, its
 * targets' translation and their plan memory at every level: every judge function's body, served statement and view
 * that held one moves, and its statements' digests with it; edullm's ledger's 04-validate.sql is 45.1 MB where it was
 * 56.9 MB, and its served statements 116 MB where they were 133 MB.
 *
 * Format 7 (pin+1): a session table, a rule judge's delta (physical/ddl/rules.ts
 * emptied) or a write program's carrier (sql/print.ts carrierEmptying), is emptied by DELETE, and by TRUNCATE only once
 * its heap or its TOAST table's heap holds more than its one page (sql/print.ts sessionTableEmptied), where format 6
 * truncated each written delta at every judged COMMIT and each carrier at every use, so each judge function's body and
 * each served carrier stand-up read the table's size before they empty it. A whole rule's judged statement spells each
 * definition its containment's sides read at one set of values once: a relational filter's SELECT holds its region's
 * shared CTEs (lower/optimize/cte-policy filteredRegion), an import a nested rule reads at a value its importer bound is bound
 * to that value itself (check/checker.ts RuleCheck #bindValue), a whole rule's unit channel keeps its name at every depth
 * (analysis/theory/navigate.ts received) and a filter passes a term its rule fixes as that term (pinnedBy), where format
 * 6 spelled such a definition again at each read inside the negation of the met side. A shared correlated node every
 * read of which is a region's occurrence is MATERIALIZED in the SELECT of the outermost region that lies on every path
 * to it and sees every outer value it reads (lower/optimize/cte-policy holdingRegion), where format 6 held it only in a
 * region whose correlated values covered what it reads and inlined it at every read otherwise, so a CTE a region held
 * for values from outside it stands in the outermost such region. A judge's delta whose relation's every field has a
 * bound and whose widest row fits one heap tuple holds every value in its row, each column STORAGE PLAIN, with no TOAST
 * table (physical/ddl/rules.ts deltaStorage, sql/ast.ts SessionTableStorage), and a delta's name
 * digests its storage beside its columns, so every delta's name moves. A fold whose body joins is read, by each judge
 * function and each served write program, over an import of its body's every bound variable, which navigation reads
 * as a chain of steps (analysis/theory/navigate.ts foldedOverBody), where format 6 left the fold's join as written for
 * PostgreSQL to order. An import or a call a query or a write binds to outer values is one node for every read of it at
 * those values (check/checker.ts importedKey), and a parameter is bound to the value its importer bound it to, a
 * column of the unit, of an enclosing region or of an attachment's parent among them, in every reading (RuleCheck
 * #bindValue), where format 6 did so in a rule judge's region reads alone and built every other such import at each
 * read: a judge function or a served statement that reads one lookup under several imports reads it once, held in the
 * outermost region every read lies in that sees its values, and reads the outer column where it read a region's
 * re-exposure of it. A key's constraint (a primary key, a UNIQUE, a WITHOUT OVERLAPS) maps, in snapshot.json's
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
 * widths of the unions it matches at every depth. A write program's sub-queries are shared by the keys of their blocks
 * (ir/dag-digest.ts ShareKeys, lower/shapes/share/statements.ts ShareIndex): a carrier or a MATERIALIZED CTE stands for
 * every read one stratum's members or one statement make of sub-queries built alike block by block, a sealed node met
 * in two blocks keyed by its own key, where format 6 shared only reads whose whole reaches were one, so two reads over
 * one sealed node built twice alike under two parents share one statement or CTE. A law's object and a law column are
 * commented with each conjunct of the selection they read as its author wrote it, each scalar builder by its public
 * spelling and each literal as written (scalar/compute/predicate-source.ts), `key T(id where Logic.gt(u, 1))`, where
 * format 6 spelled each conjunct by its canonical JSON, so every COMMENT over a selection moves, and a declared rename
 * of a field a selection reads comments the renamed object with the field's new name; no identifier moves, since an
 * identity's parts keep each conjunct's canonical text. A retirement's served step names the relations it removes rows
 * of, `removed`, its unit's bodies and then each relation of the reachable records it releases (runtime/write/steps.ts
 * RetireStep), where format 6 named its bodies alone as `bodies`; and a law of a reachable statement records that
 * statement's kind as its source (ir/law.ts LawSource `reachable`). A probe reads what the write moves of each
 * definition a negation reads as one query of the definition's rules, its parent's rows joined to it
 * (analysis/theory/query.ts movedOf), where format 6 read a row for each path down the negated arms to an occurrence of
 * the touched relation, each spelling the path's every arm; and a rule statement's rule over such rows navigates its
 * filters after them (analysis/theory/navigate.ts filteredOverSteps). A rule's arm keeps a derived relation or imported
 * query of several rules it matches as one match (analysis/theory/query.ts DefinedMatch): a probe reads what the write
 * moves of it as one query, the facts it gains read again at their keys, and an arm that reads it beside a written row
 * reads that row's keys first, so the definition is read at them, where format 6 distributed the arm into one arm for
 * each choice of a rule at every such match. Format 6's snapshot.json records each schema level's fingerprint over its
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
 * trusted a sealed record of 3 met shapes it never wrote; every one is refused here.
 *
 * Pending, for the next format, which grizzle main bumps once for the batch: a rule matches r.series(low, high), a
 * call of grizzle's series (ir/rel.ts CallFunction `series`, a Description source of kind `series`), each integer from
 * its low end to its high end, printed as generate_series, its element read within the least value its low end takes
 * and the greatest its high end takes; GREATEST is stated within its operands' greater least and greater greatest values
 * and LEAST within their lesser, and an exact integer's division by a divisor of one sign within the quotients of the
 * operands' ends (scalar/compute/bounds.ts greatestBounds, leastBounds, quotientBounds), where format 8 stated their
 * hull and the dividend's digits, so a term over them is typed narrower, an exact integer's digits and the casts and
 * domain casts its bounds prove with it. A chain of steps reads first, of two
 * lookups, one bound at a key of its relation, then, of two relations one is contained in over every row, the contained
 * read keyed at more columns than its image in the container, or else the container's lookup keyed at more columns than
 * the contained read's image (analysis/theory/navigate.ts Navigation narrower), then the one keyed at more columns,
 * where format 8 counted keyed columns alone: a judged statement over qti's placed references walks to a reference's
 * child elements and then each expression by its key, never every expression of the reference's item, so its steps
 * move, and the indexes their lookups ask for with them. A single statement holds as a part of its own a sub-query
 * another stratum's member reads too, which the later stratum lowers anew (lower/shapes/share/statements.ts
 * StatementSharing.uncarry, write/schedule/plan.ts), where format 8 left it inline at each read. Retirement is deleted:
 * a schema states no retirable unit, no header's `retirement` field, no reachable records and no side over records, a
 * role no `retire` list (its Description no `retire` member) and a ChangeSet no retire member, where format 8
 * installed each retirable unit's header retirement column with its DEFAULT false, its bodies' fence (generated
 * columns and foreign keys into the open headers), its hold and retire functions with their EXECUTE grants (manifest
 * objects of kind `unitFunction`, gone from the manifest's kinds), served a hold before a write touching a body and a
 * retire member's call, counted a retirement in an outcome and recorded a `retirement` writing in snapshot.json; an
 * installation of a schema that held one is drafted afresh. An import a chain reads whole and matches at a term of a
 * variable binds its column to a hidden variable equated with the term (analysis/theory/navigate.ts Navigator #chain
 * `hiddenFor`), where it took the term's variables for its own. A judged step that binds a column to a term computed
 * from the channels it passes in, a sum, a conditional or a bounded text's guarded cast, asks an index holding that
 * column (physical/access/extract.ts regionFacts `fixing`), where the term fixed nothing and the step's index held only
 * the columns its channels bind directly. A region that joins a union by columns an occurrence the statement's values
 * restrict binds reads it per binding, LATERAL, each arm at those values (lower/optimize/cte-policy probesByKey,
 * lower/shapes/union keyedUnion), and a fold the same way beside such an occurrence, where format 8 read the union
 * whole and joined it beside, and probed a fold only beside a stored relation; a fold or a union the statement's values
 * restrict itself is no such probe, read as it stands. A fold or a union every reader of a
 * workload's read reads at a value of a key column is read inline at each (lower/optimize/cte-policy perKeyReads, rule
 * 5c), where format 8 made one MATERIALIZED CTE of the whole node, read beside. A restricted share's EXISTS reads the
 * union of its readers' partners (lower/shapes/share/statements.ts restrictedShares), where 96b46005e's read one
 * partner. A unit delete of a relation that is a member of two counted families or more keeps none of a group of any of
 * them a doomed row it removes reaches, across the crossing, by one recursive read over its removed rows
 * (write/delete/unit.ts wholeAcross), where format 8 kept each family's groups by that family's own exclusions alone.
 * An attachment whose child reads a union or a fold through a rule that matches it as it stands reads it per parent key
 * inside its LATERAL (lower/optimize/cte-policy probedByKey, perKeyReads), where format 8 derived it whole, a
 * MATERIALIZED CTE the LATERAL filtered.
 * Each capture's branch and each part stands its session tables up in one read of pg_catalog.pg_class
 * (physical/ddl/rules.ts standing, sql/print.ts sessionTablesStanding), where format 8 asked whether each table stood
 * and whether it was the definer's own in two statements of its own, so every capture function's and part's body moves.
 * An existence test whose right side the statement's values restrict, a filter at a parameter or a literal among them
 * (lower/optimize/cte-policy restrictedByValues), stays in a bare test, derived once
 * (lower/conservative/semi-join/exists.ts readPerLeftRow), where format 8 read it per left row and counted a filter at
 * a value no restriction.
 * A served role's refusals hold the witness query of each deferred foreign key its writes meet whose table and target it
 * reads whole (served/forms.ts ServedRefusals `unmatched`, write/unmatched.ts), which the shell runs after a COMMIT that
 * key refused, so the refusal names the key of a row the write leaves unmatched, or `unreproduced` where none is left
 * (adapter/apply/run.ts unmatchedWitness), where format 8 left every refusal at COMMIT unreported.
 * A rule over a query that reads a mutable relation is judged whole where every relation it reads sits in one declared
 * unit whose key leads its own (analysis/theory/unit.ts wholeRule), and a containment between selected sides of such
 * relations is discharged whole (laws/model/plan.ts containmentDischarge), where format 8 probed the one and made the
 * other native, its law columns, their UNIQUE and their index.
 * Every table's statistics are declared from the schema's facts (physical/statistics/declared.ts): the manifest holds,
 * for each table and indexed view and each of grizzle's bookkeeping tables, one object of kind `statistics`,
 * `statistics:<schema>.<table>`, whose one statement sets the table's autovacuum_analyze_threshold and
 * autovacuum_analyze_scale_factor to their maxima and every column's statistics target to 0, and restores each column's
 * declared number of distinct values, each restore checked (sql/ast.ts DeclareStatistics), and the drift check compares
 * each column's statistics target and pg_stats, and the table's storage parameters, with it, where format 8 created the
 * extended statistics (CREATE STATISTICS of ndistinct, dependencies and mcv) a workload program's correlated selections
 * and groupings asked for, named by their columns, and recorded each program's `statistics` in snapshot.json's workload
 * access, which holds its paths alone; a live installation's extended statistics objects are departures its upgrade
 * drops.
 * An import a rule statement's chain reads whole is placed among its steps once the steps before it have bound what
 * they bind of its columns, an equality of a variable it binds first with one a step bound the rule's own
 * (analysis/theory/navigate.ts Navigator #chain `matchWhole`), where format 8 placed it before every step, the steps
 * after it keyed by its variables, so every judge statement that reads one reads its steps in another order.
 * Each delta reader declares the rows a call returns, ROWS 1 (physical/ddl/deltas.ts deltaReaderRows), where format 8
 * declared none and PostgreSQL estimated a thousand.
 * A relation is closed or open: closed, the default, its facts inserted, never changed or deleted, so a role that writes
 * it holds SELECT and INSERT on its table and no UPDATE or DELETE (physical/ddl/roles.ts entryPrivileges), where format
 * 8 granted DELETE on every table a role wrote; open, mutable(R) inside a unit whose heading its primary key leads with,
 * its writers holding UPDATE and DELETE as before. A world's grants move for every closed table a role writes.
 * A session stands up the objects a write's flight reads and writes once, before its first call of the write, in one
 * transaction of its own (adapter apply/stand-up.ts): a served write holds its stand-ups (runtime/write/flight.ts
 * ServedWrite `standUps`), each carrier's CREATE TEMPORARY TABLE with its emptying, a pg_temp session function of the
 * carrier's own name (sql/print.ts carrierEmptying), and the call of each written judged table's stand-up, a SECURITY
 * DEFINER function per judged table (physical/ddl/rules.ts addStandUps) that the installation grants every role writing
 * the table and a migration's Structure calls before its data steps (deploy/diff/diff.ts standUps); a carrier step's
 * `create` is `empty`, the call of its session function (sql/ast.ts EmptyCarrier), and a staged carrier holds its
 * `empty` beside its fill, where format 8 stood each carrier up by a DO block at every use and each capture and part
 * stood its deltas and the sentinel up inside the write's transaction; a capture requires its tables and refuses a
 * session that stood none up (core/sqlstate.ts grizzleUnstood, 55Z03).
 * A rule statement's rule that joins is navigated beside a relational filter of a query navigation reads no part of,
 * that filter its condition as written (analysis/theory/navigate.ts ruleReads, Navigator #chain `asWritten`), where
 * format 8 left the whole rule as written, one flat join, so every judge statement over such a rule reads it as a chain
 * of steps.
 * A migration's DROP ROLE of a role, a login, the decoder login or the function owner follows a statement of its own
 * that ends every session holding a temporary object of the role and waits for each to exit (sql/ast.ts EndHolders,
 * deploy/diff/diff.ts remove), naming the role by psql's literal variable `:'<stem>'`, which migrate fills as a quoted
 * literal (deploy/render/variables.ts), where format 8 dropped the role alone, refused (2BP01) while any session that
 * had written under it held its carriers; so every publish file that drops a role moves.
 * A relation parameter a ChangeSet binds to a query is an input of the call, evaluated once before its first stratum:
 * a ChangeSet's Description holds each such binding once, its rows under the parameter's private name (ChangeSetDesc
 * `boundRows`, which every served file's ChangeSet now holds, empty where it binds none), its members and read-backs
 * reading the parameter by that name, where format 8 copied the bound query into each of them; where a later stratum
 * or a read-back reads it, its write program empties and fills a carrier of its rows before the first stratum (plan
 * step `bound`, a carrier step of no stratum), which each reader's InputSet reads (ir/rel.ts InputSetInput `bound`),
 * where format 8 evaluated the query again in each statement over the state that statement reads; a bound parameter
 * read only by the first stratum's members is a part of their queries as before.
 */
export const artifactFormat = 8

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
