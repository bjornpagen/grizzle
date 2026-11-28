# Reads and writes reference

The reference grizzle's source and tests cite by heading (test/unit/dev/references.test.ts). A claim here that the code contradicts is a bug of this page, fixed here.

## Queries

```ts
/** Comments per author on published posts. */
export const commentsPerAuthor = query(Blog).rule((r) => {
	const { org, post, author, at } = v(Comment, "comment")
	return r
		.match(Comment, { org, post, author, at })
		.match(Post, { org, slug: post, status: "Published" })
		.find({ author, comments: r.count() })
})

/** Published posts nobody has commented on. */
export const unanswered = query(Blog).rule((r) => {
	const { org, slug, title } = v(Post, "post")
	return r
		.match(Post, { org, slug, title, status: "Published" })
		.where(r.not(Comment, { org, post: slug }))
		.find({ org, slug, title })
})

/** Total views per organization. */
export const viewsPerOrg = query(Blog).rule((r) => {
	const { org, post, views } = v(PostViews, "postViews")
	return r.match(PostViews, { org, post, views }).find({ org, views: r.sum(views) })
})

/** An organization's posts by title, ready for paging. */
export const orgPosts = query(Blog)
	.rule((r) => {
		const { org, slug, title } = v(Post, "post")
		return r
			.match(Post, { org, slug, title })
			.where(r.eq(org, r.param("org", ClerkOrg)))
			.find({ slug, title })
	})
	.orderBy(["title", "asc"])

/** Two posts of one organization under one title: Post matched twice, in two scopes. */
export const sameTitle = query(Blog).rule((r) => {
	const post = v(Post, "post")
	const twin = v(Post, "twin")
	return r
		.match(Post, { org: post.org, slug: post.slug, title: post.title })
		.match(Post, { org: post.org, slug: twin.slug, title: post.title })
		.where(r.ne(post.slug, twin.slug))
		.find({ org: post.org, post: post.slug, twin: twin.slug, title: post.title })
})
```

`v(Post, "post")` makes one variable per column, in a scope named `post`. `r.match(Post, { ... })` binds variables and constants to a table's columns; a variable in two matches joins them. `.where(...)` filters. `.find(...)` picks the result columns: variables, aggregates, parameters, constants and computed values.

In `sameTitle`, `v(Post, "post")` and `v(Post, "twin")` are two scopes of one table under two names, two sets of variables of two types, so the self-join's keys are proved like any join's. A second `v` of a name the rule already holds is refused with `DuplicateIdentity` when the rule is built.

Rows are typed from the query: `commentsPerAuthor` gives `{ author: string; comments: bigint }`, and `viewsPerOrg` gives `{ org: string; views: Numeric }`, as PostgreSQL's `sum` of a bigint is a numeric. `orgPosts` takes the parameter `{ org: string }`.

