import { Array as Arr, Effect } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The contract-host programs: a contract's values are its consumer's. A contract's host type is its base's host type
 * under its consumer's key, `Marked<Infer<base>, typeof key>` (core/brand.ts), which only the key's mint makes
 * (mintOf), so a write of the contract takes that type alone and a read delivers it.
 *
 * The host box is every kind of base a contract is over, each its own carrier (a base the engine refuses, a set over a
 * roster, bytes or a digest, is none): each pg type, numeric at scale 0 and at another, uuid, natural, date, a pattern
 * of infinite language, of finite language and of a fixed prefix, a pattern held to its bytes, two patterns intersected,
 * a closed id of an ordered roster, of an unordered one and of a subset, a span, a vector, another contract, and a
 * contract that checks its values and proves a fact of them. Each cell declares its contract under a key of its own and
 * a second contract over the same base under another key, then states:
 *
 * - the contract's host type is the base's under the key;
 * - a fact's field takes a value of the host type, and the key's mint of a plain base value, and refuses a plain base
 *   value and the other contract's value, as no fact of the relation;
 * - a program parameter's argument takes a value of the host type and refuses a plain base value and the other
 *   contract's;
 * - a read delivers the host type: the relation's fact and a query's head.
 *
 * The value box is every position a JavaScript value stands at a contract's term, by every kind of value: a typed
 * constant (Type.literal) and a conditional's other arm, where the value becomes one of the contract, take the key's
 * mint of a value alone; a comparison and a match's binding, where it is only compared, take a value of the base, the
 * mint's or the other contract's among them.
 *
 * The mint box is every position the database makes a contract's values at, by every target and key. A cast
 * (Type.cast), a drawn field and an accumulated field, into a consumer's contract, a contract over another, natural and
 * bigint (drawn takes no bigint): a consumer's contract takes its keys, its own then its base's down its chain, as the
 * host mints a value of it only through each of their mints, and refuses none, another's, or one of a chain's alone;
 * every other target takes none. A clock bound to a parameter of bigint or natural takes no key, of a consumer's
 * contract its key by the parameter's name, and of a contract over another none it could take. A declared function's
 * result of its base takes no mints, and of a consumer's contract or a contract over another, as a value, rows, one row
 * and a variant's arm, each contract's key by its name. A contract over another is under a key apart from its base's.
 *
 * The oracle: the rule of who makes a contract's values, a specification: the holder of its key, by its mint.
 */

/** Each base of the host box: the base, and what follows it in the contract's call (its check and its facts), or nothing. */
const bases = {
	int2: ["int2", ""],
	int4: ["int4", ""],
	int8: ["int8", ""],
	"numeric at scale 0": ["numeric(9, 0)", ""],
	"numeric at scale 2": ["numeric(9, 2)", ""],
	float4: ["float4", ""],
	float8: ["float8", ""],
	money: ["money", ""],
	bool: ["bool", ""],
	uuid: ["uuid", ""],
	natural: ["natural", ""],
	date: ["date", ""],
	"a pattern of infinite language": ['str.regex("^[a-z]{1,8}$")', ""],
	"a pattern of finite language": ['str.regex("^(yes|no)$")', ""],
	"a pattern of a fixed prefix": ['str.regex("^user_[0-9a-z]{1,8}$")', ""],
	"a pattern held to its bytes": ['str.bytes(8, str.regex("^[a-z]{1,8}$"))', ""],
	"two patterns intersected": ['str.and(str.regex("^[a-z]{1,8}$"), str.regex("^a"))', ""],
	"a closed id of an ordered roster": ["closedId(Ordered)", ""],
	"a closed id of an unordered roster": ["closedId(Unordered)", ""],
	"a closed id of a subset": ['closedId(Ordered, { only: ["low"] })', ""],
	"a range": ["range(int4)", ""],
	"a vector": ["vector(3)", ""],
	"another contract": ["Cents", ""],
	"a contract that checks and proves": ["int8", ', (v) => Logic.ne(v, 0n), { proves: ["nonzero"] }']
} as const

type Base = keyof typeof bases

/** The cells of contractHostBox, minted as a dictionary in its door (test/types/api/contract-host.dictionary.ts). */
export const contractHostBoxItems: Arr.NonEmptyReadonlyArray<Base> = [
	"int2",
	"int4",
	"int8",
	"numeric at scale 0",
	"numeric at scale 2",
	"float4",
	"float8",
	"money",
	"bool",
	"uuid",
	"natural",
	"date",
	"a pattern of infinite language",
	"a pattern of finite language",
	"a pattern of a fixed prefix",
	"a pattern held to its bytes",
	"two patterns intersected",
	"a closed id of an ordered roster",
	"a closed id of an unordered roster",
	"a closed id of a subset",
	"a range",
	"a vector",
	"another contract",
	"a contract that checks and proves"
]

