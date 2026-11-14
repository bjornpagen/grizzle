/**
 * What the isolation certifier reads of an installation (certify.ts): plain facts, drawn from the representation by
 * those who own it (each role's grant plan, the law model's discharge of each relation's laws, each compiled change
 * member's statements), so the certifier reads no compiled artifact and a search can draw the facts themselves.
 */
import type { LawId } from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * One relation of the installation: the laws the installation's law model still discharges by deferred constraint
 * triggers that read it (laws/model/model.ts triggerLawsOver), none where every law over it is native (a key, a CHECK, a
 * domain or a foreign key); its declared keys, its primary key and each UNIQUE, by their fields; its counted groups,
 * each by its key's fields: the members, under one value of the key, of a family whose immutable owner holds their
 * count (a counted, ordered or fin family), a set the count law fixes once the owner is written; every foreign key it
 * holds, native or a rule lowered to one, immediate or deferred; and what an insertion into it meets at its primary key
 * (InsertsFact).
 */
export interface RelationFacts {
	readonly triggerLaws: ReadonlyArray<LawId>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly countedGroups: ReadonlyArray<ReadonlyArray<string>>
	readonly references: ReadonlyArray<Reference>
	readonly inserts: InsertsFact
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
 * One foreign key of a relation: the relation it references, that relation's fields it references, a declared key of
 * it, and what an update of the referenced key does to the rows that reference it: carried to them (ON UPDATE CASCADE,
 * a family's owner axis), or refused while any references it (NO ACTION). PostgreSQL checks it by reads no statement
 * shows: an insert or update of a referencing row reads the referenced row, and an update or delete of a referenced row
 * reads the rows that reference it.
 */
export interface Reference {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly onUpdate: "cascade" | "noAction"
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
 * every row it writes is positively joined with, so a read that finds nothing makes it write nothing. A `retire` is a
 * retirable unit's retirement (physical/ddl/retire.ts), one of each relation of the unit: its header's retirement field
 * set and its bodies' rows of the retired groups deleted, by the unit's retire function, which locks every header it
 * retires before it reads a body and so waits for every call that holds one of its groups; it reads no row no other
 * call holds, and makes no check another call's write can pass.
 */
export interface WriteFact {
	readonly relation: string
	readonly op: "insert" | "update" | "delete" | "retire"
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
 * - `group`: the group it binds (Group), or none where it reads the relation otherwise;
 * - `probes`: the probes it stands beneath, outermost first, by their places in its statement's `probes`;
 * - `base`: its mode were every one of those probes a function of positive reads, which `mode` composes them over.
 *
 * A read of a derived relation is the reads of the stored relations its definition reads, each in the mode it has
 * there composed with the outer one.
 */
export interface ReadFact {
	readonly relation: string
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly base: "positive" | "negated" | "counted" | "arbiter"
	readonly probes: ReadonlyArray<number>
	readonly own: boolean
	readonly group: Group | undefined
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
 * One field a read binds to a value that comes from the call, and `by`, what it is bound to, as canonical text: a
 * parameter by the declared parameter it carries (`:name`), or by its number (`$n`) where it carries none, so two
 * placeholders of one parameter, in one statement or two, bind one value; a column of the call's own rows; or, for the
 * row an ON CONFLICT proposes, the parameter its conflict column's value carries, through the insert's source and the
 * call's own cores it reads, else EXCLUDED's column.
 */
export interface FieldBinding {
	readonly field: string
	readonly by: string
}

/**
 * The fields a read binds, an ON CONFLICT arbitration's its conflict columns', each once and sorted by field, with what
 * each is bound to (`bound`). Two reads of one relation by the same bindings read one group, and a read whose bindings
 * on a declared key's fields are another's reads at most the row the other reads there. `rows` is how many groups that
 * is: `one` where every field is bound to a parameter or to the session's context, a value the call holds once, and
 * `many` where one is bound to a column of the call's own rows, one group per row, which another call's rows may split,
 * some seen and some missed.
 */
export interface Group {
	readonly bound: NonEmptyReadonlyArray<FieldBinding>
	readonly rows: "one" | "many"
}

/** The fields a group binds, sorted. */
export const groupFields = (group: Group): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(group.bound, (b) => b.field)

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
 * (BodyFacts), none of them beneath a probe of a site that reads it, and `rows`, the row sources every row of its query
 * comes through, by its own cores, reads and uses. A probe its query opens outside every core of its own stands in the
 * core of the site that reads it (SiteCore `site`).
 *
 * At each site that reads it (CteUse), it stands for the reads, probes and cores its walk at that site would find: each
 * of its reads beneath the site's probes and its own, each of its probes chained beneath the site's, and its `site`
 * probes in the site's core. A statement's facts so name each query CTE's reads once, however many sites read it.
 */
export interface CteFacts extends BodyFacts<number | "site"> {
	readonly rows: ReadonlyArray<RowSource>
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
 * One role of one login: the privileges its grant plan holds, by relation, and its change members in the form served at
 * READ COMMITTED (`members`), the one certification judges it by. Its SERIALIZABLE form is no fact of it: certification
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
	readonly members: ReadonlyArray<MemberFacts>
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
