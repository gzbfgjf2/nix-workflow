import json
import os
import subprocess

import pytest

from nw.main import (
    derivation_resolved_add,
    drv_info,
    extract_static_attrs,
    nix_build,
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))


def eval_static(attr_name, hash_val):
    nix_expr = f"""
    let
      pkgs = import (import {REPO_ROOT}/npins)."nixos-25.11" {{}};
      lib = import {REPO_ROOT}/lib/lib.nix {{ inherit pkgs; }};
    in rec {{
      {attr_name} = lib.static {{
        hash = "{hash_val}";
      }};
    }}
    """
    result = subprocess.run(
        [
            "nix",
            "eval",
            "--impure",
            "--expr",
            nix_expr,
            "--apply",
            'attr: builtins.mapAttrs (_: w: if w ? "__toString" then builtins.removeAttrs w ["__toString"] else w) attr',
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


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
