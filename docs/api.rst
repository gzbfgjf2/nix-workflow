API Reference
=============

Nix library
-----------

Import the library in your workflow file:

.. code-block:: nix

   let
     nw-src = builtins.fetchTarball
       "https://github.com/gzbfgjf2/nix-workflow/archive/main.tar.gz";
     nw    = import nw-src;
     lib   = nw.lib;
   in
   rec { ... }

``output``
~~~~~~~~~~

Define a task that runs a command and stores its output content-addressed.

.. code-block:: nix

   # String form — most common
   result = output ''
     ${some_bin}/bin/train --data=${dataset}/data.csv --epochs=10
   '';

   # Attrset form — use when pinning a known output hash
   result = output {
     cmd  = ''${some_bin}/bin/train --data=${dataset}/data.csv --epochs=10'';
     hash = "0abc123...";  # optional: skip execution, use store entry directly
   };

**Arguments (string form):** a Nix multiline string containing the command.

**Arguments (attrset form):**

``cmd`` *(required)*
    The command string, same as the string form.

``hash`` *(optional)*
    Content hash of a known output. If provided, nix-workflow skips execution
    and uses ``/nix-workflow/store/{hash}`` directly. The store entry is
    re-hashed on each use to verify integrity. Raises an error if the store
    entry does not exist or its content does not match the declared hash.
    Use ``nw hash <path>`` to compute the hash of an existing path.

**Returns:** an attrset with ``__toString`` returning a placeholder path.
Use it via string interpolation in downstream tasks:
``${result}/output.json``.

The task runs inside a staging directory (``$out``). Write all outputs there.
A persistent state directory is available at ``$state``.

**Environment variables available to the task:**

``out``
    Staging directory. Write all task outputs here.

``state``
    Persistent state directory across runs (same task identity = same path).

``static``
~~~~~~~~~~

Register a pre-existing file or directory in the content store without
running a command.

.. code-block:: nix

   my_data = static {
     path = "/absolute/path/to/data";  # optional if already in store
     hash = "0abc123...";              # nw hash <path>
     info = { description = "..."; };  # optional metadata
   };

**Arguments:**

``hash`` *(required)*
    Content hash of the file or directory. Compute with ``nw hash <path>``.

``path`` *(optional)*
    Absolute path to the source. Required on first use; can be omitted if
    the hash is already in the store.

``info`` *(optional)*
    Arbitrary attrset of metadata (description, source URL, etc.).

**Returns:** an attrset with ``__toString`` returning
``/nix-workflow/store/{hash}``. Use via string interpolation:
``${my_data}/data.csv``.

On first run, nix-workflow verifies the source against the declared hash and
copies it into the store. If the hashes do not match, it raises an error.

CLI
---

``nw run``
~~~~~~~~~~

Evaluate a workflow file and run all tasks whose outputs are not already
cached.

.. code-block:: sh

   nw run <path>

Tasks are executed in dependency order. Outputs are symlinked into
``./nix-workflow-output/`` in the current directory.

``nw gc``
~~~~~~~~~

Remove GC roots for specific tasks and run ``nix-store --gc``.

.. code-block:: sh

   nw gc <path> <attr> [<attr> ...]

``<attr>`` is the Nix variable name of the task to collect. Stale database
entries whose resolved recipe paths no longer exist are also cleaned up.

``nw prune``
~~~~~~~~~~~~

Remove everything not referenced by a given set of workflow files.

.. code-block:: sh

   nw prune <path> [<path> ...]

Removes GC roots, database entries, and content store entries for any task
not present in the listed files. Useful for cleaning up experiments that are
no longer needed.

``nw hash``
~~~~~~~~~~~

Print the nix32 content hash of a file or directory. The hash is computed
using the same algorithm used internally for content-addressed storage, so the
output can be pasted directly into a ``hash`` field in your workflow file.

.. code-block:: sh

   nw hash <path>

**Example workflow for pinning a task output:**

.. code-block:: sh

   nw run experiment.nix          # run once, output lands in /nix-workflow/store/abc123.../
   nw hash /nix-workflow/store/abc123.../   # prints: abc123...

Then in your nix file:

.. code-block:: nix

   model = output {
     cmd  = ''train --data=${dataset}'';
     hash = "abc123...";   # pinned — execution skipped, integrity verified on each run
   };

``nw clean``
~~~~~~~~~~~~

Remove all nix-workflow state: GC roots, staging directories, state
directories, content store, and database.

.. code-block:: sh

   nw clean

**Flags:**

``--debug``
    Enable debug logging (nix commands, recipe contents, dependency graph).