/** The programs' prelude (test/support/programs/contract-host.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/contract-host.ts"))

/** What every cell reads: the type equality the cells state, the two rosters the closed ids are of, and the contract another contract is over. */
const header: ReadonlyArray<string> = [
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	'export const Ordered = closed.ordered("Ordered", ["low", "high"])',
	'export const Unordered = closed.unordered("Unordered", ["a", "b"])',
	'export const centsKey = Symbol("Cents")',
	'export const Cents = contract<typeof centsKey>()("Cents", int8)',
	""
]

/** The refusal a fact of a value its contract's key's mint did not make meets. */
const factRefusal = "a member fact is not a fact of the relation"

/**
 * A host cell's lines: its contract and the other contract over its base, each under its key; its host type; a fact's
 * field, a parameter's argument and a read, each of the host type and none other.
 */
const hostLines = (base: Base, at: number): ReadonlyArray<string> => {
	const [field, rest] = bases[base]
	const write = (value: string) =>
		`ChangeSet.empty(S${at}).insert(R${at}, [{ id: 1, value: ${value} }])`
	return [
		`// ${base}`,
		`export const base${at} = ${field}`,
		`export const key${at} = Symbol("C${at}")`,
		`export const otherKey${at} = Symbol("O${at}")`,
		`export const C${at} = contract<typeof key${at}>()("C${at}", base${at}${rest})`,
		`export const O${at} = contract<typeof otherKey${at}>()("O${at}", base${at})`,
		`export const to${at} = mintOf(key${at})`,
		`export type host${at} = Expect<Equals<Infer<typeof C${at}>, Marked<Infer<typeof base${at}>, typeof key${at}>>>`,
		`export declare const held${at}: Infer<typeof C${at}>`,
		`export declare const plain${at}: Infer<typeof base${at}>`,
		`export declare const other${at}: Infer<typeof O${at}>`,
		`export const R${at} = relation("R${at}", { id: int4, value: C${at} }, ["id"])`,
		`export const S${at} = schema("S${at}", [Ordered, Unordered, R${at}], [])`,
		`export const written${at} = ${write(`held${at}`)}`,
		`export const minted${at} = ${write(`to${at}(plain${at})`)}`,
		`// @ts-expect-error -- refusal: ${factRefusal}`,
		`export const plainWritten${at} = ${write(`plain${at}`)}`,
		`// @ts-expect-error -- refusal: ${factRefusal}`,
		`export const otherWritten${at} = ${write(`other${at}`)}`,
		`export const read${at} = query(S${at}).rule((r) => { const { id, value } = v(R${at}, "r"); return r.match(R${at}, { id, value }).find({ id, value, x: r.param("x", C${at}) }) })`,
		`export type argument${at} = ParamArg<ParamsOf<typeof read${at}>>`,
		`export const passed${at}: argument${at} = { x: held${at} }`,
		`// @ts-expect-error -- refused: a parameter of a contract takes only its host type's values`,
		`export const plainPassed${at}: argument${at} = { x: plain${at} }`,
		`// @ts-expect-error -- refused: a parameter of a contract takes only its host type's values`,
		`export const otherPassed${at}: argument${at} = { x: other${at} }`,
		`export type fact${at} = Expect<Equals<Fact<typeof R${at}>["value"], Infer<typeof C${at}>>>`,
		`export type head${at} = Expect<Equals<HeadOf<typeof read${at}>["value"], Infer<typeof C${at}>>>`,
		""
	]
}

/** The program over a batch of the host box's cells, its imports read through its prelude as `entry` reaches it. */
export const contractHostProgram = (
	cells: Arr.NonEmptyReadonlyArray<Base>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/contract-host.ts: a contract's values are its key's mint's.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: header },
			...Arr.map(cells, (base, at) => ({ owner: caseOwned(at), lines: hostLines(base, at) }))
		]
	)
]

/**
 * The positions a JavaScript value stands at opposite a term of a contract: those where it becomes a value of the
 * contract, a typed constant and a conditional's other arm, and those where it is only compared, a comparison and a
 * match's binding.
 */
