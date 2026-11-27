/**
 * What the isolation certifier reads of an installation (certify.ts): plain facts, drawn from the representation by
 * those who own it (each role's grant plan, the law model's discharge of each relation's laws, each compiled change
 * member's statements), so the certifier reads no compiled artifact and a search can draw the facts themselves.
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Witness } from "#compiler/analysis/theory/query.ts"
import type { KeySource } from "#compiler/core/certificate.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import type { OnUpdate } from "#compiler/ir/law.ts"

/**
 * One relation of the installation: the laws the installation's law model still discharges by deferred constraint
 * triggers that read it (laws/model/model.ts triggerLawsOver), each with its witnesses (TriggerLaw), none where every
 * law over it is native (a key, a CHECK, a domain or a foreign key); its declared keys, its primary key and each UNIQUE
 * PostgreSQL enforces, by their columns' texts (ir/law.ts columnKey): a field by its name, and a column a law
 * adds (a selected side's term, a family's drawn index) by its identifier, which starts with
 * `__` as no declared name does, so a key over law columns is a key like any other, which no read of fields alone
 * binds whole; its counted groups, each by its key's fields: the members, under one value of the key, of a family whose
 * immutable owner holds their count (a counted, ordered or fin family), a set the count law fixes once the owner is
 * written; every foreign key it holds, native or a rule lowered to one, immediate or deferred, by the columns it
 * references, by the same texts; and what an insertion into it meets at its primary key (InsertsFact).
 */
export interface RelationFacts {
	readonly triggerLaws: ReadonlyArray<TriggerLaw>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly countedGroups: ReadonlyArray<ReadonlyArray<string>>
	readonly references: ReadonlyArray<Reference>
	readonly inserts: InsertsFact
}

/**
 * A rule over a query its deferred constraint triggers hold (laws/model/model.ts RuleTrigger): its law, and every shape
 * its violation takes, by the stored and closed relations each reads, one row of a match each (`rows`), rows present
 * beyond those (`present`) and rows absent (`absent`), as analysis/theory/query.ts witnesses reads them from the
 * rule's arms, the same arms its triggers' probes are built from. A write that makes a row of a relation present fires
 * the rule's trigger where the relation stands among a witness's `rows` or `present`, and one that makes a row absent
 * where it stands among its `absent`; no other write does.
 */
export interface TriggerLaw {
	readonly law: LawId
	readonly witnesses: NonEmptyReadonlyArray<Witness>
}

/**
 * What an insertion meets at a stored row (ir/law.ts Inserts): `repeatable`, an exact repeat at every field it states
 * or a refusal, so once its statement commits every key it stated holds the row it proposed; or `race`, at `key`, its
 * primary key's fields, any row, so only the arbitration at that key fixes the row there, and the row at another key
 * it stated may be another call's or none.
 */
export type InsertsFact =
	| { readonly kind: "repeatable" }
	| { readonly kind: "race"; readonly key: NonEmptyReadonlyArray<string> }

/**
 * One foreign key of a relation: the relation it references, that relation's columns it references by their texts
 * (RelationFacts), a declared key of it, law columns among them where a law's key is, a PERIOD key's span left out,
 * which its check reads by overlap; and what an update of the referenced key does to the rows that reference it:
 * carried to them (ON UPDATE CASCADE, a family's owner axis), or refused while any references it (NO ACTION).
 * PostgreSQL checks it by reads no statement shows: an insert or update of a referencing row reads the referenced row,
 * and an update or delete of a referenced row reads the rows that reference it.
 */
export interface Reference {
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	readonly onUpdate: OnUpdate
}

/**
 * A read of a statement by the body it stands in and its place in that body's `reads`: the statement's own body (`cte`
 * none), or the CTE instance `cte` of its `ctes` (StatementFacts).
 */
export interface ReadAt {
	readonly cte: number | undefined
	readonly read: number
}

/**
 * One relation a statement writes and how. `from` lists the statement's reads, by their bodies and places (ReadAt),
 * every row it writes is positively joined with, so a read that finds nothing makes it write nothing.
 */
export interface WriteFact {
	readonly relation: string
	readonly op: "insert" | "update" | "delete"
	readonly from: ReadonlyArray<ReadAt>
}

