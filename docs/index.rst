nix-workflow: declare, freeze, and chain all your experiments
=============================================================

Declare
-------

In functional languages, moving and non-moving parts are separated to the
extreme. For experiments, the moving parts are parameters and runtime
configuration — the non-moving part is the versioned package source code.
Enforcing this separation means an experiment can be precisely declared and
identified as purely static, JSON-like data: its parameters and runtime
configuration, nothing else. This makes experiment setup clear, easy to
understand and reference, which in turn enables pinning (freezing) — by
definition, fixing the moving parts exactly, since we have captured all of them.

Freeze
------

Each experiment is its parameters and its runtime — both expressed as pure
data in Nix. Nix pins them together naturally.

Two layers of freezing: input-addressed, to track and reason about experiment
parameters forever; content-addressed, to reduce branching to only what is
needed — upstream changes will not cause downstream branching if the upstream
output does not change.

Chain
-----

Assign a step to a variable, reference it or its output files via string
interpolation, and its full lineage follows automatically:

.. code-block:: nix

   dataset = output ''
     ${build_data_bin}/bin/build-data --name=demo --samples=500 --seed=42
   '';

   model = output ''
     ${train_bin}/bin/train --data=${dataset}/data.csv --epochs=10 --lr=0.001
   '';

Here ``model`` depends on ``dataset``. nix-workflow discovers this from the
reference and builds them in the right order, caching any step whose inputs
haven't changed.

.. toctree::
   :maxdepth: 2

   getting-started
   concepts
   api