const positions = {
	"a typed constant": { makes: true },
	"a conditional's other arm": { makes: true },
	"a comparison": { makes: false },
	"a match's binding": { makes: false }
} as const

type Position = keyof typeof positions

/** The values a cell writes at its position: a plain bigint, the key's mint of one, and another contract's value. */
const values = {
	"a plain bigint": "5n",
	"the key's mint of a bigint": "toAmount(5n)",
	"another contract's value": "toOther(5n)"
} as const

type Value = keyof typeof values

/** A cell of the value box: a position and a value. */
export interface ValueCell {
	readonly position: Position
	readonly value: Value
}

/** The cells of contractValueBox, every position by every value, minted as a dictionary in its door. */
export const contractValueBoxItems: Arr.NonEmptyReadonlyArray<ValueCell> = Arr.flatMap(
	["a typed constant", "a conditional's other arm", "a comparison", "a match's binding"] as const,
	(position) =>
		Arr.map(
			["a plain bigint", "the key's mint of a bigint", "another contract's value"] as const,
			(value) => ({ position, value })
		)
)

/** What every value cell reads: the contract, another over its base, their mints, and a relation of the contract. */
const valueHeader: ReadonlyArray<string> = [
	'export const amountKey = Symbol("Amount")',
	'export const otherKey = Symbol("Other")',
	'export const Amount = contract<typeof amountKey>()("Amount", int8)',
	'export const Other = contract<typeof otherKey>()("Other", int8)',
	"export const toAmount = mintOf(amountKey)",
	"export const toOther = mintOf(otherKey)",
	'export const Ledger = relation("Ledger", { id: int4, amount: Amount }, ["id"])',
	'export const Books = schema("Books", [Ledger], [])',
	""
]

/** A value cell's statement: its value at its position. */
const statementOf = (cell: ValueCell, at: number): string => {
	const value = values[cell.value]
	const over = (body: string) =>
		`export const q${at} = query(Books).rule((r) => { const { id, amount } = v(Ledger, "l"); return ${body} })`
	switch (cell.position) {
		case "a typed constant":
			return `export const q${at} = query(Books).rule((r) => r.find({ c: Type.literal(Amount, ${value}) }))`
		case "a conditional's other arm":
			return over(
				`r.match(Ledger, { id, amount }).find({ c: Logic.cond(Logic.gt(id, 0), amount, ${value}) })`
			)
		case "a comparison":
			return over(`r.match(Ledger, { id, amount }).where(r.ge(amount, ${value})).find({ id })`)
		case "a match's binding":
			return `export const q${at} = query(Books).rule((r) => { const { id } = v(Ledger, "l"); return r.match(Ledger, { id, amount: ${value} }).find({ id }) })`
	}
}

/**
 * Whether the rule admits a value cell: a position that makes a value of the contract takes the key's mint's alone, and
 * one that only compares takes any value of the base.
 */
const admitsValue = (cell: ValueCell): boolean =>
	!positions[cell.position].makes || cell.value === "the key's mint of a bigint"

/** A value cell's lines: its statement, under the directive its refusal raises where the rule refuses it. */
const valueLines = (cell: ValueCell, at: number): ReadonlyArray<string> => [
	`// ${cell.value} at ${cell.position}`,
	...(admitsValue(cell)
		? []
		: [
				"// @ts-expect-error -- refused: a value that becomes a contract's is one its key's mint made"
			]),
	statementOf(cell, at),
	""
]

/** The program over a batch of the value box's cells, its imports read through its prelude as `entry` reaches it. */
export const contractValueProgram = (
	cells: Arr.NonEmptyReadonlyArray<ValueCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/contract-host.ts: a value that becomes a contract's is its key's mint's.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: valueHeader },
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: valueLines(cell, at) }))
		]
	)
]

/**
 * The keys a contract and a mint are over: a unique symbol, its module's own, and a value of type `symbol`, which any
 * symbol is, a registered one passed through a binding of its type among them. A registered symbol held by a const is
 * a unique symbol to TypeScript, which tells no registry apart; mintOf refuses it when it runs (core/brand.ts
 * admitHostKey).
 */
const keys = {
	"a unique symbol": ' = Symbol("K")',
	"a value of type symbol": ': symbol = Symbol.for("K")'
} as const

type KeyKind = keyof typeof keys

/** Where a key stands: a contract's first call's type argument, and mintOf's argument. */
type KeyPosition = "a contract" | "mintOf"

/** A cell of the key box: a key's kind at a position. */
export interface KeyCell {
	readonly key: KeyKind
	readonly position: KeyPosition
}

