# nix-workflow Roadmap

---

## Feature 1: Selective Execution

Run a single named output and only its transitive dependencies.

```bash
nw run experiment.nix#inference
nw run experiment.nix#ckpt_1000,ckpt_5000   # multiple targets
```

Instead of running every attribute in the file, only the target(s) and the
outputs they depend on are evaluated and executed. Everything else is ignored.

### Example

```
experiment.nix defines: dataset, training, ckpt_1000, ckpt_5000, inference, fast_eval

nw run experiment.nix#inference
  → runs: dataset → training → ckpt_5000 → inference
  → skips: ckpt_1000, fast_eval
```

### Implementation

In `run_workflow`:
1. Parse the fragment (`experiment.nix#inference` → attr `inference`)
2. After `nix eval`, keep only the target attr(s)
3. Traverse `requires` edges backwards from the target(s) to collect the
   needed subgraph
4. Run only those nodes in topological order

---

## Feature 2: Checkpoints

Add `process` and `checkpoint` primitives to support long-running jobs (e.g.
multi-day training) where intermediate checkpoints need to be pinned, shared
across downstream tasks, and permanently stored independently of the process
that produced them.

### New Primitives

#### `process`

A long-running task that produces checkpoints at regular intervals. Writes
each checkpoint to `$out/{step}/`.

```nix
training = process {
  cmd = ''train --data=${dataset} --epochs=100'';
};
```

Like `output`, but:
- Does not have a single final output
- Lazy — only runs if at least one downstream `checkpoint` is a cache miss

#### `checkpoint`

References a `process` and a specific snapshot step. Has its own CA hash,
stored permanently in `/nix-workflow/store/{hash}/`.

```nix
ckpt_1000 = checkpoint { process = training; snapshot = 1000; };
ckpt_5000 = checkpoint { process = training; snapshot = 5000; hash = "abc123..."; };
```

- Depends on `process` — dependency graph is intact
- Each checkpoint is independently addressable and permanently stored
- Optional `hash` pin short-circuits execution entirely

### Example

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

### Execution Model

1. Collect all `checkpoint` nodes referencing the same `process`
2. Check CA store for each — if all present, process does not run
3. Run process once up to the max missing snapshot, passing required steps
   via env var: `NW_SNAPSHOTS=1000,5000`
4. At each snapshot step: hash `$out/{step}/`, move to CA store, record in DB
5. Checkpoints are permanent — re-running the process never deletes them

### Caching

| Scenario | Behaviour |
|---|---|
| All checkpoints in store | Process does not run |
| Some checkpoints missing | Run up to max missing snapshot only |
| Checkpoint pinned with hash | Skip entirely, no store lookup needed |

### Resumption

The CLI detects the highest stored checkpoint below the required step and
passes it as a resume path:

```
NW_RESUME=/nix-workflow/store/{hash_of_ckpt_1000}
NW_SNAPSHOTS=5000
```

A 10-day job interrupted at day 3 resumes from that checkpoint rather than
starting over.

### DB Schema

```sql
CREATE TABLE checkpoints (
  process_recipe_resolved TEXT NOT NULL,
  snapshot                INTEGER NOT NULL,
  hash_output             TEXT NOT NULL,
  PRIMARY KEY (process_recipe_resolved, snapshot)
);
```

### Implementation

1. **`lib/lib.nix`** — add `process` and `checkpoint`, parallel to `output`
2. **`cli/src/nw/main.py`** — new dataclasses `Process`, `Checkpoint`;
   group checkpoints by process in `run_workflow`; `run_process` with
   `NW_SNAPSHOTS`; hash and store each snapshot
3. **DB** — add `checkpoints` table
4. **GC** — protect checkpoint store paths referenced by any `checkpoint` node

---

## Feature 3: Remote Execution

Run tasks on a remote machine while keeping the local machine as orchestrator.
Only task outputs (typically small) sync back locally. Large datasets stay on
the remote.

### Design

Add an optional `machine` field to `output`, `static`, and `process`:

```nix
dataset = static {
  hash = "14q08ahbjh56iy0h3hf2d6fwfcw9m2j947csxgqhkryijf540g6n";
  path = "/data/my_dataset";   # only needed on the machine that has it
  machine = "gpu-server";
};

model = output {
  cmd = ''train --data=${dataset} --epochs=10'';
  machine = "gpu-server";
};
```

Tasks without `machine` run locally as today.

### Why It Works

- The Nix runtime builds to the **same binary** on any x86-64 Linux machine —
  guaranteed by Nix's content-addressed derivations.
- Outputs are **content-addressed** — it doesn't matter where a task ran, the
  hash identifies the result.
- Large datasets are uploaded **once**. After that the hash is in the remote
  store and every subsequent run skips the upload entirely.

### What Is Not Reproducible

GPU training outputs are not bit-identical across runs due to GPU
non-determinism (cuBLAS, cuDNN). Use `hash` pinning to freeze a good result:

```nix
model = output {
  cmd = ''train --data=${dataset}'';
  hash = "abc123...";   # pinned after a successful remote run
};
```

### Upload Cost (one-time, Hyperoptic 1Gbps)

| Dataset size | Upload time |
|---|---|
| 27 GB | ~3.5 minutes |
| 6.5 GB | ~1 minute |

### Workflow

```
Local                          Remote (gpu-server)
─────                          ──────────────────
nw run experiment.nix
  → build recipes (Nix)        ← same binaries via Nix
  → upload dataset (once)   →  /nix-workflow/store/{hash}
  → SSH: run training        →  produces /nix-workflow/store/{model_hash}
  ← rsync model output       ←
  → run eval locally
    using synced model
```

### Implementation

1. **`lib/lib.nix`** — pass `machine` through recipe content, same as `hash`
2. **`cli/src/nw/main.py`**
   - `Task` / `Static` / `Process`: add `machine: str | None = None`
   - `run_task`: SSH to remote and execute if `machine` is set
   - `process_static`: rsync from remote store if hash not local
   - After remote run: rsync output back to local CA store
3. **Store sync**
   ```
   rsync -a remote:/nix-workflow/store/{hash} /nix-workflow/store/
   ```

### Out of Scope (for now)

- Multi-machine parallelism
- Shared NFS / S3 store backend
- Authentication / key management

---

## Cleanup

Small improvements that don't warrant a full feature branch.

- **`cli_parser.nix`** — add support for bare long flags (`--flag` without `=value`)
- **Rename CLI** — `nw` is terse; consider a more descriptive name
- **`lib/lib.nix`** — simplify the `if hash != null then { inherit hash; } else { }` pattern in `process`/`mkRecipe`
- **`main.py` `nix_eval --apply`** — extract the inline `if w ? "__toString" then builtins.removeAttrs w [...] else w` Nix expression (line ~248) into a named helper
