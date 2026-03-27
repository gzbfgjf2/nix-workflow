import json
import os
import subprocess

import pytest

from nw.main import (
    derivation_resolved_add,
    drv_info,
    extract_static_attrs,
    extract_task_attrs,
    nix_build,
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))

APPLY = 'attr: builtins.mapAttrs (_: w: if w ? "__toString" then builtins.removeAttrs w ["__toString"] else w) attr'


def eval_nix(expr):
    result = subprocess.run(
        [
            "nix",
            "eval",
            "--impure",
            "--expr",
            expr,
            "--apply",
            APPLY,
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def eval_static(attr_name, hash_val):
    return eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      {attr_name} = lib.static {{
        hash = "{hash_val}";
      }};
    }}
    """)


@pytest.mark.integration
def test_output_without_hash():
    """output ''cmd'' produces a task with hash=null."""
    js = eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      my_task = lib.output ''/bin/train --epochs=10'';
    }}
    """)
    tasks = extract_task_attrs(js)
    assert len(tasks) == 1
    task = list(tasks.values())[0]
    assert task.hash is None


@pytest.mark.integration
def test_output_attrset_without_hash():
    """output {{ cmd }} without hash key produces a task with hash=null."""
    js = eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      my_task = lib.output {{ cmd = ''/bin/train --epochs=10''; }};
    }}
    """)
    tasks = extract_task_attrs(js)
    assert len(tasks) == 1
    task = list(tasks.values())[0]
    assert task.hash is None


@pytest.mark.integration
def test_output_with_pinned_hash():
    """output {{ cmd, hash }} pins the hash."""
    pinned = "0ijgznq5bijyz2fyxhykjqps465lc8zm0cf7rzppwcad4dbzybl7"
    js = eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      my_task = lib.output {{ cmd = ''/bin/train --epochs=10''; hash = "{pinned}"; }};
    }}
    """)
    tasks = extract_task_attrs(js)
    assert len(tasks) == 1
    task = list(tasks.values())[0]
    assert task.hash == pinned


@pytest.mark.integration
def test_output_pinned_hash_affects_drv():
    """Pinning a hash must produce a different recipe drv than the unpinned version."""
    pinned = "0ijgznq5bijyz2fyxhykjqps465lc8zm0cf7rzppwcad4dbzybl7"
    js_unpinned = eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      my_task = lib.output ''/bin/train --epochs=10'';
    }}
    """)
    js_pinned = eval_nix(f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      my_task = lib.output {{ cmd = ''/bin/train --epochs=10''; hash = "{pinned}"; }};
    }}
    """)
    tasks_unpinned = extract_task_attrs(js_unpinned)
    tasks_pinned = extract_task_attrs(js_pinned)
    t_u = list(tasks_unpinned.values())[0]
    t_p = list(tasks_pinned.values())[0]
    assert t_u.path_recipe_unresolved_drv != t_p.path_recipe_unresolved_drv


@pytest.mark.integration
def test_static_rename_produces_same_resolved_drv():
    """Renaming the Nix variable must produce the same resolved recipe drv path
    and content — cache identity must be purely based on hash, not variable name."""
    hash_val = "0ijgznq5bijyz2fyxhykjqps465lc8zm0cf7rzppwcad4dbzybl7"

    js_a = eval_static("pretrained_model", hash_val)
    js_b = eval_static("model_pretrained_model", hash_val)

    statics_a = extract_static_attrs(js_a)
    statics_b = extract_static_attrs(js_b)

    static_id = list(statics_a.keys())[0]
    assert static_id == list(statics_b.keys())[0]

    s_a = statics_a[static_id]
    s_b = statics_b[static_id]

    nix_build([s_a.path_recipe_unresolved_drv])

    info = drv_info(s_a.path_recipe_unresolved_drv)

    recipe_data_a = json.dumps({"hash": s_a.hash, "out": s_a.task_output_path})
    recipe_data_b = json.dumps({"hash": s_b.hash, "out": s_b.task_output_path})

    drv_a = derivation_resolved_add("static", recipe_data_a, {}, info)
    drv_b = derivation_resolved_add("static", recipe_data_b, {}, info)

    assert drv_a == drv_b

    # Verify content is identical
    content_a = open(drv_a).read()
    content_b = open(drv_b).read()
    assert content_a == content_b