/** The cells of contractKeyBox, every kind of key at every position, minted as a dictionary in its door. */
export const contractKeyBoxItems: Arr.NonEmptyReadonlyArray<KeyCell> = Arr.flatMap(
	["a contract", "mintOf"] as const,
	(position) =>
		Arr.map(["a unique symbol", "a value of type symbol"] as const, (key) => ({ key, position }))
)

/** The refusal of a key no module holds alone. */
const keyRefusal =
	"a host's key is a unique symbol: its module's own Symbol(name), never a registered one, which any module reads"

/** A key cell's lines: its key, then its contract or its mint over it, refused where the key is no unique symbol. */
const keyLines = (cell: KeyCell, at: number): ReadonlyArray<string> => [
	`// ${cell.key} at ${cell.position}`,
	`export const k${at}${keys[cell.key]}`,
	...(cell.key === "a unique symbol" ? [] : [`// @ts-expect-error -- refusal: ${keyRefusal}`]),
	cell.position === "a contract"
		? `export const C${at} = contract<typeof k${at}>()("C${at}", int8)`
		: `export const to${at} = mintOf(k${at})`,
	""
]

/** The program over a batch of the key box's cells, its imports read through its prelude as `entry` reaches it. */
export const contractKeyProgram = (
	cells: Arr.NonEmptyReadonlyArray<KeyCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/contract-host.ts: a contract's key is its module's own unique symbol.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: [] },
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: keyLines(cell, at) }))
		]
	)
]

/** Where the database makes a value from values of other types. */
type MintPosition = "a cast" | "a drawn field" | "an accumulated field"

/** What a mint makes: a consumer's contract, a contract over another, or a type no consumer owns. */
type MintTarget = "a consumer's contract" | "a contract over another" | "natural" | "bigint"

/** What a mint is handed after its own arguments. */
type MintKeyKind =
	| "its keys"
	| "no key"
	| "another contract's key"
	| "its own key alone"
	| "its base's key alone"

/** A declared function's result shape. */
type ResultShape = "a value" | "rows" | "one row" | "a variant"

/** What a declared function's result is of. */
type ResultType = "its base" | "a consumer's contract" | "a contract over another"

/** What a declared function is handed after its definition. */
type MintsKind = "its keys" | "no mints" | "another contract's key" | "its own key alone"

/** A clock's parameter, and the keys its member is handed. */
type ClockCase =
	| Readonly<{ param: "bigint" | "natural"; keys: "no key" | "a key" }>
	| Readonly<{
			param: "a consumer's contract"
			keys: "its key" | "no key" | "another contract's key"
	  }>
	| Readonly<{ param: "a contract over another"; keys: "its own key" }>

/** A cell of the mint box: a mint, a clock, a declared function's result, or a contract over another's key. */
export type MintCell =
	| Readonly<{ kind: "mint"; position: MintPosition; target: MintTarget; key: MintKeyKind }>
	| Readonly<{ kind: "clock"; clock: ClockCase }>
	| Readonly<{ kind: "result"; shape: ResultShape; type: ResultType; mints: MintsKind }>
	| Readonly<{ kind: "apart"; key: "a key of its own" | "its base's key" }>

/** The targets of each position: drawn draws natural and a contract over an integer alone, no bigint. */
const targetsOf = (position: MintPosition): Arr.NonEmptyReadonlyArray<MintTarget> =>
	position === "a drawn field"
		? ["a consumer's contract", "a contract over another", "natural"]
		: ["a consumer's contract", "a contract over another", "natural", "bigint"]

/** The keys a target is handed. */
const keysOf = (target: MintTarget): Arr.NonEmptyReadonlyArray<MintKeyKind> => {
	switch (target) {
		case "a consumer's contract":
			return ["its keys", "no key", "another contract's key"]
		case "a contract over another":
			return ["its keys", "no key", "its own key alone", "its base's key alone"]
		case "natural":
		case "bigint":
			return ["no key", "another contract's key"]
	}
}

/** The mints a result of a type is handed. */
const mintsOf = (type: ResultType): Arr.NonEmptyReadonlyArray<MintsKind> => {
	switch (type) {
		case "its base":
			return ["no mints", "another contract's key"]
		case "a consumer's contract":
			return ["its keys", "no mints", "another contract's key"]
		case "a contract over another":
			return ["its keys", "its own key alone"]
	}
}