/**
 * One relation a statement reads and how:
 *
 * - `mode`: `positive` where the rows it finds feed the statement, `negated` where their absence does (an anti-join,
 *   NOT EXISTS, r.not) or may (a value or a branch that reads both), `counted` where their number or an aggregate over
 *   them does, and `arbiter` where it is the arbitration of a relation the statement writes (an EXISTS or NOT EXISTS
 *   probe of it, an INSERT's ON CONFLICT, one per object an ON CONFLICT with no target arbitrates, or a MERGE's NOT
 *   MATCHED), which PostgreSQL's unique check decides whatever the call read when its group binds a whole declared key,
 *   or the read of the row such an arbitration met by DO NOTHING under a transaction snapshot, for a row the INSERT
 *   proposed and did not insert, which is committed and visible to its statement, since DO NOTHING raises 40001 on a
 *   conflicting row its snapshot cannot see;
 * - `own`: whether the read can see only rows the call's own earlier statements wrote;
 * - `group`: the group it binds (ReadGroup), or none where it reads the relation otherwise;
 * - `probes`: the probes it stands beneath, outermost first, by their places in its statement's `probes`;
 * - `base`: its mode were every one of those probes a function of positive reads, which `mode` composes them over.
 *
 * A read of a derived relation is the reads of the stored relations its definition reads, each in the mode it has
 * there composed with the outer one.
 */
/** How a read reaches its statement (ReadFact `mode`). */
export type ReadMode = "positive" | "negated" | "counted" | "arbiter"

export interface ReadFact {
	readonly relation: string
	readonly mode: ReadMode
	readonly base: ReadMode
	readonly probes: ReadonlyArray<number>
	readonly own: boolean
	readonly group: ReadGroup | undefined
}

/**
 * A place in a statement where its reads stop reaching it by their presence alone: a negation (NOT, NOT EXISTS, NOT
 * IN, an EXCEPT's later arm, a MERGE's NOT MATCHED), a predicate in a value or a branch, or a count (a core that counts,
 * a scalar or ARRAY subquery). `gates` lists the statement's writes, by their places in its `writes`, whose source the
 * probe stands in, none for one the statement's result alone reads, as a refusal arm. `core` is the core whose rows the
 * probe filters or counts, the one it stands in, or a grouped core of its own, which yields no row from no input; none
 * where it stands in no core (SiteCore). `chain` is the probes a read on that core's rows stands beneath: the core's
 * own, and a grouped core's probe with them. Every place it names is its body's (BodyFacts).
 */
export interface ProbeFact<Core extends SiteCore = number | undefined> {
	readonly gates: ReadonlyArray<number>
	readonly core: Core
	readonly chain: ReadonlyArray<number>
}

/**
 * Where a probe stands: in a core of its body, by its number; in the core of the site that reads the CTE instance it
 * stands in (`site`), where the instance's query opens it outside every core of its own (a count of a core aggregating
 * with no GROUP BY, an EXCEPT's later arm, a subquery in its LIMIT, OFFSET or ORDER BY), judged at each use by that
 * use's core (CteUse); or in none, which only a statement's own body holds.
 */
export type SiteCore = number | "site" | undefined

/**
 * What a field a read binds is bound to, resolved where the binding stands, so two bindings of one value are one
 * binding wherever they stand, in one statement or two:
 *
 * - a binding the call holds before its first snapshot (core/certificate.ts KeySource): a declared scalar parameter's
 *   placeholder, or a clock reading of one, by the parameter's name, one value for the call; a context's field, by the
 *   context's name and the field's, one value for the call; or a field of a relation input's rows (`input`), a relation
 *   parameter's or a member slot's, through every CTE and derived table that carries its column, one value per row;
 * - `constant`: a literal its statement spells, by its SQL spelling (sql/print.ts printExpr), one value;
 * - `own`: a column of a source of the call's own rows that carries none of those, a CTE's, a derived table's, a
 *   function's, VALUES or a stratum's nested rows, by the source's alias and the column: one value where the source is
 *   one row the call holds once (`rows`), else one per row, which another call's rows may split, some seen and some
 *   missed;
 * - `proposed`: a column of the row an ON CONFLICT proposes (EXCLUDED's) that carries none of those, one per row;
 * - `stored`: a field of the row another read of the same body finds, by that read's place in its body's `reads`
 *   (BodyFacts) and the field: a value no binding of the call holds, the row that read finds holds it.
 */
export type Binding =
	| KeySource
	| { readonly kind: "constant"; readonly spelled: string }
	| {
			readonly kind: "own"
			readonly alias: string
			readonly column: string
			readonly rows: "one" | "many"
	  }
	| { readonly kind: "proposed"; readonly column: string }
	| { readonly kind: "stored"; readonly read: number; readonly field: string }

