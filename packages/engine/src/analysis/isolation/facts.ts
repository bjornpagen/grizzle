/**
 * What the isolation certifier reads of an installation (certify.ts): plain facts, drawn from the representation by
 * those who own it (each role's grant plan, the law model's discharge of each relation's laws, each compiled change
 * member's statements), so the certifier reads no compiled artifact and a search can draw the facts themselves.
 */
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * One relation of the installation: the laws the installation's law model still discharges by deferred constraint
 * triggers that read it (laws/model/model.ts triggerLawsOver), none where every law over it is native (a key, a CHECK, a
 * domain or a foreign key); its declared keys, its primary key and each UNIQUE, by their fields; its counted groups,
 * each by its key's fields: the members, under one value of the key, of a family whose immutable owner holds their
 * count (a counted, ordered or fin family), a set the count law fixes once the owner is written; and every foreign key
 * it holds, native or a rule lowered to one, immediate or deferred.
 */
export interface RelationFacts {
	readonly triggerLaws: ReadonlyArray<LawId>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly countedGroups: ReadonlyArray<ReadonlyArray<string>>
	readonly references: ReadonlyArray<Reference>
}

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
 * One relation a statement writes and how. `from` lists the statement's reads, by their places in its `reads`, every
 * row it writes is positively joined with, so a read that finds nothing makes it write nothing.
 */
export interface WriteFact {
	readonly relation: string
	readonly op: "insert" | "update" | "delete"
	readonly from: ReadonlyArray<number>
}

/**
 * One relation a statement reads and how:
 *
 * - `mode`: `positive` where the rows it finds feed the statement, `negated` where their absence does (an anti-join,
 *   NOT EXISTS, r.not) or may (a value or a branch that reads both), `counted` where their number or an aggregate over
 *   them does, and `arbiter` where it is the arbitration of a relation the statement writes (an EXISTS or NOT EXISTS
 *   probe of it, an INSERT's ON CONFLICT, or a MERGE's NOT MATCHED), which PostgreSQL's unique check decides whatever
 *   the call read when its group binds a whole declared key;
 * - `own`: whether the read can see only rows the call's own earlier statements wrote;
 * - `group`: the group it binds (Group), or none where it reads the relation otherwise.
 *
 * A read of a derived relation is the reads of the stored relations its definition reads, each in the mode it has
 * there composed with the outer one.
 */
export interface ReadFact {
	readonly relation: string
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly own: boolean
	readonly group: Group | undefined
}

/**
 * The fields a read binds to values that come from the call, an ON CONFLICT arbitration's its conflict columns';
 * `binding`, what they are bound to, as canonical text (a parameter's number, a column of the call's own rows, or
 * EXCLUDED's column for the row an ON CONFLICT proposes), so two reads of one relation by the same fields and binding
 * read one group; and `rows`, how many groups that is: `one` where every field is bound to a parameter or to the
 * session's context, a value the call holds once, and `many` where one is bound to a column of the call's own rows,
 * one group per row, which another call's rows may split, some seen and some missed.
 */
export interface Group {
	readonly fields: ReadonlyArray<string>
	readonly binding: string
	readonly rows: "one" | "many"
}

/** One statement of a change member's flight: what it writes and what it reads. */
export interface StatementFacts {
	readonly writes: ReadonlyArray<WriteFact>
	readonly reads: ReadonlyArray<ReadFact>
}

/** One change member of a role, by its name, with its statements in flight order: a change sends one at least. */
export interface MemberFacts {
	readonly name: string
	readonly statements: NonEmptyReadonlyArray<StatementFacts>
}

/**
 * One role of one login: the privileges its grant plan holds, by relation, and its change members. Its read members
 * run SERIALIZABLE READ ONLY whatever its verdict, so no fact of theirs is read.
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
