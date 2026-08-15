# shore CLI surface

Generated from `client/target/debug/shore` at commit `75fdf40f` plus the
uncommitted usage/completions work. 39 addressable surfaces.

`--json` exists on every surface except `send`, `regen`, `completions`,
`complete`, and the five bare `debug` triggers.

## Global flags

Valid in **any** position, at any depth — clap `global = true`.

| flag | env | notes |
| --- | --- | --- |
| `-c, --character <NAME>` | `SHORE_CHARACTER` | unknown name silently falls back to the default character |
| `--addr <HOST:PORT>` | `SHORE_ADDR` | overrides discovery |
| `--config <PATH>` | — | selects which daemon instance |
| `--no-color` | `NO_COLOR` | |

All four of these parse identically:

```
shore --addr X usage breakdown call-type
shore usage --addr X breakdown call-type
shore usage breakdown --addr X call-type
shore usage breakdown call-type --addr X
```

`-V, --version` is top level only. `-h, --help` works at every level and is
per-command, not global.

## Commands

### send / regen / alt

- [ ] `shore send [MESSAGE]...`
  - `-i, --image <IMAGES>` (repeatable), `--temperature <F>`, `--top-p <F>`,
    `--thinking [<BUDGET>]` (optional value), `--system`
  - reads stdin when it is not a TTY
- [ ] `shore regen`
  - `-g, --guidance <TEXT>`
- [ ] `shore alt [SELECTOR]` — `list|prev|next|last|first|<N>`
  - `--ref <MSG_REF>` (defaults to latest assistant), `--json`

### log / edit / delete

- [x] `shore log [MSG_REF]` — viewer only, no subcommands
  - `-n, --turns <COUNT>` (default 64), `--role <user|assistant|system|character>`,
    `-f, --follow`, `--json`, `--content`, `--plain`, `--reasoning`, `--tools`,
    `--subagent-tools`
  - `--plain`, `--content` and `--json` are three separate renderers, not
    decorations on one
- [x] `shore edit <MSG_REF> [CONTENT]...` — was `shore log edit`
  - `--json`
- [x] `shore delete <MSG_REF>...` — was `shore log delete`, now takes a list
  - `--json`, which must come *before* the refs: the ref list accepts leading
    hyphens so `-1` parses, and a trailing `--json` is read as a ref

### memory

- [ ] `shore memory [QUERY]` — omit QUERY to show the index
  - `--json`
- [ ] `shore memory compact [KEEP_TURNS]` — 0 keeps none

### character / model / provider

- [ ] `shore character [NAME]` — omit to list
  - `--info`, `--new`, `--json`
- [x] `shore model [NAME]` — omit to list
  - `--info`, `--reset`, `--all`, `--json`
  - the list now opens with an `in use` block naming the model behind each of
    the six roles (chat, heartbeat, compaction, sub-agents, embedding, images)
    and where it resolved from
  - `model background` and `--background` are gone; `model background` reports
    where it went. `model setting --background <task>` is untouched
- [ ] `shore model setting [KEY] [VALUE]`
  - `--global` (write global prefs instead of the character's), `--reset`
    (clear KEY), `--background <TASK>`, `--json`
- [ ] `shore provider` — bare form lists
  - `--json`
- [ ] `shore provider models <NAME>`
  - `--all`, `--json`
- [ ] `shore provider refresh [NAME]` — omit for all discovery-enabled

### config / status

- [x] `shore config [KEY] [VALUE]`
  - `--path`, `--check`, `--reset`, `--json`, `--toml`, `-a, --all`
  - a dotted KEY that lands on a leaf now prints its value; it used to
    print "nothing configured" for every non-object
- [ ] `shore config reload`
  - `-y, --yes`, `--json`
  - two round trips, and prompts on stdin when it is a TTY
- [x] `shore config tools`
  - `--json`
  - was top-level `shore tools`. The bare word is the subcommand;
    `config tools.enabled_tools` is still a key read
- [x] `shore status`
  - `--section <SECTION>` (e.g. autonomy, tokens), `--json`
  - `--diagnostics` and its `-n, --count` are gone. The flag never showed any
    status: it sent a different daemon command and returned. What it rendered
    now lives in `shore trace errors`, minus the API-call and tool-call rings

### usage

Every surface below shares one filter set:

```
--last <today|4h|7d|30d|all>   (default today)
--provider <P>   --api-key <K>   --model <M>   --call-type <T>   --json
```

- [ ] `shore usage` — default summary
- [ ] `shore usage breakdown <DIMENSION>` — `call-type` | `kind` | `api-key`,
      three output surfaces behind one command
- [ ] `shore usage budgets`
- [ ] `shore usage anomalies`
- [ ] `shore usage export` — plus `--tsv`
- [ ] `shore usage recalculate` — plus `--all`
- [ ] `shore usage refresh-pricing`

### trace

`shore trace` bare is a usage error; it renders nothing of its own.

- [ ] `shore trace calls [ID]`
  - `-n, --count <COUNT>` (default 20), `--call-type <TYPE>`, `--diff`,
    `--against <ID>`, `--json`
  - now prints cache writes as well as reads. The number was always measured
    and stored in the ledger; the call store just dropped it on the way in
- [ ] `shore trace heartbeat` — `-n, --count` (20), `--json`
- [ ] `shore trace events` — `-n, --count` (20), `--json`
- [x] `shore trace errors` — `-n, --count` (20), `--json`
  - errors the daemon hit since start, plus provider-key fallbacks, which were
    collected but never rendered anywhere before. In memory, cleared by a restart
- [ ] `shore trace subagent [ID]` — `-n, --count` (20), `--json`

### debug

`shore debug` bare is a usage error.

- [ ] `shore debug heartbeat_tick_now`
- [ ] `shore debug heartbeat_status_dormant`
- [ ] `shore debug heartbeat_status_active`
- [ ] `shore debug keepalive_ping_now`
- [ ] `shore debug session_activate`
  - the five above take no arguments and no flags at all
- [ ] `shore debug tool <NAME> [ARGS]...` — `key=value` pairs
  - `--input <JSON>`, `--raw`, `--json`
- [ ] `shore debug subagent <NAME> <QUERY>...`
  - `--raw`, `--json`

### completions

- [ ] `shore completions <SHELL>` — `bash|elvish|fish|powershell|zsh`
- [ ] `shore complete <KIND>` — `models|characters|providers`
  - hidden internal helper, absent from `--help` and from generated
    completions. Fish's dynamic completion lines shell out to it, so it has to
    keep working.

## Known defects to fix while auditing

- `-c <unknown-name>` silently falls back to the default character.
  `shore -c nosuch status` prints the default character's status.