/** One field a read binds, by its name, and what it is bound to (Binding). */
export interface FieldBinding {
	readonly field: string
	readonly by: Binding
}

/**
 * The fields a read binds, an ON CONFLICT arbitration's its conflict columns', each once and sorted by field, with what
 * each is bound to (`bound`). Two reads of one relation by the same bindings read one group, and a read whose bindings
 * on a declared key's fields are another's reads at most the row the other reads there.
 */
export interface ReadGroup {
	readonly bound: NonEmptyReadonlyArray<FieldBinding>
}

/** The fields a group binds, sorted. */
export const groupFields = (group: ReadGroup): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(group.bound, (b) => b.field)

/**
 * How many values a binding takes for the call: `one`, a declared parameter's, a context's field's, a constant's or a
 * column of an own source of one row; `many`, one per row of the call's own rows, an input's, an own source's of many or a proposed
 * row's; and none (`stored`) for a field of a row another read finds, which no value of the call names.
 */
export const bindingRows = (b: Binding): "one" | "many" | "stored" => {
	switch (b.kind) {
		case "param":
		case "context":
		case "constant":
			return "one"
		case "own":
			return b.rows
		case "input":
		case "proposed":
			return "many"
		case "stored":
			return "stored"
	}
}

/** Whether two bindings bind one value: the same parameter, context field, input field, own column, proposed column, or
 * field of the read at one place of one body. */
export const sameBinding = (a: Binding, b: Binding): boolean => bindingText(a) === bindingText(b)

/** A binding's canonical text, which names its value once: `:name` for a parameter, as a statement spells it. */
export const bindingText = (b: Binding): string => {
	switch (b.kind) {
		case "param":
			return `:${b.name}`
		case "context":
			return `context ${JSON.stringify([b.context, b.field])}`
		case "input":
			return `input ${JSON.stringify([b.parameter, b.field])}`
		case "constant":
			return `constant ${b.spelled}`
		case "own":
			return `${b.alias}.${b.column}`
		case "proposed":
			return `excluded.${b.column}`
		case "stored":
			return `read ${b.read}.${b.field}`
	}
}

/**
 * One source every row of a body's core comes through, the core's FROM sources joined inner or crosswise: a table read,
 * by its place in the body's `reads`; a derived table's one core, by its number in `cores`; a UNION's, UNION ALL's
 * among them, by its arms, each its own row sources, every row of the UNION one arm's; or a query CTE's rows, by the
 * place of the body's use of it in `uses`, which come through the rows of the instance it reads (CteFacts.rows).
 */
export type RowSource =
	| { readonly kind: "read"; readonly read: number }
	| { readonly kind: "core"; readonly core: number }
	| {
			readonly kind: "union"
			readonly arms: NonEmptyReadonlyArray<ReadonlyArray<RowSource>>
	  }
	| { readonly kind: "use"; readonly use: number }

/**
 * Where a body reads a query CTE: the instance it reads (`cte`, by its place in the statement's `ctes`), the probes of
 * the body the site stands beneath (`probes`), the core of the body it stands in (`core`), none for a MERGE's source,
 * and how many of the body's reads it found before it (`at`), so the instance's reads stand, for that site, between the
 * body's reads before it and after it.
 */
export interface CteUse {
	readonly cte: number
	readonly probes: ReadonlyArray<number>
	readonly core: number | undefined
	readonly at: number
}

/**
 * What one body of a statement reads: its reads, the probes among them and each of its cores' row sources by its
 * number, a core's before those of the derived tables and subqueries it holds, each by its place in the body; and the
 * query CTEs it reads (`uses`). A source no allowed step reaches is no row source: a LATERAL one, a function's rows,
 * VALUES, a relation input's arrays, a context's fact, the call's own rows of a data-modifying or a recursive CTE, an
 * INTERSECT, an EXCEPT, and every source of a core aggregating with no GROUP BY, which yields a row over no input.
 */
export interface BodyFacts<Core extends SiteCore> {
	readonly reads: ReadonlyArray<ReadFact>
	readonly probes: ReadonlyArray<ProbeFact<Core>>
	readonly cores: ReadonlyArray<ReadonlyArray<RowSource>>
	readonly uses: ReadonlyArray<CteUse>
}

