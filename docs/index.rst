nix-workflow
============

A functional-oriented workflow manager that pins exact runtime environments.

Pinned environments
-------------------

Each step runs in a pinned environment, so the runtime is fully captured,
including exact versions of every tool, across any language.
No Docker or extra package managers needed.

Functional pipeline definition
------------------------------

Steps are functions of their inputs and environment. Each step is addressed by
its environment and arguments rather than ad-hoc names like
``my-task-result-lr-0.1``, so comparisons and downstream steps are more
accurate and more reproducible. Since steps are just configuration, pipelines
are declarative, easy to reason about, discover, and reuse.

Nix language ergonomics
-----------------------

Assign a step to a variable, reference it or its output files via string
interpolation, and its full lineage follows automatically:

.. code-block:: nix

   dataset = output ''
     ${build_data_bin}/bin/build-data --name=demo --samples=500 --seed=42
   '';

   model = output ''
     ${train_bin}/bin/train --data=${dataset}/data.csv --epochs=10 --lr=0.001
   '';

Here ``model`` depends on ``dataset``. ``nix-workflow`` discovers this from the
reference and builds them in the right order, caching any step whose inputs
haven't changed.

.. toctree::
   :maxdepth: 2

   getting-started
   concepts
