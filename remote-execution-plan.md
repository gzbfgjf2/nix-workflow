# Remote Execution Plan

## Overview

Add support for running tasks on a remote machine, while keeping the local
machine as the orchestrator. Only task outputs (typically small) sync back
locally. Large datasets stay on the remote.

## Design

Add an optional `machine` field to `output` and `static`:

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

## Why It Works

- The Nix runtime (`train_bin`, etc.) builds to the **same binary** on any
  x86-64 Linux machine — same store path, same dependencies, guaranteed by Nix.
- Outputs are **content-addressed by hash** — it doesn't matter where a task
  ran, the hash identifies the result. Local and remote share the same CA model.
- Large datasets only need to be uploaded **once**. After that the hash is in
  the remote store and every subsequent run skips the upload.

## What Is Not Reproducible

GPU training outputs (model weights) are **not** bit-identical across runs due
to GPU non-determinism (cuBLAS, cuDNN). This is expected. Use `hash` pinning
to freeze a good run:

```nix
model = output {
  cmd = ''train --data=${dataset}'';
  hash = "abc123...";   # pinned after a successful remote run
};
```

## Upload Cost (one-time)

| Dataset size | Hyperoptic 1Gbps upload |
|---|---|
| 27 GB | ~3.5 minutes |
| 6.5 GB | ~1 minute |

After the first upload the dataset lives in `/nix-workflow/store/{hash}` on
the remote and is never uploaded again.

## Implementation

### 1. `lib/lib.nix`

Pass `machine` through `preprocess` → `process` → recipe content, same as
`hash`. The recipe JSON will contain `"machine": "gpu-server"`.

### 2. `cli/src/nw/main.py`

- `Task` / `Static` dataclasses: add `machine: str | None = None`
- `extract_task_attrs` / `extract_static_attrs`: parse `machine` field
- `run_task`: if `node.machine` is set, SSH to remote and execute there
  instead of local subprocess
- `process_static`: if `node.machine` is set and hash not in local store,
  rsync from remote store

```python
def run_task_remote(task, path_recipe_resolved, machine):
    # 1. Ensure runtime is available on remote (nix-copy-closure or nix store sign)
    # 2. rsync resolved recipe to remote
    # 3. SSH: run the command on remote with remote env vars
    # 4. rsync output back from remote /nix-workflow/store/{hash} to local
    ...
```

### 3. Store Sync

After a remote task completes:

```
rsync -a --progress \
  remote:/nix-workflow/store/{hash} \
  /nix-workflow/store/
```

Only the output directory is synced — not the full store.

### 4. Static Upload

If a `static` has `machine` set and the hash is not yet in the remote store:

```
rsync -a --progress \
  /nix-workflow/store/{hash} \
  remote:/nix-workflow/store/
```

Skipped if already present (rsync is idempotent).

## Workflow Example

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

## Out of Scope (for now)

- Multi-machine parallelism (different tasks on different machines)
- Remote Nix store (shared NFS / S3 backend)
- Authentication / key management