/** Every clock's parameter with every keys it is handed. */
const clockCases: Arr.NonEmptyReadonlyArray<ClockCase> = [
	{ param: "bigint", keys: "no key" },
	{ param: "bigint", keys: "a key" },
	{ param: "natural", keys: "no key" },
	{ param: "natural", keys: "a key" },
	{ param: "a consumer's contract", keys: "its key" },
	{ param: "a consumer's contract", keys: "no key" },
	{ param: "a consumer's contract", keys: "another contract's key" },
	{ param: "a contract over another", keys: "its own key" }
]

/**
 * The cells of contractMintBox, minted as a dictionary in its door: every position at every target under every key,
 * every clock, every result shape of every type under every mints, and a contract over another under each key.
 */
export const contractMintBoxItems: Arr.NonEmptyReadonlyArray<MintCell> = [
	...Arr.flatMap(["a cast", "a drawn field", "an accumulated field"] as const, (position) =>
		Arr.flatMap(targetsOf(position), (target) =>
			Arr.map(keysOf(target), (key): MintCell => ({ kind: "mint", position, target, key }))
		)
	),
	...Arr.map(clockCases, (clock): MintCell => ({ kind: "clock", clock })),
	...Arr.flatMap(["a value", "rows", "one row", "a variant"] as const, (shape) =>
		Arr.flatMap(["its base", "a consumer's contract", "a contract over another"] as const, (type) =>
			Arr.map(mintsOf(type), (mints): MintCell => ({ kind: "result", shape, type, mints }))
		)
	),
	{ kind: "apart", key: "a key of its own" },
	{ kind: "apart", key: "its base's key" }
]

/** The mint box's declarations: two contracts, one over the other, each with its key and mint, a roster, and T. */
const mintHeader: ReadonlyArray<string> = [
	'export const centsKey = Symbol("Cents")',
	'export const Cents = contract<typeof centsKey>()("Cents", int8, (x) => Logic.ge(x, 0n))',
	"export const toCents = mintOf(centsKey)",
	'export const outerKey = Symbol("Outer")',
	'export const Outer = contract<typeof outerKey>()("Outer", Cents)',
	"export const toOuter = mintOf(outerKey)",
	'export const Arm = closed.unordered("Arm", ["a", "b"])',
	'export const T = relation("T", { id: int4, n: int8 }, ["id"])',
	'export const S = schema("S", [T], [])',
	""
]

/** Each target as the program spells it, and its value at 0, an accumulated field's start. */
const targetText: { readonly [T in MintTarget]: readonly [string, string] } = {
	"a consumer's contract": ["Cents", "toCents(0n)"],
	"a contract over another": ["Outer", "toOuter(toCents(0n))"],
	natural: ["natural", "0n"],
	bigint: ["int8", "0n"]
}

/** What follows a mint's own arguments, as the program spells it. */
const keyText = (target: MintTarget, key: MintKeyKind): string => {
	switch (key) {
		case "no key":
			return ""
		case "its keys":
			return target === "a contract over another" ? ", outerKey, centsKey" : ", centsKey"
		case "another contract's key":
			return target === "a consumer's contract" ? ", outerKey" : ", centsKey"
		case "its own key alone":
			return ", outerKey"
		case "its base's key alone":
			return ", centsKey"
	}
}

/** Whether a mint is admitted: a consumer's contract under its keys, any other target under none. */
const minted = (target: MintTarget, key: MintKeyKind): boolean =>
	target === "natural" || target === "bigint" ? key === "no key" : key === "its keys"

/** A mint cell's statement, one line, so a directive above it covers its call. */
const mintStatement = (cell: Extract<MintCell, { readonly kind: "mint" }>, at: number): string => {
	const [target, start] = targetText[cell.target]
	const key = keyText(cell.target, cell.key)
	switch (cell.position) {
		case "a cast":
			return `export const q${at} = query(S).rule((r) => { const { id, n } = v(T, "t"); return r.match(T, { id, n }).find({ id, x: Type.cast(n, ${target}${key}) }) })`
		case "a drawn field":
			return `export const R${at} = relation("R${at}", { id: int4, n: drawn(${target}${key}) }, ["id"])`
		case "an accumulated field":
			return `export const R${at} = relation("R${at}", { id: int4, total: accumulated(${target}, ${start}${key}) }, ["id"])`
	}
}

/** Each clock parameter's type as the program spells it. */
const paramText = {
	bigint: "int8",
	natural: "natural",
	"a consumer's contract": "Cents",
	"a contract over another": "Outer"
} as const