| To | Write |
| --- | --- |
| join | one variable in two matches |
| filter | `r.eq`, `r.ne`, `r.lt`, `r.le`, `r.gt`, `r.ge`, `r.between`, `r.in`, `r.and`, `r.or`; an empty `r.in` list or `r.or([])` matches no row, `r.and([])` every row |
| exclude | `r.not(Table, { ... })`: no matching row exists |
| take a parameter | `r.param("name", type)`: a term of that type |
| pass a row list | `r.relation("name", fields)`: a parameter that is a list of rows, matched like a table; `Q.bind({ name: rows })` binds it to a query's rows, of a level above among them ([Levels](schema.md#levels)) |
| aggregate | `r.count()`, `r.sum(x)`, `r.mean(x)`, `r.min(x)`, `r.max(x)`, grouped by the other columns of `find`; a min or max is one of its values, at its type, contract included |
| combine | a second `.rule(...)`, the union of both rules' rows. Rules of different columns need a constant that tells them apart; a rule with an attachment shares its columns with no other. A take or attachment over a union of several headings is no rule of a further union, takes once and is never paged |
| nest | `.attach(name, (parent) => child, delivery)`, delivery `"array"`, `"option"` or `"one"` |
| read several queries at once | `query(S).reads({ name: query, ... })`: one row holding each query's rows under its name, in one statement ([Nearest rows](#nearest-rows)) |
| order and limit | `.orderBy(["title", "asc"])`, then `.take(10)`, `.take("batch")` for an integer parameter, or a `paged(query)` member's windows |
| recurse | `query(S).recursive(...)` |
| compare spans | `r.allen` with `ALLEN` masks, `r.pointIn`, `r.intersection`, `r.difference`, `r.pack` |
| build a span | `r.span(start, end)`: zero or one fact, the span from `start`, included, to `end`, excluded, of the span type over their endpoint type; none where `end` is not after `start` |
| compute | `Num.add`, `Num.mul`, `Num.round`, `Logic.cond`, `Logic.when` and the rest of the [scalar terms](#scalar-terms) |
| match text | `Text.matches(x, pattern)`, `Text.startsWith`, `Text.endsWith`, `Text.contains`, `Xml.isPattern`; `Text.concat` in checks, and in queries over bounded texts |
| search vectors | `.approximateNearest(...)`, with pgvector, from a parameter's vector or a stored row's ([Nearest rows](#nearest-rows)) |
| search text | `Search.matches`, `Search.rank`, `Search.rankCd` of a search document and a `Search.websearch` or `Search.plain` ([Full text search](#full-text-search)) |

### Differences from SQL

- **A query returns a set.** Identical rows are one row.
- **An aggregate folds keyed rows.** It reads each matched row once, by its key: every match in its rule binds a whole key of its source by a variable, a parent's variable or a constant, as `commentsPerAuthor` binds the comment's whole key, or the query is refused with `FoldOverProjection`, naming the match and the key to bind. To aggregate distinct values, match a query of them, a set keyed by its columns.
- **grizzle knows each result's keys**, from primary keys, equalities and constants, and keeps a key through `find` while the chosen columns still determine the row. `r.allen(a, ALLEN.equals, b)` is an equality, as is its converse; a mask written with `|` is a plain number to TypeScript, so the types read it as stating nothing. An `"option"` or `"one"` nested result takes only a query proved to return at most one row, and a window is ordered by a key. A delivery the schema does not prove is a type error. A child query built by a function takes the parent's field as `Term<T, unknown, InputOrigin, Sql, V>`, T the field's domain, `DomainOf<typeof field>`, and V its values, `Infer<typeof field>`, not as a type parameter: an equality over a type parameter says what it fixes only at the call, so inside the function the keys that prove its `"option"` delivery are lost. A child over an equality with the parent's field, built by a function or written inline, proves `"option"` and never `"one"`: `"one"` needs the child matched inline on the parent's own fields, as postPage matches `post.org` and `post.slug` in `r.match(Comment, { org: post.org, post: post.slug, author, at, body })`, where the schema proves every parent has its child.
- **`.orderBy(...).take(k)` is a set again** to whatever composes with it: a match, a further rule, a derived relation or a role's query entry. `take(1)` returns at most one row. A query or nested `"array"` that ends in a take arrives in the take's order, ties broken by the query's key; a final `orderBy` after the take orders it anew.
- **Variables belong to their columns.** Two variables made from one column of a table the rule matches once are refused, and the error shows the rewrite: make the variable where it is bound, or match the table again.
- **A JavaScript value takes the type of what it meets:** its column, the term it is compared with, the field a write puts it in, or the type the query's other rules give its field. Meeting nothing, a string is text, a safe integer an integer, a bigint a bigint, a `Numeric` a numeric, a `Money` money and a boolean a boolean; any other value is refused. It never stands first in a comparison, and a list such as `r.in`'s holds only JavaScript values. Opposite a term, at a column, for a parameter or in a fact, it is a value of its type: in a pattern's language, a uuid's hyphenated spelling, a roster's names, so `"abc"` at a uuid column is a type error, and so is a plain `string` until `Uuid.parse` reads it. Where it becomes a contract's value, a parameter's, a fact's, a typed constant's or a conditional's arm's, it is one its key's mint made; compared with a contract's term, it is a value of the base.
- **A typed term states its type** and stands wherever such a term does. `Status.handle("Published")` is a member of the `Status` roster, and `Type.literal(F, x)` is `x` at the type of any other descriptor `F`. A head keeps a handle's member, so `find({ status: Status.handle("Published") })` delivers `status: "Published"`; `Type.literal` delivers F's type.
- **Terms that meet have one type:** one SQL type, one contract and one roster. A text term never meets a uuid column, and two rosters of the same members never meet. Texts of any two patterns meet: a pattern is no part of a text's type. The rules of one query deliver each field they share at one type. An equality is the one comparison that also meets two refinements of one base carrier, one SQL type once contracts are stripped, roster and all: `r.eq(n, b)` of a `natural` and a `int8`, or of two contracts over one base, compares them under the base's equality, as a containment's sides and a negation's binding meet. Where it holds its value is both sides', so it lies in both contracts, and grizzle's own rewrites may read either side for the other at the other's type with no check and no cast. `r.ne` and the orderings meet as any comparison does: their operands are of one type, `Type.base` of a contract where one is.
- **A value is only its value**, the same under every plan. A `Numeric` has no display scale: `1`, `1.0` and `1.00` are one value, delivered as `1`, and a `numeric(10, 2)` field holds at most two places, refusing a value of more rather than rounding it, and delivers `12.5`, not `12.50`. `new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(d.toString())` prints it at the field's scale, exactly. A float keeps its zero's sign: `-0` is a value of its own, stored, computed and delivered as `-0`, equal to `0` under `=`, `DISTINCT` and a key's equality and apart from it as a fact's identity. Wherever an operation may take one float of several equal ones, a set's member, a group's key, a union's row, a recursion's state, a join variable's value, the merged zero is `+0`, so no plan picks one. A write stores the facts it states: a parameter relation's facts and a ChangeSet member's rows are sets of facts by their identity, `-0` and `0` two of them, so a `-0` a write states is stored as `-0` wherever it reads the relation, and two facts at one key that differ only in a zero's sign are refused as two facts. A read of a parameter relation delivers each of its facts, so `-0` and `0` at otherwise equal fields are two rows; a read's own merges, a projection that drops a field, a union or a group's key, take `+0` as every merge does. `min` and `max` of floats order `-0` below `0`, and a float sum or mean whose exact value is zero is `-0` exactly when every value it sums is; any other float that rounds to zero, a product, quotient, conversion or mean too small for its type, is the zero of its sign. A vector's components have one zero, `0`. A numeric quotient, power, square root or mean is PostgreSQL's for the values alone, as if no operand had trailing zeros: `Num.div(x, 3n)` is the same number whatever scale `x` was stored at.
- **Float and money sums are exact.** A sum of `real` or `double precision` values is their exact total rounded once to the result type, and of `Money` values their exact total; a mean of floats is that total over the count, rounded once. The same rows give the same sum in any order, under any plan.
- **Every answer is a function of the facts**, but for two exceptions, both pgvector's, and one caveat, full text search's: a search document, its matches and its ranks are PostgreSQL's parse of the facts' texts under the configuration's dictionaries and the database's builtin C.UTF-8 locale, a function of the facts on one server, which another PostgreSQL release's stemmers or stop word files may parse otherwise. `.approximateNearest` returns candidates from pgvector's index: which rows, and how many, depend on the index and the database owner's pgvector settings too. grizzle pins `hnsw.iterative_scan = strict_order`, which keeps the candidates in exact distance order, and `hnsw.max_scan_tuples` at pgvector's own 20,000, where both the scan and the stream a search's filters read stop; `hnsw.ef_search` and `hnsw.scan_mem_multiplier` are the owner's, and a scan that reaches their bounds returns fewer rows than asked. `Distance.cosine` is pgvector's own float arithmetic: one server gives the same result for the same vectors on every evaluation, but pgvector builds or CPUs may differ in the last place.

#### No read fails on a value

Every scalar operation is defined on every value its operands' types admit, or its precondition is proved where it stands, so no query, role view or check raises an arithmetic error on any row, but arithmetic over a `numeric`, an `exactInteger` or an `exactMoney` field, bounded by nothing but numeric's own limit, whose result past it PostgreSQL refuses with 22003, numeric_value_out_of_range.

### Scalar terms

PostgreSQL's scalar operators, functions and casts are typed builders of terms, in thirteen namespaces, each member in the one whose domain it reads, so a name is short and the namespace carries the domain: `Xml.isPattern`, never `isXsdPattern`.

| namespace | members |
|---|---|
| `Type` | `literal`, `base`, `cast` |
| `Num` | `add`, `sub`, `mul`, `div`, `mod`, `neg`, `quot`, `rem`, `abs`, `sign`, `round`, `trunc`, `ceil`, `floor`, `gcd`, `lcm`, `power`, `sqrt`, `widthBucket`, `minScale`, `numeric`, `floatBits`, `nonzero`, `nonnegative`, `positive`, `isFinite`, `within` |
| `Logic` | `cond`, `when`, `not`, `and`, `or`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between`, `in`, `least`, `greatest` |
| `Range` | `lower`, `upper`, `width` |
| `Text` | `charLength`, `octetLength`, `utf16Length`, `concat`, `startsWith`, `endsWith`, `contains`, `pattern`, `matches`, `translate`, `lowerAscii`, `replaceWhitespace`, `collapse`, `resolveReference`, `cutBefore`, `cutFrom`, `replace`, `parseFloat8`, `parseNumeric` |
| `Xml` | `pattern`, `isPattern` |
| `Crypto` | `sha256` |
| `Distance` | `cosine` |
| `Search` | `websearch`, `plain`, `matches`, `rank`, `rankCd` |
| `Bits` | `union`, `intersection`, `difference`, `cardinality`, `subset`, `disjoint`, `singleton` |
| `Net` | `within`, `strictlyWithin`, `overlaps` |
| `Time` | `wall`, `epochDay`, `dateOfEpochDay` |
| `Fn` | `call`, `rows`, `row` |

`Type` writes a typed constant, drops a contract to its base and casts; `Num` is the numeric family's arithmetic, rounding and functions, and its guards; `Logic` the comparisons, `least` and `greatest`, the connectives and the conditionals, over any type they compare; `Range` a range's endpoints and width, a span being PostgreSQL's range; `Text` text's lengths, concatenation, prefixes, suffixes and containment, patterns in grizzle's grammar and their matches, transforms, references and lexical parses; `Xml` XML Schema 1.0's pattern dialect; `Crypto` a SHA-256 digest; `Distance` the cosine distance of two vectors; `Search` a full text search's queries, matches and ranks ([Full text search](#full-text-search)); `Bits` the set algebra over one roster's sets, beside `Bits.of`, a set value; `Net` the containment of the network types ([Network containment](#network-containment)); `Time` a zone's wall clock and a date's epoch day ([Time zones](#time-zones)); and `Fn` a declared function called for its value, its rows or its one row ([Calling a function](schema.md#calling-a-function)). No namespace is named `Number`, `Set` or `Digest`: the first two would shadow JavaScript's globals, the type `Set<T>` included, in every module that imports them, and `Digest.sha256` is `effect/crypto`'s own spelling.

### Arithmetic

- **Exact.** Integer arithmetic delivers `bigint`, an *exact integer*, and money arithmetic exact `Money`; neither overflows.
- **Floats are IEEE 754, but for a quotient by zero:** `sqrt(-1.0)` is NaN, and `x / 0.0` is the infinity of `x`'s sign, NaN where `x` is zero or NaN, whichever zero divides, so `1 / -0.0` is `Infinity`, where IEEE 754 gives `-Infinity`. `-0.0` equals `0.0`, and equal operands give equal results under every plan, which may read a divisor from either of two equal fields.
- **A partial operation needs its precondition proved:** division or remainder by a value that may be zero, a numeric square root of one that may be negative, a power, `widthBucket` and `minScale` of values that may be infinite, and a cast that narrows. The proof is a literal's own type, as in `Num.div(x, 7n)`; a contract that declares it, `contract<typeof divisorKey>()("Divisor", int8, (v) => Logic.ne(v, 0n), { proves: ["nonzero"] })`; or a guard, `Logic.when(Num.nonzero(b), (b) => Num.div(a, b), 0n)`, whose function receives `b` proved nonzero and whose last argument is the value where the guard does not hold. Only the function's parameter is proved, as TypeScript narrows a callback's parameter and never a term the callback captures: `(_) => Num.div(a, b)` reads `b` with its own facts, and is refused. An unproved divisor is a type error that names the guard to write.
- **Guards** are `Num.nonzero`, `Num.nonnegative`, `Num.positive`, `Num.isFinite` and `Num.within(x, low, high)`, each a predicate too. A guard's subject is any term, a parameter included: over `d = r.param("d", int8)`, `Logic.when(Num.nonzero(d), (d) => Num.div(x, d), 0n)` delivers `0n` where `d` is bound to zero, under every plan.
- **A contract's facts are exactly the ones its `proves` declares.** Compilation proves each from the predicate and refuses one the predicate does not imply. A fact the predicate implies but `proves` leaves out is no fact of its values: `Num.minScale(rate)` over `contract<typeof rateKey>()("Rate", numeric(7, 6), (x) => Logic.between(x, 0n, 1n))` is refused, naming `{ proves: ["finite"] }` to add. A parameter of a contract has its declared facts, its binding checking every value, so `Num.div(x, Type.base(r.param("d", Divisor)))` needs no guard.
- **Magnitudes are proved by `Num.within`.** A narrowing's range or a power's is proved from `Num.within`'s bounds, or refused as `PartialOperation`: narrow an exact integer into an integer field with `Logic.when(Num.within(x, 0n, 1000000n), (x) => Type.cast(x, int4), 0)`.
- **Exact and plain values share no type.** An exact value binds at a plain integer or money column, but a ChangeSet member stores one into a plain field only through that cast: a head that writes `Num.add(balance, amount)` into a `int8` field is a type error. An `exactInteger` or `exactMoney` field holds it as it is ([Tables and types](schema.md#tables-and-types)). Where PostgreSQL would widen the plain value implicitly, `Logic.cond`, `Logic.when`, `Logic.least` and `Logic.greatest` refuse an exact value beside a plain one of its family, in either order, naming the cast of the exact one into the plain one's type. A bare literal branch takes its conditional's type, an exact one's included, and is refused where it has more digits than that type holds, `MalformedDescription` naming the bound: beside `Num.add(a, b)` over two `int4` fields, an exact integer of 11 digits, `10n ** 11n` is refused naming 10^11, where compared with it, as any value of its family, it is admitted.
- **A member writes each field at the field's own type,** as a generated field's term and an accumulator's step do: only a text's pattern and byte bound are left to the field's domain, which refuses a value outside them. A computed numeric, the value of `r.sum`, `r.mean` or a numeric operation, enters a `numeric(p, s)` field only through `Type.cast` under a guard that proves it fits, and a numeric of another precision or scale, or a span of another width, only through `Type.cast`, since a typmod rounds and a sum can pass the field's precision. Compilation refuses any other head as `DescribedHeadingMismatch`.

### Text

- **`Text.matches(x, pattern)`** is PostgreSQL's `~`: whether `x` holds a match of a pattern in `str.regex`'s grammar under the flags `"u"`, anchored by `^` and `$`. The pattern is a `Text.pattern(source)`, whose source is type-checked as `str.regex` checks its own and admitted once, where it is written, inside PostgreSQL's regex compile space as a `str.regex` pattern is ([Limits](limits.md#limits)); make it once, as a module constant, and match on it anywhere. A pattern is its language: every law, check and derived relation over it is identified by the language its source spells and never by the spelling, so a source rewritten to spell the same language identifies nothing anew, and one of another language does. `float8Text`, `numericText` and `lexicalForm(T)` are grizzle's own patterns, and `.source` is a pattern's text. Or the pattern is a text term whose every value the schema holds: a closed relation's `str.pattern` field, as in `Text.matches(lexical, ValueDomain.at("pattern", domain))`, or a `Logic.cond` of such terms. A `str.pattern` field holds patterns: each value is admitted once, where the schema compiles, and the relation's constants carry each one's translation into PostgreSQL's ARE beside it, so the match reads the translation by the field's key and translates nothing as it runs. Only a closed relation's own field is a `str.pattern`, and a match reads no other text payload as a pattern. A string is no pattern, and a field, a parameter or a computed text can be any pattern, and is refused as one. A match is also a guard: with `const digits = Text.pattern("^[0-9]+$")`, `Logic.when(Text.matches(code, digits), (code) => …, otherwise)` hands its branch the subject as text of its own patterns and the match's together, as `str.and` joins them, so nested matches prove a cast into a conjunction; over a pattern term it is a conditional. In a query, PostgreSQL's regex engine reads at most 268,435,454 bytes of `x` and a read never fails, so `x`'s bytes are proved within them by its type or by a byte guard whose branch the match stands in, `Logic.when(Num.within(Text.octetLength(x), 0, 4096), () => Text.matches(x, digits), false)`: the when is a CASE, so the match is read only where the guard holds, and its answer past the bound is the program's own, here `false`.
- **`Text.startsWith(a, b)` and `Text.endsWith(a, b)`** test a prefix and a suffix, by characters. A rule's probe that
  holds the suffix fixed, a policy's row it was written over, reads the texts that end with it by a seek: the
  installation holds a B-tree on the text's suffix key, `chr(1) || reverse(text)`, and the probe tests the key's range
  in the suffix test's place, `key >= chr(1) || reverse(b)` and below the least text above every key with that prefix,
  which is exactly the suffix test on every text, so a policy write reads the references it reaches and locks no whole
  table. Each write of the text keeps that B-tree, one entry more per row.
- **`Text.contains(haystack, needle)`** tests whether `haystack` holds `needle`'s characters together, PostgreSQL's
  `strpos(haystack, needle) > 0`. It reads no pattern, so every character of the needle is itself: a parameter's `%`,
  `_` and `\` need no escaping, as they would in a LIKE. The empty needle is in every text, and a needle longer than
  its haystack in none. It is defined on every pair of texts, so it stands in a query, a check, a contract predicate
  and a generated field alike, over texts of any length. A query filters by it, with no index: a B-tree serves no
  containment, so each row the query's other terms find is tested, and grizzle drafts no index for it. Like the prefix
  and suffix tests it is a boolean term, so a query filters by it as `Logic.eq(Text.contains(name, term), true)`. It
  folds no case: a search blind to ASCII's case folds both sides,
  `Logic.eq(Text.contains(Text.lowerAscii(name), Text.lowerAscii(term)), true)`, and like `Text.lowerAscii` it folds
  no letter past ASCII, so `É` and `é` stay apart.
- **`Xml.pattern(source)`** is a `Text.pattern` written in XML Schema 1.0's dialect, a pattern facet (Part 2, Appendix F), anchored at both ends as XML Schema reads every facet, its escapes XML Schema's own: `\s` the four XML spaces, `\i` and `\c` XML 1.0 Second Edition's name characters, `\p{IsBasicLatin}` a block of XML Schema's table. A repetition count may be any whole number, as Appendix F sets none: PostgreSQL's RE_DUP_MAX of 255 binds only the ARE grizzle prints, which spells `x{300}` as `x{255}x{45}`, and the host counts a repetition, never copying its body, so a count costs it no state. A facet past PostgreSQL's regex compile space is refused where it is written, as `Text.pattern` refuses one, before it is printed.
- **`Xml.isPattern(x)`** is whether `x` is an XML Schema 1.0 pattern, a string of Appendix F's `regExp` production, the language of QTI 3.0.1's `pattern-mask`, as `Xml.pattern` reads one: groups and class subtractions nested to any depth and counts of any size, refused at `(?`, a back-reference, an unclosed `[` or `(`, a `{` that opens no count, a count whose greatest is below its least, a range whose end is below its start, and a category or block escape the tables do not name. PostgreSQL judges it by the installation's own IMMUTABLE STRICT function, NULL over a NULL text as every operation is, the reader's moves as a table that a recursive query reads once over the text's characters, with no state budget and no bound on a count, so it is defined on every text and stands in checks, contract predicates, generated fields and queries alike: `contract<typeof patternMaskKey>()("PatternMask", Prose, (v) => Xml.isPattern(v))` is a text type of patterns.
- **A byte bound is a guard.** `Logic.when(Num.within(Text.octetLength(x), 0, 64), () => Type.cast(x, Name), "")`, with `Name` a `str.bytes(64, pattern)` whose pattern holds x's, reads `x` inside the branch as at most 64 UTF-8 bytes of its own pattern, so a text of no byte bound casts into `Name`. `octetLength` is total, so the guard stands everywhere, a query included, and it proves the bytes every operation that reads them needs: a query's `Text.matches` and `Text.translate`, and `Text.utf16Length`.
- **`Text.utf16Length(x)`** is `x`'s UTF-16 code units, JavaScript's `x.length`: its code points, and its supplementary ones once more, `char_length(x) + regexp_count(x, '[\U00010000-\U0010FFFF]')`. A length an Effect Schema's `isMaxLength` states of a string is this one, where `Text.charLength` counts code points. Like `charLength`, it stands in checks, contract predicates and generated fields, never in a query. `regexp_count` widens its text to four bytes for every byte, so `x` is bounded within 268,435,454 bytes by its type or by a byte guard, or the operation is refused when it compiles as `PartialOperation` (`bounded`), and no law that reads it fails on a long text. A UTF-16 unit is at most three UTF-8 bytes, so a bound reads no regex past them: `contract<typeof nameKey>()("Name", Prose, (v) => Logic.when(Num.within(Text.octetLength(v), 0, 765), () => Text.utf16Length(v), 256).le(255))` holds a text of at most 255 units, as `Schema.String.check(Schema.isMaxLength(255))` does, since a text of more than 765 bytes has more than 255.
- **`Text.concat(a, b)`** is `a || b`, text of no pattern, of at most the bytes of the two together where each is bounded: a term by its type's byte bound, a string or a typed constant (`Type.literal`) by its own bytes. It stands in checks, contract predicates, generated fields and folds; in a query wherever its operands' types bound its bytes within the most one varlena holds (`byteaMaxLength`), a query's head among them, so `find({ module: Text.concat(path, ".js") })` over a `str.bytes`-bounded `path` is text within its bytes and 3 more, since it allocates its result, which PostgreSQL refuses past 1 GB, and a read never fails on a value; and over texts of any length as a side of `Logic.eq` or `Logic.ne`, which is decided as an equality of the other side with the concatenation built under its bytes' guard: `octet_length(t) = Σ octet_length(pi) AND t = CASE WHEN Σ octet_length(pi) > byteaMaxLength THEN '' ELSE p1 || … || pn END`, which never allocates past the most bytes one varlena holds and is NULL exactly where `t = a || b` would be. So a rule that joins a stored text to a concatenation of the other side's columns reads that text by its key, never every row its other columns find. A literal on the other side is a value opposite the concatenation, as in a comparison with its term, so one of more bytes than the parts take together is refused at compile (`ContractLiteral`), in an equation as in an IN list. A concatenation nested in that side is read through as its parts, in order, so `Logic.eq(t, Text.concat(Text.concat(Text.concat(lead, target), params), trail))` builds the four in order, in a query as in a check. Its first operand is a term, as every operation's is, so a leading literal is a typed constant: `Text.concat(Type.literal(Prose, "item-"), id)`.
- **`Text.translate(x, from, to)`** is PostgreSQL's `translate`, by characters: each character of `x` that `from` holds becomes the character of `to` at its position, so `Text.translate(title, "\t\n\r", "   ")` reads a title in `xs:normalizedString`'s value space. `from` and `to` are strings of one length, `from` holding each character once, or the call is refused where it is written.
- **`Text.lowerAscii(x)`** is `translate` from `A` to `Z` onto `a` to `z`. It lowers no other letter, so it is one IMMUTABLE map whatever the collation. PostgreSQL computes it as `lower(x COLLATE "C") COLLATE pg_c_utf8` wherever it stands, a query, a check and a generated field alike: lower folds byte by byte under the C collation and allocates `x`'s own length, so it folds any text, and its result is collated as every stored text is, so an equation of it with a key is served by the key's index.
- **`Text.replaceWhitespace(x)`** is XML Schema's whiteSpace replace, `Text.translate(x, "\t\n\r", "   ")`.
- **`Text.collapse(x)`** is its whiteSpace collapse, each run of tab, LF, CR and space one space and none at either end, by PostgreSQL's `replace` and `btrim` alone, which never lengthen the text: IMMUTABLE and defined on every text, so it stands in a generated field and in a query over any text. A collapse keeps its operand's byte bound, so a query's `Text.matches` over a collapse still needs the operand bounded, as below. No other character is white space to it, a no-break space and a line separator among them.
- **`Text.cutBefore(x, chars)`** is `x` before its first character among `chars`, all of `x` where it holds none, and **`Text.cutFrom(x, chars)`** is `x` from that character on, the empty text where it holds none, so the two concatenate to `x`: `Text.cutBefore(href, "?#")` is an href's path and `Text.cutFrom(href, "?#")` its query and fragment. Characters are code points, and `chars` is a set, a repeat no second member and an empty one cutting nowhere; it may be any text term. Each is text of no pattern within `x`'s bytes, computed by a function of grizzle's library (strpos, `left` and `substring`), which allocates at most `x`'s own bytes, so it stands in queries over any text as in checks and generated fields.
- **`Text.replace(x, from, to)`** is PostgreSQL's `replace`: every occurrence of `from` in `x`, left to right and none overlapping, replaced by `to`, and `x` itself where `from` is empty, so `Text.replace(Text.replace(Text.replace(name, "%", "%25"), "?", "%3F"), "#", "%23")` writes an entry's name as a URI path segment, one character by several. It is text of no pattern within `x`'s bytes and what each occurrence of `from` adds (a string `from` by its own bytes, a term's at least one), and it allocates its result, so a query holds it only where that bound is within the most bytes one varlena holds; a check or generated field over longer texts fails its write.
- **`Crypto.sha256(x)`** is the SHA-256 digest of a `bytes` value, its 32 bytes as they are, PostgreSQL's `sha256(x)`, the one operation that reads a bytes value, which it reads whole; over a text it is the digest of the text's UTF-8, `<textDigest>(x)`, the installation's own IMMUTABLE STRICT function of `sha256(convert_to(x, 'UTF8'))`, which a grizzle database, always UTF8, converts nothing for. Its value is a `sha256` digest, never a text: no hex spelling is stored or compared. It is IMMUTABLE and defined on every value, so it stands in checks, selections, generated fields and queries. `generated(sha256, Crypto.sha256(row.content))` is a field PostgreSQL computes from the bytes it stores: no writer sends it, since an insert holds only the written fields, and no row holds a digest of other bytes. On the host, `Sha256.ofBytes(bytes)` and `Sha256.ofText(text)` compute the same digest.
- **`Num.floatBits(x)`** is a float's identity image: `float8send`'s 8 bytes, the bits of its IEEE 754 binary64 encoding, read as a signed `bigint`, a `real` widened exactly to `double precision` first, every NaN in one form (0x7ff8000000000000), as Java's `doubleToLongBits` reads them. `floatBits(value)`, exported beside `Num`, is the same function for an application's own code. Two floats have one image exactly when they are one value: `-0` and `0` differ, where `Logic.eq` holds them equal. It is IMMUTABLE and defined on every float. A primary key holds only fields a caller writes, so a key over floats by identity states the image as a field and holds it to the value by a law: `relation("Bag", { variable, bits: int8, value: float8, count }, ["variable", "bits"])` with `check("BagImage", Bag, (b) => b.eq(b.bits, Num.floatBits(b.value)))`, each row written with `bits: floatBits(value)`. A bag holding both zeros holds two rows, the check refuses a `bits` that is not its value's image, and a read by `=` on `value` still finds either zero. A generated image, `generated(int8, Num.floatBits(r.value))`, stands in a candidate key and a reference.
- **A query matches or translates only a bounded text**, one whose type bounds it within 268,435,454 bytes, since PostgreSQL allocates four bytes for every byte of it; `Text.lowerAscii` folds any text there. A check, a law's selection or a generated field reads any text ([Limits](limits.md#limits)).
- **`r.series(low, high)`** is a source a rule matches: each integer from `low` to `high`, both included, none where `low` lies above `high`, `r.match(r.series(first, last), { at })`, PostgreSQL's `generate_series(low, high)` where the match stands, once for each binding of the matches before it. Each end is a term of an integer, bigint or exact integer type over the rule's variables, parameters and constants (a JavaScript value, which meets no term, is refused), and `at` is an exact integer. Every element lies between its own row's ends, so a term of the rule reads it within the least value `low` takes and the greatest `high` takes: no filter and no guard is its premise, so it holds wherever the term is evaluated. A piece of presence's UTC days are `r.series(Num.div(from, dayMicros), Num.div(Num.sub(to, 1n), dayMicros))`, and with `from` and `to` bounded by Moment's top each day is a date's, `Time.dateOfEpochDay(Type.cast(day, int8))`, proved by those intervals. A day stored in another relation's column is typed by a bounded contract there, proved at the write by the same interval.
- **`r.tokens(x)`** is a source a rule matches: the tokens of a whitespace-separated list, XML Schema's list lexical space, `x` collapsed and split at its spaces, `r.match(r.tokens(lexical), { at, token })`. Each `token` is a run of the characters `x`'s language holds but tab, LF, CR and space, text within `x`'s byte bound, so a token of a bounded text is bounded and a token of a text of XML's characters is a text of them, which a cast into a QTI identifier's type admits under a guard of its bytes; a token of any text is a run of no tab, LF, CR or space. `at` is its place among them from 0, a natural, which keys the tokens of one `x`: a derived relation of the tokens of a keyed row is keyed by the row's key and `at`, and by the row's key alone where a literal fixes `at`, so a stored one of tokens of no byte bound holds a key a B-tree entry holds. A series' element keys its rows so too; a declared function's rows (`Fn.rows`) are keyed by their whole heading. A text of whitespace alone has none. `x` is a text term of the rule's scope: a variable, a parameter or a constant, bound as a call's argument is, or a term computed from them where the match stands, as a series' end is. PostgreSQL computes the tokens where the match stands, `unnest(string_to_array(<x collapsed>, ' ')) WITH ORDINALITY`, once for each binding of the matches before it, so a list an import would store token by token, with a family and a fold to prove its split, is a derived relation instead: `derived("Idref", query(S).rule((r) => r.match(Attribute, { …, lexical }).match(r.tokens(lexical), { at, token }).find({ …, at, token })))`, its split true by definition. A rule over such a relation is judged whole where it is unit-local ([Rules over queries](schema.md#rules-over-queries)), reading the tokens of the units a transaction wrote alone; no probe reads a token back to the row that holds it, so one that is not unit-local is refused as `UnsupportedLawFamily`.
- **`r.split(x, separator)`** is a source a rule matches: the pieces of `x` between the occurrences of `separator`, a JavaScript string of one Unicode scalar value but U+0000, the split's own constant, `r.match(r.split(path, "/"), { at, piece })`. n occurrences give n + 1 pieces, the empty ones kept, so `"a//b"` is `a`, an empty piece and `b`, and the empty text is one empty piece, as JavaScript's `String.prototype.split` reads it: `x` is always its pieces joined by the separator. Each `piece` is a stretch of the characters `x`'s language holds but the separator, text within `x`'s byte bound, so a piece of a bounded text casts into a type that excludes the separator; `at` is its place from 0, a natural, which keys the pieces of one `x` as a token's place does. A whitespace-separated list is `r.tokens`, whose runs of whitespace are one separator and whose empty list has no token. PostgreSQL computes the pieces where the match stands, `string_to_table(<separator> || x, <separator>) WITH ORDINALITY`, its first piece, the one before the separator written ahead of `x`, dropped.
- **`r.rest(x, prefix)`** is a source a rule matches: one row, `rest`, the code points of `x` past `prefix`'s, where `x` starts with `prefix`, and none where it does not, so a match of it keeps only the bindings whose `x` has the prefix and `r.not(r.rest(x, prefix), {})` keeps the others. The text and the prefix are each a text term of the rule's scope, as a token split's text is, a computed one among them: the variable after an item ref's identifier and its period is `r.match(r.rest(reference, Text.concat(scope, ".")), { rest: variable })`. The rest is a stretch of `x`'s characters within its byte bound, and its row is keyed by what keys `x` and the prefix. PostgreSQL computes it where the match stands, `substring(x, char_length(prefix) + 1)` where `starts_with(x, prefix)`. The empty prefix is a prefix of every text, its rest the text itself; a text is a prefix of itself, its rest the empty text.
- **`r.splitLast(x, separator)`** is a source a rule matches: one row, `before`, the code points of `x` before the last occurrence of `separator`, and `after`, those after it, where `x` holds the separator, and none where it does not, so a match of it keeps only the bindings whose `x` holds it and `r.not(r.splitLast(x, separator), {})` keeps the others. `x` is always `before`, the separator and `after` joined, `after` holds no separator, and either may be empty, a separator at either end of `x`. The separator is a JavaScript string of one Unicode scalar value but U+0000, the split's own constant, as `r.split`'s is, and its occurrences are code points: a scalar value's UTF-8 never occurs inside another character's, so `é` and a character beyond the BMP split as a comma does. `before` is a stretch of `x`'s characters, the separator among them, and `after` a stretch of them but the separator, each within `x`'s byte bound, so the text after a bounded text's last separator keys a stored relation and casts into a type that excludes the separator; its row is keyed by what keys `x`. The last piece of a text is the text after the last separator of the text with one written ahead of it, a computed text, and a path's extension as Node's `path.posix.extname` reads it, without its dot, is the text after the last dot of its last segment, where neither side of that dot is empty: `r.match(r.splitLast(Text.concat(Type.literal(Slash, "/"), path), "/"), { after: segment }).match(r.splitLast(segment, "."), { before: stem, after: extension }).where(r.ne(stem, ""), r.ne(extension, ""))`, `Slash` being `str.regex("^/$")`, so `photo.JPG` is `JPG`, `..foo` `foo` and `a.b.c` `c`, and `.bashrc`, `a/.svg` and `a.` have none. PostgreSQL computes it where the match stands, `left(x, -k)` and `right(x, k - 1)` for `k` the place of the separator in `reverse(x)` (`strpos`), where `k > 0`: one pass of each over `x`.
- **`r.decodedPath(x)`** is a source a rule matches: one row, `path`, the path the percent-encoded URI path `x` spells (RFC 3986 §2.1 and §2.5), each `%HH` its octet and every other character its own UTF-8, the octets read as UTF-8, so `my%20sign.png` and `%C3%A9` decode to `my sign.png` and `é`; and none where `x` spells no path: a `%` that begins no `%HH` (`a%zz`, a `%` at the end), escaped octets that are no well-formed UTF-8 (`%FF`, a lone `%C3`, an overlong `%C0%80` or `%E0%80%80`, a surrogate `%ED%A0%80`, past U+10FFFF, or a lead and its continuations with a literal between them), an escape of U+0000, which no text holds, or of `/` (`a%2Fb`), which would join two segments, and a segment of dots alone with one written `%2E`, which would decode to a dot segment `x` does not hold. Every other character stands as written, a literal `/`, `.` or `..` among them, so decode a path after its dot segments are removed. `r.not(r.decodedPath(x), {})` keeps the texts that spell none. The path is any text within `x`'s byte bound, and its row is keyed by what keys `x`. PostgreSQL computes it where the match stands by a function of grizzle's library, which reads `x` once between its `%`s by window functions, no regular expression, at any length.
- **`r.resolvedWithin(base, reference)`** is a source a rule matches: one row, `target`, `reference` resolved against `base` as `Text.resolveReference` resolves it (RFC 3986 §5.2.2, strict, then §5.3's recomposition), where no `..` segment of the path its resolution walks climbs past that path's root, and none where one does, so a hierarchy rooted at the base holds no target of it: from a package's document `package:///items/i.xml`, `../a.png` resolves to `package:///a.png` and `../../a.png` to none, an href above the package root, which `r.not(r.resolvedWithin(base, reference), {})` keeps. A reference of no path keeps its base's path unwalked, within it. Only a literal `.` or `..` is a dot segment, as the strict resolver reads one; RFC 3986 §6.2.2.2 reads `%2E` as `.`, so a package importer that does replaces `%2E` and `%2e` in the reference with `.` first (`Text.replace`), resolves, then decodes the target's path (`r.decodedPath`). The target is any text within both texts' bytes and a merge's `/`, which a query holds only where their patterns bound that within the most bytes one varlena holds, as for `Text.resolveReference`; its row is keyed by what keys the base and the reference. PostgreSQL computes it by a function of grizzle's library, the resolution's walk counting each `..` that finds no segment to remove, by window functions over the path's segments, no regular expression.

A translation is text of the image of `x`'s language, every class and character of its pattern rewritten by the map, so a bounded pattern stays bounded and a literal opposite it is judged by the image. Where `x`'s type bounds its bytes, a `str.bytes` among them, so does the translation's: by the most bytes the image of a text of `x`'s byte and character bounds over its pattern's characters can take, which is `x`'s own bound where the map takes no character to one of more bytes, as `lowerAscii` and `replaceWhitespace` never do, and more where it does: `Text.translate(x, "a", "€")` over any text of at most 6 bytes is at most 18, six `a`s of three bytes each. A query's head delivers it as it delivers any refined text, cast where its trace proves no row inside the refinement into that refinement's domain, which the installation holds for every refinement any artifact over it or any program it serves types a value by, whatever field declares it; a law that reads it, a containment of a stored text into a derived relation that computes one among them, and a cast of it in a generated field or a check name that domain alike. A cast of a text into a refined text is total where the text's language lies inside the target's, proved by comparing their automata as for a parse, and, into a `str.bytes`, where the longest text of its language within its own byte bound fits the target's, which its automaton finds: a collapse of a text of at most one byte of spaces and `😀` is the empty text alone, so it casts into text of no byte. So a translation is stored in a field of a type the image lies in: `generated(Normalized, Type.cast(Text.translate(row.title, "\t\n\r", "   "), Normalized))`, `Normalized` being `str.regex("^[^\\t\\n\\r]*$", "su")`.

A collapse is text within `x`'s length and byte bounds, since it never lengthens a text, of runs of `x`'s other characters a space apart. That is exactly the image of `x`'s language for a pattern with no white space, which collapse leaves as it is, and for a class repeated freely, `^[...]*$` (the wildcard among them), whose image is every collapsed text over its other characters: `^(?:[^ \t\n\r]+(?: [^ \t\n\r]+)*)?$` for `Prose`. For any other pattern it is more than the image: for one of at most n characters, n up to 257, every text of at most n characters that begins and ends with a character other than white space, two spaces together included, `^(?:[^ \t\n\r](?:[^\t\n\r]{0,n-2}[^ \t\n\r])?)?$` for `^.{0,n}$`; for any other, the collapsed texts over its characters, unbounded. Store a collapse as a translation is stored: `generated(T, Type.cast(Text.collapse(row.title), T))` for a `T` the result lies in. The bound and the language compose through a chain, so a key text normalized from a key text casts back into its type: `generated(Key, Type.cast(Text.lowerAscii(Text.collapse(row.lang)), Key))`, `Key` being `str.bytes(2587, str.regex("^.*$", "su"))` and `lang` a `Key`.

A digest is a `sha256` value, 32 bytes: bytea behind the installation's digest domain, whose CHECK holds its length, and a `Sha256` on the host, a `Uint8Array` of its bytes. A key, a UNIQUE, a family's axis and a reference's target hold one by its bytes, its entry 32 bytes and a header, so a digest of a text no index entry could hold keys that text. `Logic.eq` compares two, a parameter of the type finds a row by one, and a query's head delivers one as a fresh `Sha256`. A value of another length is refused where it is passed, `sha256Value`, before any statement is sent. No contract is over a digest, and no cast turns one into a text: a URL or a file name that spells one renders its bytes at that boundary, `digest.toHex()`.

### Parsing text

`Type.cast(lexical, T)` is PostgreSQL's own cast from text into an integer type, `numeric(p, s)`, `float8`, `bool` or `date`, read as XML Schema reads `xs:integer`, `xs:decimal`, `xs:double`, `xs:boolean` and `xs:date`. Each type has one lexical form, `lexicalForm(T)`: XML Schema's lexical space cut to the values `T` holds exactly, so the cast never raises and never rounds.

| `T` | `lexicalForm(T)` |
| --- | --- |
| an integer type | `[+-]?[0-9]+` within the type's range, a bigint's 19th digit included |
| `numeric(p, s)` | at most `p - s` integer and `s` fraction digits, besides leading and trailing zeros |
| `float8` | a mantissa of at most 15 significant digits either side of its point, with an exponent of at most 293; or `INF`, `-INF` or `NaN` |
| `bool` | `true`, `false`, `1` or `0` |
| `date` | `YYYY-MM-DD` from 0001 to 9999, leap days by the Gregorian rule, no timezone |

The cast is total, and compiles, exactly when every value of its operand is in the form: a field typed `lexical(T)` or `str.regex(lexicalForm(T).source)`, a text whose pattern's language lies inside the form, proved by comparing the two languages' automata, or a subject under `Logic.when(Text.matches(x, lexicalForm(T)), (x) => Type.cast(x, T), otherwise)`. Anything else is `PartialOperation` with the precondition `lexical`. Two languages whose automata the comparison cannot build within 2,048 DFA states and 2,097,152 NFA-state visits are `ResourceBound`, naming both patterns.

So a typed value derived from its lexical form is a generated field, `generated(int8, Type.cast(row.count, int8))`: NOT NULL, computed by PostgreSQL from the text it agrees with, and read by a law as any field is. A numeric's cast is `::numeric(p, s)`, which the form keeps from rounding; a date's is `make_date` over the text's year, month and day, since `text::date` reads `DateStyle` and is STABLE, which a generated column refuses. The host reads each form by a scan of its own and agrees with PostgreSQL to the bit, a double's rounding included.

`Text.parseFloat8(x)` reads any decimal text of a double, of any digits and any exponent, by IEEE 754's conversion to binary64, the one JavaScript's `Number` and Java's `Double.parseFloat8` make: the text's exact value rounded to the nearest double, ties to even, an infinity of its sign past the greatest finite double, and a zero of its sign below half the least subnormal. Its text is `float8Text`, the grammar of XML Schema 1.1's `xs:double` lexical space: `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` with an optional `[eE][+-]?[0-9]+`, or `INF`, `+INF`, `-INF` or `NaN`, which name themselves. It compiles as a cast does, over a field whose pattern lies inside `float8Text` or a subject under `Logic.when(Text.matches(x, float8Text), (x) => Text.parseFloat8(x), otherwise)`; anything else is `PartialOperation` with the precondition `lexical`. So `1e400` is `Infinity`, `-1e-400` a negative zero, equal to zero as every double's zero is, and `1.7976931348623157e308`, `5e-324` and `1.2345678901234567` the doubles they name, where `Type.cast` into `float8` keeps its bounded form, since PostgreSQL's own `float8in` refuses an overflow and an underflow. Its SQL reads the digits and exponent with plain text functions into a numeric of at most 769 significant digits, its exponent clamped within ±324, and rounds that once, so it stands in checks, generated fields and queries over a text of any length.

`Text.parseNumeric(x)` reads a decimal text of any digits into numeric exactly, by XML Schema's `xs:decimal` lexical mapping: its digits, signed, over ten to the count of its fraction digits, a numeric of no typmod. So `1.50`, `+001.5` and `1.5` are one value, and a text past 256 integer or 255 fraction digits is the value it names, never rounded, clamped or read as an infinity. Its text is `numericText`, the grammar of XML Schema 1.1's `xs:decimal` lexical space, `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)`, within `numericTextMaxBytes` UTF-8 bytes, 16,384. Every such text names a value PostgreSQL's numeric holds, at most 16,383 digits past its point; one byte more can name one it does not hold. A regex counts no run past 255, so the byte bound stands beside the pattern, as `str.bytes` does. The parse compiles over a field whose pattern lies inside `numericText` and whose type bounds its bytes within 16,384, `str.bytes(16384, str.regex(numericText.source))` or a refinement of it, or a subject under both guards, `Logic.when(Text.matches(x, numericText), (x) => Logic.when(Num.within(Text.octetLength(x), 0, 16384), () => Text.parseNumeric(x), otherwise), otherwise)`, the byte guard standing where `octetLength` does. Anything else is `PartialOperation` with the precondition `lexical`, whose guard names the test the operand lacks. The value of a text of at most n bytes has at most n integer and n - 1 fraction digits, so it casts into `numeric(2n, n - 1)` with no guard. Its SQL is `x::numeric`, IMMUTABLE, so it stands in checks, generated fields and queries. Where `Type.cast` into `numeric(p, s)` keeps its form of at most 256 integer and 255 fraction digits, compare decimals of any length by their parse. Never let an `otherwise` stand for a value, such as an infinity: a rule over it then passes on a text that does not parse, so state what the rule holds of such a text in the rule.

XML Schema collapses a number's white space before it reads it. Guard the collapsed text, and the branch reads it as text of the collapse's language and the guard's pattern together, as a guard narrows any term: `Logic.when(Text.matches(Text.collapse(x), float8Text), (x) => Text.parseFloat8(x), otherwise)` parses ` 1.5 ` and `\t-2e3\n`, and a translation, a cast and a value's base narrow alike.

### Network containment

`Net.within(a, b)` is PostgreSQL's `a <<= b`, whether `a` lies within the network `b` or is it, `Net.strictlyWithin(a, b)`
its `a << b`, within and not `b` itself, and `Net.overlaps(a, b)` its `a && b`, whether either lies within the other.
Each operand is an inet or a cidr, a contract over one among them, of either type whatever the other's, so an address
is tested against a network as each is stored; a JavaScript value takes the first operand's type. `>>=` and `>>` are
`within` and `strictlyWithin` with their operands swapped. Each is a predicate, false across the address families as
PostgreSQL defines it, and defined on every pair of values, so it stands in a query's filter, a row check and a rule
alike, and the host's evaluation of it is PostgreSQL's, bit for bit.

```ts
/** An organization's networks, each a cidr under the organization's key. */
export const Network = relation("Network", { org: ClerkOrg, network: cidr }, ["org", "network"])
export const Campus = schema("Campus", [Network], [])
/** The address a request reached the server from, as its edge reports it: attested by the server, never the client's. */
export const Origin = attested("Origin", { address: inet })

/** The organizations whose networks the request's address lies within. */
export const orgsHere = query(Campus).rule((r) => {
	const { org, network } = v(Network, "network")
	const { address } = v(Origin, "origin")
	return r
		.match(Network, { org, network })
		.match(Origin, { address })
		.where(Net.within(address, network))
		.find({ org })
})
```

A containment in a query's filter of a stored inet or cidr and a value the probe knows, a parameter's, a literal's or a
join partner's, a context's address among them, requests a GiST index on the column: inet_ops, PostgreSQL 19's default
GiST class for inet and cidr, serves `<<=`, `<<`, `>>=`, `>>` and `&&` alike, so the probe reads the networks that
contain or lie within the value and no other row. A rule's judge reads its rows by its equalities' keys and filters
by the containment.

### No outer joins

Where SQL would LEFT JOIN and fill the gaps with NULL, a second rule covers the rows that have no match:

```ts
/** Tickets sold per show, zero included: the second rule covers the shows a LEFT JOIN would pad with NULL. */
export const sold = query(BoxOffice)
	.rule((r) => {
		const { id } = v(Show, "show")
		const { id: ticket } = v(Ticket, "ticket")
		return r
			.match(Show, { id })
			.match(Ticket, { id: ticket, show: id })
			.find({ show: id, sold: r.count() })
	})
	.rule((r) => {
		const { id } = v(Show, "show")
		return r
			.match(Show, { id })
			.where(r.not(Ticket, { show: id }))
			.find({ show: id, sold: 0n })
	})
```

Its rows are `{ show: string; sold: bigint }`, one per show, since `0n` takes the count's type, `natural`, whose
values are bigints.

### Nearest rows

```ts
import { Distance } from "@bjornpagen/grizzle"

/** A QTI item's identifier, and a lesson's and a catalog's slugs. */
const ItemIdentifier = str.regex("^[A-Za-z_][0-9A-Za-z_.-]{0,63}$")
const LessonSlug = str.regex("^[a-z0-9-]{1,96}$")

export const Missed = relation("Missed", { id: ItemIdentifier, embedding: vector(1536) }, ["id"])
export const Lesson = relation(
	"Lesson",
	{ id: LessonSlug, catalog: LessonSlug, embedding: vector(1536) },
	["id"]
)
export const Seen = relation("Seen", { learner: ClerkUser, lesson: LessonSlug }, [
	"learner",
	"lesson"
])
export const Tutor = schema("Tutor", [Missed, Lesson, Seen], [])

/** The twenty lessons of a catalog nearest a missed question's stored embedding, the question named by its key. */
export const nearMissed = query(Tutor)
	.rule((r) => {
		const { id, catalog, embedding } = v(Lesson, "lesson")
		const missed = v(Missed, "missed")
		return r
			.match(Missed, { id: r.param("missed", Missed.fields.id), embedding: missed.embedding })
			.match(Lesson, { id, catalog, embedding })
			.where(r.eq(catalog, r.param("catalog", Lesson.fields.catalog)))
			.find({ lesson: id, distance: Distance.cosine(embedding, missed.embedding) })
	})
	.approximateNearest({ by: "distance", take: 20 })

/** The lessons a learner has seen. */
export const seenBy = query(Tutor).rule((r) => {
	const { lesson } = v(Seen, "seen")
	return r
		.match(Seen, { learner: r.param("learner", Seen.fields.learner), lesson })
		.find({ lesson })
})

/** Both reads of a step, in one statement. */
export const stepReads = query(Tutor).reads({ nearest: nearMissed, seen: seenBy })
```

`.approximateNearest({ by, take })` searches one rule's rows, nearest first by `by`, a `Distance.cosine` between a vector the rule matches and one query vector, through the HNSW index the workload's search requests, at most `take` of them. The query vector is one value for the whole statement: a parameter, a literal, or a field of another match than the ranked vector's, whose whole key the rule fixes to parameters or literals, in the match or by a `where` equality, `Missed` matched by its `id` above, which holds at most one row, so its fields are its row's. A match keyed to one row ranks at most that row, so a distance between two of its own fields ranks nothing. The statement reads that row by its key once, before the search, in a subquery PostgreSQL runs as an InitPlan, so the index orders by the stored vector as it orders by a parameter, in one scan. A key that holds no row leaves no candidates, an empty answer and no error, and the scan then never runs.

`query(S).reads({ ... })` is a record of named queries as one query of exactly one row, which holds each query's rows under its name, an array in that query's own order: its `orderBy` or `take`, otherwise its key. `stepReads`' row is `{ nearest: ReadonlyArray<{ lesson: string; distance: number }>; seen: ReadonlyArray<{ lesson: string }> }`. Each query's parameters are its own under its name, `"nearest.missed"`, `"nearest.catalog"` and `"seen.learner"`, so two reads never share one by its name. The record is one statement, whatever its queries are, searches among them, so its queries read one snapshot under any isolation, and its `explain` plans that one statement. It is a query like any other: `stepReads` is a member of a workload. Each query is an attachment of the unit row, the one row of no columns `r.find({})` holds, and an attachment under a parent of no columns reads none of its columns; under any other parent, an attachment that reads none of the parent's columns is refused with `AttachedParentUnbound`.

### Full text search

```ts
import { searchDocument } from "@bjornpagen/grizzle"

/** A unit of a course: its subject, grade, texts and embedding, and the search document of its title and summary. */
export const Unit = relation.generated(
	"Unit",
	{
		id: LessonSlug,
		subject: int4,
		grade: int4,
		title: Prose,
		summary: Prose,
		embedding: vector(1536)
	},
	["id"],
	(r) => ({ search: searchDocument("english", ["A", r.title], ["B", r.summary]) })
)
export const Course = schema("Course", [Unit], [])

/** A query's text, within 4,096 bytes. */
const SearchText = str.bytes(4096, str.regex("^.*$", "su"))

/** The ten units of a subject up to a grade that best match a web search's text. */
export const searchUnits = query(Course)
	.rule((r) => {
		const { id, subject, grade, search } = v(Unit, "unit")
		const q = Search.websearch(r.param("q", SearchText))
		return r
			.match(Unit, { id, subject, grade, search })
			.where(
				r.and([
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				])
			)
			.find({ unit: id, rank: Search.rank(search, q) })
	})
	.orderBy(["rank", "desc"])
	.take(10)
```

`searchDocument(configuration, [weight, text], ...)` is a generated field PostgreSQL parses from its row's texts: `setweight(to_tsvector('pg_catalog.<configuration>', text), weight) || ...`, the parts concatenated in their order, a tsvector stored with the row. The configuration is one of pg_catalog's (`textSearchConfigurations`: `simple`, and one per Snowball language, `english` among them), named per field and the document's type: a query is parsed under the configuration of the document it meets, so no query is ever read under another, and two documents of two configurations are two types. A weight is `A`, `B`, `C` or `D`, which a rank weighs a match by. Each text is a text term of the row, as a generated field's term reads it. A read delivers the document as the text PostgreSQL prints for it, `SearchDocument`, under the brand a read alone mints; no parameter carries one, and no key, rule, comparison, contract or fold reads one.

**A stored document.** `tsvector(configuration)` is a search document's field its caller writes: each value a `SearchDocument` of its configuration a read delivered, written back as it is, so a read's documents can be kept with the rest of its rows and matched and ranked there as any document is. Its value is the text PostgreSQL prints, its lexemes quoted in their one order, each once, its positions ascending; any other text, one PostgreSQL would read and store as another document, is an `EncodingFailure` (`searchDocumentForm`), and one past PostgreSQL's sizes, a lexeme over 2,047 bytes or a document over 1,048,575, is `searchDocumentSize`. Over the wire a document is its text, which a served write's facts state as the host does, any other refused as `searchDocument`, the gap its JSON Schema lists (`x-grizzle-gaps`). A query's row states one by a term of its type.

`Search.websearch(text)` reads a query's text by `websearch_to_tsquery`, a web search engine's syntax of quoted phrases, `or` and a leading `-`, and `Search.plain(text)` by `plainto_tsquery`, every word required. A query is no term: `Search.matches(document, query)`, the predicate `document @@ query`, `Search.rank(document, query)`, ts_rank's real, and `Search.rankCd(document, query)`, ts_rank_cd's, read it, each in PostgreSQL's two-argument form, its default weights (A 1.0, B 0.4, C 0.2, D 0.1) and no normalization. A match in a query's filter over a stored document requests a GIN index on the document's column, which serves it: PostgreSQL reads the rows the query's lexemes hold, never the table. `searchUnits` delivers `{ unit, rank }`, best first, ties broken by `unit`, its key.

Text search is PostgreSQL's alone. What a document holds is its configuration's parser, dictionaries and stop word files, read under the database's builtin C.UTF-8 locale, which no host reproduces, so the host evaluates no document, match or rank, and every position a host judgement stands in refuses one: a contract predicate, a row check and a generated field compute no `textMatches`, `textRank` or `textRankCd`, a type error and `UnsupportedOperation` when the schema compiles; a document is made in a generated field alone. A query's text is read within `textQueryMaxBytes`, 262,143 bytes, by its type or by a byte guard whose branch the read stands in, `Logic.when(Num.within(Text.octetLength(q), 0, 4096), () => …, otherwise)`, since PostgreSQL refuses a query whose lexemes pass 1,048,575 bytes and a read never fails on a value; any other text is `UnsupportedOperation` when the query compiles.

### Hybrid search

```ts
import { Num, Type } from "@bjornpagen/grizzle"

/** The twenty units of a subject up to a grade nearest a query's embedding. */
export const nearUnits = query(Course)
	.rule((r) => {
		const { id, subject, grade, embedding } = v(Unit, "unit")
		return r
			.match(Unit, { id, subject, grade, embedding })
			.where(
				r.and([
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				])
			)
			.find({
				unit: id,
				distance: Distance.cosine(embedding, r.param("vector", Unit.fields.embedding))
			})
	})
	.approximateNearest({ by: "distance", take: 20 })

/** Each unit of either search with its place there: the count of its units at or before it, ties by unit. */
export const unitPlaces = query(Course)
	.rule((r) => {
		const near = nearUnits.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			vector: r.param("vector", Unit.fields.embedding)
		})
		const x = v(near, "x")
		const y = v(near, "y")
		return r
			.match(near, { unit: x.unit, distance: x.distance })
			.match(near, { unit: y.unit, distance: y.distance })
			.where(
				r.or([
					r.lt(y.distance, x.distance),
					r.and([r.eq(y.distance, x.distance), r.le(y.unit, x.unit)])
				])
			)
			.find({ arm: "nearest", unit: x.unit, place: r.count() })
	})
	.rule((r) => {
		const text = searchUnits.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			q: r.param("q", SearchText)
		})
		const x = v(text, "x")
		const y = v(text, "y")
		return r
			.match(text, { unit: x.unit, rank: x.rank })
			.match(text, { unit: y.unit, rank: y.rank })
			.where(r.or([r.gt(y.rank, x.rank), r.and([r.eq(y.rank, x.rank), r.le(y.unit, x.unit)])]))
			.find({ arm: "text", unit: x.unit, place: r.count() })
	})

/** The ten units both searches rank best together: reciprocal rank fusion, Σ 1 / (60 + place). */
export const hybridUnits = query(Course)
	.rule((r) => {
		const places = unitPlaces.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			vector: r.param("vector", Unit.fields.embedding),
			q: r.param("q", SearchText)
		})
		const { arm, unit, place } = v(places, "place")
		return r.match(places, { arm, unit, place }).find({
			unit,
			score: r.sum(
				Num.div(
					Type.literal(float8, 1),
					Type.cast(Num.add(place, 60n), float8)
				)
			)
		})
	})
	.orderBy(["score", "desc"])
	.take(10)
```

A hybrid search is one query: an approximate search and a full text search under one route's filters, each bounded, fused by reciprocal rank (Cormack, Clarke and Büttcher, 2009), each unit's score Σ 1 / (k + place) over the searches that hold it. A unit's place in a search is the count of the search's rows at or before it, nearest or best first, ties broken by its key, 1 for the first. `unitPlaces` states that order in its `where`, since an approximate search answers its candidates as a set, each with its distance, and a record of reads delivers them by key. The score is a double, each reciprocal and the sum rounded once ([Differences from SQL](#differences-from-sql)), and k is yours, a literal of the query, here the method's authors' 60. `hybridUnits` delivers `{ unit, score }`, best first, ties by `unit`, in one statement, which runs each search once however many matches read it. A record of reads holds it as it holds any query, its parameters `subject`, `grade`, `vector` and `q` under its name.

A nearest read is approximate by its index. Its statement reads the searched relation as one ordered stream, `SELECT ... ORDER BY <vector> <=> <query vector> LIMIT current_setting('hnsw.max_scan_tuples')`, a subquery PostgreSQL neither pulls up nor filters into, and a filter beside the search, a range such as `grade`'s among them, the rule's other matches and its negations read that stream above it until the search's bound is filled: every candidate holds every filter, met in exact distance order. Under `hnsw.iterative_scan = strict_order`, which grizzle pins, PostgreSQL's scan of the HNSW index goes on past the rows the filters refuse until the bound is filled, or until `hnsw.max_scan_tuples`, which grizzle pins at pgvector's own 20,000 and the stream reads where it runs, or the owner's `hnsw.scan_mem_multiplier` stops it; a row the scan meets after it returned a farther one is dropped to keep the order, as pgvector 0.8.7's strict order does. So a search underfills only where those bounds stop it or strict order dropped what would have filled it, and which rows it returns is HNSW's approximation, never proved the exact nearest. No statistic of a filter decides the read: PostgreSQL drives the stream from the HNSW index once the relation holds more rows than the index scan costs over a sorted read of all, from about 50,000 rows of eight dimensions on PostgreSQL 19, and reads a smaller relation whole and sorted, its candidates then exactly the nearest. A full text search reads its relation alike, the match the stream's own condition (`WHERE <document> @@ <query> OFFSET 0`), its rows what the GIN index finds, and the filters beside it above them; neither asks an index of the relation for its filters.

### A recursive rule joins `self`

The recursion compiles to `WITH RECURSIVE … UNION`, and its result is a set, so a cycle in `BillsThrough` ends the walk instead of looping forever. A recursive rule reads `self` positively, never under a negation, an aggregate or a take, so the fixed point is well defined: aggregate the finished set, as `treeSpend` does. The edges' rules hold for every writer: both ends of an edge are accounts, and a second parent for one account is `refused` on `BillsThrough`'s primary key, `child`.

A recursive rule joins `self` to stored relations, and to queries of one rule over them, each at the row it extends, which an index reads. A rule may read a recursion where the recursion keeps within one unit ([Rules over queries](schema.md#rules-over-queries)). It reads no other recursion and no union of rules, at any depth of what it matches or negates: PostgreSQL computes a recursion once as a relation with no index, and deduplicates a union before any join reaches it, so a step that read either would read all of it for every row it extends. Both are refused when the query compiles (`RecursionRefused`, cause `recursiveStep` or `unionStep`): carry the other recursion's state as columns of this walk, and match each rule of the union in a recursive rule of its own. A base rule, and a recursive rule that reads no `self`, which joins the base, read either: they run once.

## Reading

A Db runs its login's served workload and nothing else: every call is a member, `db.workload.<name>`, compiled by `grizzle generate` and loaded when the layer was built. A member's input is one record, the same in process and over HTTP: `{ params, facts }`, both always present, `{}` where the program takes none, and a paged member's `{ params, facts, window }`. Every read runs in one SERIALIZABLE READ ONLY transaction, so a query's nested results and a window's rows see one snapshot.

- **Answered reads.** A read member is live, or `answered(read)`, of a query, an ordered query, a `paged(...)` one or a key: answered at its call's instant alone and never live. Its handle holds `once`, `explain` and `explainAnalyze`, and no `watch`, which is a type error; over HTTP its answer is `reset`, its upserts, `ready`, then `end`, and its OpenAPI operation's `ready` says in `x-stream` that `end` follows it, so a CLI generated from the document offers no `--follow` for it. Its workload plans no footprint for it, so its served file records it `answered` and the installation's live source decodes nothing for it. A login whose reads are all answered, beside its writes, serves no live read: `DbLayer.make` of it requires no `LiveSource`, in its type and at run time, so it serves from a process that holds no replication session, a serverless function's among them. A `clocked(...)` read is an answered one with its clock ([The database's clock](#the-databases-clock)); a member `deferrable(answered(read))` is both.

### `once(input)`

`once(input)` answers the member's value: its rows as a `KeyedList`, in its order: an ordered query's `orderBy`, ties broken by its key, and a query's that states none its key's, ascending field by field in the order of the declared key it copies. Each row's key is the fields of that order, and an upsert of `watch` places its row after the row whose key it carries. A key member's value holds the one row at its key, or none. Every failure is one `CallError`.

- **`watch(input)`** is a `Stream` of the member's events: `reset`, then an `upsert` of each row as PostgreSQL delivers it, then `ready` once the read's transaction has committed, then, live, an `upsert` or a `remove` of each row whose change alters the answer. An upsert before `ready` is provisional: an `error` before it voids the rows it delivered. `once` is `watch` folded until `ready`.
- **Windows.** A member `paged(orderedQuery)` reads a window: `window: { anchor, size }`, its anchor `{ kind: "start" }`, `{ kind: "after", key }`, `{ kind: "end" }`, `{ kind: "before", key }` or `{ kind: "at", position }`. A key is a row's `RowKey`, the values of the query's completed order, which the row's entry in a value carries. A position is the count of rows of that order before the window, 0 for its first row, any safe integer of at least 0: page `n` of size `m`, counting pages from 1, is `window: { anchor: { kind: "at", position: (n - 1) * m }, size: m }`. A window is one statement of at most `size` rows, and a window that holds no rows is past the end. A size is any safe integer of at least 1, with no default and no largest.

### A key or a position

A keyset window seeks past its key in the order, through the index the order is read by, so it costs its size's rows wherever it lies. A positioned window is PostgreSQL's own `OFFSET` over the same order: its statement reads and discards every row before its position, so its cost grows with its position, and the window at position 1,000,000 reads a million rows to deliver its own. The order is total, so a position names exactly one window of one snapshot, but each call is its own snapshot: a row written or deleted before a position between two calls moves every row after it, so pages read by position across calls can repeat a row or skip one. A positioned window's entries carry their keys as every window's do, so `{ kind: "after", key }` at its last entry continues it by keyset. Keyset anchors are the scalable and stable way through an order, and position anchors exist for an API whose callers name pages by number.

- **`explain(input)`** returns PostgreSQL's plan of each statement the member sends for that input, in the order it sends them, as data: one `{ statement, plan }` per statement, `statement` the name it is prepared under on every session (`grizzle_…`, as `pg_prepared_statements` and `pg_stat_statements` show it). Each is planned by `EXPLAIN (FORMAT JSON, VERBOSE)` over the statement's served text with the call's values, which runs nothing, in one transaction of the Db's role that is rolled back, so explaining a ChangeSet member writes nothing: its session stands the write up first, as its apply's does (a session's first call of a write makes its rule tables once), and each statement that fills a carrier runs, unplanned, before the statements after it are planned, so a ChangeSet member's plans are those of every statement it sends but its carriers' fills. The plan is the one PostgreSQL makes for those values, which a session uses for a statement's first executions; a session that has run it many times may switch to a generic plan. A plan node holds its node type, its estimated startup and total cost, rows and width, its children, and `on`, what it reads, named by the login's served file and never parsed back from PostgreSQL's names: `{ kind: "relation", relation }` for a table, a stored derived relation's among them, read whole or written; `{ kind: "index", relation, index: { name } }` for one read through an index; and `{ kind: "none" }` for a join, a sort or any node that reads no relation, the ChangeSet's own carriers among them, whose rows are arrays its transaction's settings hold. A key member takes its key's values as its params, and a paged member explains its window's statement. A plan that reads a table or index the served file does not name is refused as unreadable. A served file names each index alone, so no running process loads what an index is: `indexesOf(snapshot)`, from `@bjornpagen/grizzle/compile`, takes the JSON value of the snapshot.json the file was generated beside and returns a `Result` of a map that holds, under each relation and then each index name, `{ columns, reasons }`. `columns` are the index's key columns in key order, each `{ kind: "field", field }`, a field of the relation by its declared name, or `{ kind: "law", holds, laws }`, a column a law adds, by the field whose values it holds and the laws it is added for, and each with its `direction`, `"asc"` or `"desc"` in a B-tree and `"none"` in an index that orders nothing; so a test holds a plan's index to "leads with `document`, then `start`" in field names. `reasons` are why the installation holds it: each law it serves by its identity, the `id` a refusal names that law by; the workload's access; or a derived relation's key.
- **`explainAnalyze(input)`**, on a read member, runs its statement under `EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE)` in the read's own transaction, rolled back, and returns each node's actual time to its first and last row, rows and loops, and the shared buffers it hit and read, beside its estimates, with the statement's planning and execution times. A ChangeSet member has none.

```text
yield* db.workload.postPage.explain({ params: { org, slug }, facts: {} })   // abridged
[{ statement: "grizzle_…", plan: { node: "Nested Loop", on: { kind: "none" }, rows: 1, …, children: [
  { node: "Index Scan", on: { kind: "index", relation: "Post", index: { name: "__post_pk_dyy23qj6j2" } }, … },
  { node: "Index Scan", on: { kind: "index", relation: "Comment", index: { name: "__comment_pk_…" } }, … }] } }]
(yield* Effect.fromResult(indexesOf(snapshot))).get("Post")?.get("__post_pk_dyy23qj6j2")
{ columns: [{ kind: "field", field: "org", direction: "asc" }, { kind: "field", field: "slug", direction: "asc" }],
  reasons: [{ kind: "law", law: "__post_pk_org_slug_…" }, { kind: "access" }] }
```

- **A member's calls** are exactly what its program allows: a read's `once`, `watch`, `explain` and `explainAnalyze`; an answered read's, a clocked one's among them, `once`, `explain` and `explainAnalyze`; a ChangeSet's `once`, `watch` and `explain`. A ChangeSet member with array members, facts its `insert`, `insertAll`, `delete` or `put` was given as an array, takes them as its input's `facts`: under each such member's op, `insert` (an `insertAll`'s members are inserts), `put` or `delete`, and then under its relation's name, the rows that member takes, typed and checked as its own (an owner's insert's with their families nested), as in `once({ params: {}, facts: { put: { Blob: stated }, delete: { Blob: removed } } })`. An op or relation left out, a row that is no fact of its relation and a name that is no array member's op or relation are type errors, and two array members of one op and one relation in two strata are refused where the strata meet: merge them into one. Every other member's facts are `{}`.
- **No other program runs.** A Db holds only the members its served file holds, each prepared under the name generate gave its text. A program built at run time runs once a workload names it and generate serves it, so put every program your application runs in a workload.

### A session's first call of a write stands the write up

Before a session's first call of a ChangeSet member, one
transaction of its own, framed as the call is, makes in the session, for each table the write writes that a rule over
a query reads, the rule judge's temporary tables, by the table's stand-up ([Rules over queries](schema.md#rules-over-queries)).
The session remembers what it stood up, so each is made once a session, whichever member needs it first, and a call's
own transaction makes no relation: the plans a brand-new backend's first call makes serve its second.

- **No served statement names an object of its session.** Rows one statement of a write makes and a later one reads,
  which no later statement could make again since the statements between changed what they read (a relation
  parameter's evaluation another state reads, a member or a sub-query two statements of a stratum read, a delta side a
  read-back after the last stratum reads, a member slot two statements read), travel in the transaction's own settings:
  the statement that makes them writes each column's array by `set_config(..., true)`, and each later statement reads
  them as `ROWS FROM (unnest(current_setting(...)::text[]), ...)`, each element cast back to its type, one function scan PostgreSQL evaluates once a
  statement however often a plan rescans it, over PostgreSQL's own text of the typed array, as every parameter travels. So
  every statement's text is its program's alone and one statement in every session, one `queryid` in
  `pg_stat_statements`, planned once a session; no session creates, empties or truncates anything to run a write, and no
  role needs `TEMPORARY`. A column's array is one setting's value, so one carrier is bounded as a parameter is, by
  PostgreSQL's longest text.

### A call's planned queries are bounded

`plannedQueriesOf(login, snapshot, workloads)`, from
`@bjornpagen/grizzle/compile`, compiles `login` under `snapshot` as `compileServed` does and returns, under each role
and then each member of its workload, the most `pg_stat_statements` entries one call of the member makes, a session's
first call with its stand-ups included: `{ kind: "bounded", queries, by }`, `by` the same entries by the user each runs
as (`login`, the login's own; `role`, the role it enters; `owner`, the installation's, every function and trigger of
grizzle's) and whether it runs at the top level, as `pg_stat_statements` keys them. A test that measures a call by
`pg_stat_statements` (track `all`, track_planning on), resetting it before the call, sets `pg_stat_statements.max` to
its largest member's bound and loses no entry. The bound counts every statement the call sends, by the user it runs as,
and every query PostgreSQL plans behind them, which `snapshot.json` records of the installation (`derived.planned`):
each SPI query and expression of every PL/pgSQL body the call reaches, a trigger's for the event that fires it (the
rule judge's captures, its parts, the upkeeps of stored relations, the stand-ups and the closures they make), a row
function's, the queries of each foreign key's NO ACTION check and ON UPDATE CASCADE of a referenced row the call
removes or re-keys, and a PERIOD key's check of a row it writes (a plain key's probes its index and plans none), and
one RAISE's options, since the first RAISE a call meets ends it. Two queries PostgreSQL jumbles into one query id are counted once where their identities say so: a literal's value
is no part of one, a relation read by its alias alone is none of its name. It is an upper bound: it counts every branch
a call may take, a refusal's, a judge's TRUNCATE of a delta past the pages its emptying keeps and the forms a single
statement's batched executions may send among them. A member whose call reaches a declared function, whose body
grizzle never reads, has no bound (`{ kind: "declared", functions }`).

### The database's clock

A lease, a timer or a due instant judged by the caller's clock is judged differently by two hosts whose clocks disagree. `clocked(program, binding)` serves a query, an ordered query or a ChangeSet with each parameter its binding names bound to the database's clock: the instant the call's transaction began, `transaction_timestamp()`, counted since the Unix epoch and floored, in `"micros"`, PostgreSQL's own resolution, or `"millis"`, JavaScript's and Effect's. The program is unchanged: it declares the parameter, a `bigint`, `natural` or a consumer's contract over one, and a test serves the same program unclocked with a `now` of its own. A contract's reading is a value of it the clock makes, so the member takes the contract's key after its binding, by the parameter's name: `clocked(ranBefore, { now: "millis" }, { now: millisKey })`. A reading lies in PostgreSQL's timestamptz range, 4714-11-24 BC to 294277-01-01, in its unit, beside its declared type's bounds, and the scalar typing reads that range: a due instant `Type.cast(Num.add(Type.base(now), Type.base(delay)), Due, dueKey)`, its `delay` a contract whose predicate bounds it, `contract<typeof delayKey>()("Delay", int8, (d) => Logic.and([Logic.ge(d, 0n), Logic.le(d, 10n ** 12n)]))`, casts with no guard wherever the reading's range plus the delay's bounds fit `Due`: in millis, whose range ends near 9.2 × 10^15, it fits a bigint; in micros, whose range reaches past bigint's top, it asks a guard.

```ts
/** The calls that ran at or before the database's instant. */
export const ranBefore = query(Usage).rule((r) => {
	const { id, at } = v(Call, "call")
	return r
		.match(Call, { id, at })
		.where(r.le(at, r.param("now", Millis)))
		.find({ id, at })
})

export const UsageClock = workload(Usage, {
	ranBefore: clocked(ranBefore, { now: "millis" }, { now: millisKey })
})
```

`db.workload.ranBefore.once({ params: {}, facts: {} })` takes no `now`: the database reads it.

- **One reading per call.** Every statement, row and flight of a call reads the same instant, so a row a write stamps and the read-back that judges it agree. The reading is no later than any snapshot the call takes, so every call that committed before it is visible to the call's reads: a read of what is due at or before the reading misses nothing committed before it.
- **A reading is an observation, not an order.** Calls that do not overlap read non-decreasing instants, unless the server's wall clock steps back, as an NTP step or a failover to another host can. Overlapping calls read in neither their commit order nor the serial order their isolation proves, so a stamp is no cursor over what is visible: a read at an instant can miss a row stamped before it that commits after the read's snapshot. Keys fence a write; the clock decides only when work is due.
- **Never live.** Time passing is no change, so a clocked read is an answered one ([Reading](#reading)) with its clock: answered at its call's instant alone, its handle holds `once`, `explain` and `explainAnalyze`, and no `watch`, and over HTTP its answer is `reset`, its upserts, `ready`, then `end`. It needs no live source. To wake at an instant, watch a read of the due instants that reads no clock, and read the clocked one when an instant passes. A clocked ChangeSet is a ChangeSet member like any other, whose `watch` is its outcome, then the end.
- **The reading is the parameter's value.** It stands wherever the parameter does, cast to the parameter's type, so a contract judges it as it judges a caller's value, `refused` on the contract. The member's input holds the program's other parameters alone. A law, a check, a contract, a generated field, a derived relation and a role's entry read no parameter, so none reads the clock: a law judged against the clock would turn false with no write. PostgreSQL accepts `now()` in a table's or a domain's CHECK and judges it only at write; grizzle emits none.
- **What a binding binds.** A binding names at least one parameter of the program whose values are `bigint`s, `bigint`, `natural` or one consumer's contract over either, each with its unit; any other name is a type error, a contract over another consumer's contract among them, whose values one key would not make, a take's or a page's bound is refused, and a paged member and a key are never clocked. A micros reading past the year 294,247 on the server's clock is out of bigint's range, and refuses the call.
- **A host row's deadline is computed from the reading.** An insert's computed fields (`insertAllComputed`,
  [Writes](#writes)) read the reading as any parameter, so the rows a caller states, an owner's with its members nested among them, take a lease's
  end or a due instant from the call's own clock in the statement that writes them, never from the host's.
- **A reading is a value, never an instant.** Its parameter is a `bigint`, `natural` or a contract over one, never `instant`, which no parameter is: a deadline, a lease's end or a due instant is a reading and some arithmetic, while when a row was written is the insert's to stamp, ordered within its scope as no reading is ([Instants](#instants)).
- **A test states the clock; it never sleeps.** `compileServedMoved(login, snapshot, workloads)` (`@bjornpagen/grizzle/compile`) compiles a login's served file as `compileServed` does, but every clocked read and every ChangeSet of it declares the clock's instant and reads every instant of the database's clock as it, its clocked parameters' and its inserts' stamps alike: the Unix epoch plus the instant's microseconds as an interval, exact to the microsecond, PostgreSQL refusing an instant its timestamptz cannot hold. Serve that file with its login's `DbLayer` and open its roles with `Db.openMoved(role, options, instant)`: each call of a clocked read or a ChangeSet reads `instant`, an `Effect<bigint>` of microseconds since the Unix epoch (a millisecond is `1000n`; an instant stamps nothing before 1970, never below zero), once, and every statement of the call reads exactly that instant, whatever the database's own clock reads, so a stamp is the instant the test stated. A suite on Effect's `TestClock` passes `Effect.map(Clock.currentTimeMillis, (at) => BigInt(at) * 1000n)`, so a lease lapses when its clock travels past it; one that wants the database's own time moved reads that instant once and states it moved. A production file, whose programs declare no instant, is no moved Db's, and a moved file is no production Db's: a call that states no instant is refused as its parameters. `grizzle generate` never compiles a moved file, and the files it writes are the same with or without this facility.

### Time zones

A lesson's window, a store's opening hours or a report's local day reads an instant on a zone's wall clock. grizzle
reads it the way the database does: by PostgreSQL's tzdata, the server's own, with no zone, date or interval type of its
own, and the calendar is integer arithmetic over two numbers.

- **`Time.wall(t, zone)`** is the zone's wall clock at the instant `t`, both in milliseconds: `t` since the Unix epoch,
  the wall clock since the local epoch, 1970-01-01 00:00 on the zone's clock, a `bigint`. `t` is a `bigint` term, a millis
  reading of the database's clock among them (`clocked(program, { now: "millis" })`), never an `instant`, which counts
  microseconds: a stored instant's milliseconds are `Type.cast(Num.div(Type.base(at), 1000n), int8)`. It is defined
  where `t` lies in PostgreSQL's timestamptz range, 4714-11-24 BC to 294277-01-01, which a reading's bounds prove and a
  contract's or `Num.within`'s prove of any other term; anywhere else it is `PartialOperation` naming the guard. It is
  exact over that whole range, before 1970, at a zone's local mean time and at every daylight change: the instant plus the
  zone's offset at it, as `timezone(zone, t)` reads it, every function it calls IMMUTABLE.
- **`zone` is a closed id of a zone roster**, `closed.zones(name, zones)`, whose handles are time zones' IANA names, each
  in its Area/Location form (`"America/Chicago"`, `"Asia/Kolkata"`, `"Etc/UTC"`), in any order, its order meaning nothing,
  as an unordered roster's. A closed id of any other roster is a type error. The roster's code reaches the zone as its
  handle, read from its names constant, so no zone's name ever comes from a caller: a field, a parameter or a literal of
  the roster's closed id is a zone the schema declared.
- **A name of one component is refused** where the roster is built, `MalformedDescription`: `UTC`, `GMT`, `UCT`,
  `Zulu`, `EST`, `MST`, `HST`, `CET`, `EET`, `MET`, `WET`, `EST5EDT`, `CST6CDT`, `MST7MDT`, `PST8PDT`, `GB`, `NZ`,
  `Cuba` and tzdata's other backward names. PostgreSQL's `timezone(text, ...)` reads a name as a time zone abbreviation
  first, from the `timezone_abbreviations` setting and the session's `TimeZone`, then as a POSIX zone, and only then as a
  zone of its tzdata, so the first eleven name a fixed offset a session's settings choose and the four POSIX names a
  rule of their own, not the zone file their name is: no wall clock over them is a function of the zone alone. Each has
  an Area/Location twin (`Etc/UTC`, `America/New_York`, `Europe/London`). No abbreviation or POSIX zone holds a `/`.
- **The migration checks each zone on the server.** The migration that installs a zone roster, or changes its handles,
  reads each one as a time zone first in Setup, `timezone('<zone>', ...)`, so a handle the server's tzdata lacks refuses
  the migration with PostgreSQL's 22023 before anything changes, and no read of `Time.wall` ever raises. A production
  server ships its own tzdata (RDS updates it in its minor versions), and this is where it is held to the schema.
- **A query reads it, nothing else.** The host holds no tzdata: Node's ICU is its own version of tzdata (Node 26.13.1's
  is 2025c, PostgreSQL 19.0's bundled one 2026f, and they disagree in 26 zones), and no host could be pinned to a
  production server's. So a check, a contract predicate and a generated field, which the host evaluates, refuse
  `Time.wall`, as they refuse a declared function's call, and a row's evaluation never states a wall clock.
- **`Time.epochDay(date)`** is a date's days after 1970-01-01, negative before it, an integer, `x - '1970-01-01'::date`,
  and **`Time.dateOfEpochDay(n)`** the date `n` days after it, an `integer` or a `bigint` term, an exact integer cast into
  one first, `'1970-01-01'::date + n`, defined where `n` is the epoch day of a date grizzle holds, 0001-01-01 to
  9999-12-31, which its bounds prove or a `Num.within` guard. The host computes both, so they stand in a query, a check
  and a generated field alike.
- **The calendar is integer arithmetic.** A wall clock's milliseconds into its local day are `((w mod 86400000) +
  86400000) mod 86400000`, `Num.mod` keeping the dividend's sign as SQL's `%` does, and its local day `(w - intoDay) /
  86400000`, a division that is exact: so a wall clock before the local epoch lies in its own day, never the next. A local
  day's weekday is `((day + 4) mod 7 + 7) mod 7`, Sunday 0, 1970-01-01 a Thursday, and its date `Time.dateOfEpochDay`. A
  local wall clock's instant is a guess, the wall clock read as an instant, `g`, less the zone's offset at it, `g - (wall(g)
  - g)`: in a daylight gap the wall clock names no instant and this is the instant at the offset before the gap; in an
  overlap it names two and this is the one of the offset the guess reads.
- **A tzdata change moves a wall clock.** PostgreSQL declares `timezone(text, timestamptz)` IMMUTABLE, but the server's
  tzdata is updated in place: a read after an update reads the new rules. grizzle stores no wall clock, so nothing it
  holds goes stale.

```ts
/** Each branch's zone and the minute of its local day it opens at. */
export const BranchZone = closed.zones("BranchZone", [
	"America/Chicago",
	"America/New_York",
	"Asia/Kolkata"
])
export const Branch = relation(
	"Branch",
	{ id: int4, zone: closedId(BranchZone), opens: int4 },
	["id"]
)
export const Branches = schema("Branches", [BranchZone, Branch], [])

/** Each branch's minute of its local day and weekday at the database's instant. */
export const branchClock = query(Branches).rule((r) => {
	const { id, zone, opens } = v(Branch, "branch")
	const wall = Time.wall(r.param("now", Millis), zone)
	const intoDay = Num.mod(Num.add(Num.mod(wall, 86_400_000n), 86_400_000n), 86_400_000n)
	const day = Num.div(Num.sub(wall, intoDay), 86_400_000n)
	return r.match(Branch, { id, zone, opens }).find({
		id,
		minute: Num.div(intoDay, 60_000n),
		weekday: Num.mod(Num.add(Num.mod(Num.add(day, 4n), 7n), 7n), 7n)
	})
})

export const BranchesClock = workload(Branches, {
	branchClock: clocked(branchClock, { now: "millis" }, { now: millisKey })
})
```

## Writes

A write is a ChangeSet: rows to insert, delete and put, applied as one transaction.

```text
ChangeSet.empty(Blog)               a write over a schema, or over a role: ChangeSet.empty(MemberBlog)
  .insert(Post, rows)               add these rows; a row already present is no change, which delta.met returns
  .insertAll({ Post: rows })        an insert of each relation the record names by its key
  .insertAllComputed({ Lease: rows }, { until })   each relation's rows leaving out the fields the call computes, once
  .delete(Comment, rows)            remove these rows
  .deleteWhere({ Comment: { post: param("post", Slug) } })     remove the rows whose fields equal these values
  .put(PostViews, rows)             after the change, the row at each key is the one given
  .read("name", (delta) => query)   a query over the result, delivered in the outcome
  .bind({ org, sittings: mine })    the parameters it names, ahead of apply: a value, rows, or a query of a relation
                                    parameter's rows, read once before this ChangeSet's first stratum; the rest stay
                                    the program's
```

- **Rows** are an array, an Effect `Stream` or a query, in any number; each column travels as one array. A query reads
  the state before its stratum, in the same transaction. There are no interactive transactions: a write that depends
  on a read states the read as its query.
- **A relation parameter bound to a query is an input of the call**, not a member's query, and it is scoped to the
  ChangeSet it was bound on, as a let is to its body: `.bind({ sittings: mine })` gives it one value, `mine` evaluated
  once in the state before the first stratum of that ChangeSet, and every member of every stratum and every read-back
  of it that reads `sittings` reads that one evaluation. A bind on the whole call's ChangeSet is evaluated before the
  call's first stratum: metis's assignment, `ChangeSet.sequence(held, assigned).read(…).bind({ target: picked })`,
  reads back the items `picked` chose before the call, never a pick made again over the state after it. A bind on a
  part sequenced after another is evaluated after the earlier part's writes, as that part's own members read them:
  edullm's take, `ChangeSet.sequence(decide, ChangeSet.union(take, grants).bind({ taken: mine }))`, takes the sittings
  `mine` holds once `decide` has written its decision. ChangeSet.union keeps each part's binding where it was. Contrast
  a member's own query, which reads the state before *its* stratum, and a read-back's, which reads the tables after the
  change: a bound parameter reads the state before its part, and no stratum or read-back reads it again. Where every
  reader reads a state that agrees with that one on every relation the parameter's query reads, through derived
  definitions and a role's entries (no stratum between writes one), its query is a part of theirs, as an import's is:
  metis's assign binds its target test to a read of the catalog, which no stratum of the assign writes, so each
  statement reads the catalog itself, keyed by the call's test; otherwise it is filled into a carrier first among that
  stratum's statements, every reader reading the carrier. The two realize one meaning, as a
  CTE inlined or held does one query; a read-back over such a parameter reads no table the change writes, so it rides
  the statement making the delta it reads, unless that statement comes before the part that bound it, where its rows
  are not yet read: then it runs after the change, over its delta carried there (below, "Where a read-back runs").
- **`insertAll`**'s rows at each key are what `insert` takes for that relation, typed and checked as that insert and
  refused at their key. Its keys are required, and their order means nothing. `insertableNamesOf(schema)` names, in the
  schema's order, every table a ChangeSet over it inserts at the top level: all that `writableNamesOf` names but an
  ordered family's members, which are nested under their owner; a counted family's members and a tree's table are
  among them. `InsertableNameOf<S>` is their type, and `InsertAllRowsOf<S>` is the record `insertAll` takes over all
  of them, each table's rows an array of its `AdditionIn<S, R>`, so `ChangeSet.empty(Credits).insertAll(rows)` with
  `rows: InsertAllRowsOf<typeof Credits>` writes grants and debits at once.
- **`deleteWhere`** removes, of each table the record names by its key, the rows whose named fields equal the given
  values, each a parameter, `param(name, descriptor)`, or a literal of the field's type: `DELETE FROM t WHERE post = $1`,
  and the conjunction for several fields; `{}` removes every row. It is the delete of the query that matches the table's
  rows and keeps those, so it plans, refuses and certifies as that delete does: a tree's selection names its root
  fields and removes whole trees, an owner's removes every row nested under it, and a family's member, whose delete is
  its family's edit, is a type error. A field names only the rows the table's delete states (`Written<R>`, or a tree's
  root), and a value is a parameter or a literal, never a variable, a typed constant or a scalar term, so a delete
  that reads another table or compares otherwise is a query's. Its keys are required, and their order means nothing.
  `ChangeSet.empty(S).deleteWhere({ Node: { package }, Entry: { package } }).insertAll(rows)` replaces a package.
- **A row holds the fields its caller writes**, `Written<R>` ([How a field is written](schema.md#how-a-field-is-written)). A
  family's member is a row of its own, nested under its owner only in a sequence ([Families](schema.md#families)), and written
  from an array or a `Stream`, never from a query or through a query entry, since grizzle draws its family's values
  from its rows on the host. Its owner may be written through a query entry
  ([Writing through a role](access.md#writing-through-a-role)).

### A relation's rows are a set

Identical rows are one row. Two rows one stratum adds to one relation that share a
key and differ elsewhere are `refused` on that key before any SQL is sent, or, at a key over a generated
field, by the statement that writes them. Two rows it deletes at one key are no refusal: a deletion names its row
exactly, so at most one of them is stored, and deleting the other changes nothing. At the primary key, an array literal of up to 1,024 such rows with literal values is a
type error. A row one stratum both adds and deletes stays; one it both inserts and puts is the put's. Laws are
judged only once every row and parameter of the application encodes: a row or a parameter that does not, a missing
parameter among them, is its `EncodingFailure`, whatever key the other rows share or generated field they leave
without a value.

- **A row states its whole fact.** grizzle mints no ids and PostgreSQL draws none: every field a caller writes is in
  every row, its key among them, and a row that leaves one out is an `EncodingFailure`
  ([Identity: natural keys](schema.md#identity-natural-keys)). An instant is no caller's: an insert's row leaves it out and the
  database stamps it ([Instants](#instants)).
- **`insertAllComputed`** inserts host rows that leave fields for the call to compute: `insertAllComputed(rows,
  computed)` takes insertAll's record, under each relation's name an array or a Stream of its rows, and a record of
  fields, at least one, to terms over the call's parameters, its clock reading and literals, each a caller-written
  field of every relation the record names, written at its field's own type as a query member's head is, a relation
  that lacks one refused at its key: `ChangeSet.empty(Den).insertAllComputed({ Claim: [] }, { until:
  Type.cast(Num.add(Type.base(param("now", DenInstant)), Type.base(param("budget", Budget))), DenInstant,
  denInstantKey) })`, served `clocked(…, { now: "millis" }, { now: denInstantKey })`, whose rows `{ step, holds: [{ resource }] }` leave `until` out (the row type omits
  every computed field), and edullm's pantry inserts every relation of a package computing `package` from its one
  parameter. The call evaluates the record once for each relation, one value of each field for every row of it the
  stratum's host rows insert, in the statement that writes them: a plain insert's own, or a nested insert's family statement, where every member field
  filled from a computed field of its owner, by its group or by its copy along the owner axis, holds its owner's one
  value, at any depth, never a value of its own; a generated field over one is PostgreSQL's, and a fold or a copy that
  reads one on the host is refused as `UnfillableField` (`stamped`). A computed field is part of the fact the call states, so a stored row at its key that differs there is refused
  on the key. Every row of a call holds the call's one value of a computed key field, so two of its rows that share the
  key's other fields and differ elsewhere are two facts of one key, refused before any SQL is sent, and a put of the
  relation in the same stratum meets the call's rows at that key in the database, as a stored row does. A stratum computes one record for each relation; a query member's head computes its own fields
  instead, and an insert through a query entry states every field.
- **A put at a no-overlap key** holds its row over every point of its span, as a put at a scalar key holds its row at
  its key: it displaces each stored row that agrees with it on the key's other fields and shares a point of its span,
  which the key would refuse beside it, every such row, one or several, and inserts its own. A row equal to it stays,
  so an identical put is no change. A window extended to a later end is a put of the whole new window, which displaces
  the window it grows from ([A window a put extends](#a-window-a-put-extends)).
- **`read`** runs its query after the change, before COMMIT. `delta.added(T)` and `delta.removed(T)` are the rows the
  change added and removed, and `delta.met(T)` the stored rows its insertions met ([Rows an insertion
  met](#rows-an-insertion-met)). A ChangeSet's read-backs are one set by name, each run once after the whole change,
  so a name read again, by `read`, `ChangeSet.union` or `ChangeSet.sequence`, over the same query is the same
  read-back: two programs that each end in `.read("standing", () => standing)` compose into one that reads it once.
  One name over another query is refused: by the types where its rows are of another type, and by the builder
  (`MalformedDescription`, naming both read-backs) where only the query differs.

### Where a read-back runs

The rows a statement returns exist only inside it. Each side of a delta a read-back
reads is made whole by one statement, the only one that makes that side of the table, whose rows no statement of
another stratum nets. Where one statement makes every side the read-back reads, no statement at or after it writes a
table the read-back reads, and every relation parameter it reads is bound before it, the read-back runs inside that
statement, over its rows. Otherwise it runs after the change, in the state the whole write leaves: each side it reads
is carried there out of the statement making it, which fills a session table with its rows as it makes them, so the
read-back reads the write's own delta, keyed as the write made it, joined to every table as the write leaves it, and
never searches the state for it again. edullm's answer reads back the attempt it recorded, `delta.added(Attempt)`,
with the grade a later stratum writes and the status derived from both. A stratum runs the writes of tables whose
deltas a read-back reads after its others where its foreign keys allow, so the read-back rides with no session table.
A delta of a table no statement writes is empty, and a read-back that reads no other runs after the change. A
read-back of a side no one statement makes whole is refused when the ChangeSet compiles
(`ReadBackCrossesStatements`, naming the side): a side two statements make, or one another statement nets (one table
written in two strata; a delete and an insert of one table in one stratum each make their side whole, since a row
one stratum both adds and deletes stays): write the table in one action of one stratum, or read it back by its key.

- **Strata.** Every write in a stratum reads the state before it, so build order means nothing, and a stratum's
  members of one operation on one table are one write of their union, whatever ChangeSets they came from, but for an
  insert's host rows that leave computed fields out or own counted families, and queries that state different
  instants, each a write of its own.
  `ChangeSet.union(a, b)` merges two ChangeSets stratum by stratum; `ChangeSet.sequence(a, b)` runs `b`'s strata after
  `a`'s. Either is one transaction, over the higher of the two schemas.
- **Statement order.** A stratum's writes, its families' members and owner counts included, run in the order its
  immediate foreign keys require: a referenced row is added before the rows that name it and removed after them, so a
  family's members are deleted before their owner. Writes those keys order in a cycle are refused when the ChangeSet
  compiles (`UnorderableStratum`): move one to another stratum with `ChangeSet.sequence`.
- **A ChangeSet member's `once`** answers `accepted`, with `counts` (each written relation's `added`, `deleted` and
  `put`, as `bigint`s) and `reads`, or
  `unchanged`, with `reads`; a write the laws refuse, or one that writes outside
  its role's world, fails with its `CallError`, `refused` or `outsideWorld`
  ([Errors and outcomes](errors-and-concurrency.md#errors-and-outcomes)). Its `watch` is that outcome, then the end.

Two writes over the blog, each one transaction and one round trip:

```ts
/** Publish a draft: the new row is read from the old one, in the same transaction. */
export const publish = ChangeSet.empty(Blog).put(
	Post,
	query(Blog).rule((r) => {
		const { org, slug, author, title, body } = v(Post, "post")
		return r
			.match(Post, { org, slug, author, title, body, status: "Draft" })
			.where(r.eq(org, r.param("org", ClerkOrg)), r.eq(slug, r.param("slug", Slug)))
			.find({ org, slug, author, title, body, status: Status.handle("Published") })
	})
)

/** Delete every comment by one author, and read back how many went. */
export const purge = ChangeSet.empty(Blog)
	.delete(
		Comment,
		query(Blog).rule((r) => {
			const { org, post, author, at, body } = v(Comment, "comment")
			return r
				.match(Comment, { org, post, author, at, body })
				.where(r.eq(author, r.param("author", ClerkUser)))
				.find({ org, post, author, at, body })
		})
	)
	.read("removed", (delta) =>
		query(Blog).rule((r) => {
			const { org, post, author, at } = v(delta.removed(Comment), "removedComment")
			return r
				.match(delta.removed(Comment), { org, post, author, at })
				.find({ comments: r.count() })
		})
	)
```

`publish` takes `{ org: string; slug: string }`; applied twice, the second answers `unchanged`, since the query finds
no draft to put.
`purge` takes `{ author: string }`, and its `accepted` outcome carries `reads.removed`, a
`ReadonlyArray<{ comments: bigint }>`: `RETURNING`, as a query over what the change removed.

### A window a put extends

A learner's presence in a sitting is one row per stretch of readings no more than 3 s apart, each from its first
reading to its last plus one microsecond, a span's end being excluded, so a window of one reading is
`[now, now + 1 µs)` and its credited time, `upper − lower − 1 µs`, is its last reading less its first exactly. One put
records a reading: its row is the window over the reading and every window of the sitting within 3 s of it, from the
earliest start to the latest end, which displaces each window it grows from.

```ts
const learnerIdKey = Symbol("LearnerId")
const stageKeyKey = Symbol("StageKey")
const momentKey = Symbol("Moment")
const readingKey = Symbol("Reading")
const LearnerId = contract<typeof learnerIdKey>()("LearnerId", int4)
const StageKey = contract<typeof stageKeyKey>()("StageKey", int8)
/**
 * Microseconds on the database's clock, a window's ends, up to 10000-01-01, after which no day a date holds begins; a
 * reading is one below the top, so it ends a window too.
 */
const Moment = contract<typeof momentKey>()("Moment", int8, (t) =>
	Num.within(t, 0n, 253_402_300_800_000_000n)
)
const Reading = contract<typeof readingKey>()("Reading", int8, (t) =>
	Num.within(t, 0n, 253_402_300_800_000_000n - 1n)
)

export const Presence = relation(
	"Presence",
	{ child: LearnerId, stage: StageKey, during: span(Moment) },
	["child", "stage", "during"]
)
export const Attendance = schema(
	"Attendance",
	[Presence],
	[unit("Learner", { child: LearnerId }), mutable(Presence)]
)

/** The reading [now, now + 1 µs) and every window of the sitting within 3 s of it, each by its ends. */
const near = query(Attendance)
	.rule((r) =>
		r.find({
			child: r.param("child", LearnerId),
			stage: r.param("stage", StageKey),
			start: Type.cast(Type.base(r.param("now", Reading)), Moment, momentKey),
			end: Type.cast(Num.add(Type.base(r.param("now", Reading)), 1n), Moment, momentKey)
		})
	)
	.rule((r) => {
		const { child, stage, during } = v(Presence, "window")
		const now = Type.base(r.param("now", Reading))
		return r
			.match(Presence, { child, stage, during })
			.where(
				r.eq(child, r.param("child", LearnerId)),
				r.eq(stage, r.param("stage", StageKey)),
				Logic.gt(Num.add(Type.base(Range.upper(during, Moment)), 3_000_000n), now),
				Logic.lt(Type.base(Range.lower(during, Moment)), Num.add(now, 3_000_001n))
			)
			.find({ child, stage, start: Range.lower(during, Moment), end: Range.upper(during, Moment) })
	})

/** One window over them all: the earliest start to the latest end. */
const hull = query(Attendance).rule((r) => {
	const { child, stage, start, end } = v(near, "near")
	const bound = near.bind({
		child: r.param("child", LearnerId),
		stage: r.param("stage", StageKey),
		now: r.param("now", Reading)
	})
	return r
		.match(bound, { child, stage, start, end })
		.find({ child, stage, start: r.min(start), end: r.max(end) })
})

export const beacon = ChangeSet.empty(Attendance).put(
	Presence,
	query(Attendance).rule((r) => {
		const { child, stage, start, end } = v(hull, "hull")
		const bound = hull.bind({
			child: r.param("child", LearnerId),
			stage: r.param("stage", StageKey),
			now: r.param("now", Reading)
		})
		return r
			.match(bound, { child, stage, start, end })
			.find({ child, stage, during: r.span(start, end) })
	})
)
```

`Presence` is `mutable` in its learner's unit, the one exception to insert-only rows, and the beacon is served
`clocked(beacon, { now: "micros" }, { now: readingKey })`: its reading is `Reading`'s, one below `Moment`'s top, so `now + 1` casts into
`Moment` unguarded. A reading within 3 s of the sitting's latest window extends it, and any other opens a new one. A
call reads the clock as its transaction begins, so a slower call may read an instant before the latest window began:
its reading falls inside the windows it lies within 3 s of, or joins them, so no reading is lost and no two windows
overlap, whatever order the calls commit in, and the windows are the 3 s stretches of the readings committed.

### Rows an insertion met

`delta.met(T)` holds each stored row of `T` an insertion of the ChangeSet met at its arbiter key and did not refuse:
the row as stored, every field of it. Without it, an insertion that repeats a stored row learns nothing about that row
in the same call. The arbiter key is the primary key. A row equal at every
field the insertion states is an exact repeat: no change, and met. One that differs at a field it states is `refused`
on the key, as always, and the ChangeSet commits nothing. A put meets nothing: an equal row at its key is its own no
change.

So a call that may lose a race to another learns the row that won, in the same round trip:

```ts
/** File a post at its slug, or meet the one filed there: either way, read back the post its key holds. */
export const filePost = ChangeSet.empty(Blog)
	.insert(Post, [])
	.read("post", (delta) =>
		query(Blog)
			.rule((r) => {
				const { org, slug, title } = v(delta.added(Post), "added")
				return r.match(delta.added(Post), { org, slug, title }).find({ org, slug, title })
			})
			.rule((r) => {
				const { org, slug, title } = v(delta.met(Post), "met")
				return r.match(delta.met(Post), { org, slug, title }).find({ org, slug, title })
			})
	)
```

Exactly one rule finds each post the call states. At READ COMMITTED the later of two racing calls waits at the key
for the earlier, then reads the row it committed, even though that commit came after its own statement began, and
never fails with 40001. The row is fixed from its commit on, since a READ COMMITTED role writes only relations no role
updates or deletes. At SERIALIZABLE the met row is read again under the transaction's snapshot, so SSI sees it as a
read, and a met row the snapshot cannot see fails the call with 40001, a TransientFailure, as before. A role that
inserts through a query entry runs at SERIALIZABLE, since its precheck reads every row at each key the call states:
the precheck refuses a row outside the entry at such a key on the key's law, and a row committed after the
transaction's snapshot fails the call with 40001, whose retry's precheck refuses an outside row on the key's law.

`delta.met` of a relation whose primary key holds a span is refused when the ChangeSet compiles: its exclusion
constraint arbitrates only by `ON CONFLICT DO NOTHING`, so no statement can tell a row it met from one it made. A
family's members are a type error, since their family statement writes them. A read-back over `delta.met(T)` rides
the one statement that inserts into `T`.

### Instants

`instant` is when a row was written, on the database's clock: microseconds since the Unix epoch, written by the
database alone. A row is keyed by its natural identity ([Identity: natural keys](schema.md#identity-natural-keys)), and by an
instant after it where when it was written is part of its fact. No caller states one, so a time a row records is never
a host's clock or a value a caller passes. Every instant field is a clock or a reference, as the schema's laws make it:

- A **reference** is an instant field a containment carries, from every row of its relation, into another relation's
  instant field: its values are stored instants there, which the containment proves. Below, `Visit.at` is a
  reference to `SignIn.at`.
- Every other instant field is a **clock**. It stands in its relation's primary key after at least one field, and the
  key's fields before it are its **child**: `SignIn`'s key `(user, at)` makes `user` the child of `SignIn.at`. A clock
  outside its primary key is refused when the schema compiles (`InstantRefused`, `clockOutsideKey`), since no child
  would order it, and so is one first in its key (`childless`), whose relation would be one child every write of it
  waits on.
- Every clock is ordered in a **scope**, the writes one lock serializes: the [unit](schema.md#units) its relation sits under,
  every clock of every relation of the unit alike, or, for a clock no unit holds, its own child. A scope's key is the
  unit's heading or the child, and each value of it has one **head**, the last instant ever stamped in the scope there.
  `SignIn` below sits in no unit, so its scope is its child, `user`; under `unit("User", { user: UserId })`, every clock
  of a relation keyed `(user, …)` would stamp from `User`'s one head at each user.

```ts
/** A user's sign-in at an instant, and the visit it opened, at the same instant. */
const SignIn = relation("SignIn", { user: UserId, at: instant, method: closedId(Method) }, [
	"user",
	"at"
])
const Visit = relation("Visit", { token: Token, user: UserId, at: instant }, ["token"])
export const Auth = schema(
	"Auth",
	[Method, SignIn, Visit],
	[contained(on(Visit, "user", "at"), on(SignIn, "user", "at"))]
)

/** A sign-in and its visit in one write that reads no row: both at the call's instant for the user. */
export const signIn = ChangeSet.empty(Auth)
	.insert(
		SignIn,
		query(Auth).rule((r) =>
			r.find({ user: r.param("user", UserId), method: r.param("method", SignIn.fields.method) })
		)
	)
	.insert(
		Visit,
		query(Auth).rule((r) =>
			r.find({ token: r.param("token", Token), user: r.param("user", UserId) })
		)
	)
```

- **An insert leaves an instant out to have it stamped.** A row of an array, a Stream or a query that omits an
  instant field has it stamped with the call's instant of its clock: a clock's own, at the row's child, or a
  reference's clock, at the child its containment carries the row to, `Visit.user` above. A stamp's child is a
  field the row states, never one the same insert stamps (`childStamped`). A clock is only ever stamped: a row that
  states one is refused (`clockStated`). A reference is stamped only beside an insert of its clock
  in the same stratum, else refused (`clockUnstamped`), since no stored row could hold the instant; and a reference
  whose containments reach no one clock at one child is never stamped (`unstampable`).
- **Or states a stored instant.** A query's row may state a reference by a term of type `instant`, and only a stored
  instant is one: a variable of an instant field, or `r.min`, `r.max`, `Logic.least`, `Logic.greatest` or
  `Logic.cond` over such terms. No parameter, relation parameter's column, literal, `Type.literal`, cast, contract
  or span is of type `instant`, so each is a type error and a `CompileError`, and arithmetic over an instant is a
  `bigint`. An instant meets only instants; `Type.base(at)` reads one as the `bigint` it is. A put and a delete state
  every instant of their rows this way, from a query, and a put of a relation with a clock is refused, since it would
  state the clock.
- **One instant per scope key per call.** Every row a call stamps at one key of one scope holds one instant, whichever
  clock and child of the scope it is a row of, so rows of one child in one call that share the rest of a key need a
  field of their own in it, a place or a name, or they meet at the key. A call stamps a clock in one statement: its
  stratum's, which holds its every insert and those of the references it stamps, a table's inserts one write of all
  their sources, however many queries, arrays and Streams state them. A ChangeSet that would stamp it in two strata, or
  in a stratum of several statements, such as one that inserts a table beside a put or a delete of it, whose removals
  run first, is refused when it compiles (`stampedApart`); a later stratum reads the stamped rows back as stored
  instants. Two clocks of one scope may stamp in two strata or two statements of one call: each stamps rows of its own
  relation, and both take the call's one instant.
- **A stamped row is new.** Its instant is above every instant its scope held at its key, so an insertion that stamps a
  clock meets no stored row at the primary key: `delta.met` holds none of its rows ([Rows an insertion
  met](#rows-an-insertion-met)), and a call retried after `commitUnknown` adds them again, at a later instant.
- **The stamp.** The call's instant at a key is `greatest(c, h + 1)`: `c` the call's reading of the database's clock in
  microseconds, `transaction_timestamp()`, and `h` the key's head, the last instant ever stamped in the scope there.
  Each scope keeps its keys' heads in a table of its own, one row a key, which no role reads or writes: a unit's in the
  installation's root schema, a clock's own beside its relation. The statement that stamps calls the scope's stamp
  function, which advances each key's row by one `INSERT ... ON CONFLICT DO UPDATE` and returns it. A ChangeSet that
  stamps has a READ COMMITTED form, so its role runs at the level the rest of its workload earns ([READ COMMITTED
  writes](errors-and-concurrency.md#read-committed-writes)).

**Why it is the scope's order.** For one key of one scope, at every level:

- **Two calls that stamp the key take turns, and instant order is commit order, across every clock of the scope.** The
  stamp function's upsert either inserts the key's head row or locks the row it meets and assigns from its latest
  committed version, whatever the calling statement's snapshot holds, and keeps that lock until the call ends
  (PostgreSQL's ON CONFLICT DO UPDATE). So a call that stamps the key while another holds its head waits for that call
  to end, then stamps at least one past its instant, and commits after it, whichever clocks the two stamp. A call that
  began before another committed reads an earlier clock, and `h + 1` carries it past the other's instant. At
  SERIALIZABLE, a call whose snapshot cannot see the head's latest version, one a call that committed since wrote, is
  refused with 40001, a retryable `transient`, and its retry stamps after it. So a law that compares two clocks of one
  unit at one key, an end with the snapshots before it, reads every row of the one stored before the other's insertion
  at an instant at most the other's: a scope's instants are commit-ordered across the clocks it holds.
- **A unit's head adds no wait.** Every write of a unit's relations holds the unit's borrow exclusively at its key from
  before its first statement ([Units](schema.md#units)), so no other call of that key could meet its head's lock: the unit's
  writes already take turns.
- **No writer states a clock out of order.** The head records the transaction that stamped each key last, and every
  relation of a clock holds a guard: each row a statement inserts, and each row an UPDATE moves to another instant or
  key, must hold its transaction's own stamp of the clock at its scope's key, else the statement is refused with 23514
  under `__clocked` (an insert, at the statement's end) or `__clock_moved` (a move, at COMMIT). A served write meets it
  by construction; a direct writer, the owner and a migration's data step alike, calls the scope's stamp function first
  and states the instant it returns, one instant a key a transaction, so a history of several instants at a key is
  written one transaction an instant, in order. The insert guard probes the head once for each distinct key and
  instant of its statement's rows: a served statement, whose rows of one call share their instant at a key, probes it
  once a key, the row its own stamp just wrote, and never scans it.
- **Calls that stamp different keys never wait on each other.** Each key's head is its own row, so no lock of one key's
  stamp is another's: the key is the shard key, and keys shard freely. A call that stamps several keys of one scope
  takes their heads in key order, so two such calls never wait on each other in a cycle. Two calls that each stamp two
  heads, scopes or places, at keys the other stamps too may: a ChangeSet that stamps one of them before the other, in
  an earlier stratum or an earlier part of one statement, beside one that stamps them the other way round. PostgreSQL
  then fails one of them with 40P01, a retryable `transient`.
- **A clock that steps back reorders nothing.** An NTP step or a failover to a host whose clock is behind gives a
  smaller `c`, and `h + 1` wins: the key's instants count up by one a write until the clock passes them again. An
  instant is never earlier than its call's reading.
- **A call that rolls back stamps nothing**: its head's advance rolls back with it.
- **No occupant of the call's microsecond is met.** A stamped row's instant is above every instant ever stamped in its
  scope at its key, so an insertion that stamps a clock meets no stored row at the primary key.
- **What a key holds.** A write may delete a row its head counted; a later stamp is still above it, since the head
  keeps the last instant stamped, not the greatest one held.
- **A clock a migration adds to stored rows** takes the migration's instant on every one, its transaction's reading
  of the database's clock, under a DEFAULT the backfill then drops, with no placeholder: re-keying `VerifiedEmail` from
  `(user)` to `(user, at)` gives each stored row the one instant, and every later insert stamps above it. A migration
  that creates a scope's head table beside stored rows, for a clock it adds, a child it re-keys, a unit it declares or
  a type it changes, fills it with each key's greatest stored instant across the scope's clocks, and one whose clock
  joins a scope over stored rows, a relation re-keyed into the unit or a clock added to one of its relations, makes the
  head again and fills it so, so every later stamp is above every row it finds. That keeps the rows apart exactly when
  the new primary key holds the old one beside the clock; a clock added under a key that does not, `(user, email)` to
  `(user, at)`, is refused when generate drafts it (`InstantRefused`, `addedOverRows`, naming both keys): keep the old
  key's fields, or re-key in a migration of its own.

**An instant stored as it is.** A read delivers an instant as an `Instant`, a `bigint` under the brand grizzle's read of
one alone mints, so a host holds an instant only where a read delivered it. `instant.stored` is a field of instant's
type its caller writes, a copy of an instant read elsewhere, which the database draws nothing of: its writing is its
caller's, where `instant`'s is the database's clock, two writings of one type. A host row states it as an `Instant` it
read, and a bare `bigint`, a host's own clock or arithmetic, is a type error; a query's row states it by a term of type
`instant`, as it states a reference. It is no clock and no reference, so it may stand anywhere in its relation, its
primary key included, and a put and a delete of host rows state it as an insert does. Its terms meet every instant's,
and it is still no parameter, literal, cast, contract or span. A relation that keeps a read's rows, an audit's or a
workflow's record of what it read, is keyed by what identifies the read, never by its instants alone.

```ts
/** What a read of sign-ins delivered, kept as it was read: its instants stored as they are. */
const SeenSignIn = relation("SeenSignIn", { user: UserId, at: instant.stored }, ["user", "at"])
```

### Places

`place` is a row's place in its group, a natural the database stamps when an insert adds the row: one past the greatest
place the group holds, 0 for its first. It stands last in its relation's primary key, and the key's fields before it are
its **group**: `relation("Claim", { step, attempt: place, holds: drawn(natural) }, ["step", "attempt"])` numbers each
step's claims 0, 1, 2, … in the order their calls commit, so a group's places are gapless from 0 with no law to state it
and no count for a write to read.

- **Declared once.** A place first in its key (`groupless`), before another field of it (`notLast`) or outside it
  (`outsideKey`) is refused when the schema compiles (`PlaceRefused`).
- **Stamped by its insert.** An insert's rows leave the place out, as they leave out every field grizzle writes: a row
  that states one is refused as its heading's mismatch. Every row a call stamps in one group holds one place, so a
  call adds one row a group. A place is stamped as a clock is, in one statement of one stratum (`stampedApart`), never
  at a group the same insert stamps (`groupStamped`), from its group's head row ([Instants](#instants)): two calls
  that stamp one group take turns at its head, at every level, so no two commit one place, and a call that rolls back
  leaves no gap.
- **Its members carry it.** An owner whose place a nested insert stamps hands it to its members: each member's group
  field paired with the place carries the one place its owner's row takes, at any depth, and no member states it. The
  owner and every member are written by one family statement, which stamps the place once at each group, every row that
  carries it joining that one stamp, so the place is read from its group's head once per group and never again; a
  read-back of the owner's `delta.added` rides that statement, so the call reads back the place it was stamped:
  `ChangeSet.empty(S).insert(Claim, []).read("held", (delta) => ...)` over rows `{ step, holds: [{ resource }] }`. The
  host fills every other column of the rows, a member's slot, its copies of its owner's fields and its owner's folds
  over it, and none the statement stamps: a member's generated field over its carried place is PostgreSQL's alone, and
  a fold's step or selection, or a copy, that reads the place or such a field is refused where the write compiles
  (`UnfillableField`, `stamped`). Two owners of one call in one group would take one place, so they meet at the owner's
  primary key, which the host holds at the group, and the call is refused there before any statement.
- **Written by inserts, and deleted by whole groups.** A put would state a place, so none writes a relation with a
  place (`written`). A delete removes whole groups, and leaves every group gapless: every field its rows state is a field
  of the group, as `deleteWhere({ Claim: { root } })` states only `root` of a group `(root, step)`, so each group it
  reaches goes whole, a family owner's members with it, and its statement deletes each removed group's head with it,
  so an insert into the group again stamps 0; a delete whose rows state any other field, a row of a group rather than
  the group, is refused (`written`). A role that deletes from a place's relation holds SELECT and DELETE on the place's
  head table for it, and no other privilege on a head's table: no more than its DELETE on the relation lets it do.
- **Its order is the migration's.** A place's declaration says nothing a write reads beyond the place itself; it states
  only how a migration that adds the place to a table holding rows numbers them. `place` states no order: a relation
  created with it numbers nothing, and a migration that adds it to stored rows gives every one place 0, which keeps them
  apart at the new primary key exactly when it holds the old one, re-keying `(child, item)` to `(child, item, n)`; where
  it does not, so a group would hold two stored rows, the draft is refused (`addedOverRows`, naming both keys).
  `place.by(field)` numbers them: each group's stored rows from 0 in `field`'s order, `row_number() OVER (PARTITION BY
  <group> ORDER BY <field>) - 1`, in its backfill ([Migrations](operations.md#migrations)), with no placeholder, which a key of the
  relation within the group and the field makes total (`byUnkeyed`, which names the key the group and the field would
  be; `byUnknown`, `byItself`): `relation("ItemSession", { child, package, item, n: place.by("stage"), stage }, ["child",
  "package", "item", "n"])` beside `key(on(ItemSession, "child", "package", "item", "stage"))`. The inserts after a
  migration stamp on from each group's greatest. A child keyed by the parent's old key and re-keyed by its place,
  `Attempt` from `(child, stage, package, item, at)` to `(child, package, item, n, at)` beside a containment into
  `ItemSession`'s `(child, package, item, n)`, takes each row's `n` from the session its old containment named: a column
  a migration adds to stored rows that a containment carries is drawn from the row the previous installation's
  containment over the same table named, every other pair of the two containments alike, and is the reviewer's
  placeholder only where there is none.
