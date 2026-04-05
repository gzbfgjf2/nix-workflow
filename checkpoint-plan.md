# Checkpoint Plan

## Overview

Add `process` and `checkpoint` primitives to support long-running jobs (e.g.
multi-day training) where intermediate checkpoints need to be pinned, shared
across downstream tasks, and permanently stored independently of the process
that produced them.

## New Primitives

### `process`

A long-running task that produces checkpoints at regular intervals. The
process writes each checkpoint to `$out/{step}/`.

```nix
training = process {
  cmd = ''train --data=${dataset} --epochs=100'';
  # training script writes to $out/1000/, $out/2000/, etc.
};
```

Like `output`, but:
- Does not have a single final output
- Signals to the CLI that it produces snapshots at numbered steps
- Lazy — only runs if at least one downstream `checkpoint` is a cache miss

### `checkpoint`

References a `process` and a specific snapshot step. Has its own CA hash,
stored permanently in `/nix-workflow/store/{hash}/`.

```nix
ckpt_1000 = checkpoint {
  process = training;
  snapshot = 1000;
  hash = "abc123...";   # optional — pin to skip execution entirely
};

ckpt_5000 = checkpoint {
  process = training;
  snapshot = 5000;
};
```

- Depends on `process` — dependency graph is intact
- Each checkpoint is independently addressable and permanently stored
- Optional `hash` pin short-circuits execution: if the hash is in the store,
  the process does not run at all for this checkpoint

## Example

```nix
training = process {
  cmd = ''train --data=${dataset} --epochs=100'';
};

ckpt_1000 = checkpoint { process = training; snapshot = 1000; };
ckpt_5000 = checkpoint { process = training; snapshot = 5000; };

fast_eval = output {
  cmd = ''eval --model=${ckpt_1000}/model.json --data=${dataset}'';
};

inference = output {
  cmd = ''infer --model=${ckpt_5000}/model.json --data=${dataset}'';
};
```

## Execution Model

### Step 1 — Collect required checkpoints

`nw run` traverses the DAG and collects all `checkpoint` nodes that reference
the same `process`.

```
training → [ckpt_1000, ckpt_5000]
```

### Step 2 — Check CA store

For each checkpoint, check if its hash is already in `/nix-workflow/store/`.

- All hits → process does not run
- Some hits → process runs up to the max missing snapshot only
- All miss → process runs up to max snapshot (5000)

### Step 3 — Run process with required snapshots

The CLI passes the required snapshot steps to the process via environment
variable:

```
NW_SNAPSHOTS=1000,5000
```

The training script is responsible for:
1. Checking `NW_SNAPSHOTS` to know which steps to checkpoint
2. Writing checkpoint to `$out/{step}/` at each required step
3. Stopping early if the max step is reached (no need to train to 100 epochs
   if only step 5000 is needed and epoch size maps accordingly)

### Step 4 — Store each checkpoint permanently

After each snapshot step, the CLI:
1. Hashes `$out/{step}/` with `nix hash path`
2. Moves to `/nix-workflow/store/{hash}/`
3. Records in DB: `process_recipe + snapshot → hash`

Checkpoints are stored permanently — re-running the process does not delete
or overwrite existing checkpoints.

### Step 5 — Continue or stop

If the process produces a checkpoint beyond the max required snapshot, it is
simply not stored. The process can be designed to stop early by reading
`NW_SNAPSHOTS`.

## Caching

| Scenario | Behaviour |
|---|---|
| All checkpoints in store | Process does not run |
| `ckpt_1000` in store, `ckpt_5000` missing | Run from scratch (or from latest stored checkpoint) up to step 5000 |
| `ckpt_1000` pinned with hash | Skip ckpt_1000 check entirely, still run for ckpt_5000 if missing |
| Both pinned with hash | Process does not run |

## Resumption

If the training script supports resuming from a checkpoint (most do), the CLI
can detect the highest stored checkpoint below the required step and pass it
as a resume path:

```
NW_RESUME=/nix-workflow/store/{hash_of_ckpt_1000}
NW_SNAPSHOTS=5000
```

This means a 10-day training job interrupted at day 3 (step 1000) can resume
from that checkpoint rather than starting over.

## Permanent Storage

Checkpoints go to `/nix-workflow/store/{hash}/` — the same CA store as task
outputs. They are:
- Never deleted by re-runs
- Protected from GC as long as a `checkpoint` node references their hash
- Shareable across experiments that reference the same snapshot

## DB Schema

New table:

```sql
CREATE TABLE checkpoints (
  process_recipe_resolved TEXT NOT NULL,
  snapshot                INTEGER NOT NULL,
  hash_output             TEXT NOT NULL,
  PRIMARY KEY (process_recipe_resolved, snapshot)
);
```

## Implementation Plan

1. **`lib/lib.nix`** — add `process` and `checkpoint` functions, parallel to
   `output` and `static`
2. **`cli/src/nw/main.py`**
   - New dataclasses: `Process`, `Checkpoint`
   - `extract_process_attrs`, `extract_checkpoint_attrs`
   - Group checkpoints by process in `run_workflow`
   - `run_process`: run with `NW_SNAPSHOTS` env var, hash and store each snapshot
   - `process_checkpoint`: check CA store, record in DB
3. **DB** — add `checkpoints` table
4. **GC** — protect checkpoint store paths referenced by pinned hashes

## Selective Execution: `nw run experiment.nix#attr`

Run a single named output and only its transitive dependencies:

```bash
nw run experiment.nix#inference
```

Instead of running every attribute in the file, only `inference` and the
outputs it depends on (e.g. `ckpt_5000` → `training` → `dataset`) are
evaluated and executed.

### Implementation

`parse_args` already accepts a path. Extend it to accept an optional fragment:

```
nw run experiment.nix#inference
nw run experiment.nix#ckpt_1000,ckpt_5000   # multiple targets
```

In `run_workflow`:
1. Parse the fragment from the path (`experiment.nix#inference` → attr `inference`)
2. After `nix eval`, filter to only the target attr(s)
3. Build the subgraph: traverse `requires` edges backwards from the target(s)
   to collect only the needed nodes
4. Run only those nodes in topological order

Everything outside the subgraph is ignored — not built, not run.

### Example

```
experiment.nix defines: dataset, training, ckpt_1000, ckpt_5000, inference, fast_eval

nw run experiment.nix#inference
  → runs: dataset → training → ckpt_5000 → inference
  → skips: ckpt_1000, fast_eval
```

## Open Questions

- Should `process` support a `machine` field for remote execution? (see
  `remote-execution-plan.md`)
- Should the CLI support `nw snapshot <process>` to manually trigger a
  checkpoint of a running process?
- How does the training script know the step-to-epoch mapping for early
  stopping?
