Concepts
========

How string interpolation works
------------------------------

Both ``output`` and ``static`` return Nix attrsets with a ``__toString``
attribute. When Nix evaluates a string interpolation like
``${my_data}/data.csv``, it calls ``__toString`` on the attrset and splices the
resulting string into the command.

- **output**: ``__toString`` returns a *placeholder* path (derived from the
  recipe derivation hash). The placeholder is not the final location — the
  Python CLI resolves it to the actual content-addressed store path at runtime
  once dependencies have been built. This indirection is necessary because the
  content hash is not known until the task runs.

- **static**: ``__toString`` returns the *final* store path
  ``/nix-workflow/store/{hash}`` directly. No placeholder or runtime resolution
  is needed because the content hash is declared upfront by the user.

Static data
-----------

Use ``static`` to register pre-existing files or directories (datasets,
configs, pre-trained models) without running a command:

.. code-block:: nix

   my_data = static {
     path = "/absolute/path/to/data";
     hash = "1b2m2y8AsgTpgAmY7PhCfg==...";  # from: nix hash path --base32 /absolute/path/to/data
     info = { description = "test dataset"; };  # optional metadata
   };

   model = output ''
     ${train_bin}/bin/train --data=${my_data}/data.csv
   '';

The ``hash`` is the content hash of the file or directory. On first run,
``nix-workflow`` verifies the source path against the declared hash and copies
it into the content store at ``/nix-workflow/store/{hash}``. Subsequent runs
skip the copy if the store entry already exists.
