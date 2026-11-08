# grizzle

Describe your data, its rules and who may see it, in TypeScript. grizzle compiles it into PostgreSQL.

You declare your tables, the rules your data must always obey, what each kind of user may read and write, and the
queries and writes your app runs. grizzle turns that into constraints, roles, views, row-level security and indexes,
and into SQL compiled ahead of time, with exact result types. PostgreSQL then enforces all of it, for your app and for
anything else that connects.

## Install

You need PostgreSQL 19, Node 26 or later, and Effect 4.1.

```sh
pnpm add @bjornpagen/grizzle@beta effect pg
```

The agent guide ships in this package as `skills/grizzle/SKILL.md`.

The full guide, with every type, rule and limit, is the
[README on GitHub](https://github.com/bjornpagen/grizzle#readme).

## License

0BSD