/** The keys a clocked member is handed after its binding, as the program spells them. */
const clockKeysText = (clock: ClockCase): string => {
	switch (clock.keys) {
		case "no key":
			return ""
		case "a key":
		case "its key":
			return ", { now: centsKey }"
		case "another contract's key":
		case "its own key":
			return ", { now: outerKey }"
	}
}

/** The refusal of a clock bound to a parameter of a contract over another's. */
const clockRefusal =
	"clocked binds only parameters of the program whose values are bigints: int8, natural, or one consumer's contract over either, under its key"

/** Each result shape over a type as the program spells it, a variant's declared on a line before the function. */
const resultText = (shape: ResultShape, type: string, at: number): string => {
	switch (shape) {
		case "a value":
			return type
		case "rows":
			return `rows({ x: ${type} })`
		case "one row":
			return `row(rows({ x: ${type} }))`
		case "a variant":
			return `V${at}`
	}
}

/** Each result type as the program spells it. */
const resultTypeText = {
	"its base": "int8",
	"a consumer's contract": "Cents",
	"a contract over another": "Outer"
} as const

/** The mints a declared function is handed after its definition, as the program spells them. */
const mintsText = (type: ResultType, mints: MintsKind): string => {
	switch (mints) {
		case "no mints":
			return ""
		case "its keys":
			return type === "a contract over another"
				? ", { Cents: centsKey, Outer: outerKey }"
				: ", { Cents: centsKey }"
		case "another contract's key":
			return type === "its base" ? ", { Cents: centsKey }" : ", { Cents: outerKey }"
		case "its own key alone":
			return ", { Outer: outerKey }"
	}
}

/** The refusal of a contract over another under its base's key. */
const apartRefusal = "a contract over another is under a key of its own, apart from its base's"

/** A directive refusing the next line, where the rule refuses it. */
const refusedUnless = (admitted: boolean): ReadonlyArray<string> =>
	admitted
		? []
		: [
				"// @ts-expect-error -- refused: a contract's values are made under its keys alone, any other type's under none"
			]

/** A mint box cell's lines: its statement, refused where the rule refuses it. */
const mintLines = (cell: MintCell, at: number): ReadonlyArray<string> => {
	switch (cell.kind) {
		case "mint":
			return [
				`// ${cell.position} into ${cell.target} under ${cell.key}`,
				...refusedUnless(minted(cell.target, cell.key)),
				mintStatement(cell, at),
				""
			]
		case "clock":
			return [
				`// a clock of ${cell.clock.param} under ${cell.clock.keys}`,
				`export const q${at} = query(S).rule((r) => r.find({ now: r.param("now", ${paramText[cell.clock.param]}) }))`,
				...(cell.clock.param === "a contract over another"
					? [`// @ts-expect-error -- refusal: ${clockRefusal}`]
					: refusedUnless(
							cell.clock.keys === "no key"
								? cell.clock.param !== "a consumer's contract"
								: cell.clock.keys === "its key"
						)),
				`export const m${at} = clocked(q${at}, { now: "millis" }${clockKeysText(cell.clock)})`,
				""
			]
		case "result": {
			const type = resultTypeText[cell.type]
			return [
				`// a declared function's result of ${cell.type} as ${cell.shape} under ${cell.mints}`,
				...(cell.shape === "a variant"
					? [`export const V${at} = variant("V${at}", Arm, { a: { x: ${type} }, b: {} })`]
					: []),
				...refusedUnless(
					cell.type === "its base" ? cell.mints === "no mints" : cell.mints === "its keys"
				),
				`export const f${at} = fn("f${at}", { calls: [], args: {}, returns: ${resultText(cell.shape, type, at)}, volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT NULL\` }${mintsText(cell.type, cell.mints)})`,
				""
			]
		}
		case "apart":
			return [
				`// a contract over another under ${cell.key}`,
				...(cell.key === "a key of its own" ? [`export const k${at} = Symbol("K${at}")`] : []),
				...(cell.key === "its base's key"
					? [`// @ts-expect-error -- refusal: ${apartRefusal}`]
					: []),
				`export const C${at} = contract<typeof ${cell.key === "a key of its own" ? `k${at}` : "centsKey"}>()("C${at}", Cents)`,
				""
			]
	}
}

/** The program over a batch of the mint box's cells, its imports read through its prelude as `entry` reaches it. */
export const contractMintProgram = (
	cells: Arr.NonEmptyReadonlyArray<MintCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/contract-host.ts: a consumer's contract's values are made under its keys alone.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: mintHeader },
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: mintLines(cell, at) }))
		]
	)
]
