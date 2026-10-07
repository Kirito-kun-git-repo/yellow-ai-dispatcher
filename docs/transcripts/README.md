# Session transcripts

This project was built across two Claude Code sessions running side by side in tmux. Both
transcripts are here, in full.

| File | Session | What happened in it |
| --- | --- | --- |
| [`0-claude-adr-session.md`](0-claude-adr-session.md) | window 0 | The design argument. A `/grilling` pass over the brief, then one decision at a time, each written out as an ADR before moving on. Produced `docs/adr/ADR-000` through `ADR-009`. |
| [`2-claude-implementation-session.md`](2-claude-implementation-session.md) | window 2 | The build. Schema, the three endpoints, mock provider, worker loop, Postman collection, this repo. |

The two ran concurrently and did not share context, which is visible in the result: window 2
had finished the worker before window 0 published ADRs 007–009, and the implementation
diverged from them on six points. Those were reconciled in favour of the ADRs before the
first commit — see the README's **How each rule was verified** table, and the ADR-006
correction it documents.

## How to read them

- `### ▶ <time> — human` is a prompt. Entries marked *(sent mid-turn)* were typed while the
  assistant was still working, which is why the timestamps interleave the way they do.
- `**claude**` blocks are the assistant's prose, in full.
- `> \`ToolName\` — summary` lines are tool calls, one line each.

## What was removed

- **Raw tool output.** Roughly 95% of the bytes and almost none of the meaning. The
  transcripts carry the reasoning and the commands, not the thousands of lines of `psql`
  and `npm` output they produced.
- **Three identifying details**, since this repo is public: the names of unrelated private
  repositories, and two absolute home paths rewritten to `~/`. Nothing about this project
  was changed.

Nothing else is edited. The wrong turns are still in here — the claim predicate hole found
by reasoning about a worker killed on its fifth attempt, the port-3000 collision that made
another service's health check look like a pass, a transcript renderer that silently dropped
half the human input, and a `sed` that renamed a field to `rate_rate_per_sec`.
