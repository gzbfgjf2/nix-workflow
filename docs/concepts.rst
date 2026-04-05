Concepts
========

Content-addressed outputs
--------------------------

Every task output is stored at ``/nix-workflow/store/{hash}`` where ``hash``
is the content hash of the output directory. Two runs that produce identical
bytes end up at the same path — there is no duplication and no naming
convention to maintain.

The hash is computed after a task finishes and the output is moved into the
store. From that point on, the path is stable and immutable. Downstream tasks
reference it by content, not by name.

Recipe derivations
------------------

For each ``output`` or ``static`` node, nix-workflow creates a *recipe
derivation* — a small Nix derivation that stores the task's canonical command
(or hash, for statics) as a JSON file in the Nix store. The store path of
this file serves as the stable identity of the task: same command + same
inputs = same path.

There are two recipe derivations per task:

- **Unresolved recipe**: produced by ``nix eval``. Contains placeholder paths
  for outputs whose content hash is not yet known.
- **Resolved recipe**: produced at runtime by ``nix derivation add``. Contains
  the actual content-addressed paths once all dependencies have been resolved.

The resolved recipe path is used as the cache key in the database.

Caching
-------

nix-workflow maintains a SQLite database at ``/nix-workflow/db/db.sqlite``
with two tables:

- ``placeholder_to_resolved``: maps unresolved recipe path → resolved recipe
  path. Tracks which resolved recipe corresponds to each task in the current
  workflow file.
- ``realisations``: maps resolved recipe path → output hash. A cache hit means
  the output is already in the store at ``/nix-workflow/store/{hash}``.

On each run, nix-workflow checks the database before executing any task. If a
resolved recipe path is already in ``realisations`` and the store entry
exists, the task is skipped entirely.

Dependency resolution
---------------------

Dependencies between tasks are expressed through Nix string interpolation.
When you write ``${dataset}/data.csv`` inside an ``output`` command,
Nix substitutes the placeholder path of ``dataset`` into the command string.
At runtime, nix-workflow scans each recipe file for known placeholder strings
and uses ``nix-store --references`` to build the dependency graph — no
explicit dependency declarations needed.

How string interpolation works
------------------------------

Both ``output`` and ``static`` return Nix attrsets with a ``__toString``
attribute. When Nix evaluates a string interpolation like
``${my_data}/data.csv``, it calls ``__toString`` on the attrset and splices
the resulting string into the command.

- **output**: ``__toString`` returns a *placeholder* path derived from the
  recipe derivation hash. The placeholder is not the final location — the CLI
  resolves it to the actual content-addressed store path at runtime once
  dependencies have been built. This indirection is necessary because the
  content hash is not known until the task runs.

- **static**: ``__toString`` returns the final store path
  ``/nix-workflow/store/{hash}`` directly. No placeholder or runtime resolution
  is needed because the content hash is declared upfront.

Variable names don't affect caching
------------------------------------

Renaming a Nix variable does not invalidate the cache. The cache key is
derived from the task's command and its dependency content hashes — not from
the variable name. You can freely rename ``pretrained_model`` to
``model_pretrained`` without triggering a retrain.

Composable workflow files
--------------------------

A workflow file is just a Nix file. It can import other Nix files, split
tasks across modules, and share definitions. A large experiment can be
organised across multiple files that are imported into a single entry point:

.. code-block:: nix

   let
     data   = import ./data.nix   { inherit output static pkgs; };
     models = import ./models.nix { inherit output data pkgs; };
     evals  = import ./evals.nix  { inherit output models pkgs; };
   in
   data // models // evals

nix-workflow sees a flat attrset of tasks and statics regardless of how the
file is structured.

Referencing an existing run output
-----------------------------------

If a task has already run — on your machine, a colleague's, or a CI server —
you can reference its output directly by hash without re-running anything.
Look up the hash from a previous run's ``nix-workflow-output/`` symlink:

.. code-block:: sh

   nix hash path --base32 $(readlink nix-workflow-output/trained_model)

Then declare it as a static in your workflow:

.. code-block:: nix

   trained_model = static {
     hash = "0abc123...";
   };

   eval = output ''
     ${evaluate_bin}/bin/evaluate --model=${trained_model}/model.json
   '';

As long as ``/nix-workflow/store/{hash}`` exists on the current machine,
``eval`` runs immediately using the cached model. No retraining, no copying
files manually. If the store entry is missing, provide ``path`` to copy it in.

Static data
-----------

Use ``static`` to register pre-existing files or directories (datasets,
configs, pre-trained models) without running a command:

.. code-block:: nix

   my_data = static {
     path = "/absolute/path/to/data";
     hash = "0abc123...";  # nix hash path --base32 /absolute/path/to/data
     info = { description = "test dataset"; };  # optional metadata
   };

   model = output ''
     ${train_bin}/bin/train --data=${my_data}/data.csv
   '';

The ``hash`` is the content hash of the file or directory. On first run,
nix-workflow verifies the source path against the declared hash and copies it
into the content store. Subsequent runs skip the copy if the store entry
already exists.

``path`` is optional. If the data is already in the store (copied by a
previous run or another machine), omit it:

.. code-block:: nix

   my_data = static {
     hash = "0abc123...";
   };

If the hash is not found in the store and no ``path`` is provided,
nix-workflow raises an error.

Pinned task outputs
-------------------

If you already know the output of a task (from a previous run or another
machine), you can pin it and skip re-execution:

.. code-block:: nix

   trained_model = output {
     cmd = ''
       ${train_bin}/bin/train --data=${dataset}/data.csv --epochs=50
     '';
     hash = "0xyz789...";
   };

nix-workflow checks that ``/nix-workflow/store/{hash}`` exists and uses it
directly. If it does not exist, it raises an error rather than silently
re-running.