/**
 * One instance of a query CTE: its query walked once for every site that reads it where it arrives alike, at one
 * polarity, counted or not, feeding the same writes (program/isolation/extract.ts), its reads, probes and cores its own
 * (BodyFacts), none of them beneath a probe of a site that reads it; `rows`, the row sources every row of its query
 * comes through, by its own cores, reads and uses; and `query`, the query CTE it walks, by a number the statement gives
 * each of its query CTEs. The instances of one query read the same reads, in the same order, each at its own arrival: a read of a
 * query CTE is one read of the statement, however many sites read the CTE and however they arrive. A probe its query
 * opens outside every core of its own stands in the core of the site that reads it (SiteCore `site`).
 *
 * At each site that reads it (CteUse), it stands for the reads, probes and cores its walk at that site would find: each
 * of its reads beneath the site's probes and its own, each of its probes chained beneath the site's, and its `site`
 * probes in the site's core. A statement's facts so name each query CTE's reads once, however many sites read it.
 */
export interface CteFacts extends BodyFacts<number | "site"> {
	readonly rows: ReadonlyArray<RowSource>
	readonly query: number
}

/**
 * One statement of a change member's flight: what it writes, and what its own body reads (BodyFacts), with the
 * instances of the query CTEs its bodies read (`ctes`), each by its place.
 */
export interface StatementFacts extends BodyFacts<number | undefined> {
	readonly writes: ReadonlyArray<WriteFact>
	readonly ctes: ReadonlyArray<CteFacts>
}

/** One change member of a role, by its name, with its statements in flight order: a change sends one at least. */
export interface MemberFacts {
	readonly name: string
	readonly statements: NonEmptyReadonlyArray<StatementFacts>
}

/**
 * A change member of a role with no READ COMMITTED form: its name, and the relation a write of it has none for, an
 * insert of complete facts into a span primary key, whose exclusion constraint arbitrates by ON CONFLICT DO NOTHING
 * alone, so no statement of the insert tells a requested fact it met from one it made (core/errors.ts
 * NoReadCommittedForm). Its role runs SERIALIZABLE from the first round, by the condition `form` (certify.ts).
 */
export interface Unformed {
	readonly member: string
	readonly relation: string
}

/**
 * What a role writes, as its facts know it: `served`, by its change members, whose facts in the form served at READ
 * COMMITTED are every statement a call of them sends (none for a role whose members have no READ COMMITTED form, whose
 * facts are its lowering's, certify.ts Candidate); or `unknown`, where it has no change member, so it writes, if at all,
 * by direct SQL alone, which grizzle never sees. A fact grizzle cannot know is no fact that is absent: unknown writes
 * are not writes of nothing, but any transaction its privileges permit, which the certifier bounds (certify.ts
 * writtenFacts). Its grants are a fact grizzle knows, which PostgreSQL holds a direct transaction to as it holds a
 * member: `readable`, by declared name, is every relation a statement of the role can read (physical/ddl/roles.ts
 * readableRelations), and a read of any other is refused with 42501 before its plan reads a row.
 */
export type RoleWrites =
	| { readonly kind: "served"; readonly members: ReadonlyArray<MemberFacts> }
	| { readonly kind: "unknown"; readonly readable: ReadonlyArray<string> }

/**
 * One role of one login: the privileges its grant plan holds, by relation, and what it writes (RoleWrites), its change
 * members in the form served at READ COMMITTED, the one certification judges it by. Its SERIALIZABLE form is no fact of it: certification
 * takes it once the role runs SERIALIZABLE, as its lowering (certify.ts Candidate), and judges the others by it beside
 * these. Its read members run SERIALIZABLE READ ONLY whatever its verdict, DEFERRABLE where declared so, so no fact of
 * theirs is read: a read writes nothing, so it is never a pivot, and of a dangerous structure through it, PostgreSQL's
 * SSI refuses one whose pivot and later writer are SERIALIZABLE (a deferrable read by retaking an unsafe snapshot), and
 * conditions `laws` and `pivot` refuse one through a READ COMMITTED writer, which SSI never tracks.
 */
export interface RoleFacts {
	readonly login: string
	readonly role: string
	readonly privileges: ReadonlyMap<string, ReadonlySet<TablePrivilege>>
	readonly writes: RoleWrites
}

/**
 * Every relation's facts by name, and every role of every login over the installation's base: built whole by
 * isolationInput (input.ts) from the compiled installation and logins, so no relation a role reads or writes and no
 * change member lacks its fact; a relation the certifier finds no fact of is a reason, never a pass.
 */
export interface IsolationInput {
	readonly relations: ReadonlyMap<string, RelationFacts>
	readonly roles: ReadonlyArray<RoleFacts>
}
