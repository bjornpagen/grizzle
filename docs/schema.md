# Schema reference

The reference grizzle's source and tests cite by heading (test/unit/dev/references.test.ts). A claim here that the code contradicts is a bug of this page, fixed here.

## Identity: natural keys

grizzle mints no ids. A row is keyed by what makes its fact the one it is, so a fact written twice is one fact, and its
key names the same row in every database that holds it, a replica, a restore and a test's alike:

- **A child is its parent's key and its own name or place.** A lesson of a course is `(course, slug)`, a line of an
  order `(order, line)`, a member of an ordered family its owner and the index grizzle draws for it
  ([Families](#families)).
- **Content is its digest.** A file, a blob or a rendered document is keyed by `sha256`, the SHA-256 of its bytes, its
  32 bytes as they are (`Sha256`): equal bytes are one row, whoever stores them.
- **A published thing is its name and version.** A package is `(name, version)`, a QTI item its QTI identifier.
- **An outside system's id is that system's, by name.** A bare `uuid` field is a type error,
  `say whose id this is: contract<typeof key>()("ClerkUserId", uuid)`, and from JavaScript a `CompileError` with the
  same text: `contract<typeof clerkUserKey>()("ClerkUserId", uuid)` is a Clerk user's id, its own type, so a Clerk user
  is never written where a Stripe customer belongs.
- **Its time is an instant on the database's clock, never bits inside an id.** When a row was written is a field of its
  own that the database writes, and a fact that happens again later is keyed by its child and that instant. A UUIDv7's
  leading bits are its writer's clock, which another host's disagrees with, and its random bits answer uniqueness, not
  order, so no order of its ids is an order of the writes.

`pg.serial` and its kin and `pg.uuidv7` are type errors that say so, and from JavaScript a `CompileError` (`Refused`)
with the same text.

**Sharding.** The child is the shard key: every row under a parent carries the parent's key, so its subtree lives on
one shard and a write to it is that shard's transaction. Writes on several shards at once are ordered by a hybrid
logical clock, or told apart by the writer's own name joined to the key, `(child, at, writer)`, never by a minted id,
which orders nothing.

**Edges.**

- **A rename is a new fact, never a key update.** A key never changes: renaming a lesson, an open relation, deletes
  the fact at its old slug and inserts the one at its new slug in one ChangeSet, and the rows that name it move with it
  there; a closed relation records the rename as a fact inserted. A field that changes in place is outside the key, and
  `mutable(R)` inside a unit lets a put update it ([Writes](reads-and-writes.md#writes)).
- **Two writes in one microsecond** are told apart by the rest of their key. Where nothing else tells them apart, they
  meet at the key, and under SERIALIZABLE the later one fails as a retryable `transient`, whose retry reads a later
  instant.

## Tables and types

`relation(name, fields, primaryKey)` declares a table. `schema` groups tables and their rules into one PostgreSQL
schema.

- **A name is one relation.** A schema's relations are a list, each relation carrying its own name, and `S.relations`
  holds them by name. A library's relations join an application's by concatenating lists, `schema("App", [...own,
  ...library.relations], [...ownRules, ...library.rules])`, which drops nothing, where a spread of two records keeps
  one of two relations of a name without a word. A relation listed twice, or an identical copy of it, is one
  declaration. Two relations of one name that differ in anything are refused when the schema is built, in the types and
  with `DuplicateIdentity` naming both declarations, and so is a rule built over a relation of a declared name that is
  not the one declared, since a rule names its relations by name. A level may list a relation a level below declares,
  exactly as declared there, and nothing else of its name.
- **No nullable columns.** A value that may be missing is a row that may be missing, in a table of its own, like
  `PostViews`.
- **Closed by default.** A closed relation's rows are inserted, never updated or deleted: a role that writes it holds
  SELECT and INSERT on its table and no UPDATE or DELETE, and a ChangeSet's put or delete of it is refused when it
  compiles. Each closed table carries an immutability guard, a `BEFORE UPDATE` row trigger that refuses an UPDATE
  changing any field but the few grizzle itself rewrites in place (a family member's copy of a mutable owner's column,
  which the owner axis's ON UPDATE CASCADE carries), whoever runs it, its owner included, with 42501 naming the table.
  A writer of a closed member of a mutable owner's family holds UPDATE on one hidden column of it alone, the member's
  successor, which an append sets on the member it follows; no field.
  A migration's data steps on such a table run with the guard dropped and create it again in the same transaction:
  a draft's and the data step you write at its place, over every table the previous version guards and this one keeps,
  and a custom migration's (`generate --custom`) transactional file, over every guard the database holds as it runs. A
  `-- grizzle: no-transaction` file has no transaction to do that in, so it cannot write a guarded table. Every data
  step also stands up the rule judge's session tables first ([Rules over queries](#rules-over-queries)): a draft's by
  the previous version's stand-ups, a custom migration's file, a no-transaction one's too, by every stand-up the
  database holds as it runs, so a step's write of a table a rule over a query reads is judged at its COMMIT; and a step
  that lifts the guards re-checks every rule and stored relation over an immutable relation before it commits
  ([Migrations](operations.md#migrations)).
  An open relation is `mutable(Post)` inside a unit whose heading its key leads with ([Units](#units)): its writers hold
  UPDATE and DELETE, and its rows change in place and are deleted under the unit's exclusive borrow. A family's owner
  whose family changes after it is inserted is open too ([Families](#families)).
- **First insertion wins, by `race`.** `race(Claim)` among a schema's rules makes a table's primary key first come,
  first held: an insertion at a key another row holds meets that row instead of being refused for differing from it
  ([Races](errors-and-concurrency.md#races)).
- **No timestamp type.** When a row was written is an `instant`, which the database alone writes ([Instants](reads-and-writes.md#instants)).
  Any other time, a deadline or a due instant, is a value: a `bigint` contract, such as milliseconds since the epoch,
  and the current time is a parameter, the caller's, or the database's clock where a member binds it
  ([The database's clock](reads-and-writes.md#the-databases-clock)). A calendar day is a `date`.

| Field                                              | PostgreSQL                                                          | TypeScript                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `contract<typeof key>()("ClerkUserId", uuid)`      | uuid, behind the contract's domain; a bare `uuid` column is refused | `Marked<Uuid, typeof key>`, made by `mintOf(key)`; `Uuid.parse` reads a string |
| `sha256`                                           | bytea, behind the digest domain that checks 32 bytes                | `Sha256`, a SHA-256 digest's 32 bytes, `Sha256.ofBytes` or `ofText`    |
| `pg.smallint`, `pg.integer`                        | smallint, integer                                                   | `number`                                                               |
| `pg.bigint`                                        | bigint                                                              | `bigint`                                                               |
| `natural`                                          | bigint, behind a domain that checks `>= 0`                          | `bigint`                                                               |
| `instant`                                          | bigint, behind natural's domain                                     | `Instant`, a `bigint` of microseconds since the Unix epoch, written by the database |
| `instant.stored`                                   | bigint, behind natural's domain                                     | `Instant`, an instant a read delivered, written by its caller as it is |
| `date`                                             | date, its column checked to 0001-01-01 … 9999-12-31                 | `CalendarDate`, its ISO 8601 text `"YYYY-MM-DD"`                       |
| `pg.numeric`                                       | numeric, no typmod: every value numeric holds, NaN and ±Infinity    | `Decimal`, exact, passed as it is                                      |
| `pg.numeric(p, 0)`                                 | numeric(p, 0), its column checked to hold no NaN                    | `bigint`, an integer of at most p digits                               |
| `pg.numeric(p, s)`, s not 0                        | numeric(p, s)                                                       | `Decimal`, exact, no display scale                                     |
| `pg.numeric.within(digits, scale)`                 | numeric, no typmod, its column checked to NaN, ±Infinity and the finite values below 10^digits of at most `scale` fraction digits | `Decimal`, exact, a sum's, a mean's or an operation's value stored as it was read |
| `pg.real`, `pg["double precision"]`                | real, double precision                                              | `number`                                                               |
| `pg.money`                                         | money                                                               | `Money`                                                                |
| `exactInteger`                                     | numeric, its column checked to scale 0: no fraction, NaN or infinity | `bigint` of any size, integer arithmetic's exact value                 |
| `exactMoney`                                       | numeric, its column checked to money's scale 2: no NaN or infinity  | `Money` of any count of cents, money arithmetic's exact value          |
| `pg.boolean`                                       | boolean                                                             | `boolean`                                                              |
| `pg.inet`                                          | inet                                                                | `Inet`, inet_out's text; `Inet.parse` reads any text inet_in reads     |
| `pg.cidr`                                          | cidr                                                                | `Cidr`, cidr_out's text; `Cidr.parse` reads any text cidr_in reads     |
| `str.regex(pattern, flags?)`                       | text, behind a domain that checks the pattern                       | the pattern's language: `string`, or `"yes" \| "no"` for `^(yes\|no)$` |
| `str.bytes(n, str.regex(...))`                     | text, behind a domain that checks its UTF-8 bytes, then the pattern | the pattern's                                                          |
| `str.and(str.regex(p), str.regex(q), ...)`         | text, behind a domain that checks every pattern                     | the patterns' languages intersected, `P & Q`                           |
| `closedId(X)`, for `X = closed.ordered("X", [...])` or `closed.unordered("X", [...])` | smallint, behind the roster's domain | the union of its names |
| `closedId(X, { only: [...] })`, `closedId(X, { except: [...] })` | smallint, behind the roster's domain and a CHECK of the subset's codes | the union of the subset's names |
| `bits(X)`, a set of `X`'s handles                  | bit(n), behind a domain that holds only live handles                | `Bits<typeof X>`, a `ReadonlySet` of its names; `Bits.of(X, [...])`    |
| `contract<typeof key>()(name, base, check?)`       | a domain with that CHECK                                            | the base type under the key, `Marked<base, typeof key>`                |
| `span(T, width?)`, T integer, bigint or date       | int4range, int8range or daterange                                   | `{ start, end }`, start included, end excluded                         |
| `pg.vector(n)`                                     | pgvector's vector(n)                                                | `Vector`, a Float32Array                                               |
| `searchDocument(configuration, [w, text], ...)`, generated | tsvector, a STORED generated column                            | `SearchDocument`, the text PostgreSQL prints for it                    |
| `pg.tsvector(configuration)`                       | tsvector                                                            | `SearchDocument`, a document a read delivered, written back as it is   |
| `bytes`                                            | bytea, at most 1,073,741,819 bytes                                  | `Uint8Array`, a fresh one over its own buffer                          |

Each type has one name, the one PostgreSQL prints for it: `pg.integer`, never `int4`; `pg["double precision"]`, never
`float8` or `float(p)`; `pg.numeric`, never `decimal`; `pg.boolean`, never `bool`.

- **A value is parsed exactly, once.** Every value you pass, a fact's field, a parameter or a page's boundary, is read
  as its field's type and never altered: a `Decimal` with more fractional digits than its `pg.numeric(p, s)` holds is
  an `EncodingFailure` (`numericScale`), never rounded, so `1.005` at scale 2 is refused where PostgreSQL would store
  `1.01`; a `Decimal` past a `pg.numeric.within(digits, scale)` bound is an `EncodingFailure` (`numericBound`); a
  `SearchDocument` for `pg.tsvector` is the text PostgreSQL prints for a document, its lexemes in their one order,
  each once, and anything else is an `EncodingFailure` (`searchDocumentForm`), never sent to be stored as another
  document; a `number` for `pg.real` must be a binary32 value as it is, `Math.fround(x) === x`, or it is an
  `EncodingFailure` (`realInexact`), never rounded to the nearest one. A uuid's case is a spelling of one value, a
  float's `-0` a value of its own, kept as written, and nothing else is changed. Everything else a field's type says, its pattern and contract, is
  PostgreSQL's to check ([Errors and outcomes](errors-and-concurrency.md#errors-and-outcomes)).

- **Network types.** `pg.inet` is an address with its network's mask, `pg.cidr` a network, IPv4 and IPv6 alike, PostgreSQL's own. A value is any text PostgreSQL's inet_in or cidr_in reads, and its host value the one text inet_out or cidr_out prints of it, so `"1.2.3.4/32"` is the inet `"1.2.3.4"`, `"10/8"` the cidr `"10.0.0.0/8"`, and a cidr with a bit set right of its mask, `"10.1.2.3/8"`, is an `EncodingFailure` (`cidrHostBits`), as PostgreSQL refuses it. grizzle reads every text as PostgreSQL 19 does, quirks included, so a value means one thing on the host and in the database: `Inet.parse(text)` and `Cidr.parse(text)` read a text, such as a request's address from an edge's header, into the value, a `Result`. Both compare, order (IPv4 before IPv6, then network_cmp's order), hash, stand in a key or an index, and are a context's field; an inet has `min` and `max`, and a cidr none, since PostgreSQL has neither. Their containment is `Net`'s ([Scalar terms](reads-and-writes.md#scalar-terms)).
- **A contract's values are its consumer's.** Its host type is its base's under a key the declaring module holds:
  `const centsKey = Symbol("Cents")`, then `contract<typeof centsKey>()("Cents", pg.bigint, (c) => Logic.ge(c, 0n))`,
  whose values are `Marked<bigint, typeof centsKey>`. Only the key's mint makes one, `const toCents = mintOf(centsKey)`,
  then `toCents(500n)`, without checking it; the contract makes none. Where the key lives, and whether it is exported,
  decides who makes values: a module that grades keeps its key, exports its grading function and its type,
  `Marked<Decimal, typeof gradedKey>`, and a write of a grade takes nothing else. A key is a unique symbol, one per
  contract: a key of type `symbol` is a type error, and `mintOf` refuses a registered one, which `Symbol.for` gives any
  module by its name.
- **A contract's checked mint parses a value from outside, with no compiler loaded.** A configuration that names the
  contract, `contracts: [Cents]`, has `grizzle generate` compile it into its checker file,
  `migrations/contract-checks/Cents.json`: its type as a schema's compile types it, its predicate a table the host
  evaluates, the automata of its patterns and the digest of its description, a served file's artifact kind, which
  `grizzle check` holds current. `contractParser(centsFile, Cents, centsKey)` (`@bjornpagen/grizzle/runtime`), over the
  file as an import of it yields (`import centsFile from "./migrations/contract-checks/Cents.json" with { type: "json"
  }`), reads a value of the base as PostgreSQL does before it stores it: a value of no value of the base's type is
  `ValueRefused` by the codec's fault (a bigint past int8), one outside the contract's predicate or its base's
  refinements `DomainRefused`, each at the contract, and any other value is minted under the key, `Marked<bigint, typeof
  centsKey>`; over a file compiled from another description of the contract every value is `CheckerDrifted`. Its
  `contract` is the contract, which a consumer that stores what it parses types its column by. It takes the contract's
  own key, so only the key's holder builds it, in a module of its own beside the mint (a schema module importing the
  file would load it while generate writes it), where a boundary decodes the contract's values, a request's or a step
  input's. A test builds one over `contractCheck(Cents)` (`@bjornpagen/grizzle/compile`), the same file's value.
- **Where a contract's value comes from.** A fact's field, a parameter's argument, a closed relation's row, a typed
  constant (`Type.literal(Cents, toCents(5n))`), a conditional's other arm and a variant arm's field are values of the
  host type: a plain `bigint`, or another contract's value, is a type error there. A value compared with a contract's
  term, in a filter, a comparison or a selection, is its base's, `r.ge(cents, 0n)`, since a comparison makes no value.
- **The database makes a contract's values under its key.** Every place a value of a contract is made from values of
  other types takes the key after its own arguments, as `mintOf` takes it on the host: a cast,
  `Type.cast(Num.add(a, b), Cents, centsKey)`; a field grizzle fills, `drawn(TestNumber, testNumberKey)` and
  `accumulated(Cents, toCents(0n), centsKey)`; a clock bound to a parameter of the contract, `clocked(program,
  { now: "millis" }, { now: millisKey })`, by the parameter's name; and a declared function whose result holds one at
  any depth, `fn("grade", { …, returns: row(Single) }, { QtiInteger: qtiIntegerKey })`, by the contract's name. A
  contract over another takes every key of its chain, its own first, `Type.cast(x, Outer, outerKey, centsKey)`, as the
  host makes its value only through each mint, `toOuter(toCents(0n))`, so it is declared under a key apart from its
  base's. A generated field, a derived relation's field, `r.min` and `r.max` carry values the contract already holds
  and take none, and `r.sum` and `r.mean` deliver its base. A module that does not hold the key makes no value of the
  contract: not on the host, not in a query, not in a stored computation. From JavaScript, a missing key, an extra one
  or a value that is no symbol is `MalformedDescription`, and a registered symbol `Refused`.
  A read delivers the host type, the one conversion grizzle makes unchecked, since it trusts its own database, and the
  database checks the base type and the predicate on every write. A fourth argument, `{ proves: [...] }`, declares facts
  the check implies ([Queries](reads-and-writes.md#queries)).
- **`natural`** is the builtin contract over `pg.bigint`, unbranded: a count, the type of every `r.count()`, and the one
  type a rule's `pred` reads ([Rules](#rules)). Every schema holds it, since every query over it may count, so its
  domain is installed whether or not a field is natural. A count meets a natural field, parameter or literal and is
  written into a natural field as it is; a count beside a `pg.bigint` is two types, so type that side `natural`, which
  is what it holds, and an arithmetic's exact integer meets a count as `Type.base(count)`. A negative value is an
  outcome on the law `{ kind: "contract", contract: "natural" }`. No other contract may be named `natural`.
- **`exactInteger` and `exactMoney`** are the types integer and money arithmetic deliver, of any size, as stored
  fields: an exact integer, a `bigint`, and exact money, a `Money` of any count of cents, so a query's
  `Num.add(balance, amount)`, `Num.mul(a, b)` or a sum over money is written into one as it is, by a ChangeSet member,
  a generated field or a derived relation's head, and a read of one keeps every digit. Each is PostgreSQL's numeric of
  no typmod, numeric's own 131,072 integer digits, its column checked to the values its host type spells:
  `CHECK ((scale(x) = 0) IS TRUE)` for an exact integer, `= 2` for exact money, money's own fraction digits, which
  refuses a fraction, another scale (`5.0`, `1.5`), NaN and the infinities from a direct writer with 23514; grizzle's
  own writes are its host values, which hold no other. Its arithmetic is exact at numeric's own limit, PostgreSQL
  refusing a result past it with 22003, as over a `pg.numeric`. A literal or a parameter of its family meets it, a
  bigint or a `Money` among them, and a parameter of its own type takes any value of it. A bare literal is a value of
  it as of any type, a bigint for an exact integer and a `Money` for exact money: where a field of it is written,
  `V.make("integer", { value: 1n })` over an arm's `exactInteger` field or `Type.literal(exactInteger, 1n)`, it is a
  value of the field, and opposite an exact value in a comparison or an operation any value of its family, an exact
  value's digits being what its making proves of it, never a domain the value it meets is held to; it is refused only
  past numeric's own limit, `MalformedDescription` naming 10^131072. No key, UNIQUE, containment or family axis holds one, since its widest
  value outgrows every index entry: one there is `UnrepresentableKey` naming the precision to declare, `pg.numeric(p, 0)`
  (or `pg.bigint`) for an exact integer, `pg.numeric(p, 2)` (or `pg.money`) for exact money; a lookup leaves one out
  of its index, a filter beside it, as a `pg.numeric` of no typmod ([Keys and indexes](limits.md#keys-and-indexes)). No
  contract is over one,
  nor a closed relation's, a context's or a declared function's field of one: bound it first, with `Type.cast` under
  `Num.within`, into the type that holds it.
- **`date`** is a day of the proleptic Gregorian calendar, PostgreSQL's date, a plain type: `Type.base` of a date is
  the date. Its value is its ISO 8601 text, `"2024-02-29"`, one text per day, in calendar order; every login pins
  `DateStyle` to ISO. A CHECK on every date column holds it to 0001-01-01 … 9999-12-31 against any writer, so no
  infinity or unspellable year is stored; it is the type's range, not a rule an outcome names. Dates compare, take
  `min` and `max`, and may stand in a key or index.
- **Spans** are over integer, bigint or date, or a contract over one; `span(date)` is a span of days.
  `span(T, width)` fixes `end − start` by a CHECK on the column: a positive `number` over integer, a count of days
  over date, a positive `bigint` over bigint.
- **`bytes`** is written and read back whole, nothing more. No key, unique, containment, rule, selection, filter or
  parameter takes one, no scalar term reads one but `Crypto.sha256`, its digest ([Text](reads-and-writes.md#text)), and no
  contract, generated or accumulated field is of one: each is a type error where the types see it and
  `UnsupportedOperation` when it compiles. A query's head reads one like any field. It is written in binary and read back in chunks of 16 MiB, one result row a chunk, in the same statement and
  round trip, wherever it is delivered: a query's rows, an attachment's, a window's, a family's stored members. grizzle
  writes the chunks into a fresh `Uint8Array` you own, so a value never passes through one string. A write reads back
  only a value's SHA-256 digest, which is how the host knows it: two values of one digest that differ are a SHA-256
  collision, refused as an `EncodingFailure` (`bytesCollision`) rather than taken as one. grizzle reads your array
  where it is and copies it once, into its column's binary array, as the call is sent, checking the copy against the
  digest: an array you change or detach after passing it to a write's `apply`, before the call is sent, is an
  `EncodingFailure` (`bytesChanged`) rather than sent unlike the value the write was worked out from. Its bound,
  1,073,741,819 bytes (`bytesMaxLength`), is PostgreSQL's longest bytea: a longer value is an `EncodingFailure` naming
  its field, before any SQL. An attachment whose rows hold a bytes field is a statement of its own, so one under rows
  that read `.approximateNearest` is refused: query the nearest rows, then attach to their keys in a second query.
- **Patterns.** Text always carries one, with flags `"u"` (the default) or `"su"`. The syntax is JavaScript's under
  `u`, cut to what PostgreSQL matches the same way: characters and escapes, classes and ranges, `\d`, `\w` and their
  complements, `.`, groups, `|`, `^` and `$` for the start and end of the whole text, and greedy `?`, `*`, `+` and
  `{m,n}`, each bound at most 255 (`regexMaxRepeat`). Refused: lookahead and lookbehind, `\p{…}` and `\P{…}`, `\s`
  and `\S`, `\b` and `\B`, backreferences, named groups, inline modifiers, lazy quantifiers, NUL, a lone surrogate,
  and, as a field's or a contract's type, a pattern no text matches, such as `a^b` or `[]`, which no value could hold.
  TypeScript accepts these; the first relation or contract built over the pattern refuses it with
  `UnsupportedOperation`, naming the construct and its position. As a `Text.pattern` or a value of a closed
  relation's pattern field, a pattern no text matches is the empty language, whose match holds of no text.
- **`str.bytes(n, pattern)`** is the pattern's text of at most `n` UTF-8 bytes, `n` from 0 to 2,147,483,647. Its host
  type is the pattern's, so an unbounded text of the pattern needs no cast. Its domain checks
  `octet_length(VALUE) <= n` before the pattern, so the regex engine never reads a longer value, and refuses either
  with 23514. Equal patterns and bounds share one domain; a bound the pattern already implies is dropped.
  `str.bytes(n, str.regex("^.*$", "su"))` is any text of at most `n` bytes.
- **`str.and(a, b, ...)`** is text of every pattern its texts carry at once, their intersection, as XML Schema reads
  two pattern facets: write each facet as its own `str.regex` and join them, never one regex you intersect by hand.
  Its host type is theirs intersected (`P & Q`), its byte bound the tightest of theirs, and its domain checks
  `VALUE ~ p AND VALUE ~ q`, each pattern held to PostgreSQL's limits on its own, so a conjunction costs the sum of
  its patterns, never their product. A text may be a `str.bytes` or another `str.and`, whose patterns it takes in
  order. Two conjunctions of one language, or a conjunction and a pattern of its language, share one domain wherever
  grizzle builds the intersection's automaton, within 2,048 DFA states and 2,097,152 NFA-state visits as for a parse's
  proof ([Parsing text](reads-and-writes.md#parsing-text)), and a conjunction no text matches is refused there with
  `UnsupportedOperation`; past the bounds the domain still checks every pattern.
- **Text in a key** needs a byte bound. A key, a UNIQUE, a family's axis or a reference's target holds every text as
  itself, so its entry, in any order of its columns, must fit a B-tree entry for the widest value each field admits; a
  key over a text of no byte bound, or one that could outgrow the entry, is `UnrepresentableKey` when the schema
  compiles ([Keys and indexes](limits.md#keys-and-indexes)). Bound the text (`str.bytes(n)`), or key by a digest you declare, a
  generated `generated(sha256, Crypto.sha256(x))` field, whose 32 bytes any key holds. A lookup grizzle drafts holds only the columns that fit its entry. A text of no byte bound it binds
  by equality is sought by the digest its relation declares of it: wherever a rule states the text equal to a value, a
  match's constant or parameter, a variable another match binds, `Logic.eq` or `Logic.in` in its where with a term of
  its other values, or a negation's constant, grizzle states the digest equal to that value's `Crypto.sha256` too, which
  the digest's generation makes true of every such row, so the lookup's index holds the digest and the read rechecks the
  text on the rows of that digest alone. Through a query the digest goes by lineage: a query whose head copies the text,
  delivering it as its relation stores it, carries the declared digest beside it wherever its reader equates the text,
  through every query between them, and a negation that correlates the text with a column of its reader states the
  digest equal to that column's `Crypto.sha256`; only the digest the relation declares is carried, never one grizzle
  computes. A lookup that binds such a text and no digest of it, a relation that declares none, or a text a query's
  head computes rather than copies, is `UnrepresentableKey` naming the field and the digest (`undigestedText`), unless
  its other equalities bind a key, which reads one row. A bounded text too wide for the entry
  beside the lookup's other columns is a filter beside the index, never a column of it, and a text it orders, ranges or
  matches a prefix by needs the byte bound. `keyTextBytes(fields)` is the most bytes a text holds as itself beside
  `fields`, the index's other columns, in every index grizzle plans over them, in any order, any of them a hidden
  column that may be NULL: a key one byte wider is refused. For
  a family axis that carries the text, `fields` are its group fields, its natural index, its natural successor, its
  other carried values and a tree's `end`. So `str.bytes(keyTextBytes([uuid, natural]), str.regex("^.*$", "su"))` is
  held as itself in a key beside a uuid and a natural, declared or over a selection, and
  `keyTextBytes([uuid, natural, natural])` in an ordered family's axis grouped by a uuid.
  `keyTextBytes` throws `UnrepresentableKey` naming every fault at once: more fields than an index holds beside a text,
  and each field of no byte bound; or, where neither is, fields that leave a text no byte. `keyFits(fields)` is whether a key over `fields` holds every value
  they admit, each as itself, the verdict a relation keyed by them meets, as a `boolean`, never thrown.
- **A numeric in a key** needs a precision. A key's entry holds each numeric as itself, so a `pg.numeric` of no typmod,
  an `exactInteger` or `exactMoney` field, or a `pg.numeric(p, s)` of digits enough to outgrow the entry, is
  `UnrepresentableKey` in a key; a lookup leaves such a numeric out of its index, a filter beside it. An entry is sized as PostgreSQL could lay it out in any order of its
  columns: from its data offset, each datum at its widest alignment padding and its longest, the whole MAXALIGNed, so
  a key, the UNIQUE a reference lands on and the reference agree whatever order each lists the columns in.
- **Exported bounds.** `messageMaxBytes`, PostgreSQL's longest message (1,073,741,822 bytes), `maxStringLength`, V8's
  longest string (536,870,888 UTF-16 code units), `bytesMaxLength` (1,073,741,819 bytes) and `flightMaxBytes`, the most
  one write over TLS carries (1,908,342,784 bytes), refuse a call before it is sent; `regexTextMaxBytes`, the longest
  text PostgreSQL's regex engine reads (268,435,454 UTF-8 bytes), is the byte bound a text a query matches by a pattern
  must keep. Each is a `Limit`: `.value` is the
  number, with its owner, unit, scope and evidence, the source that states it or the limits it derives from. Code that
  splits an input across calls (`InputTooLarge`, [Errors and outcomes](errors-and-concurrency.md#errors-and-outcomes)) reads the bound instead of
  restating it.
- **Rosters.** `closed.ordered("Status", ["Draft", "Published"])` is a fixed list of handles whose order means
  something, and `closed.unordered("Element", [...])` one whose order means nothing; every roster is one or the other.
  A `closedId(Status)` column holds a handle's code: an ordered roster numbers its handles 0 … n − 1 in declared order,
  which is also comparison order, and an unordered one numbers them in the UTF-16 order of their names, which nothing
  compares by. A closed id of an unordered roster has no order: a comparison, `between`, `orderBy`, `Logic.least`,
  `Logic.greatest`, `r.min`, `r.max` or a fold's `Monoid.max` over it is a type error that names the fix, declaring
  the roster `closed.ordered`. Its equality, `in`, keys, joins and sets are an ordered roster's. Where grizzle
  completes an order to break ties the caller left open (a `take`, a page), it reads a closed id's code, which never
  moves, whatever its roster's kind. The API reads and writes names. The table stores codes, under a smallint domain
  that admits only live handles' codes, and every role's view adds a decoded column, `status_name`, beside each closed
  id. A handle is at most 63 UTF-8 bytes, a PostgreSQL `name`. Codes are history: an added handle is appended, a
  removed one leaves its code unused, and an ordered roster's reorder is refused ([Migrations](operations.md#migrations)).
- **Sets.** `bits(Status)` is a `bit(n)`, one bit per code, n rounded up to whole bytes, under a domain that holds
  only live handles' bits and 0 past the last code. PostgreSQL stores a bit string in whole bytes, so the padding costs
  nothing and a roster grows into it without a wider type, which would rewrite every table that stores a set over it.
  grizzle writes a set in hex only: `X'…'` cast to its domain in SQL, `X` and its hex digits as a parameter's text. The
  algebra is `Bits.union`, `.intersection`, `.difference`, `.cardinality`, `.subset`, `.disjoint` and `.singleton`;
  for a complement, take the full set less it. Membership is `Bits.subset(Bits.singleton(id), set)`, which reads
  the one bit of the id's code. Every operation gives NULL on NULL, a NULL id's singleton included. No key holds a set:
  its bit string is too wide for an index entry.

### How a field is written

Every field has one writer. An insert or a put takes exactly the fields its caller writes, `Written<R>`.
`AdditionIn<S, R>` is R's addition in S, its sequences' members nested at their count fields.

- **The caller**, the default: a field declared by its type alone, `title: Title`. A value a read delivered is
  stored so whatever its type, so a read's rows can be kept as rows of their own: `instant.stored`, an instant as it
  was read ([Instants](reads-and-writes.md#instants)), `pg.tsvector(configuration)`, a search document as it was read
  ([Full text search](reads-and-writes.md#full-text-search)), and `pg.numeric.within(digits, scale)`, a sum's, a mean's or an
  operation's numeric within the bound its query proves of it.
- **PostgreSQL**: a STORED generated column,
  `relation.generated(name, written, primaryKey, (r) => ({ f: generated(type, term) }))`, or a search document PostgreSQL
  parses from the row's texts, `searchDocument(configuration, [weight, text], ...)` ([Full text search](reads-and-writes.md#full-text-search)).
- **grizzle, drawn:** `drawn(natural)`, a family's count or index, and a tree's `start` and `end`
  ([Families](#families)); or `drawn(c, key)`, c a contract over `pg.smallint`, `pg.integer` or `pg.bigint` under its
  key, whose column is c's and whose CHECK bounds every value grizzle draws into it.
- **grizzle, accumulated:** `accumulated(type, start)`, a fold's end or accumulator, or a copy along a family's axis,
  `start` its value where the axis begins; a contract's under its key, `accumulated(c, start, key)`.
- **The database's clock:** `instant`, stamped by the insert that adds its row where it is its relation's clock, or a
  stored instant where it is a reference ([Instants](reads-and-writes.md#instants)). The same type its caller writes is `instant.stored`.

**Generated fields.** A term reads its own row and closed relations ([Closed relations](#closed-relations)). `r` holds
every stored field of the row but the generated ones, a field grizzle draws or accumulates among them: its column holds
its final value whenever PostgreSQL generates the term, at the row's INSERT or at an UPDATE that writes it, a family's
recount, refill or cascade among them. So a value read through an accumulated copy of an owner's column, such as a
text collapsed by its owner's declared type, is one generated field every query reads. Reading a generated field is a
type error.
Compiling the schema refuses a term that breaks these rules with `GeneratedRefused` (`readsGenerated`, or `notRowLocal`
for a read beyond its row). The term has the field's type, except for a text's pattern and byte bound,
which the field's domain checks: `generated(Ids, Text.concat(row.head, row.tail))` fills a refined text, and a
generated value outside the domain refuses its row, `refused` on the pattern's rule; a term whose type shares no value with the field's, `Text.lowerAscii` of a text of capitals into a field of capitals, would refuse every row, and is `GeneratedRefused` (`disjoint`) wherever the text analysis proves it, by the two patterns together or by the tighter byte bound. Nothing is cast
implicitly: a term of another integer width, numeric typmod or contract, `natural` included, is `GeneratedRefused`
(`type`); write the `Type.cast`. A term with no value at a row, such as `C.at` at a key no row holds, refuses the
row, `refused` on `{ kind: "generated", relation, field }`, witnessed by the first row you stated whose term
has no value. It is one outcome whoever finds the NULL: grizzle, filling a nested write or a family's values that read
the field, before any SQL, or PostgreSQL's NOT NULL.

**Keys.** A fact and a query's row hold every field. A primary key holds no set, bytes, generated or accumulated field.
Another key may hold a generated field, such as a `value` generated from a text to keep two spellings of one value
apart. It is compared in the statement that writes the row, never on the host, against every row the statement writes
and every stored row: two rows of one value are `refused` on the key, witnessed by the key's values as
PostgreSQL stores them. A delete compares only at keys whose fields it states. The members a new owner nests meet such
a key at its index alone, which refuses them on the key with an `unreported` witness; a member a put appends to a
stored owner's family is compared in its statement like any other row, against the stored rows and the rows the
statement writes, and witnessed by its key.

**Fill order.** grizzle fills every value it writes in an order the schema fixes, and refuses when it compiles, never
at a write, a schema that would read a field before it is filled. An insert fills a row's own fields, counts, index,
a tree's `start` and `end` and its copies from its owner or the member before it on entering the row; then the ordered
families and trees nested under it; then, on leaving the row, its fold ends and copies along a last axis. Counted
families fill their members last, from the owner's whole row, then their fold ends; a counted family's member that the
insert nests is filled there like any nested row, and its counted families complete it afterwards. So:

- a copy along an ordered family's or a tree's owner axis reads a column its owner fills on entering it, never a
  fold's end, a copy along a last axis, or a column read from one;
- a copy along a counted family's owner axis reads any column of its owner but the end of a fold over that family;
- a counted family's count and fold ends, and the index, count and copies it fills on its members, are read only by
  that family's own members and ends, never by another family's copy, fold step or selection;
- no row's columns read each other in a cycle, as copies along a tree's owner axis can at its root;
- no predecessor copy reads its own value on a member before it, through a field generated from its row and the
  predecessor copies it meets, a chain no window over the group draws: fold such a running value instead.

A generated field is filled where the columns it reads are: after the latest of them, by the fill that writes them, a
counted family's where it reads a column that family fills. Where no one fill writes every column it reads (at a
position whose fill does not reach one, or two counted families' columns), PostgreSQL alone computes it, and a copy, a
step or a selection that reads it there is refused. So a copy of a generated field waits on what the field reads: a copy
along an owner axis of an owner's field generated from a fold's end over that family is filled after its members, and
a sequence's copy of a field generated from a counted family's copy reads a column that family fills on its own.

A schema that breaks one is refused with `UnfillableField`, naming the field, the law that fills it, the column it
reads, the axis it reads it along, and why that column is filled later. A cycle through a generated field is named at
the column that reads it. A write is refused with it too where the host would read a column the write's statement
stamps (`stamped`): a member's place carried from its owner's, or a generated field over one ([Places](reads-and-writes.md#places)).

### Variants

`variant(name, roster, arms, checks?)` is a typed sum: a value is one arm, each arm named by a handle of a closed
roster and a record of typed fields. One field holds one value, its host value a TypeScript tagged union, `{ tag:
"integer", value: 3 }`: the arm's handle under `tag`, then that arm's fields.

```ts
import { closedId, generated, pg, sha256, variant } from "@bjornpagen/grizzle"

const baseTypes = ["boolean", "file", "float", "integer", "pair", "string"] as const
const BaseType = closed.unordered("BaseType", baseTypes)
const QtiValue = variant(
	"QtiValue",
	BaseType,
	{
		boolean: { value: pg.boolean },
		float: { value: pg["double precision"] },
		integer: { value: pg.integer },
		pair: { least: Identifier, greatest: Identifier },
		string: { value: Prose }
	},
	{ pair: (a) => a.le(a.least, a.greatest) }
)
const Single = relation.generated(
	"Single",
	{ variable: Name, value: QtiValue },
	["variable"],
	(r) => ({
		baseType: generated(closedId(BaseType), QtiValue.tag(r.value))
	})
)
const Multiple = relation.generated(
	"Multiple",
	{ variable: Name, value: QtiValue, count: natural },
	["variable", "image"],
	(r) => ({ image: generated(sha256, QtiValue.digest(r.value)) })
)
```

- **The arms name the subset it holds.** A variant holds the handles its arms name, every handle of its roster or
  some, as `closedId(roster, { only })` holds its subset: `QtiValue` names no arm `file`, a handle the roster keeps for
  the relations that declare one, so no value of it is a file. A handle no arm names is no value of the variant: its
  host type has no arm for it, a write of it is refused before any SQL, and its domain's CHECK refuses its code from a
  direct writer, 23514. A variant over the whole roster is the one whose arms name every handle; there is no other
  form. A variant holds at least one arm.
- **One column, judged whole.** A variant field is one column, typed by the variant's domain over its composite: the
  tag, the arm's code, then every arm's fields at their base types. The domain's one CHECK holds the tagged arm's
  fields present, each judged by its own type (a contract's, a pattern's, a roster's domain, a closed id subset's codes),
  the arm's check, and every other arm's fields absent. A value of no arm, a field under another arm's tag, or a pair out of order is refused
  wherever it is written: by a write, a cast, a parameter or direct SQL. A write's refusal names the field's one rule,
  `{ kind: "variant", relation, field, variant }`, whichever domain PostgreSQL reports, the variant's or an arm's
  field's contract's or pattern's: grizzle judges the stated row on the host by the same domain to name the field.
- **The tag is an ordinary field.** `V.tag(value)` is a closed id of the roster holding the handles the arms name, as
  a closed id of that subset is, so `generated(closedId(R), V.tag(r.value))` stores it, and so does a field of the
  subset, `generated(closedId(R, { only }), V.tag(r.value))`. A key, a reference and a law name it like any field, so
  a containment can hold each value of a declared type: `on(Single, "variable", "baseType")` into the declarations'
  `(identifier, baseType)`.
- **One equality, its identity.** Two values are equal exactly when they are of one arm and each field is one value:
  a text by its bytes, a float by its bits, -0 apart from 0, every NaN one. A key, a reference, `=`, DISTINCT, GROUP
  BY and a join all read it. Order is the tag's code, then the arm's fields in declared order.
- **A digest for a key no B-tree holds.** `V.digest(value)` is a SHA-256 of that identity, the arm's handle's digest
  then each field's fixed-width image. It is a term like any other: a generated field a key is declared over, as
  `Multiple` does where an arm holds unbounded text, a query's join or a check.
- **Case analysis is exhaustive.** `V.cases(value, { boolean: (a) => …, float: (a) => …, … })` takes a handler for
  every arm, each given its arm's fields as terms, and is one term. `V.make("pair", { least, greatest })` is a value of
  one arm, each field a term that meets its type or a bare literal, which takes the field's type, as
  `V.make("integer", { value: 3 })` does. `r.match(V.arm(value, "string"), { value: text })` is a source, one row of an arm's fields where the value
  holds that arm and none where it holds another, so a rule reads an arm's fields as columns. Its key is its value: an
  arm of a cell a key fixes is at most one row, to the types as to the engine, so an attachment reading it is an
  Option. A derived relation of that one match is the relation of an arm, which a law may name.
- **Arm checks are the type's.** `checks` states at most one predicate per arm, over that arm's fields alone, with
  the row-check helpers. It is printed into the domain's CHECK under the arm's code, so every relation holding the
  variant holds it, with no check of its own.
- **Functions take variants.** A declared function's argument, result or rows heading may hold a variant. Its body
  reads one with `${V.code(handle)}`, the arm's code `(v).tag` holds, and `${V.attribute(handle, field)}`, the
  attribute a field is. It builds one with `${V.of(handle, { field: "<sql>" })}`, which writes each field at its own
  attribute and casts the value to the domain. Each handle and field name is type-checked. A function at any level,
  a library level every application composes among them, names a variant of any level its schema extends: each
  installation prints the body under its own codes, as it stores the variant's columns.
- **A sum of relations is no variant.** A variant's arms are values of one column. Where an arm's data is a relation
  of its own, one other relations refer to by its key, the sum is of relations: keep the tag a field of the header, and
  mirror each arm relation with the header's rows of its handle or handles, `mirrors(on(Arm, ...key),
  on(select(Header, (h) => h.eq(h.tag, "arm")), ...key))`, or `h.in(h.tag, ["a", "b"])` for an arm two handles share,
  one statement per arm relation. Its two containments state exactly one arm row per header of those handles and none
  of another, since the header's tag holds one value per key. A query attaches an arm plainly at the
  header's key, delivered as `"option"`: the arm's key, the header's, proves at most one row.
- **Arms grow by migration.** An arm appended to the roster takes the next code. Its fields come after every installed
  attribute, and the migration adds them in place, `ALTER TYPE … ADD ATTRIBUTE`, rewriting no stored value. A handle
  renamed keeps its code and its arm's attributes. A handle removed from a roster an arm's field holds is validated
  through the variant's domain, so a stored value holding it refuses the migration, 23514.
- **The subset widens and narrows by migration.** The composite lays the arms' fields out in their codes' order. An
  arm taken into the subset at a handle past every arm's code adds its fields after every installed attribute, in
  place, as an appended arm does; an arm of no field, taken in or left out at any handle, holds no attribute, so only
  the domain's CHECK changes. The migration replaces that CHECK and validates it against the stored values, so a stored
  value of an arm left out refuses the migration, 23514. An arm with fields left out of the subset, or taken in below
  the code of an arm the variant holds, would rewrite every stored value, as would a field removed or added to an arm
  other than the one of the greatest code: any such change to a variant's arms is refused when drafted, a custom
  migration.

### Closed relations

`closed.relation(name, fields, key, rows)` is a relation whose rows are fixed when the schema compiles, such as a
grammar or a price list. Its key is required, a nonempty list of its closed-id fields; a key of every field makes it a
set. A key field's roster may be `closed.ordered` or `closed.unordered`: its constant is indexed by codes, which are
history, and reads no roster's order. Its other fields are closed ids or open-typed values, never a span, set, vector, bytes or exact value. Its rows are a
set: a row written twice is one row, and two rows of one key with different payloads are refused, naming the key and
both payloads.
`closed.relation("Allowed", { kind: closedId(Kind), flag: closedId(Flag), weight: pg.integer }, ["kind", "flag"], rows)`
says which flags each kind admits, and at what weight.

A query reads a closed relation's rows as facts its declaration fixes. The engine keys the relation by every minimal
set of its columns whose value tuples no two rows share, its declared key among them; it treats a column that holds
one value as constant, and two columns of one type whose values agree row by row as equal. The types read only the declared key, and cannot see a value no literal types,
such as a contract's bigint. So a query whose cardinality rests on any other of these facts is typed as having many
rows where the engine proves at most one: over `Allowed`, if no two rows share a weight, a match that fixes the weight
by a parameter is at most one row to the engine and many to the types.

It has no table. The migration installs it as content-addressed IMMUTABLE constants, a bit string indexed by its key's
codes and an array of each open-typed field's values, which PostgreSQL folds into every statement that reads them. A
rule that reads one from an open row is a CHECK on that row's table, named by its rule, through a row function of the
columns it reads: a containment of a row's `(kind, flag)` into `Allowed` is one substring read of the row's own codes.

Three reads stand in a row check, a selection, a generated field's term or a query's filter, never in a value a query
delivers or binds:

- **`Allowed.at("weight", kind, flag)`**: the payload field at that key, NULL where no row holds it.
- **`Allowed.row(kind)`**: the set of the last key field's handles that complete the prefix, empty where none does.
- **`Allowed.has(kind, flag)`**: a predicate, true where a row holds the key and false where none does.

Each is NULL where a key value is NULL. `has` states what holds at an absent key:
`Logic.or([Logic.not(Allowed.has(kind, flag)), Logic.ge(Allowed.at("weight", kind, flag), 1)])` holds of every
pair `Allowed` lacks, and `Logic.cond(Allowed.has(kind, flag), Allowed.at("weight", kind, flag), 0)` is the weight,
0 where there is none. NULL follows SQL's three-valued logic: a row check, over a table or a derived relation, refuses a
row its condition leaves unknown, and holds where another arm of an `or` holds; a selection keeps only the rows its
condition is true of; and a generated field's NULL term is refused by its column's NOT NULL. Every domain admits NULL,
so no cast to a contract, pattern, roster or set refuses a read first.

A rule over closed relations alone is checked once, by PostgreSQL, in the migration that installs them: a violating
row refuses the migration and leaves nothing behind. A containment from a closed relation into an open one is
refused; those rows belong in a closed relation of their own.

**Slots.** A key field may hold slots instead of every code of its roster. `slot(closedId(Position), fin(Model,
"positions"))` is a closed id of `Position` whose codes run, for each owner, from 0 to below its count: `fin(O, "n")`
over a closed relation `O` is its natural field `n` per row. `O`'s key pairs with the key's first fields, roster for
roster and in order, and every slot follows them. So
`closed.relation("Follow", { version: closedId(Version), parent: closedId(Kind), from: slotOf, to: slotOf },
["version", "parent", "from", "to"], rows)`, with `slotOf` that slot, holds each model's positions squared, not the
widest model's for every model: its constant is one block per owner, at the owner's own counts. A row whose slot is at
or past its owner's count is refused when the installation is planned, and a read at such a key, in a rule, a
generated field or a query, finds nothing, never another key's row. `Follow.row(version, parent, from)` is the set of
`to` positions that follow, over `Position`.

**The migration file** states each constant as one hex literal, `X'…'`, four bits a digit, its cells' bits padded with
0s to a whole digit, under a comment of its row count and content digest. `grizzle check` decodes each literal and
holds it to that digest and to its function's name: a changed digit, a lowercase digit or a 1 in the padding is
refused, naming the relation, the first cell where the literal departs from the declared rows, and that cell's key.
Relations that share a constant share one literal. `Follow` over 1,217,966 rows drafts a 507,520-byte literal and
installs it in 35 ms.

## Rules

Rules are declared in a schema's list, beside its tables. A box office:

```ts
import { check, contract, counted, drawn, fin, key, Logic, mutable, natural, span, unit } from "@bjornpagen/grizzle"

const centsKey = Symbol("Cents")
const Cents = contract<typeof centsKey>()("Cents", pg.bigint, (c) => Logic.ge(c, 0n))
/** A show's production code, and a ticket's barcode, as the box office prints them. */
const ShowCode = str.regex("^[A-Z0-9]{2,12}$")
const Barcode = str.regex("^[0-9]{12}$")

export const Show = relation(
	"Show",
	{ id: ShowCode, seats: natural, price: Cents, tickets: drawn(natural) },
	["id"]
)
export const Ticket = relation("Ticket", { id: Barcode, show: ShowCode, holder: ClerkUser }, ["id"])
/** A stage is its name in the building. */
export const Stage = relation("Stage", { name: Title }, ["name"])
export const Run = relation("Run", { stage: Title, nights: span(pg.integer), show: ShowCode }, [
	"stage",
	"nights"
])

export const BoxOffice = schema(
	"BoxOffice",
	[Show, Ticket, Stage, Run],
	[
		counted(on(Ticket, "show"), fin(Show, "tickets")),
		contained(on(Run, "stage"), on(Stage, "name")),
		contained(on(Run, "show"), on(Show, "id")),
		key(on(Ticket, "show", "holder")),
		check("SomeSeats", Show, (s) => s.ge(s.seats, 1n)),
		check("NoOversell", Show, (s) => s.le(s.tickets, s.seats)),
		unit("Show", { id: ShowCode }),
		mutable(Show)
	]
)
```

A price is never negative. Every ticket's show, and every run's stage and show, exists. A person holds at most one
ticket per show. A show has at least one seat and never more tickets than seats: `tickets` is drawn, each show's count
of the tickets that name it, which grizzle keeps and `mutable(Show)`, in the show's unit, lets change. `nights` is a span in `Run`'s primary
key, so two runs on one stage never share a night.

| Rule           | Written as                                                                | Holds when                                                                    |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Primary key    | `relation`'s third argument                                               | no two rows share it                                                          |
| Unique key     | `key(on(Ticket, "show", "holder"))`                                       | no two rows share these fields                                                |
| No-overlap key | a key with a `span` field                                                 | rows that agree on the key's other fields never share a point of the span     |
| Foreign key    | `contained(on(Ticket, "show"), on(Show, "id"))`                           | every ticket's `show` is a show's `id`                                        |
| Both ways      | `mirrors(on(A, "x"), on(B, "y"))`                                         | `contained(a, b)` and `contained(b, a)`, the two rules it stands for          |
| Coverage       | `contained` between two `span` fields                                     | the target's spans cover each source span                                     |
| Row check      | `check("SomeSeats", Show, (s) => s.ge(s.seats, 1n))`                         | the condition holds on every row                                              |
| Counted family | `counted(on(Ticket, "show"), fin(Show, "tickets"))`                       | each show's `tickets` is the number of tickets that name it                   |
| Ordered family | `ordered(on(Line, "order", "at"), fin(Order, "n"))`                       | each order's lines hold `at` exactly 0 … n − 1                                |
| Tree           | `tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })` | Node keyed (doc, start): each `doc`'s rows one tree, `[start, end)` each row's pre-order interval |
| Fold           | `fold(family, Monoid.sum, step, end)`                                     | each owner's end is its members' step values combined by the monoid           |
| Selected side  | `on(select(Ticket, (t) => φ), "show")`, in any rule                       | the rule reads only the rows where φ holds                                    |
| Predecessor    | `on(Place, "show", pred("at"))`, in any rule                              | the rule reads `at` − 1, and nothing of a row whose `at` is 0                 |
| Over a query   | `on(TypedHref, "path")`, TypedHref a derived relation, in any rule        | the rule reads the query's rows as the tables stand at commit                 |

A rule pairs its sides' terms in order. A side is `on(source, ...terms)`.

- **A source** is a table, a derived relation, or `select(T, (t) => φ)`, the rows of T where φ holds, φ written as a
  row check's condition. It is the one way to write a selection. A rule over a derived relation reads its query
  ([Rules over queries](#rules-over-queries)).
- **A term** is a field, or `pred(n)` of a `natural` field n: n − 1, defined only where n is above 0.
- **Each term once.** A side lists each term once: `on(Ticket, "show", "show")` is a type error, and refused from
  JavaScript when built. `"at"` and `pred("at")` are two terms.
- **Rows a side leaves out**, outside its selection or with its `pred` field at 0, have no tuple there: a key over the
  side doesn't hold them apart, a containment from it doesn't require them, and one into it doesn't find them.
- **Keys.** A key over a table's own fields is a candidate key of the table; one over a selected side or a `pred` term
  is not. A containment's target holds a key of its table whose selection's conditions are all the target's, its terms
  among the target's terms, or among its terms and the fields the target fixes. A target's selection fixes a field
  beyond its terms by one condition, outside the key's selection, that equates the field to a value or to one of the
  target's terms: `contained(on(A, "id"), on(select(B, (b) => b.and([b.eq(b.kind, "x"), b.eq(b.root, b.id)])), "id"))`
  holds where every A's id is a B of kind `"x"` that is its own root, and B's primary key `id` keys the target. A
  target no key holds is refused when the schema compiles.
- **Generic helpers.** A rule may be written in a helper generic over the tables it reads,
  `<T extends typeof A | typeof B>(t: T) => contained(on(t, "owner"), on(Owner, "id"))`, and typechecks exactly where
  the rule holds for each table T may be. Those tables share one heading, or one holds every field of another and
  more; a helper over tables that share none is refused. A query over such a T reads it the same way, through
  `v(t, "x")` and `r.match(t, …)`, and there tables whose headings differ only in a closed id's roster share one: each
  such field is read off the table T is, typed per instantiation at that table's own roster, ordered or unordered. One
  helper `<L extends typeof BaseTypeLexical | typeof ResourceTypeLexical>(lexical: L)` over closed relations
  `{ code: closedId(Roster), lexical }` reads `v(lexical, "lexical").code` as a closed id of L's own roster, and a
  binding of it meets only L's `code`. A helper over several tables reads every closed id so, so a constant at one is
  refused: no handle is the types' at each instantiation.

A show's waitlist, over the box office:

```ts
import { natural, pred, select } from "@bjornpagen/grizzle"

/** A show's waitlist: its places in order from 0, and whether each place's holder has been called. */
export const Place = relation(
	"Place",
	{ show: ShowCode, at: natural, holder: ClerkUser, called: pg.boolean },
	["show", "at"]
)

/** The places whose holder has not been called yet. */
const waiting = select(Place, (p) => p.eq(p.called, false))

export const Waitlist = schema.extend(
	[BoxOffice],
	"Waitlist",
	[Place],
	[
		contained(on(Place, "show"), on(Show, "id")),
		contained(on(Place, "show", pred("at")), on(Place, "show", "at")),
		key(on(waiting, "show", "holder"))
	]
)
```

A show's places run from 0 with no gap. A holder waits at most once per show, and may hold any number of places
already called.

Every rule holds at commit, for every writer. A rule over tables is PostgreSQL's own constraints, and grizzle installs
no trigger and no function for it.

### Sides

A selected side's guarded term, the one over its earliest field (its primary key's first), and each `pred`
term, is a STORED generated column, `CASE WHEN φ THEN t END`, and every other term is its field's own column. A key
over a side is `UNIQUE NULLS DISTINCT` and a containment `FOREIGN KEY … MATCH SIMPLE`, both of which pass a row with
any of its columns there NULL, so the one guarded column keeps every row the side does not read out of both, and a
row computes each selection once, never once per term.

- **Fixed fields.** The source holds each value a target fixes a field to as a STORED generated column, and lists its
  own field again for each field the target equates to one of its terms, so the foreign key meets the target's terms,
  then its fixed fields, which add no column to the target. The UNIQUE it references is the key the target holds, or
  one over more columns, which that key implies. The key implies a UNIQUE over the target's terms under its selection
  too, which needs no constant, and grizzle references whichever adds fewer indexes and columns to the schema: the
  target's own terms where a containment out of the same selection reads them, as each arm's mirrors' way back
  does, so one index serves both, or where the shared UNIQUE costs a constant or a column more; the shared one where
  several targets fix a field to different values, or where both cost the same.
- **Coverage.** A coverage's target needs a no-overlap key over its span, or the schema is refused: coalesce the spans,
  or key them.

A write that breaks a rule comes back as an outcome that names the rule, never as a message to parse.

### Rules over queries

A rule's side may be a derived relation, a query the schema names. A content package's resource may have an href, a
type, both or neither, each stored on its own, and the rules about a resource's href and its type together hold where
it has both:

```ts
import { derived, query, v } from "@bjornpagen/grizzle"

/** A resource's identifier, as its package's manifest names it. */
const ResourceId = str.regex("^[A-Za-z_][0-9A-Za-z_.-]{0,63}$")

/** A content package's resources, each with an href and a type, either of which it may lack. */
export const Resource = relation("Resource", { id: ResourceId }, ["id"])
export const ResourceHref = relation(
	"ResourceHref",
	{ resource: ResourceId, path: Title, internal: pg.boolean },
	["resource"]
)
export const ResourceTyped = relation("ResourceTyped", { resource: ResourceId, type: Title }, [
	"resource"
])
export const PackageFile = relation("PackageFile", { path: Title }, ["path"])
/** A catalog record of a resource, naming its href and its type. */
export const CatalogRecord = relation(
	"CatalogRecord",
	{ resource: ResourceId, path: Title, type: Title },
	["resource"]
)

export const Content = schema(
	"Content",
	[Resource, ResourceHref, ResourceTyped, PackageFile, CatalogRecord],
	[
		contained(on(ResourceHref, "resource"), on(Resource, "id")),
		contained(on(ResourceTyped, "resource"), on(Resource, "id"))
	]
)

/** The resources that have both: a join, which no table stores and no write keeps. */
export const TypedHref = derived(
	"TypedHref",
	query(Content).rule((r) => {
		const { resource, path, internal } = v(ResourceHref, "href")
		const { type } = v(ResourceTyped, "typed")
		return r
			.match(ResourceHref, { resource, path, internal })
			.match(ResourceTyped, { resource, type })
			.find({ resource, path, internal, type })
	})
)

/** The typed hrefs of items. */
const items = select(TypedHref, (t) => t.eq(t.type, "item"))

export const ContentPackage = schema.extend(
	[Content],
	"ContentPackage",
	[TypedHref],
	[
		check("ItemsInside", TypedHref, (t) =>
			t.not(t.and([t.eq(t.type, "item"), t.eq(t.internal, false)]))
		),
		contained(on(items, "path"), on(PackageFile, "path")),
		contained(
			on(CatalogRecord, "resource", "path", "type"),
			on(TypedHref, "resource", "path", "type")
		)
	]
)
```

A typed href is a resource with both parts. An item's href is inside the package and names one of its files, and
every catalog record names a typed href as it stands. A resource with an href and no type, or a type and no href, has
no typed href, so none of these rules asks anything of it. No table holds a copy of the join for the rules to read,
and no write keeps one in step: `derived(name, query)` stores nothing, and a query that matches `TypedHref` reads its
definition too.

- **What a side's query may be.** Matches, `where` conditions and the head's fields: joins, selections, projections
  and semijoins, a union of such rules, and negations. `r.not(Q, …)`, alone or inside `r.and([...])`, negates a table, a
  query of such rules or a derived relation whose query is one, which may negate in turn, so a rule can read "the rows
  of R with no S", "the rows of R that no join of S and U names" and "the sittings no ending and no standing
  invalidation names", an invalidation standing where no reinstatement names it. A negation of a union negates each of
  its rules. An aggregate (`r.count()`, `r.min(x)` and the others) is read by a unit-local rule, below, and by a rule
  its probes judge where the law reads it inside one unit: its terms hold the unit fields of every relation the
  aggregate's body matches, so a probe folds again only groups whose rows one unit holds. Any other is refused
  (`UnsupportedLawFamily`), naming the relation whose unit is left free and the remedy: where the groups span units, as
  a count of every learner's attempts at an item does, group within a unit, adding the unit's fields to the grouping;
  where the groups lie inside one unit and the law's terms leave it free, as a key at the item alone over each learner's
  count of an item does, bind the unit's fields in the law. Its probe would fold every group at its terms again at each
  write, work that grows with the units. A query that reads it is untouched, and so is a law over a derived relation
  that aggregates nothing at terms that leave its unit free, a chain of keyed reads from its terms. A recursion and a
  text's tokens, pieces, rest, decoded path, target within a base and split at its last separator (`r.tokens`,
  `r.split`, `r.rest`, `r.decodedPath`, `r.resolvedWithin`, `r.splitLast`, [Text](reads-and-writes.md#text)) are read by a unit-local
  rule, below, and refused in any other: a split as `UnsupportedLawFamily` naming what the query does, and a rule over
  a recursion as `Refused`, naming the unit-locality it lacks. `orderBy(...).take(k)`, `attach` or an
  approximate search, in the query or in a query it negates, are refused the same way (`Refused` over a derived
  relation, its refusal the type error's words), and a type error where the query does it itself. A family and a fold
  read tables only. Every value a rule reads is immutable: a stable function's call (`Fn.call`,
  [Calling a function](#calling-a-function)) or a conversion that reads a setting of its session, as int4's to money
  reads `lc_monetary`, can turn the rule's verdict with nothing written, which no judge sees, so a rule whose violation
  reads one is refused (`UnsupportedOperation`, naming the rule), judged whole or by its probes alike.
- **A probe reads each relation with the polarity of the negations above it.** A rule that is not unit-local is judged
  from the rows a transaction wrote (below): a row a relation gains under no negation, or under two, can add facts of
  the side that reads it, and a row it loses under one negation can, and the judge probes exactly those, a target's the
  other way round. `key(on(Active, "student", "form"))`, `Active` the sittings no ending and no standing invalidation
  names, is so judged from each sitting a transaction adds, each ending or invalidation it deletes and each
  reinstatement it adds: each probe reads `Active` at that sitting's student and form, through the index the law model
  plans over `Sitting`'s `(form, student)` and the keys of `Ending`, `Invalidation` and `Reinstatement`, one student's
  sittings of the form and never the table, its work the same however many students the tables hold. Two
  transactions that each make one such sitting active, each alone keeping the key, read at COMMIT each other's writes
  under SERIALIZABLE, so PostgreSQL commits at most one of them and fails the other with 40001.
- **An order across relations is a row check over their join.** A sitting's visits lie after its start and, once it
  has one, before its end: `AfterStart` derives each visit beside its sitting's start, `check("VisitAfterStart",
  AfterStart, (s) => s.ge(Range.lower(s.during, Seconds), s.at))`, and `BeforeEnd` each visit beside its end, its
  check `s.le(Range.upper(s.during, Seconds), s.at)`. A sitting with no end has no fact of `BeforeEnd`, so its end
  bound asks nothing of it: an open interval is the absence of its end, never a span unbounded above, and every span
  stays bounded and non-empty. The judge holds each bound at COMMIT, whether the transaction writes a visit, a start or
  an end, and the host judges a row of either as PostgreSQL does (`rowEvaluator`).
- **Unit-local rules are judged whole.** A rule is unit-local when every stored relation its query reads is immutable,
  or every one sits in one declared unit whose key leads its own (`unit(...)`: every write of their rows, a mutable
  relation's updates and deletes among them, borrows that unit, and an update of a column the rule reads is captured
  as any write is), no field it reads one grizzle rewrites in place (a member's copy of a mutable owner's column), and
  leads its primary key with the same fields, its unit key, and its query joins within one unit: every match of a
  stored relation, in every rule of its violation query at any depth, binds those fields to the same variables, every
  negation is correlated at them, and every aggregate's groups hold them. A content package's relations keyed
  `(package, path, …)` are one such family of units, each document a unit. Every fact of such a rule's violation lies
  within one unit, so a write changes the rule's verdict only within the units it writes, and the judge reads the
  rule's violation query, the one the migration that adds the rule runs, over the units the transaction wrote alone:
  once, set-based, whatever rows of them it wrote, never a probe per row. The outermost rule of the query that binds a
  unit, from a table it matches or a query that delivers one, reads it once per written unit, as a LATERAL subquery at
  that unit's key, and every rule it reads through a query it joins or negates reads that same unit's rows, so the
  unit is bound once: every read is an index range at the unit, an aggregate groups that unit's rows alone, a negation
  reads the written units' rows whether PostgreSQL probes it or hashes it, the work grows with the units written and
  never with their square, and no estimate PostgreSQL makes, with statistics or none, widens a read past the written
  units. Within the unit, a rule that joins, or negates a query that joins, is read as a chain of lookups, as a probe
  is: each relation it reads, a derived relation's definition included, by the columns the unit and the reads before
  it bound. A dependency's negation of a derived join of its node and the resource its ref names reads that node and
  that resource by key at the dependency's row, never the two joined at `(package, path)` alone and filtered after,
  which PostgreSQL, estimating every read at one row on tables no ANALYZE has run on, nests once for each dependency.
  A definition that joins and that the rule reads more than once, counting the reads of the definitions that read it,
  is read whole instead, once per unit: a `MATERIALIZED` CTE inside the unit's LATERAL subquery, read at the unit's
  key, every read of it a join of its rows. A chain of definitions each reading the one below it twice is then one
  CTE a level, where a chain of lookups at every read doubled the statement, its planning and its reads at every
  level: edullm's assembled-catalog rules were one statement of 3798 SELECTs reading one table 1186 times, whose
  planning at a session's first COMMIT took 12.4 GB.
  The unit is as narrow as the rule's joins allow: a rule over one relation's rows by their whole key is judged a row
  at a time. Whether a rule is unit-local is decided when the schema compiles,
  from its query; any other rule is judged by its probes, below. Its outcome and its law are the same either way.
- **A recursion is unit-local** when its row carries the unit: every base rule delivers it from a stored relation's
  leading key fields, and every recursive rule binds self's unit fields and those of every relation it matches to
  the same variables and delivers them at the same fields, a derived relation it matches read through its definition.
  Every state is then derived from a seed by steps that keep its unit, so the states of one unit are the fixed point
  of the seeds at that unit, and the judge reads the recursion once per written unit, its base and each of its steps
  at that unit's key. A recursion that follows a link into another unit, as a lineage of versions across packages
  does, is no unit's, and a rule over it is refused: no probe reads a recursion.
- **The cost of a unit-local rule** is a read of each unit the transaction wrote, whole, once per rule. A write of
  whole units, as a content package's publish is, reads the rows it wrote once more for each rule. A write of a sliver
  of a large unit, one row into a package of thousands, still reads the whole unit for each rule that reads that row's
  relation: a relation written row by row into large units is better declared in a unit of a longer key than the one
  its rules join within, where no borrow of one of its units covers a rule's unit, so its rules are probed.
- **A unit-local containment with a selected side is the judge's.** A containment between two tables is a foreign key;
  one whose side is a selection, `on(select(T, φ), …)`, is a foreign key over STORED generated columns
  (`CASE WHEN φ THEN key END`), the UNIQUE it references and an index, kept on every row of the table. Where its tables
  are immutable, or all in one declared unit, its two sides join within one unit and each selection compares fields with
  literals (`eq`, `in`, ranges, `and`, `or`, `not` and a closed relation's constants), the judge holds it instead: no
  column, no UNIQUE, no index and no foreign key. Over immutable tables, at COMMIT each row the transaction added to its
  source, and each source row at the fields of a row it took from its target, probes the target at those fields, a
  lookup of its index whatever the unit's size; over a declared unit's mutable tables, whose rows change in place, it
  reads every row of each unit the transaction wrote, as a whole rule does; either way a broken one is refused with
  23503 naming the containment. It is the same law, with the same identity and the same evidence; it holds at COMMIT
  rather than at each statement. A query's rewrite reads a containment's evidence from the law itself, whatever
  discharges it, in the context its discharge holds it in: at every statement for an immediate foreign key, in a
  committed snapshot for a deferred one or the judge. A containment of two unselected sides into a target a key holds
  apart, at a declared key's fields or a superkey's: its foreign key is the same law, its source's fields NOT NULL, so
  MATCH SIMPLE checks every source row, into that key's UNIQUE or one over the superkey, which the key implies, so the
  rows a source row's values find are exactly the target facts the law asks for. It adds no column, a written row costs
  one probe of an index, and its writers keep the isolation a foreign key admits ([READ COMMITTED
  writes](errors-and-concurrency.md#read-committed-writes)), where a rule the judge holds keeps most of them SERIALIZABLE; it holds at every
  statement where it references every field of its target off a cycle, and at COMMIT where its target holds a field it
  does not reference. So does one whose selection computes (a pattern's match, an arithmetic), whose generated column a
  query cannot always restate, and any containment over a mutable table outside its sides' one declared unit. A
  containment into a target no key holds apart, such as `on(T, "unit", "kind")` with T keyed by `(unit, id)`, has no
  UNIQUE grizzle may add, one over its columns refusing rows the schema admits: the judge holds it where it is
  unit-local as above, and it is refused (`UnsupportedLawFamily`) anywhere else. A migration that moves a containment
  from its foreign key to the judge checks no row: the foreign key held this very law on every write.
- **Judged live.** A rule reads its query as the tables stand at commit, a stored derived relation's table as its
  upkeep left it there included: the judge keeps every stored relation first, then judges the rules. A key or a check
  over a stored relation refuses there, at its table's UNIQUE or CHECK, and a served write refused so is
  `invariant-rejected` naming the law, as a write of the relation's holders changes the relation by its COMMIT.
- **A check the schema proves emits nothing.** Before a probe of the rows a write adds to a relation R is built, each
  occurrence of R in each arm of the rule, at any depth (a definition's rules, a fold's body, a negated query's arms),
  is put to the schema's containments, stated or composed, its keys and its closed relations. Where a stored relation
  S matched beside it is contained in R, `S(F) ⊆ R(G)`, and the arm binds each field of G it pins to the variable S
  binds at its pair in F, a row R gains opens no fact there that the rule's other probes do not judge: beside a row of
  S the transaction added, S's own probe reads the fact; beside one that stood, R held a row at G before the
  transaction. Where every field the occurrence reads of R is among G, that row gives the same fact, which held then.
  Where only a key of R is among G, R must be closed: no served write removes a row of a closed relation, so the row
  that stood at the key stands, and a row a served write adds is of a new key, whose children stand only where the
  same write creates them. A mutable R is covered at no key, a row it gains there one that may replace the row that
  stood. So the probe of a new sitting's rows beside its children, which pin it, is no block, no statement and no
  plan; an insert of a relation no other probe reads is captured by no rule; and the rows a write removes of a closed
  relation, which no served write does, are captured by no rule and read by no judge or upkeep: a migration's data
  step, which lifts the guards, re-checks every rule and stored relation over an immutable relation after it
  ([Migrations](operations.md#migrations)). Two more losses are proved empty. A containment's target that reads its own source at
  a key, `Assignment ⊆ AssignmentStatus` where the status of an assignment with no event reads the assignment itself,
  loses no fact by a row the source loses: the fact it withdraws needed that very row, so no rule reads the rows the
  source loses there. And a target's arm that negates a row of an immutable relation R, an open candidate session
  being one with no end, loses nothing to a row R gains where a sibling arm reads the same matches, conditions and
  negations, R at exactly the negation's fields, and R's instants only as no earlier than an instant of the arm's
  rows on the same clock at the same key (the ended session's arm, `response.at <= end.at`): every writer stamps a
  new row of R at its unit's clock, after every row it reads there, so the sibling regains every fact the arm loses,
  and no probe reads the rows R gains for it ([Instants](reads-and-writes.md#instants)). A sibling that reads R at another field too, the
  end's kind, regains nothing, and its rule reads them. Each match is covered
  by one sibling, assigned in its arm's order so that no chain of covers reaches back to it: a chain of containments
  keeps its last link's probe and a cycle one link's; a containment no schema states proves nothing, however a
  procedure keeps it. The decision is the compiler's, made when the schema compiles, never a skip at run time, and
  snapshot.json records it under `derived.proved`: each rule by its law, each relation a cover spares, each cover by
  its sibling, its containment's pairs and what it pins (`read`, every field read; `fresh`, a key of a closed
  relation), or a sibling arm's regain (`clock`, the negation's fields and the instants it reads), and the sides of
  the relation a block still reads. On edullm's bar, a start's probes of qti-pie's
  "Suspended in time" over its new sitting, candidate session and item sessions read about 450 pages each and planned
  for up to 750 ms in a fresh session, all of it for rows no pause could stand beside; the rule holds none of them, and
  its probe of the pause a later write adds judges it.
- **What PostgreSQL gets.** A rule that reads only tables is a constraint, as above. A rule that reads a query is
  judged once per transaction, over the rows it wrote: a unit-local rule over the units of those rows, any other over
  the rows themselves. On each table the query reads, an AFTER statement trigger for
  each write that can break it copies the statement's rows into a temporary table of the session, `ON COMMIT PRESERVE
  ROWS`, which the judge empties once it has read it, so no COMMIT truncates one. A session makes those tables once,
  before its first write of the table, by the table's stand-up, a SECURITY DEFINER function every role that writes the
  table may run ([Writes](reads-and-writes.md#writes): a served write's session calls it itself, for each table it writes that a rule of
  any level of the installation reads, a level above its login's among them; a direct writer calls it, as in
  [Direct SQL access](access.md#direct-sql-access)), so no write's transaction makes a relation, and the plans it makes outlive
  it (PostgreSQL truncates every `ON COMMIT
  DELETE ROWS` table of a session at each COMMIT that touched a temporary table, a lock and invalidations each): for a containment,
  a write that adds rows to its source or takes rows from its target, and so also a delete from a table its source
  negates and an insert into one its target negates. The rows a transaction adds are kept as its net write: a delete,
  or an update of a column a rule reads, of a row it added cancels the row there, so the judge reads each added row as
  the transaction leaves it and never reads it again from its table. The copy arms a deferred constraint trigger,
  `DEFERRABLE INITIALLY DEFERRED`, whose function, the judge, runs at COMMIT: each rule's violation query, compiled by
  grizzle's own query compiler, read once over every row the transaction wrote, a chain of index lookups from the set of
  bindings those rows give it, each binding read once however many rows give it, or, for a unit-local rule, over the
  set of the units those rows hold. It raises 23503 for a containment, 23505 for a key and 23514 for a check, naming the rule. A
  transaction runs only the rules over the relations it wrote: the judge reads once which of its temporary tables the
  session holds, a part of the judge reads once which of its own hold a row, and a rule runs where a table its
  violation query reads holds one, over tables that hold none its region being empty. The rules stand in parts, a
  function each, the classes of the rules that read a temporary table in common, and the judge runs a part only where
  the session holds one of its tables, so a session compiles, plans and runs only the parts of the relations it writes:
  a learner's answers never run or plan the rules of a content package. Each rule's
  statement over a side is a function of its own, which its part calls where a table it reads holds a row, so a
  session compiles the statements its writes run alone: a learner's save compiles its five, never the other seventy of
  the learner's part. A stored relation's upkeep stands so too: a unit form's statements in one function, a delta form's
  removal of the facts a write withdraws and its insert of those it gains in one each, the removal first, each called
  where a table its own statements read holds a row, so a write that only adds rows never plans or runs the removal,
  nor locks the stored table it seeks. After `SET
  CONSTRAINTS ALL IMMEDIATE` the judge runs at the end of each statement. The functions are SECURITY DEFINER on a
  pinned `search_path`, no role may run them but a table's stand-up, which each role that writes the table may, and a
  temporary table another role made under the judge's names is refused.
- **Plans.** Each lookup of a judged statement's chain, a probe's after the rows the transaction wrote and a
  unit-local rule's within its unit, is a read of one table at the columns the steps before it bound, so no estimate
  turns a join the judge reads into a product it filters after.
- **Outcomes.** A write's `once` fails with `refused` naming the rule, its witness `unreported`: the row that breaks
  it may be one the transaction never wrote.
- **Concurrent writers.** Every writer is SERIALIZABLE, so PostgreSQL orders the judge's reads against the writes
  it does not see: two transactions that each keep a rule and together break it never both commit, and one fails with
  40001.
- **Migrations.** A migration that adds a rule over a query, or changes one, checks it over the stored rows, and fails
  where a row breaks it, as it validates a foreign key. The check is the judge itself, over the transaction that would
  write every stored row into an empty installation: the same chain of index lookups, from every row where the judge
  starts from the rows a transaction wrote, so its work is linear in the rows it reads whatever PostgreSQL estimates of
  them. The check's identity is the rule's meaning over what it reads, never its SQL: the rule, the definitions it
  reads, of each table the columns it reads and the key, and of each closed relation it reads by `C.at`, `C.has` or
  `C.row` the facts those read, its key set and each payload field a `C.at` reads. A draft proves, as it is generated,
  whether a migration keeps that meaning: one that only changes how grizzle lowers the rule, drops or renames a column
  the rule does not read, or changes a closed payload it does not read, keeps it, so the proof the rule's earlier check
  made of the stored rows still stands, and one that changes the rule, a definition, a column it reads or a closed fact
  it reads (a seat count lowered under the live holds it bounds) states a new identity, which its check proves over the
  rows. The proof is of the values the rule read, so a migration that writes again a column it reads checks it again
  too, whatever its identity: a generated column re-expressed (SET EXPRESSION, a closed row its generation reads among
  the causes), converted, or dropped and added again, and a column a family's backfill draws again, none of which the
  rule's triggers see. A stored derived relation above such a column's table is created again and filled for the same reason.
- **TRUNCATE** fires no capture, so a rule over a query does not judge a TRUNCATE of a table it reads, and judges
  the rows a transaction added to it before a TRUNCATE as if they stood. grizzle never truncates and no role may; a
  direct writer who truncates such a table answers for the rule itself.

### Families

A family is a rule over rows the caller writes: each owner's members, counted by a drawn field of the owner.
`fin(O, "n")`, a family's second argument, is the slots of O's drawn count `n`, never a side or a table.

A family's count and an ordered family's index are of one type: `drawn(natural)`, or `drawn(c, key)` for c a contract
over an integer under its key, `drawn(TestNumber, testNumberKey)` of
`contract<typeof testNumberKey>()("TestNumber", pg.integer, (n) => Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483647)]))`, which
stores them in c's column, an int4 here, so a field of c elsewhere is contained in the indexes and they in it. An index
and a count of two types are refused when the schema compiles (`an ordered family's index is of its count's type`), and
`drawn` of any other type is a type error. A count past c's bound is `refused` on c's contract: past its CHECK by the
CHECK, and past its carrier, smallint's 32,767 or integer's 2,147,483,647, by the family's statement where it draws a
stored group, and as its input (`integerRange`) before any statement where the host draws a fresh one. No drawn value is
ever wrapped. pred reads a natural alone.

- **`ordered(on(F, g…, "at"), fin(O, "n"))`**: each owner's members, their group `g…` paired with O's primary key,
  indexed by their drawn `at` exactly 0 … n − 1, in order.
- **`counted(on(F, g…), fin(O, "n"))`**: each owner's `n` members, their group `g…` naming the owner by O's primary
  key: an unordered set, one row per member key. Its index is hidden from every field, fact and query: a coordinate,
  never a multiplicity.
- **`tree(on(T, "parent", "at"), fin(T, "children"), { root: ["doc"] })`**: T over itself, keyed by its root fields
  then its drawn `start` (here `["doc", "start"]`; `{ root: ["package", "path"] }` keys T `["package", "path",
  "start"]`), with drawn `parent`, `at`, `children`, `start` and `end`. Each value of the root fields is one tree: its
  root is its row at start 0, its own parent, every other row is a member of its parent's ordered family, `parent` is
  its parent's start in its own tree, and `[start, end)` is each row's pre-order interval. PostgreSQL's own constraints
  keep each tree one tree, every row reachable and none on a cycle, each constraint led by the root fields. The primary
  key `(doc, start)` is the document order: a document in order is one scan of it, and a row's descendants, its tree's
  rows whose `start` lies in its interval, one range scan, with no recursion. A fold over the tree steps on
  `on(T, "doc", "parent", …)` and ends on `on(T, "doc", "start", …)`; a copy down the tree is
  `contained(on(select(T, (t) => t.gt(t.start, 0n)), "doc", "parent", "x"), on(T, "doc", "start", "y"))`, `x`
  accumulated: the root, which has no parent, holds `x`'s start.
- **A chain is a fold whose step is a field.** A copy may read a field that reads the copy back through its row, a
  generated field over it: `was` accumulated from the predecessor's `state` along
  `contained(on(F, "o", pred("at"), "was"), on(F, "o", "at", "state"))`, `state` generated from `was` and the row,
  holds at each member the step applied to every member before it, from `was`'s start at slot 0; a copy down a tree of
  its parent's generated field so folds down the tree from the root's start. grizzle draws a chain as any copy, on
  every write, and in SQL one member after another.
- **`fold(family, Monoid.m, step, end)`**: the members' step values, `step` a side of the member, combined by the
  monoid into the owner's `end` fields, each `accumulated`.

An ordered family or a tree is a sequence. The monoids:

| Monoid          | Step value                                                           | Identity               |
| --------------- | -------------------------------------------------------------------- | ---------------------- |
| `Monoid.count`  | none; the end is a `natural`                                         | 0                      |
| `Monoid.sum`    | an integer type or a numeric, summed exactly; no float or money      | 0                      |
| `Monoid.or`     | a set, by union                                                      | the empty set          |
| `Monoid.twos`   | a set; two planes, the handles seen at least once and at least twice | the empty set, twice   |
| `Monoid.max`    | an integer type, a closed id or money                                | its type's least value |
| `Monoid.concat` | text, each step after the running text                               | the empty text         |

- **Accumulators and ends start at the identity**, which an empty family's end holds. They are of the step value's
  type, each with its own text pattern and byte bound: concat's pieces may be any text, generated or written, and its
  accumulators of a pattern of the text they spell. Each one's domain checks every value grizzle fills into it: a
  value outside its pattern is `refused` on that pattern's rule. Another integer width, numeric typmod or
  contract is another type, and such a fold is `Refused` when the schema compiles.
- **Running values.** A fold over a sequence may name each member's running `before` and `after`; one over a counted
  family names only its step value and end, its order being hidden. concat folds only a sequence, and names its pair.
  The family's axes key each running text: one that fits the axes' UNIQUE beside their other columns rides them as
  itself, and a fold refused for one names the largest byte bound that fits ([Limits](limits.md#limits)).
- **A running text of any length rides the axes by its digest.** Declare each running text's SHA-256 digest, a
  generated field `Crypto.sha256(row.v)` over the accumulated text `v`, and name the digests in the fold where the texts
  stand: `fold(lines, Monoid.concat, on(Line, "doc", "piece", "beforeDigest", "afterDigest"), on(Doc, "id",
  "textDigest"))`. The texts stay the fold's values, filled by grizzle and proved by its CHECK and pins, and PostgreSQL
  stores each digest beside its text; the predecessor axis pairs each member's `beforeDigest` with its predecessor's
  `afterDigest` and the last axis the owner's `textDigest` with its last member's `afterDigest`, so a text is its
  predecessor's after wherever their digests are equal, short of a SHA-256 collision. A plane's before, after and end
  name their digests alike or none; any other generation is refused, since only a digest's equality is its text's.
- **A separator belongs to the step**, never to the monoid: write each member's token with the separator before it,
  except at index 0, and the end is the tokens joined by it.

A relation is a member of at most one sequence, which orders it, and of any number of counted families, each with its
own hidden columns and foreign keys. A counted family's member may also be a sequence's member or owner, or a tree's
node. One count counts one family. Ordered families that nest each other in a cycle, an ordered family of a relation
over itself among them, are refused when the schema compiles (`UnwritableRelation`, `nestingCycle`), and so are
families, ordered or counted, that nest relations in a cycle below a relation that owns a family and is no family's
member (`unitCycle`): a delete of that relation removes every row nested under its rows, and through a cycle a row may
be nested again under another of them or another unit's, so no delete could remove its groups whole. A family's or a
tree's member side is a table, never a selection: `counted(on(select(Ticket, φ), "show"), fin(Show, "tickets"))` is a
type error, and from JavaScript refused when you build it. A fold's step may still select the members it reads.

grizzle owns every value a family holds: each count, index, interval, copy and accumulator is drawn by grizzle on
every write and proved by PostgreSQL, never written by the caller. A fold's running `after` is no generated column:
grizzle fills it and `CHECK ((after = combine(before, x)) IS TRUE)` proves it in exact arithmetic, so a sum is never
narrowed into its column's type unproved.

Each group is drawn by one engine of one set of fill rules. A sequence's members, nested under their owner, are drawn on
the host as the write walks them. A counted family's group is fresh where the write inserts its owner and stores none of
its members: the call holds the group whole, so the host draws it, the owner's count and ends and every member's index,
copies and fold planes, and the write inserts the members as drawn. Every other group holds a stored member or a stored
owner, which only the database holds, so the family's statement draws it in SQL, by a window over the group in slot
order, past its stored members. Whether a group holds a stored member is a fact of the database, so the statement
decides it as it runs: an exact repeat of a stored owner beside an append to its group is drawn in SQL past the stored
members, as any append to a stored group is, and under a closed owner refused by the family's count, as before. Where
the closed owner restated holds the very count the host drew, the new member meets a stored member at its family's
slot, and the member's insert, which takes every row it meets as data rather than an error, refuses it on that
family's rule in its own statement, witnessed by the member's key, in the call's one round trip.
A fresh group's members are walked in their key's order, each key field by the host's order of its values, which is
PostgreSQL's `ORDER BY` of them (test/pg/values/order.test.ts holds the two equal for every type), so a member's hidden
index is the one the window gives it, and a migration that draws a family over stored rows draws the same values again.

#### Writing a family

- **A sequence is written nested**: its members under their owner, in order, at its count field, without their group
  and drawn fields: `insert(Order, [{ id, n: [{ qty }, { qty }] }])`. No tree row names its key or its `parent`, and only
  the root names the root fields: `{ doc, children: [{ children: [] }] }`. A nested member, at any depth, states no
  field its nesting supplies, grizzle draws or accumulates, or its relation lacks: a type error, and from JavaScript an
  `EncodingFailure` (`factShape`) before any SQL. An ordered member inserted alone is a type error. A tree is written
  whole: a put of one of its rows is a type error, and from JavaScript refused when the ChangeSet compiles.
- **A group is deleted whole, through its owner.** A delete of a tree names trees by their root value,
  `delete(Node, [{ package, path }])`, and a delete of a relation that owns a family and is no family's member names its
  rows as any delete does; each removes its rows and every row nested under them, through every family, to any depth:
  the members of each family the removed rows own, the rows those own, and a tree's every node. So no count, index,
  fold end or tree interval ever describes a partial group, and the delete is of open relations alone, its own and every
  one it removes rows of, a closed one refused when the ChangeSet compiles, by name. Its
  rows may come from a query, as `delete(Node, query(…).find({ package, path }))`. Its write list names every
  relation it removes rows of. A delete of a tree whose nodes are another family's members is a type error, and so is a
  put or a delete of a family's member that owns a sequence, and a put in its stratum of the relation it deletes or of
  one nested under it, before or after the delete or through a union. Refused when the ChangeSet compiles: a delete
  whose nested rows include a member of a family whose owner it does not remove; one through a query entry. Families
  that nest its relations in a cycle are refused earlier, when the schema compiles. A delete of a family's member beside it in one stratum removes that member's
  named rows too, as an edit of its family after the whole delete: a row inside the deleted groups is gone already,
  one outside them is removed as any member's is. A delete of any other family's member is an edit of its family, as
  before.
- **A replace is a delete and an insert in one stratum**: `ChangeSet.empty(S).delete(Node, roots).insertAll(rows)`.
  The delete runs first, as one statement, so the inserts meet no stored row at a key it removed, and the outcome is
  the difference of the two states: an identical replace answers `no-change`, and the counts are the rows each
  relation lost and gained. A row the replace adds again unchanged is never written: the delete keeps it where every
  column grizzle draws on it is the same, every owner of it is kept, a counted family's group is the same set of rows,
  and every row before it in its sequence, and every node on its tree path and before one of those among its
  siblings, is kept too. So a replace that changes one value rewrites that row's group from its first changed row on,
  and leaves every other row in place. A delta of a relation the delete removes rows of is refused when the ChangeSet
  compiles (read the relation itself after the change).
- **A put and an insert of one sequence owner at one key in one stratum are two rows** at that key, since the insert
  states the owner's members and the put leaves them as they are. They are `refused` on the key before any
  SQL is sent; at different keys each is written.
- **A counted member is a row**, inserted, put and deleted like any row, its group key naming its owner. One that is
  also a sequence's member or a tree's node is inserted nested there, stating its counted group key; one that owns a
  sequence is inserted with that sequence's members nested under it. grizzle reads each of its counted families'
  stored groups and appends it there, as it does a row inserted on its own.

##### A change rewrites what it shifts

Each change to one owner's family is one edit of it. An append takes the slots
after the last; a counted member's removal moves the last member into the freed slot and refills from there; an
update that changes a step value, or a value a selection or a copy reads, refills from its slot; one that changes
the group key leaves the old owner's family and joins the new one's; any other update is in place. In an ordered
family an insertion or a removal rewrites the later siblings, so a change near the start of a long family costs the
members after it. No member holds its owner's count: each holds its successor, the slot after its own where a member
follows it and its own slot at the last, so an append writes its owner, its appended members and the one member
before them, whatever the length of the family, each a probe of a key. An edit of an owner already stored reads its
stored values first ([Transactions and concurrency](errors-and-concurrency.md#transactions-and-concurrency)).

- **A changed owner column reaches its copies.** A put of an owner updates its row in place, and an edit of one of its
  families its count and ends. A member's copy of a changed column follows by cascade; a member appended in the same
  ChangeSet takes the new value.
- **A value drawn from a changed column is refilled.** A fold's step or selection, a predecessor or last copy, and a
  tree node's copy of its parent's are drawn when their row is written. A put of a relation no family has as a member
  that changes a column one of them reads, on a stored row, through such a copy, refills that value's family: grizzle
  finds every group the change reaches along the copies that carry it, draws each value there again and rewrites those
  rows in place, members first, before the change cascades into them, so a fold's CHECK holds at every statement, and
  the same ChangeSet may put, delete and append those members too. A family member's own write refills two values only:
  its re-placed rows' copies that its owned families' members hold, and the copy of a count or an end its own family's
  stored members hold, which an append recounts. Any other value a member's put, delete or append reaches, through an
  owner axis or as its owner's count or end, is refused when the ChangeSet compiles (`StaleDerivedRead`, cause `edit`).
  A value that reads what a refill itself changes, an owner's ends or last copy or a member's predecessor copy or fold,
  is not refilled in turn: such a change is refused when the ChangeSet compiles (`StaleDerivedRead`, cause `chained`). A
  tree's values are not refilled either: a node's copy of its parent's, a sibling's predecessor copy or fold, and a
  parent's ends and last copy are drawn only when the node is written, so a change that reaches one on a stored tree is
  refused when the ChangeSet compiles (`StaleDerivedRead`, cause `tree`).
- **A re-placed row is drawn whole.** A put that moves a member to another group or changes what its ordered family
  reads of it, and a delete of an ordered family's member, delete rows and insert them again, which no cascade
  follows. Every family the re-placed rows own is refilled where its members copy a column the ChangeSet changes
  there, the count among them, and each re-placed row is drawn with its owners' values as the ChangeSet leaves them.
- **Some axes are checked at commit**, decided once for the schema: the owner axis of every family, a tree among them,
  which holds each member to an owner that holds one; the foreign key of an owner axis's copies, where its members a
  refill can rewrite or its owner a put or a delete can re-place; and the predecessor axis of every sequence a refill
  rewrites.
- **A refill is planned in the first stratum**, beside every edit of a family's members; a ChangeSet that needs one
  elsewhere is `UnsupportedOperation` when it compiles. A refill is refused when the ChangeSet compiles
  (`StaleDerivedRead`) only where grizzle cannot draw it: a put whose rows a query states; refills that reach a family
  they refill again; a refill of a closed relation's rows or a closed owner's family; a refill of a tree's
  values; a refill of a value that reads what another refill changes; a refill of a value a family member's own write
  reaches beyond the two it refills; and a refill no statement of its stratum draws: a put's cascade that passes a
  member the same stratum puts or deletes (cause `passed`), a member's write whose refilled member the same stratum
  puts or deletes (cause `rewritten`), and a member the edits of two relations reach (cause `edits`). Every refill is
  drawn by the write's own statements, in process exactly as in a served file. A role refills only relations it holds
  whole: the members it rewrites in its `write` list, and every relation the refill's cascade passes among its entries
  (`OutsideRole`).

##### A closed owner's family is fixed when the owner is inserted

Declare the owner open, `mutable(Owner)` inside its
unit, for a family that changes later, or an owner you put. A delete of a member of a closed owner's family and a put
or a delete of a closed owner are type errors, and from JavaScript refused when the ChangeSet compiles; a delete of an
open owner removes its family whole, every member open too. An insert of such a member in a
stratum that inserts no such owner is a type error where a workload declares the ChangeSet, since a later insert or
a union may still add the owner. One that names a stored closed owner in a stratum that inserts others of its
relation, or restates it, is `refused` `every` on the family's rule alone, the owner standing and every containment
into it holding, witnessed by the member's key.

- **A ChangeSet writes family members in one stratum**: writing them in a second is a type error at the call that
  makes it, and from JavaScript `UnsupportedOperation` when the ChangeSet compiles.

### Units

A unit is the key a family of rows sits under: a sitting, a learner, a package, a step of a workflow. Each value of
it is one lock: a ChangeSet that writes a unit's rows holds their key exclusively, from before its first read until it
commits; one that reads a unit's rows and writes none of them holds the key shared; and calls of different keys never
meet. That is what lets every write run READ COMMITTED: a read inside a unit the call holds sees each earlier holder's
commit and no concurrent writer, and a law whose rows stay inside one unit is judged with none. `unit(name, heading)`
among a schema's statements declares one:

```ts
/** An assignment's number, a sitting's key: a contract of its own, so no other number leads a key with it. */
const assignmentNoKey = Symbol("AssignmentNo")
const AssignmentNo = contract<typeof assignmentNoKey>()("AssignmentNo", pg.bigint, (n) =>
	Logic.ge(n, 0n)
)

const Assigned = relation("Assigned", { number: AssignmentNo, test: TestId }, ["number"])
const ClockOpened = relation(
	"ClockOpened",
	{ number: AssignmentNo, at: instant, question: QuestionId },
	["number", "at"]
)
const Invalidated = relation("Invalidated", { number: AssignmentNo, at: instant, reason: Reason }, [
	"number",
	"at"
])
export const Assignments = schema(
	"Assignments",
	[Assigned, ClockOpened, Invalidated],
	[
		unit("Sitting", { number: AssignmentNo }),
		contained(on(ClockOpened, "number"), on(Assigned, "number")),
		contained(on(Invalidated, "number"), on(Assigned, "number"))
	]
)
```

- **Its members are inferred from their keys.** Every stored relation whose primary key leads with the heading's
  fields, by name and type in order, sits under the unit: above, `Assigned`, `ClockOpened` and `Invalidated`, and
  every relation keyed `(number, …)` by an `AssignmentNo`, in this schema or any level above it, which states nothing
  more. No relation is listed, so none that leads with the key can be left out, and a unit's rows lie in one index
  range of each member. A relation keyed by its fields in another order, or by other fields, is no member.
- **An open relation sits in a unit.** A relation is closed by default, its facts inserted, never changed or deleted;
  `mutable(R)` opens it, and is admitted only where R's primary key leads with a unit's heading, so its every update and
  delete is a write of its unit's rows, held under the unit's exclusive borrow. `mutable(R)` over a relation that sits
  in no unit is refused when the schema is built, in the types and by the engine, by name: declare the unit its key
  leads with, or keep R closed and record each change as a fact inserted.
- **Give its key a named domain.** A field of the same name and type that means something else, a user's `number`
  beside an assignment's, joins the unit all the same. That is never wrong, since every writer and reader of the row
  takes the same lock, only coarser than it need be; a contract of the key's own, `AssignmentNo` above, keeps it out.
- **One unit a relation.** No unit's heading leads with another's, by name and type in order, and two units of one
  heading are refused, `MalformedDescription` naming both: a relation keyed by the longer would sit under both, and a
  lock on the inner key would not exclude a holder of the outer one. So every relation sits under one unit at most.
  One name is one unit: a unit stated twice identically, at two levels or in a fragment and its schema, is one
  declaration, and one name over two headings is refused.
- **Declared at or below its members.** A unit is stated at the level of its lowest member or below it, since a
  process over that level compiles its writes without the levels above: a unit stated above a relation of a level
  below that leads with its heading is refused, naming the relation and its level. A schema that lists a fragment
  states no unit over the fragment's relations (`FragmentRefused`): the fragment states its own.
- **No borrow is written.** Which units a ChangeSet holds, and how, follows from what it writes and reads: generate
  reads each of its statements, and each write of a member at the unit values its parameters and rows state holds
  them exclusively, and each read of a unit it does not write holds them shared. A call holds each key once, however
  many members it touches, all of them in one statement sorted by lock, so two calls never wait on each other in a
  cycle.
- **A lock is no row.** A unit's key is locked as a PostgreSQL advisory transaction lock, its id a digest of the
  unit's name and the key's values, the one spelling every lock grizzle takes shares, a call's borrows, its judge's at
  COMMIT and a series' alike. Nothing is stored for it: the lock adds no table, column or migration step, and two keys
  whose ids collide only share a lock, a coarser one, never a wrong one. A unit whose relations hold a clock holds one
  table, its clocks' head, one row a key, which the writes that already hold the key stamp from
  ([Instants](reads-and-writes.md#instants)). The id's top byte is the unit's rank, its place in the one order generate gives every unit
  and series, and the 56 bits below it the first of the SHA-256 of the
  unit's name and the key's values, each written after its length, so no two lists of them spell one text, and each
  value as its type's equality reads it: 1.0 and 1.00 are one key, as -0 and 0 are. Every schema installs one function
  that takes them, `__borrow`, which every role executes: handed a call's locks in the order of their ids, each with
  its mode, it takes them in that order, so a call that waits holds only locks below the one it waits for, and no two
  calls ever wait on each other in a cycle.

**The series.** A number every new row takes as one past the greatest, with no gap, such as an assignment's place in
its series, is the one thing no key splits. `series(R)` declares it, over a relation keyed by one field alone, of a
type grizzle draws:

```ts
/** What holds a number: an assignment, or nothing, where an import found the number skipped. */
const NumberHolder = closed.unordered("NumberHolder", ["held", "unused"])
const AssignmentNumber = relation(
	"AssignmentNumber",
	{ number: natural, holder: closedId(NumberHolder) },
	["number"]
)
export const Numbers = schema(
	"Numbers",
	[NumberHolder, AssignmentNumber],
	[series(AssignmentNumber)]
)
```

- **Its law.** The statement states that each number's predecessor is one of the series, `contained(on(R,
  pred("number")), on(R, "number"))`, so the numbers run 0, 1, 2, … with no gap: a schema that states that
  containment too states it once.
- **Its lock.** Every ChangeSet that writes `R` holds the series' one lock, from before its first read until it
  commits, so its read of the greatest number is exact and the next append waits for it. Appends queue one at a time,
  which is what a gapless series means at any level.
- **The only lock no key splits.** A call takes it only by writing `R`: no statement or ChangeSet names a lock, every
  other lock is a unit's, whose heading holds a field at least, a clock stays refused first in its key
  (`childless`) and a place first in its key (`groupless`). And the series carries its law, so it is never a lock to
  wrap other work in.
- **Its numbers' type.** `R`'s primary key is its one field, `natural` or a contract over an integer, exactly the types
  `drawn` takes ([Families](#families)): a test's number kept in an int4,
  `contract<typeof testNumberKey>()("TestNumber", pg.integer, (n) => Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483646)]))`, keys its series as
  itself, and a number past its bound is refused by the contract's own CHECK. Any other key, a second field or a type
  of no integer carrier, is refused where `series(R)` is stated.
- `R` is immutable: its numbers only grow by appends.

### Removing a unit's rows

Rows go by deletes. A family of rows that must go once its work is done, a finished run's leases, a removed package's
content, a superseded load, is deleted by a ChangeSet of deletes of its relations, under the unit its rows sit under,
which the call borrows exclusively, so a delete inside a unit is as safe as an insert. What must never come back, a run's
idempotency key, a package's name, a release's attempt numbers, stays in a relation no ChangeSet deletes. A foreign key
into a row refuses its delete while a row that references it remains (23503), as PostgreSQL holds it at every level.

```ts
/** A run of a workflow, by the idempotency key its trigger gave it. */
const RunKey = str.bytes(64, str.regex("^[0-9A-Za-z_-]{1,64}$"))

/** Each run, kept for good, so a key a run took never starts a fresh one. */
export const Flow = relation("Flow", { flow: RunKey, steps: natural }, ["flow"])
/** The leases of a run's steps, each deleted once its step is done. */
export const FlowLease = relation(
	"FlowLease",
	{ flow: RunKey, step: pg.integer, until: pg.bigint },
	["flow", "step"]
)
export const Flows = schema(
	"Flows",
	[Flow, FlowLease],
	[
		unit("Run", { flow: RunKey }),
		mutable(FlowLease),
		contained(on(FlowLease, "flow"), on(Flow, "flow"))
	]
)
/** A finished step's lease goes: a delete, under its run's exclusive borrow. */
export const finished = ChangeSet.empty(Flows).delete(FlowLease, [])
```

What the consumers' shapes come to:

- **A release's loads** (learning-commons): `unit("Release", { release: ReleaseId })`, the load keyed `(release, attempt)`
  with `attempt: place`, stamped one past the release's last under the release's exclusive borrow, and every loaded row
  keyed `(release, attempt, …)`. A superseded attempt's rows are deleted under the release's borrow; the release and its
  attempt numbers stay, so a new load is a new attempt, never a revived one.
- **A package's content** (pantry, a publisher): `unit("Package", { package: PackageName })` over every content relation
  keyed `(package, …)`. A removal deletes the package's rows under the package's exclusive borrow; a
  learner's write that references the content borrows the package shared, so a removal waits for it, and an insert that
  references removed content after the removal commits is refused by its foreign key.
- **A workflow's run** (den): `unit("FanRoot", { root: DenScope })`, every relation of a flow keyed `(root, …)`; a finished
  run's leases and claims are deleted under the root's exclusive borrow, its root row kept, so its idempotency key never
  starts a fresh run.

## Derived tables

`derived(name, query)` names a query as a relation of the schema; declare it in a level over the schema its query reads,
with `schema.extend` ([Levels](#levels)). The query takes no parameter, matches no context, has at least one field,
and its rules share one set of columns. No role holds it as an entry: a role reads it through the relations its
definition reads.

Where its rows live is grizzle's to decide, never yours. grizzle stores it, its rows in a table of its own kept equal
to its definition at every COMMIT for every writer (grizzle's programs, direct SQL and a migration's data steps alike),
exactly where it can keep it at a written unit by reading only rows that unit's borrow covers. That is where its
definition is unit-local, as a rule judged whole is ([Rules over queries](#rules-over-queries)):
- every relation it reads leads its primary key with the unit's fields and sits in one declared unit
  ([Units](#units)) whose key leads them, so every write of its rows, a mutable relation's updates and deletes among
  them, holds that unit, and grizzle writes the stored rows under the same borrow;
- every match binds them to the rule's variables;
- every negation is correlated at them, and every aggregate groups by them;
- its head delivers them;
- every declared function it calls, and every function that function's body calls, is `immutable`;
- it reads no field grizzle rewrites in place, a fold's running value;
- and its table can hold its rows: every key it provably has fits a B-tree entry, and its fields convert to columns
  apart.

Whether the relations it reads are closed or open decides nothing. A definition over closed relations alone that joins
two units' rows could lose a fact two writers inserted into the two at once, so it is live; one over a relation open
inside its unit is kept under the borrow every writer of the unit holds.

A definition that reads relations of a unit sealed at founding beside relations of another unit reads the sealed ones by
reference, as it reads a closed relation, and stands in the other unit alone: a learner's credit over a package's
content is stored in the learner's unit. Each such read must stand at a key of the sealed unit that a row of the
definition's own unit, matched in the same rule, names through a containment the schema states into the sealed unit
(`contained(on(Attempt, "package", "item"), on(Item, "package", "item"))`), over every row that match admits; a
reference-only query read at such a key counts as read there. A row so contained stands only once its key was founded,
and the founding transaction wrote every row of the sealed unit there, which no later write changes, so the stored rows
change only with the writes of their own unit: a later fact of a learner, a regrade's assertion among them, is
re-stated at its COMMIT; a founding changes no stored row but at the units its own transaction writes; and a
migration's data step, the one writer that removes or updates a sealed row, is followed by its bracket's re-check, which
makes the relation its definition's rows again by one MERGE of its table, so no capture writes a sealed row's removal.
A read of sealed content at a key no such row reaches is live (`reference`).

Its upkeep costs what a write's delta bounds, never its whole unit: its unit is wider than the declared unit and one
read of it roots the others by their keys, or its unit binds a key of every relation it reads, or its declared unit is
sealed and its one founding write the upkeep's; or else its upkeep is a delta form whatever the width of its unit:
checked, every rule a join of relations reached from its head by keys, or by seeks, an existence test of one relation at
the fields the head binds, one descent of an index and at most one range of one more column, each changed row of it
naming its one fact by keys (a sitting holding an unprocessed attempt, a session whose control lies above its counted
attempts), and every negation one relation's, so a write reads
each fact it gains from the rows it wrote outward and checks each fact it may withdraw at the fact, one probe of a key
each, a fact whose candidate leaves fields free read from the stored table's own rows at the fields it binds, only where
those hold the unit's key and more (a removed snapshot withdraws its facts in each candidate session, read from
SessionSnapshot's table at the snapshot, never at the learner alone), and every stored relation a statement reads
read by an index of its own at the keys the write binds (a suspension's open snapshots read from TestSnapshot's
table at the sitting);
or monotone over closed relations, every rule a join negating nothing over relations no served write updates or
deletes, so a served write only gains facts, each read from the rows it wrote, and a migration's data step that removes
a row re-derives the units it touched. Ledger's TestSnapshot, SessionSnapshot, ItemSessionControl, ItemSessionOpen,
SettledSitting and UnsettledSitting, each at a learner whose sittings, item sessions and attempts are keyed apart, are
stored checked, an import read by its name where its canonical relation is stored. A definition whose upkeep is none of these is live
(`unboundedUpkeep`), and snapshot.json records why its delta form bounds none (`delta`: `arms`, `match`, `negation`,
`unreached`, `loss` or `open`, and where).

Every other derived relation is live: it stores nothing, and every query that matches it and every rule over it reads
its definition. `grizzle generate` records each live one in snapshot.json, under `derived.liveDerived`, with why:
`notUnitLocal`, naming the condition it lacks (`inPlace`, `unitKey`, `split`, `negation`, `aggregate`, `recursion`,
`shape`, `hidden`, `noUnit`, `call`, `borrow` or `reference`) and where, or `unrepresentable`, naming why no table could
hold its rows.

A stored relation's table serves a read exactly where its rows are its definition's there:
- **A query** that matches it reads the table, a range of its key, never its definition.
- **A role** reads it through its whole view where the role holds every relation its definition reads whole, and through
  its definition over the role's own entries otherwise, so a role sees the same rows whether or not it is stored. No role
  writes it.
- **A ChangeSet** that writes a relation its definition reads reads its definition, whose table the ChangeSet's own
  COMMIT replaces.
- **A read inside a write's transaction** and a query entry's view read its definition where the role may write a
  relation its definition reads, and a write entry's membership always reads it: the transaction's own writes reach
  its table only at COMMIT.

Its storage changes no verdict and no type: the checker and every analysis read a derived relation as a relation keyed
by the keys its definition provably has, stored or live alike, and only the SQL grizzle writes reads its table or its
definition.

- **When its rows are written.** At COMMIT, where the rule judge runs: for each unit whose rows a transaction wrote,
  on either side of every relation its definition reads, the judge deletes the stored rows there its definition no
  longer delivers and inserts the ones it delivers anew, two statements over the rows the transaction wrote, its work
  the written units' and never the table's. Before any of them reads a row, the judge borrows each of those units
  exclusively, one lock a unit key, every one in one statement in the order of their ids ([Units](#units)), so no two
  transactions keep one unit at once, whatever level they run at and wherever they come from: a READ COMMITTED
  transaction then reads every row of the unit that any earlier writer committed, and two writers of one learner's
  rows at once never leave a join's row missing, a count short or a negation's row standing. A stored row that stays
  is never touched. A definition that reads another
  stored relation reads its table, which the judge keeps first in the same COMMIT: it keeps each stored relation after
  every stored relation it reads, at the units whose rows the transaction wrote or whose stored rows the keeping of
  those below it changed, so no work below is done twice. A query a definition imports is a relation too, stored where
  it can be kept as a derived relation is, and read alike: its table, by reference, wherever a definition imports it,
  never its definition spelled again in place, so each statement the judge runs for an upkeep or a rule is as large as
  its own definition, however many stored derivations stand beneath it, and plans in time bounded by its own
  relations. After `SET CONSTRAINTS ALL
  IMMEDIATE` the judge runs at the end of each statement, so the stored rows are current after each.
- **Laws over it.** A rule over a stored relation reads its table, its rows as the transaction leaves them. A key
  over it is a unique index of its table (the index of the key it provably has, where it is one), a check over it its
  table's CHECK, each refusing at the upkeep's insert of a row that breaks it, at COMMIT (23505, 23514). A containment
  with it on either side is judged at COMMIT, after the upkeep, never a foreign key: a foreign key is checked by the
  statement that writes the other table, before the upkeep writes this one.
- **Its table.** `CREATE TABLE … AS <definition> WITH NO DATA`, each column of the type its definition delivers, its
  primary key the narrowest key the query provably has that holds the unit's fields, those fields first (or, where
  none holds them, the unit's fields and then the narrowest key's others), so the rows of a unit are a range of its
  index, and a unique index on each other: a choice of one key in each of its independent parts, such as one
  of the two keys of each table it joins, one index on one key and on each key one choice away from it, so k such
  tables make k + 1 indexes, not 2^k, and every key of the product stands in a key member, a nested result or an
  order. A query of several rules, each finding a literal that tells its rows apart, is keyed the same way: its keys
  hold a key of every rule beside those literals. Columns the query makes equal count as one column of a key, so k
  equal pairs make one key, not 2^k: the index holds the first of them, and any of them stands for it.
- **Migrations.** The migration that creates the table fills it with its definition's every row, once every row it
  reads is written. One that changes what the definition means, a function it calls among them, or writes again a
  column it reads, creates it again and fills it.
- **Rules over it** read its definition, as a rule over `derived` does.

## Records of a query

`records(stem, query, owner, ownerKey)` declares the relations that hold the rows a query found, for a level over the
query's to list: `${stem}Row`, the owner's fields, then each column of the query's heading as the query's own field, keyed
by `ownerKey`, a nonempty list of the owner's field names, as `relation`'s primary key takes it. A column is stored as
the type it is declared of, its contract's host type and check, its closed id's roster, its text's patterns, so a closed id
references the roster of the level below; a drawn, generated or accumulated field is stored as its declared type, never
drawn again; a computed numeric is stored as numeric within its bound (`pg.numeric.within`), an instant as a stored one
(`instant.stored`) and a search document as a stored one (`pg.tsvector`); a head literal is stored nowhere, its read writing it again, but a union's rules that write literals of
several values at one key (`kind: "draft"` in one, `kind: "final"` in the other) store that key as a column whose values
are exactly them: a text of the pattern of just those texts, or a boolean. List `R.relations` in the level and
`R.rules` among its rules.

```ts
import { Array } from "effect"

const found = records("Lessons", lessonsOf, { digest: sha256, run: RunId }, ["digest", "run"])
export const Audit = schema.extend([School], "Audit", found.relations, found.rules)

/** The insert of one run's found rows, each under its own digest. */
const entries = Array.map(lessons, (row) => [{ digest: digestOf(row), run }, row] as const)
const insert = recordsFacts(Audit, found)(entries)
ChangeSet.empty(Audit).insertAll(insert)

/** The rows stored at one owner: rows of `lessonsOf`'s own type, read through its own decoder. */
export const storedLessons = recordsQuery(Audit, found)
```

`recordsFacts(level, records)(entries)` is the insert of found rows as `insertAll` takes it, each entry a row beside
its owner's values, each fact the owner's values then the row's columns; an owner of several rows is entries that share
it. `recordsQuery(level, records)` is an ordinary query over the level whose
parameters are the owner's key fields and whose rows are the stored rows at that owner, delivered through the query's
own decoder: `HeadOf<typeof storedLessons>` is `HeadOf<typeof lessonsOf>`, value for value. A union of several
headings is refused with `UnsupportedOperation`, as is a column of a contract the level does not declare and a union's
literals of another type than text or boolean, which no field holds exactly.

A query's attachments, at any depth, are stored too, each in a relation of its own: `${stem}${Name}`, the attachment's
name capitalized, or, where that name is another attachment's anywhere in the tree or `Row`, its parent relation's name
followed by it. Each holds its parent's key, every field under its own name unless the attachment's own columns or
attachments take it, then the first free `<name>2`, `<name>3`, …; an array's place, `at` or the first of `at2`, … free;
the attachment's stored columns; and a drawn count under the name of each array attachment of its own, the root's
among them. Each is keyed by its parent's key, then an array's place, and held to its parent by the law its delivery
states: an array is the parent's ordered family counted at the attachment's name, so `recordsFacts` nests its members
under their owner in the order the query delivered them and their places are 0 … n − 1; an option is contained in its
parent; and the one child mirrors it.
`R.apart` names the relations an insert states beside the root, every attachment's but an array's; `recordsFacts`
gives each its facts under its name, its carried key's values then its own, so `insertAll(recordsFacts(level,
records)([]))` is the member that takes them all. `recordsQuery` reads each attachment back over its relation as the
query stated its delivery, an array in its places' order, so its rows are still the query's, value for value. Every
name the records mint is the stem followed by more: name a relation of your own the stem itself, never the stem and a
suffix.

A name the records derive is never cut short and never refused for its length, however deep the attachments: it is
the relation's name in the schema's types, and no PostgreSQL identifier. The relation's table and whole view are
named `__<stem>_<digest>`, hashed over the relation's name and spelled after the records' stem and the relation's path
(its attachment names from the root, none for the root), within PostgreSQL's 63 bytes, with a COMMENT naming the
relation, and listed by `grizzle names`. Two derived names that convert alike are still one name, refused as any two are.
`records(stem, query, owner, ownerKey, { names })` states a relation's name for an attachment's path, its attachment
names from the root joined by `.`, as `{ names: { "stimuli.document": "Stimulus" } }`, in place of the derived one,
and the derived names of the repeated attachments under it follow it. The options are optional: left out, no name is
stated. A stated name is a relation's declared name: its table and whole view are its conversion, readable, and one
past 63 bytes is `IdentifierTooLong`. A path no attachment has is refused.

Records' relations are relations like any other: their rows go by deletes, under the unit their owner's key leads with,
a reference to a row of them refusing its delete while it remains.

## Declared functions

`fn(name, { calls, args, returns, volatility, nullInput, language, body })` declares a PostgreSQL function the application writes,
a schema object a level lists beside its relations. Its body is PL/pgSQL or SQL text you own, written
`` fn.body`...` ``, installed byte for byte but for the headings it names; grizzle prints its head and never reads its
body.

```ts
const Word = str.regex("^[a-z]+$", "u")
const Weighted = rows({ weight: natural, word: Word })

/** A word folded to lower case: an SQL body. */
export const folded = fn("folded", {
	calls: [],
	args: { word: Word },
	returns: Word,
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT lower(word)`
})

/** Each word of `words` folded, its weight doubled: a set of rows, read from an array of rows. */
export const doubled = fn("doubled", {
	calls: [folded],
	args: { words: Weighted },
	returns: Weighted,
	volatility: "immutable",
	nullInput: "called",
	language: "plpgsql",
	body: fn.body`
DECLARE
  w ${Weighted};
BEGIN
  FOREACH w IN ARRAY words LOOP
    w.word := folded(w.word);
    w.weight := w.weight * 2;
    RETURN NEXT w;
  END LOOP;
END
`
})

/** A titled list of weighted words: a heading whose field holds rows of another. */
const Titled = rows({ title: Word, words: Weighted })
const Summary = rows({ count: natural, title: Word })

/** A titled list's title and its count of words: one row of a heading, from one row of another. */
export const summary = fn("summary", {
	calls: [],
	args: { doc: row(Titled) },
	returns: row(Summary),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT ROW(cardinality((doc).words), (doc).title)::${Summary}`
})

export const Lexicon = schema("Lexicon", [folded, doubled, summary], [])
```

- **Arguments and results** are a value of a field's type, `rows(heading)` or `row(heading)`: an argument of rows is
  an array of the heading's row type, a result of rows is a set of them, `RETURNS SETOF`, and one row, as an argument
  or a result, is a value of the row type itself, a composite. Each field of a heading is a value, rows of another
  heading (an array of that one's row type) or one row of one, so a heading holds another as one composite or as
  many: `Titled` above holds its words, and its row type installs after `Weighted`'s. A value's type is a base type, a
  closed id, a contract or a refined text over one: a serial, money, an exact value, bytes, a set, a span or a vector is a type error,
  and from JavaScript `Refused` when the schema is owned. A closed id is of its whole roster: one of a subset is refused
  alike, since no body is a value of a subset and the call casts its value to the roster's domain alone, while a
  variant's arm field of a subset is held to it by the variant's domain the call casts to. A heading holds no NULL, so no row is no arm of a type: a
  function of one row returns its row, and a body with none to return raises. PostgreSQL holds a function to its
  declared types exactly (a PL/pgSQL `RETURN QUERY` refuses a column whose type is not the row type's), so each is its
  field's base type, `natural` a bigint, `Word` a text and a closed id its code, a smallint: a contract, a pattern or
  a roster is checked where a statement reads the function's value, cast to its field's domain, never by the
  signature. That cast makes the contract's values from what the body returned, so a function whose result holds a
  consumer's contract at any depth is declared under each such contract's key, by its name, after its definition:
  `fn("grade", { …, returns: row(Single) }, { QtiInteger: qtiIntegerKey })`; one whose result holds none takes
  nothing. A call passes a closed id of the argument's own roster alone, as every term does.
- **Order.** A heading's fields and a function's arguments are each a set of names, and PostgreSQL reads both by
  position: a row type's attributes, in the order `ROW(...)::${heading}` builds them and a body's `SELECT` or
  `RETURN QUERY` returns them, and a function's parameters, in the order a call passes them and `$1`, `$2` number
  them. Both stand in code point order of their names, whatever order the record writes its keys in, which is the
  order oxlint's `sort-keys` holds a record to: `Summary` above is `(count, title)`, so its body builds
  `ROW(cardinality(...), (doc).title)`, and a function of `args: { x, y, iy }` is `f(iy, x, y)`. A body calls a
  declared function positionally in that order, or by name, `f(x => 0.5, y => 0, iy => 1)`, which no order changes.
  A record written in any key order, sorted or not, installs the same row type and the same function, and grizzle's
  own calls, rows arguments and reads of a call's rows take the same order.
- **Names.** A function installs in its level's schema under its name's conversion, `folded`, `xsd_regex` for
  `xsdRegex`; functions are one namespace across a schema's levels, apart from its relations. Each heading installs
  once per level as a row type named by its definition's digest, `__rows_<digest>`, its fields by name, so a changed
  heading is another type and the functions over it take the new one, and a heading whose record only writes its keys
  in another order is the same type.
- **A body names its row types** by placeholders: each `${heading}` of `` fn.body`...` `` is a heading `rows()` built,
  and the body installs with its row type's name in its place, `"__rows_<digest>"`, which the function's search_path
  resolves. A heading the body names is one its own arguments or result take rows of or return, or one a function it
  `calls` does; any other is `MalformedDescription` when the schema is owned, since its row type may stand in no schema
  of the level, or stand there for another function alone and go with it. The snapshot records the body as it
  installs, names and all, so a changed heading is a changed body of every function that names it.
- **It reads no table.** Every declared function is `SECURITY DEFINER`, owned by the installation's function owner,
  a role of no privilege on any table or view, under `SET search_path = pg_catalog, <its schema>, pg_temp`. So its
  body names the functions and row types of its own level unqualified, and a body that reads a relation, of its schema
  or any other, fails where it is called, `42501` permission denied. PUBLIC executes none. It runs under no plan advice
  (`SET pg_plan_advice.advice = ''`), its caller's included: grizzle proves no plan of its body, and an item of the
  calling statement's advice must never meet a relation the body reads, a system catalog among them, by its alias.
- **`calls`** lists the declared functions of the function's own level its body calls. The installation creates them
  callees first, so PostgreSQL, which reads an SQL body's names as it creates the function, finds each; a call of a
  function of another level, of one the schema does not declare, or a cycle, is `MalformedDescription` when the schema
  is owned. A PL/pgSQL body reads its names where it first runs, so `calls` orders its creation alone.
- **NULL input.** `nullInput` is what the function does with a NULL argument, and every declaration states it, since
  neither is a default: `"called"`, PostgreSQL's `CALLED ON NULL INPUT`, runs the body at every argument, NULL ones
  among them; `"strict"`, PostgreSQL's `STRICT`, answers a call with any NULL argument without running the body, NULL
  for a value or a row and no rows for a function of rows, so inside a strict body every parameter is a value. Declare
  a function strict wherever a NULL argument means nothing to it, as a text or a number's own function: its body need
  never test for NULL, and a body that would loop, raise or answer a value at NULL never runs there. A function that
  must refuse a NULL argument itself, as a constructor that raises on one, stays `"called"`.
- **Migrations.** A changed body, volatility or null input is `CREATE OR REPLACE FUNCTION`, which keeps the function's owner and
  grants; a changed signature or result drops the function and creates it again. The snapshot records each function by
  its head and the SHA-256 of its body, and the drift check holds the installed source, `pg_proc.prosrc`, to that
  digest, so a body edited by hand is drift, reported with both digests and the committed statement that last defines
  the function.

### Calling a function

A query calls a declared function of its schema in one of three ways, by what the function returns.
`Fn.call(f, args)` is the value of a function that returns a value: a term, which stands wherever a term of its
result's type stands. `Fn.rows(f, args)` is the rows of a function that returns rows: a source, which a rule
matches as it matches a bound query. `Fn.row(f, args)` is the fields of the one row a function returns: a
record of sources, one for each field of the row that holds rows of a heading of values. Each argument is named as the
function declares it, every one of them and no other: a value is a term, a parameter or a JavaScript value, as a bind
map takes one; rows are a query, or a bound query, whose heading holds the argument's fields. A rows argument's
parameters are all bound, as a matched query's are: a query of parameters is passed as `Q.bind({ ... })`, each bound
to a parameter, a variable or a constant of the calling rule, since the call binds them by its bind map alone and
never by name from the caller's own. Passed unbound, it is a type error ("bind the query's parameters before
matching it or passing it as rows") and, from JavaScript, `MalformedDescription`.

```ts
/** A document, by its slug. */
const DocSlug = str.regex("^[a-z0-9-]{1,64}$")
const Doc = relation("Doc", { doc: DocSlug, shift: natural }, ["doc"])
const Line = relation("Line", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
const Numbered = rows({ pos: natural, txt: Word })

/** Each line of `program` shifted by `shift`, its word folded. */
export const shifted = fn("shifted", {
	calls: [folded],
	args: { program: Numbered, shift: natural },
	returns: Numbered,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT p.pos + shift, folded(p.txt) FROM unnest(program) AS p`
})

export const Docs = schema("Docs", [Doc, Line, folded, shifted], [])

const linesOf = query(Docs).rule((r) => {
	const { pos, txt } = v(Line, "line")
	return r.match(Line, { doc: r.param("doc", DocSlug), pos, txt }).find({ pos, txt })
})

/** Every document's lines, shifted by its own shift, each beside its word folded again. */
export const shiftedLines = query(Docs).rule((r) => {
	const { doc, shift } = v(Doc, "doc")
	const run = Fn.rows(shifted, { program: linesOf.bind({ doc }), shift })
	const { pos, txt } = v(run, "run")
	return r
		.match(Doc, { doc, shift })
		.match(run, { pos, txt })
		.find({ doc, pos, txt, again: Fn.call(folded, { word: txt }) })
})
```

A function that computes several sets at once returns them as the fields of one row, and a statement reads each of
them as a source. The ChangeSet below files a document's lines by the length of their word, two members of one
statement, and calls `parted` once:

```ts
const Parted = rows({ long: Numbered, short: Numbered })

/** The lines of `program`, parted by the length of their word: one row, two fields of rows. */
export const parted = fn("parted", {
	calls: [],
	args: { program: Numbered },
	returns: row(Parted),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT ROW(
  ARRAY(SELECT p FROM unnest(program) AS p WHERE length(p.txt) >= 5),
  ARRAY(SELECT p FROM unnest(program) AS p WHERE length(p.txt) < 5))::${Parted}`
})

const Short = relation("Short", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
const Long = relation("Long", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
export const Words = schema("Words", [Line, Short, Long, parted], [])

const wordsOf = query(Words).rule((r) => {
	const { pos, txt } = v(Line, "line")
	return r.match(Line, { doc: r.param("doc", DocSlug), pos, txt }).find({ pos, txt })
})

/** A document's lines, each filed under its word's length. */
export const file = ChangeSet.empty(Words)
	.insert(
		Short,
		query(Words).rule((r) => {
			const doc = r.param("doc", DocSlug)
			const { short } = Fn.row(parted, { program: wordsOf.bind({ doc }) })
			const { pos, txt } = v(short, "short")
			return r.match(short, { pos, txt }).find({ doc, pos, txt })
		})
	)
	.insert(
		Long,
		query(Words).rule((r) => {
			const doc = r.param("doc", DocSlug)
			const { long } = Fn.row(parted, { program: wordsOf.bind({ doc }) })
			const { pos, txt } = v(long, "long")
			return r.match(long, { pos, txt }).find({ doc, pos, txt })
		})
	)
```

- **Where it runs.** A call of rows is read `LATERAL`, after the matches whose variables its arguments read, once per
  their binding: `shifted` above runs once per document, at the array of that document's lines. A rows argument is an
  array of the heading's row type, `ARRAY(SELECT ROW(...)::<row type> FROM (<query>))`, a set, in no order; a value
  argument is cast to its declared type's base.
- **What it returns.** The rows of a call are a set: a row the function returns twice is one row. Each value is cast to
  its field's declared type, so a contract or a pattern refuses a value of the function's that breaks it, where the
  query reads it. grizzle holds no NULL: a function that returns NULL, as a value or in a field of a row, fails the
  query with SQLSTATE `22004`. A strict function's `Fn.call` at a NULL argument, which a closed read at a key no row
  holds gives, is NULL, as a strict operation's is, never that refusal, and its body never runs there: a filter over it
  is unknown, so it keeps no row there. Every other argument a query passes, a variable, a parameter or a constant, is
  a value.
- **The fields of one row.** `Fn.row(f, args)` holds a source for each field of `f`'s row that holds rows of
  a heading of values, by the field's name, its facts the heading's, a set, typed by the heading as a call's rows are; a
  field of a value, of one row, or of rows whose heading holds rows or a row is none of them, and from a description
  `MalformedDescription`. Every read of a field of one call at one argument tuple reads one evaluation of it, so a
  statement that reads several fields calls the function once: a call whose arguments read only parameters, and
  bound queries over them, is one `MATERIALIZED` CTE of its statement, `SELECT r.* FROM f(...) AS r(...)`, which each
  field's read unnests (`LATERAL unnest(e.field)`), and in a ChangeSet's stratum of one statement one CTE that every
  member reads; a call that reads its rule's variables is one `LATERAL` item of the rule's region, once per binding,
  whichever of its fields the rule matches. A value an argument reads from a stored row, for a call several members
  share, comes in through a rows argument, a query bound to parameters, or as a parameter: a value argument bound to
  a member's own variable makes each member's call its own. `f` is immutable or stable, since a volatile function's
  evaluations are not one; a volatile `f` is refused. grizzle holds no NULL: a row holding NULL at any field, the
  function's NULL row among them, fails the statement with SQLSTATE `22004` where the call is evaluated, and a NULL
  element of a field's array, or one holding NULL, where the field is read, so a field of no rows, an empty array, is
  the empty source and never a NULL.
- **What a query calls.** A query calls a function whose arguments are values and rows of headings of values, and
  that returns a value, rows of such a heading, or one row whose fields it reads. A function that takes one row, or
  that returns rows of a heading with a field of rows or of a row, is called by another function's body alone, and a
  query's call of it is `MalformedDescription` (from JavaScript, and a type error where its types say so): a query's
  sources and terms hold fields, and no field holds a composite or an array of them, so a query could neither read such
  a column nor build such an argument.
- **Where a call is matched.** A call's rows arguments may each be built by a `query(S)` of their own, over one level
  of a schema or over several: the call is matched where the highest of them may be, in a rule over that level or one
  above it, and rows arguments over two levels neither of which is a level of the other are `MalformedDescription`.
- **What may call one.** A call is a query's term alone: a check, a contract's predicate and a generated field are
  evaluated on the host too, and PostgreSQL alone evaluates a declared function, so a call there is a type error
  (`Refused`), and refused from JavaScript when the schema is owned. A term calls an immutable or stable function; a
  volatile one is called through `Fn.rows` alone.
- **Who may call one.** A role holds `EXECUTE` on exactly the declared functions its served programs call, and the
  function, which reads no table, runs as the function owner. A derived relation's or a query entry's definition that
  calls a function runs inside its view, as its owner.

## Levels

A schema builds on another under its own name: `schema.extend([base], name, relations, statements)` is a level over
`base`, with every relation and rule of it and of the levels below it, and relations and rules of its own. Each level is
declared once, by its own name, which no level below it takes, and there is no other way to extend a schema. Its bases
are a list, its description's `bases`, of one base: a level over several bases is not built yet, and a second base is
refused, `Refusal<"schema.extend takes one base: a level over several bases is not built yet">`.

```ts
/** The QTI content model, maintained on its own: an item is its QTI identifier. */
export const Item = relation("Item", { id: ItemIdentifier, title: Title }, ["id"])
export const Qti = schema("Qti", [Item], [])

/** A child's sittings, over Qti: each sitting's item is one Qti holds, as the database enforces. */
export const Sitting = relation("Sitting", { child: ClerkUser, item: ItemIdentifier }, [
	"child",
	"item"
])
export const Ledger = schema.extend(
	[Qti],
	"Ledger",
	[Sitting],
	[contained(on(Sitting, "item"), on(Item, "id"))]
)

/** The signed-in child's own sittings; an insert fills `child` from the token. */
export const mySittings = query(Ledger).rule((r) => {
	const { child, item } = v(Sitting, "sitting")
	return r.match(Sitting, { child, item }).match(Session, { sub: child }).find({ item })
})

export const Learner = role(
	Ledger,
	"learner",
	{ ...wholeEntriesOf(Qti), MySitting: mySittings },
	{ insert: ["MySitting"], contexts: [Session] }
)
export const LedgerApp = login(Ledger, "app", [Learner])
export const QtiAuthor = role(Qti, "author", wholeEntriesOf(Qti), wholeWritesOf(Qti))
export const AuthorApp = login(Qti, "author_app", [QtiAuthor])
```

- **Each level is a PostgreSQL schema.** `schemaNameOf(Qti)` is `qti` and `schemaNameOf(Ledger)` is `ledger`: a level's
  tables, stored derived tables and rosters' domains live in its own schema. A login or role is named
  by the level it is over, `roleNameOf(LedgerApp, {})` is `ledger__app` and `roleNameOf(AuthorApp, {})` is `qti__author_app`.
  The root's schema also holds what belongs to the whole installation: the migrations ledger, the contract and text
  domains, the constants and grizzle's functions. Every reference across schemas is qualified.
- **One installation.** The config lists `Ledger`, its top level, and both levels install together: one migrations
  directory, `migrations/qti/`, named by the root, one snapshot recording each level and one ledger. A migration
  spans every level, so a change of `Qti` that a view or foreign key of `Ledger` reads drops and recreates it in one
  transaction, and a rename of a `Qti` table or field reaches `Ledger`'s foreign keys and views in place. A level added
  on top later is the next migration of the same installation. A relation moved to another level is a new table there:
  `--drop` the old one, as for any stored relation.

### A level reaches the levels below it only where their writes need nothing of it

A containment between stored
relations may have one side below, its other side the level's own, the lower side's terms fields with no `pred` and
no span, every fact or a selection of them, into a key the target relation declares: a foreign key such as
`ledger.sitting` into `qti.item`, or, from a selection below, `contained(on(select(Item, (i) => φ), "id"),
on(Reviewed, "item"))`, every item φ holds of reviewed above. A selection's terms, and a field a selected
target fixes, are generated columns PostgreSQL computes on the lower table however its row is written, under a
UNIQUE the key implies, so a `Qti` write is compiled and drawn as before and meets the law as one above it; a
containment that is unit-local is judged at COMMIT instead ([Rules over queries](#rules-over-queries)). A rule over a
query may read the levels below through its derived relation, as deferred triggers on their tables. A row check may
stand over a relation below (next). Anything else stated at `Ledger` over a `Qti` relation (a key, `mutable`, a
family, tree or fold, a containment between two `Qti` relations, whose foreign key would order `Qti`'s own
statements) is `LevelRefused` when the schema is built: a process over `Qti` holds none of `Ledger`'s code, so no law
of `Ledger` may change how a `Qti` write is compiled or drawn.

- **A level checks the rows below it.** `Ledger`'s list may hold a row check over a `Qti` relation, written exactly as
  that relation's own would be, `check("Titled", Item, (i) => Text.matches(i.title, nonBlank))`, `nonBlank` a
  `Text.pattern`: it reads any field of the row, a text of no byte bound with `Text.matches` among them, as a row
  check does. It is `Ledger`'s law and its CHECK on `qti.item`, named as a row check is and sharing `Item`'s checks'
  names, so a second `Titled` over `Item` at any level is `IdentifierCollision`. The migration that installs `Ledger`, or
  adds the check to it, adds it and validates every stored row, refusing the migration over one that breaks it, and the
  one that removes it drops it; an installation of `Qti` without `Ledger` holds no trace of it.
- **Read-only is the worlds model.** `Learner` holds `Qti`'s tables whole and writes only its own sittings: it reads `Qti`
  through the whole views of its tables, one view of each table in `Qti`'s schema of whole views, `__qti`
  (`wholeSchemaNameOf(Qti)`), owned by the migration role, which every role holding the table whole reads, and holds no
  privilege on a `Qti` table. Since it holds every `Qti` table whole, every query over `Qti` runs on it, through those
  views. Its query entry `MySitting` is a view of its own, in its own schema, `ledger__learner`.
- **Every level is served.** `DbLayer.make` takes the served file of a login over any level of the installation: a
  process of `Qti` alone, such as `AuthorApp`'s, loads only what its programs over `Qti` read, and nothing above it. When a write of it breaks a law a level above states, such as deleting an `Item` a
  `Sitting` holds or inserting one `Titled` refuses, the error is `refused` with `refused.kind` `above`
  and `refused.above` naming the law `{ kind: "above", level: "Ledger", law }`, the level and the law as that level states it
  ([Errors and outcomes](errors-and-concurrency.md#errors-and-outcomes)). `Qti`'s own laws are named as they would be were `Ledger` not
  installed: a process holds no predicate of a law above it, so it never claims to judge one, and judges each of its
  own.
- **A relation parameter takes a query of a level above.** A lower level's program that names the rows it acts on as a
  relation parameter, `r.relation("sittings", heading)`, is bound to a query of a level above it, so the higher level's
  guard runs inside the lower level's write, in its transaction, with no read by the host before it. In a rule over the
  higher level,
  `openVisit.bind({ sittings: appSittings.bind({ child: r.param("child", LearnerId) }) })` binds an import's parameter
  to a bound query, which is bound first as a match's is; and `suspendTest.bind({ sittings: appSittings })` binds a
  ChangeSet's, an input of the call read once before the first stratum of the ChangeSet it is bound on by every member
  and read-back of it that uses it ([Writes](reads-and-writes.md#writes)): bound on the whole call, as metis binds the item its assignment
  picks, before the call's first stratum; bound on a part sequenced after another, as edullm binds the sittings its take
  reads after its decision, after the earlier part's writes. `appSittings`' own parameter `child` joins the ChangeSet's
  as one parameter of one type, the
  other parameters staying the program's. Either is then over the higher
  of the two levels and reads the query's contexts. A query over a level apart is refused, `Refusal<"a relation
  parameter binds a query over a level of the schema it is bound in, or over a schema that schema is a level of">`, as
  is one that delivers other fields than the parameter's heading; a scalar parameter takes no query, whose rows are
  any number. Every member that reads one bound query reads one evaluation of it: an import's in the statement of the
  query that imports it, a ChangeSet's before the first stratum of the part it was bound on.
- **The empty level is below every root.** `schema.empty` is the level of no relation and no rule, below every root: a
  query over it is a query over every schema and every role, which holds it whole whatever it holds: every level's
  reader of queries admits it beside its own, so no level's levels grow by it. A read of no relation, a row of its parameters and
  constants alone, is written over it, `query(schema.empty).rule((r) => r.find({ at: r.param("at", pg.bigint) }))`, and
  runs on every role, so the role serving it holds nothing for it: den's role serves a schedule's input derived from
  its key so while holding nothing of the app's. It installs nothing and names no migrations directory. A level that
  declares nothing over a base is no empty level: it holds the base's relations, and a role runs a program over it only
  where it holds them whole.
- **A level over whatever base it is given.** A package's level over the base its installation hands it is a function
  of that base, bounded by the least level it reads: `export const ledgerOf = <Base extends SchemaOver<typeof Qti>>(base:
  Base) => schema.extend([base], "Ledger", [Sitting], [contained(on(Sitting, "item"), on(Item, "id"))])`. The call checks
  the level over that least level, the one level it knows: its relations' names against `Qti`'s, its statements'
  relations among `Qti`'s and its own, and each derived relation's definition a query over a level of `Qti`. `AnySchema`
  is the weakest bound, which knows no relation's name and admits no derived relation. The same checks over the base
  itself wait for `ledgerOf(base)`: a level the base refuses, one of whose relations takes a name the base holds
  another relation under, or whose statement names a relation the base lacks, is typed with its refusal, which no
  schema admits, so it is refused wherever it is taken as a schema, as a base, a role's or a login's, naming the rule
  it breaks: `Refusal<"two relations of one name across a schema's levels">`.

### A program over whatever role it is given

A package's write over its level is applied through whichever role
over that level the application hands it, bounded by that level: `export const ledgerWrite = <W extends
RoleOver<typeof Qti>>(role: W) => ChangeSet.over(role, ledgerProgram)`. `ChangeSet.over(role, cs)` is `cs` taken over
the role, the empty ChangeSet over the role unioned with it, its strata, parameters, writes and read-backs `cs`'s, and
the call checks `cs`'s schema a level of the bound's least level, the one level it knows, where
`ChangeSet.union(ChangeSet.empty(role), cs)` waits on the parameter and is refused. `RoleOver<typeof Qti>` holds
`Qti`'s relations whole under their names, so `ledgerWrite(role)` admits a role that holds `Qti` whole, a full role
over it or over a level above it; `AnyRole` is the weakest bound, which knows no level. Over a built role the call is
checked against the role itself: a ChangeSet over a schema that is none of the role's levels is refused,
`Refusal<"ChangeSet.over takes a ChangeSet over a level of its role">`. A union or a sequence of ChangeSets over a
role parameter waits on it as union's does, so build the program over its level and take it over the role last.

## Fragments

A library ships its relations, the laws over them and the programs that read and write them, written once, and every
application that composes the library serves those programs over its own schema. `fragment(relations, statements)` is
the library's half: relations and the statements over them, with no name and no installation of their own. An
application lists the fragment among its relations, and its schema declares the fragment's relations and writes its
statements at that level, as if they were its own.

```ts
/** A library's facts: each job, and its one result. */
/** A job, by the key its enqueuer gave it. */
const JobKey = str.regex("^[0-9A-Za-z:_-]{1,96}$")
export const Job = relation("Job", { id: JobKey, attempts: pg.integer }, ["id"])
export const JobDone = relation("JobDone", { job: JobKey, ok: pg.boolean }, ["job"])
export const Jobs = fragment([Job, JobDone], [contained(on(JobDone, "job"), on(Job, "id"))])

/** The library's programs, over the fragment: they name no application's schema. */
export const finishJob = ChangeSet.empty(Jobs).insert(JobDone, [])
export const pendingJobs = query(Jobs).rule((r) => {
	const { id, attempts } = v(Job, "job")
	return r
		.match(Job, { id, attempts })
		.where(r.not(JobDone, { job: id }))
		.find({ id, attempts })
})

/** An application: a relation of its own beside the library's, and a law of its own into the library's key. */
export const Fee = relation("Fee", { job: JobKey, cents: pg.bigint }, ["job"])
export const Shop = schema("Shop", [Fee, Jobs], [contained(on(Fee, "job"), on(JobDone, "job"))])
export const JobWorker = role(
	Shop,
	"jobs",
	{ ...Jobs.relations, Fee },
	{ insert: ["JobDone", "Fee"] }
)
export const feeJob = ChangeSet.union(finishJob, ChangeSet.empty(Shop).insert(Fee, []))
export const ShopApp = login(Shop, "shop", [JobWorker], {
	workload: [workload(JobWorker, { finishJob, pendingJobs, feeJob })]
})
```

- **A fragment is a level of every schema that lists it.** A query or a ChangeSet written over the fragment reads and
  writes its relations alone. It is a program of every schema whose levels list the fragment, and of every role that
  holds the fragment's relations whole, as a program over a level is. So it can stand in that schema's and that role's
  workloads, be imported by their rules, be read back, and join their ChangeSets by `ChangeSet.union` and `sequence`,
  which are then over the schema. A rule over a fragment matching any other relation is a type error, and from
  JavaScript is refused when it is built. A fragment is never what a program compiles against: `grizzle generate`
  compiles each fragment program in each login that serves it, against that login's schema and role, names and
  prepares its statements there, and certifies its role there, exactly as for a program written over the schema. A
  fragment carries no certificate and no served text of its own, and two installations that list one fragment are two
  certificates.
- **Its identity is its content.** A fragment listed twice, or reached through two libraries, is one: its relations are
  one declaration each, as two copies of a relation are, and its statements one statement each. A fragment's
  relations meet the application's under one namespace, so a relation of the fragment's name that differs is
  `DuplicateIdentity`. A diagnostic names a fragment by its relations, `fragment(Job, JobDone)`.
- **Only the fragment states how its relations are written.** A key, `mutable`, `race`, a unit, a series, a family, a
  tree or a fold over one of its relations is the fragment's own statement. The application may state one again, since one
  text is one statement, but it may not add one: a key can become an insertion's arbiter, `mutable` puts a row in place,
  `race` meets the row at a key instead of refusing it, a unit and a series are what its writes borrow, and a
  family, tree or fold draws fields and nests members. Any of those, from any level of the schema or another fragment
  it lists, is `FragmentRefused` when the schema is built. What the application may add over the fragment's relations
  only refuses a write: a containment either way, a row check, a rule over a query. So a fragment's program means the
  same in every application, and an application can only refuse more of its writes.
- **What an application's laws may still refuse.** A containment over the fragment's relations can order a fragment
  ChangeSet's writes into a cycle (`UnorderableStratum`). Then `grizzle generate` refuses that program in that
  application, naming the application's law, and serves it unchanged in an application without that law. It is a
  refusal at generate, per application, and never a difference at run time: a program that compiles is served exactly
  as it would be written over the application's schema. A containment that orders a table a read-back reads after the
  statement making its delta refuses nothing: the read-back runs after the change, over its delta carried there.
- **Nothing is installed for a fragment.** Its relations install at the level whose list holds it, in that level's
  PostgreSQL schema, under the application's one migrations directory, snapshot and ledger. Listing a fragment is, to
  the snapshot, that level declaring its relations and stating its laws, so a schema that spread the same relations and
  laws by hand and now lists the fragment migrates by nothing. A fragment has no login, role or workload: an application's
  role holds its relations and serves its programs.
