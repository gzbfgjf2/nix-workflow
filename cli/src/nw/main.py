import argparse
import copy
import json
import os
import selectors
import shlex
import shutil
import sqlite3
import subprocess
import sys
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

OUTPUT = "nix-workflow-output"
NW_BASE = Path("/nix-workflow")
NW_STORE = NW_BASE / "store"
NW_STAGING = NW_BASE / "staging"
NW_STATE = NW_BASE / "state"
NW_GC_LINKS = NW_BASE / "gc-links"
DB_PATH = NW_BASE / "db" / "db.sqlite"


def init_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True, parents=True)
    db = sqlite3.connect(str(DB_PATH))
    try:
        result = db.execute("PRAGMA integrity_check").fetchone()
        if result[0] != "ok":
            raise sqlite3.DatabaseError("integrity check failed")
    except sqlite3.DatabaseError:
        db.close()
        DB_PATH.unlink(missing_ok=True)
        db = sqlite3.connect(str(DB_PATH))
    db.execute(
        """CREATE TABLE IF NOT EXISTS placeholder_to_resolved (
            path_recipe_unresolved TEXT PRIMARY KEY,
            path_recipe_resolved TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS realisations (
            path_recipe_resolved TEXT PRIMARY KEY,
            hash_output TEXT NOT NULL
        )"""
    )
    db.commit()
    return db


def drv_resolved_lookup(
    db: sqlite3.Connection, path_recipe_unresolved: str
) -> str | None:
    row = db.execute(
        "SELECT path_recipe_resolved FROM placeholder_to_resolved WHERE path_recipe_unresolved = ?",
        (path_recipe_unresolved,),
    ).fetchone()
    return row[0] if row else None


def drv_resolved_record(
    db: sqlite3.Connection,
    path_recipe_unresolved: str,
    path_recipe_resolved: str,
):
    db.execute(
        "INSERT OR REPLACE INTO placeholder_to_resolved (path_recipe_unresolved, path_recipe_resolved) VALUES (?, ?)",
        (path_recipe_unresolved, path_recipe_resolved),
    )
    db.commit()


def path_resolved_lookup(
    db: sqlite3.Connection, path_recipe_resolved: str
) -> str | None:
    row = db.execute(
        "SELECT hash_output FROM realisations WHERE path_recipe_resolved = ?",
        (path_recipe_resolved,),
    ).fetchone()
    return row[0] if row else None


def path_resolved_record(
    db: sqlite3.Connection, path_recipe_resolved: str, hash_output: str
):
    db.execute(
        "INSERT OR REPLACE INTO realisations (path_recipe_resolved, hash_output) VALUES (?, ?)",
        (path_recipe_resolved, hash_output),
    )
    db.commit()


def path_hash(path: str) -> str:
    result = subprocess.run(
        ["nix", "hash", "path", "--base32", path],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def cmd_resolve(canonical_cmd: str, rewrites: dict[str, str]) -> str:
    resolved = canonical_cmd
    for placeholder, content_path in rewrites.items():
        resolved = resolved.replace(placeholder, content_path)
    return resolved


def drv_info(drv_path: str) -> dict:
    result = subprocess.run(
        ["nix", "derivation", "show", drv_path],
        check=True,
        capture_output=True,
        text=True,
    )
    drv = json.loads(result.stdout)
    v = next(iter(drv.values()))
    input_drvs = {k: v2["outputs"] for k, v2 in v["inputDrvs"].items()}
    return {
        "system": v["system"],
        "builder": v["builder"],
        "PATH": v["env"].get("PATH", ""),
        "inputDrvs": input_drvs,
    }


def derivation_resolved_add(
    name: str,
    recipe_data: str,
    dep_resolved_recipe_drvs: dict[str, list[str]],
    info: dict,
) -> str:
    import re

    name = f"{name}-resolved"
    builder = "/bin/sh"
    args = [
        "-c",
        'printf \'%s\' "$1" > "$out"',
        "dummy",
        recipe_data,
    ]
    nix_input_drvs = {
        drv: {"dynamicOutputs": {}, "outputs": outs}
        for drv, outs in dep_resolved_recipe_drvs.items()
    }

    def try_add(out_path):
        recipe_json = {
            "name": name,
            "system": info["system"],
            "builder": builder,
            "args": args,
            "env": {"out": out_path},
            "inputDrvs": nix_input_drvs,
            "inputSrcs": [],
            "outputs": {"out": {"path": out_path}},
        }
        return subprocess.run(
            ["nix", "derivation", "add"],
            input=json.dumps(recipe_json),
            capture_output=True,
            text=True,
        )

    # First try with a dummy path — Nix masks out before hashing,
    # so the "should be" path in the error is always correct
    dummy_path = f"/nix/store/{'0' * 32}-{name}"
    result = try_add(dummy_path)
    if result.returncode == 0:
        return result.stdout.strip()

    # Parse correct path from error message
    m = re.search(r"should be '(/nix/store/[^']+)'", result.stderr)
    if not m:
        raise RuntimeError(f"nix derivation add failed: {result.stderr}")
    correct_path = m.group(1)

    # Retry with correct path
    result = try_add(correct_path)
    if result.returncode != 0:
        raise RuntimeError(f"nix derivation add retry failed: {result.stderr}")
    return result.stdout.strip()


@dataclass
class Task:
    name: str
    canonical: dict
    canonical_cmd: str
    path_recipe_unresolved_drv: str
    path_recipe_unresolved: str
    id: str
    task_output_path: str
    task_state_path: str
    dir_name: str
    nix_var_name: str
    _untracked: Any
    requires: set[str] | None = None
    required_by: set[str] | None = None


def parse_args():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="Run workflow")
    run_parser.add_argument(
        "path",
        type=str,
        help="Path to the file or directory",
    )

    gc_parser = subparsers.add_parser("gc", help="Garbage collect")
    gc_parser.add_argument("path", type=str, help="Path to the nix file")
    gc_parser.add_argument(
        "attrs", nargs="+", type=str, help="Attribute names to collect"
    )

    prune_parser = subparsers.add_parser(
        "prune", help="Remove everything not defined by the given experiments"
    )
    prune_parser.add_argument(
        "paths", nargs="+", type=str, help="Experiment nix files to keep"
    )

    subparsers.add_parser("clean", help="Remove all outputs, gc-links, and DB")

    args = parser.parse_args()
    return args


def nix_eval(path: str):
    command = [
        "nix",
        "eval",
        "-f",
        path,
        "--apply",
        'attr: builtins.mapAttrs (_: w: if w ? "__toString" then builtins.removeAttrs w ["__toString"] else w) attr',
        "--json",
    ]
    print(f"nix eval command:\n{' '.join(command)}")
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        print("Command failed!")
        print("Return code:", e.returncode)
        print("STDOUT:", e.stdout)
        print("STDERR:", e.stderr)
        raise

    eval_json_result = json.loads(result.stdout.strip())
    print(json.dumps(eval_json_result, indent=2))
    return eval_json_result


def popen_with_stderr_forward(command: list[str], env=None) -> list[bytes]:
    stdout_chunks = []
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        assert process.stdout is not None
        assert process.stderr is not None
        sel = selectors.DefaultSelector()
        sel.register(process.stdout, selectors.EVENT_READ, data="stdout")
        sel.register(process.stderr, selectors.EVENT_READ, data="stderr")

        while sel.get_map():
            for key, _ in sel.select():
                data = os.read(key.fd, 1024)
                if not data:
                    sel.unregister(key.fileobj)
                    continue
                if key.data == "stdout":
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                    stdout_chunks.append(data)
                else:
                    sys.stderr.buffer.write(data)
                    sys.stderr.buffer.flush()

        rc = process.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, command)
    except subprocess.CalledProcessError as e:
        print("Command failed!")
        print("Return code:", e.returncode)
        print("STDOUT:", e.stdout)
        print("STDERR:", e.stderr)
        raise
    return b"".join(stdout_chunks).splitlines()


def nix_build(paths: list[str]):
    command = ["nix-build", *paths, "--no-out-link"]
    print(f"command:\n{' '.join(command)}")
    stdout_lines = popen_with_stderr_forward(command)
    built_recipe_names = [
        x.decode("utf-8", "replace").strip() for x in stdout_lines
    ]
    print("nix build result", built_recipe_names)
    return built_recipe_names


def nix_build_recipes(nodes):
    print("setup..")
    print(nodes.keys())
    drvs = list(map(lambda x: x.path_recipe_unresolved_drv, nodes.values()))
    recipe_store_paths = nix_build(drvs)
    return recipe_store_paths


def setup_local_output(nodes, rewrites):
    local_folder = Path(OUTPUT)
    local_folder.mkdir(exist_ok=True, parents=True)
    for node_id, node in nodes.items():
        link = local_folder / node.nix_var_name
        target = rewrites.get(node.task_output_path, node.task_output_path)
        if link.is_symlink():
            link.unlink()
        link.symlink_to(target)
        print(f"{link} -> {target}")


@dataclass
class Static:
    name: str
    path: str | None
    hash: str
    info: Any
    task_output_path: str
    nix_var_name: str
    path_recipe_unresolved_drv: str
    path_recipe_unresolved: str
    id: str
    task_state_path: str
    dir_name: str
    requires: set[str] | None = None
    required_by: set[str] | None = None


def extract_static_attrs(js: dict) -> dict[str, Static]:
    statics = {}
    for attr, value in js.items():
        if value.get("__type__") == "static":
            s = Static(
                name=attr,
                path=value.get("path"),
                hash=value["hash"],
                info=value.get("info"),
                task_output_path=value["taskOutputPath"],
                nix_var_name=attr,
                path_recipe_unresolved_drv=value["pathRecipeUnresolvedDrv"],
                path_recipe_unresolved=value["pathRecipeUnresolved"],
                id=value["id"],
                task_state_path=value["taskStatePath"],
                dir_name=value["dirName"],
            )
            statics[value["id"]] = s
    return statics


def extract_task_attrs(js: dict):
    tasks = {}
    for attr, value in js.items():
        if "__type__" in value and value["__type__"] == "task":
            task = Task(
                name=value["name"],
                canonical=value["canonical"],
                canonical_cmd=value["canonicalCmd"],
                path_recipe_unresolved_drv=value["pathRecipeUnresolvedDrv"],
                path_recipe_unresolved=value["pathRecipeUnresolved"],
                id=value["pathRecipeUnresolved"],
                task_output_path=value["taskOutputPath"],
                task_state_path=value["taskStatePath"],
                dir_name=value["dirName"],
                _untracked=value["_untracked"],
                nix_var_name=attr,
            )
            tasks[value["id"]] = task
    return tasks


def subprocess_run(cmd) -> str:
    p = subprocess.run(cmd, check=True, text=True, capture_output=True)
    return p.stdout


def references_of(path: str) -> set:
    try:
        out = subprocess_run(["nix-store", "--query", "--references", path])
    except subprocess.CalledProcessError as e:
        print("Command failed!")
        print("Return code:", e.returncode)
        print("STDOUT:", e.stdout)
        print("STDERR:", e.stderr)
        raise

    if not out:
        return set()
    outs = out.strip().splitlines()
    return set(outs)


def build_dag(paths: list[str]):
    tasks = set(paths)
    dag: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for path in paths:
        references = references_of(path)
        dag[path]["in"] = set(
            r for r in references if r in tasks and r != path
        )
        for r in references:
            if r in tasks and r != path:
                dag[r]["out"].add(path)
    return dag


def topological_sort(dag):
    dag = copy.deepcopy(dag)

    q = deque()
    for node in dag:
        if not dag[node]["in"]:
            q.append(node)

    res = []
    while q:
        node = q.popleft()
        res.append(node)
        for next_node in dag[node]["out"]:
            dag[next_node]["in"].remove(node)
            if not dag[next_node]["in"]:
                q.append(next_node)
        del dag[node]

    assert not dag, (
        f"dag not cleared after topological sort, maybe there is a cycle, dag:\n{dag}"
    )
    return res


def add_edges(dag, tasks):
    for k, v in dag.items():
        task = tasks[k]
        required_by = sorted(v["out"])
        requires = sorted(v["in"])
        task.required_by = required_by
        task.requires = requires


def resolved_recipe_build(path_recipe_resolved_drv: str) -> str:
    stdout_lines = popen_with_stderr_forward(
        ["nix-build", path_recipe_resolved_drv, "--no-out-link"]
    )
    return stdout_lines[0].decode("utf-8", "replace").strip()


def initialise_task(path_recipe_resolved: str):
    p = Path(path_recipe_resolved)
    if p.is_file():
        recipe = json.loads(p.read_text())
    else:
        with open(p / "recipe.json", "r") as f:
            recipe = json.load(f)
    print(recipe)
    command = recipe["canonicalCmd"]
    return command


def run_task(task: Task, path_recipe_resolved: str):
    staging = NW_STAGING / task.dir_name
    staging.mkdir(exist_ok=True, parents=True)
    Path(task.task_state_path).mkdir(exist_ok=True, parents=True)
    commands = initialise_task(path_recipe_resolved)
    env = {
        **os.environ,
        "out": str(staging),
        "state": task.task_state_path,
    }
    command = shlex.split(commands)
    print(f"run {staging}")
    print("running...", command)
    result = popen_with_stderr_forward(command, env=env)
    print("task completed")
    return result


def process_static(static: Static, rewrites: dict[str, str]):
    NW_STORE.mkdir(exist_ok=True, parents=True)
    store_path = NW_STORE / static.hash
    if store_path.exists():
        print(f"static '{static.name}': already in store at {store_path}")
        rewrites[static.task_output_path] = str(store_path)
        return static.hash

    if static.path is None:
        raise FileNotFoundError(
            f"static '{static.name}': not in store and no source path provided"
        )

    source = Path(static.path)
    if not source.exists():
        raise FileNotFoundError(
            f"static '{static.name}': source path does not exist: {static.path}"
        )

    computed_hash = path_hash(static.path)
    if computed_hash != static.hash:
        raise ValueError(
            f"static '{static.name}': hash mismatch — declared {static.hash}, computed {computed_hash}"
        )

    shutil.copytree(
        str(source), str(store_path)
    ) if source.is_dir() else shutil.copy2(str(source), str(store_path))
    print(f"static '{static.name}': copied {static.path} -> {store_path}")
    rewrites[static.task_output_path] = str(store_path)
    return static.hash


def run_workflow(path):
    db = init_db()
    eval_json_result = nix_eval(path)
    statics: dict[str, Static] = extract_static_attrs(eval_json_result)
    tasks: dict[str, Task] = extract_task_attrs(eval_json_result)

    # Combine all nodes into a single dict keyed by id
    nodes: dict[str, Task | Static] = {**tasks, **statics}
    nix_build_recipes(nodes)
    dag = build_dag(list(nodes.keys()))
    add_edges(dag, nodes)
    ordered_nodes = topological_sort(dag)

    rewrites: dict[str, str] = {}  # task_output_path -> content store path
    resolved_recipe_drvs: dict[str, str] = {}  # node_id -> resolved .drv path

    for node_id in ordered_nodes:
        node = nodes[node_id]
        info = drv_info(node.path_recipe_unresolved_drv)

        if isinstance(node, Static):
            # Build recipe_data for static resolved recipe
            recipe_data = json.dumps(
                {"hash": node.hash, "out": node.task_output_path}
            )
            dep_resolved_recipe_drvs = {
                resolved_recipe_drvs[dep_id]: ["out"]
                for dep_id in (node.requires or [])
                if dep_id in resolved_recipe_drvs
            }
            path_recipe_resolved_drv = derivation_resolved_add(
                node.name,
                recipe_data,
                dep_resolved_recipe_drvs,
                info,
            )
            resolved_recipe_drvs[node_id] = path_recipe_resolved_drv
            path_recipe_resolved = resolved_recipe_build(
                path_recipe_resolved_drv
            )

            # Cache check
            hash_output = path_resolved_lookup(db, path_recipe_resolved)
            if hash_output and (NW_STORE / hash_output).exists():
                print(f"cache hit for static {node.name}: {hash_output}")
                rewrites[node.task_output_path] = str(NW_STORE / hash_output)
                drv_resolved_record(
                    db, node.path_recipe_unresolved, path_recipe_resolved
                )
                continue

            # Process static: verify + copy
            hash_output = process_static(node, rewrites)

            # Record in DB
            path_resolved_record(db, path_recipe_resolved, hash_output)
            drv_resolved_record(
                db, node.path_recipe_unresolved, path_recipe_resolved
            )

        else:
            # Task flow
            # 1. Resolve command and canonical
            cmd_resolved = cmd_resolve(node.canonical_cmd, rewrites)
            canonical_resolved = json.loads(
                cmd_resolve(json.dumps(node.canonical), rewrites)
            )

            # 2. Create resolved recipe .drv and build it
            recipe_data = json.dumps(
                {
                    "canonical": canonical_resolved,
                    "canonicalCmd": cmd_resolved,
                    "out": node.task_output_path,
                }
            )
            dep_resolved_recipe_drvs = {
                resolved_recipe_drvs[dep_id]: ["out"]
                for dep_id in (node.requires or [])
                if dep_id in resolved_recipe_drvs
            }
            path_recipe_resolved_drv = derivation_resolved_add(
                node.name,
                recipe_data,
                dep_resolved_recipe_drvs,
                info,
            )
            resolved_recipe_drvs[node_id] = path_recipe_resolved_drv
            path_recipe_resolved = resolved_recipe_build(
                path_recipe_resolved_drv
            )

            # 3. Cache check (keyed on built recipe paths, not drvs)
            hash_output = path_resolved_lookup(db, path_recipe_resolved)
            if hash_output and (NW_STORE / hash_output).exists():
                print(f"cache hit for {node.name}: {hash_output}")
                rewrites[node.task_output_path] = str(NW_STORE / hash_output)
                drv_resolved_record(
                    db, node.path_recipe_unresolved, path_recipe_resolved
                )
                continue

            # 4. Run task
            run_task(node, path_recipe_resolved)

            # 5. Hash output from staging
            staging = NW_STAGING / node.dir_name
            hash_output = path_hash(str(staging))

            # 6. Move staging to content store
            content_path = str(NW_STORE / hash_output)
            if not Path(content_path).exists():
                shutil.move(str(staging), content_path)
            else:
                shutil.rmtree(staging)

            # 7. Record in DB (keyed on built recipe paths)
            path_resolved_record(db, path_recipe_resolved, hash_output)
            drv_resolved_record(
                db, node.path_recipe_unresolved, path_recipe_resolved
            )

            # 8. Update rewrites for downstream
            rewrites[node.task_output_path] = content_path

    # Create GC root symlinks
    NW_GC_LINKS.mkdir(exist_ok=True, parents=True)
    for node_id in ordered_nodes:
        node = nodes[node_id]
        gc_link_recipe = NW_GC_LINKS / f"{node.dir_name}-recipe"
        if not gc_link_recipe.exists():
            subprocess.run(
                [
                    "nix-store",
                    "--add-root",
                    str(gc_link_recipe),
                    "-r",
                    node.id,
                ],
                check=True,
                capture_output=True,
            )
        gc_link_resolved_recipe = (
            NW_GC_LINKS / f"{node.dir_name}-resolved-recipe"
        )
        if not gc_link_resolved_recipe.exists():
            subprocess.run(
                [
                    "nix-store",
                    "--add-root",
                    str(gc_link_resolved_recipe),
                    "-r",
                    resolved_recipe_drvs[node_id],
                ],
                check=True,
                capture_output=True,
            )

    setup_local_output(nodes, rewrites)


def gc(path, attrs):
    db = init_db()
    eval_json_result = nix_eval(path)
    tasks = extract_task_attrs(eval_json_result)

    # Find tasks matching the specified attr names
    tasks_to_gc = {
        task_id: task
        for task_id, task in tasks.items()
        if task.nix_var_name in attrs
    }

    # 1. Delete GC root symlinks for recipe and resolved recipe
    for task_id, task in tasks_to_gc.items():
        gc_link_recipe = NW_GC_LINKS / f"{task.dir_name}-recipe"
        if gc_link_recipe.exists():
            gc_link_recipe.unlink()
            print(f"Removed GC root: {gc_link_recipe}")
        gc_link_resolved_recipe = (
            NW_GC_LINKS / f"{task.dir_name}-resolved-recipe"
        )
        if gc_link_resolved_recipe.exists():
            gc_link_resolved_recipe.unlink()
            print(f"Removed GC root: {gc_link_resolved_recipe}")

    # 2. Nix garbage collection
    subprocess.run(["nix-store", "--gc"], check=True)

    # 3. Clean DB: remove entries whose paths no longer exist
    rows = db.execute(
        "SELECT path_recipe_unresolved, path_recipe_resolved FROM placeholder_to_resolved"
    ).fetchall()
    for unresolved, resolved in rows:
        if not Path(resolved).exists():
            db.execute(
                "DELETE FROM placeholder_to_resolved WHERE path_recipe_unresolved = ?",
                (unresolved,),
            )
            print(f"Removed stale mapping: {unresolved}")

    rows = db.execute(
        "SELECT path_recipe_resolved, hash_output FROM realisations"
    ).fetchall()
    for resolved, h in rows:
        if not Path(resolved).exists():
            db.execute(
                "DELETE FROM realisations WHERE path_recipe_resolved = ?",
                (resolved,),
            )
            print(f"Removed stale realisation: {resolved}")

    # 4. Remove orphan realisations (not linked by any unresolved recipe)
    db.execute(
        """DELETE FROM realisations WHERE path_recipe_resolved NOT IN (
            SELECT path_recipe_resolved FROM placeholder_to_resolved
        )"""
    )

    db.commit()


def prune(paths):
    db = init_db()

    # 1. Collect all tasks and statics from all experiment files
    keep_unresolved = set()
    keep_dir_names = set()
    keep_static_hashes = set()
    for path in paths:
        eval_json_result = nix_eval(path)
        tasks = extract_task_attrs(eval_json_result)
        for task in tasks.values():
            keep_unresolved.add(task.path_recipe_unresolved)
            keep_dir_names.add(task.dir_name)
        statics = extract_static_attrs(eval_json_result)
        for static in statics.values():
            keep_static_hashes.add(static.hash)
            keep_unresolved.add(static.path_recipe_unresolved)
            keep_dir_names.add(static.dir_name)

    # 2. Remove GC root symlinks not belonging to kept tasks
    keep_gc_names = set()
    for dn in keep_dir_names:
        keep_gc_names.add(f"{dn}-recipe")
        keep_gc_names.add(f"{dn}-resolved-recipe")
    if NW_GC_LINKS.exists():
        for link in NW_GC_LINKS.iterdir():
            if link.name not in keep_gc_names:
                link.unlink()
                print(f"Removed GC root: {link}")

    # 3. Remove DB entries not in keep set
    rows = db.execute(
        "SELECT path_recipe_unresolved FROM placeholder_to_resolved"
    ).fetchall()
    for (unresolved,) in rows:
        if unresolved not in keep_unresolved:
            db.execute(
                "DELETE FROM placeholder_to_resolved WHERE path_recipe_unresolved = ?",
                (unresolved,),
            )
            print(f"Removed DB mapping: {unresolved}")

    # 4. Remove orphan realisations
    db.execute(
        """DELETE FROM realisations WHERE path_recipe_resolved NOT IN (
            SELECT path_recipe_resolved FROM placeholder_to_resolved
        )"""
    )
    db.commit()

    # 5. Nix garbage collection
    subprocess.run(["nix-store", "--gc"], check=True)

    # 6. Remove content store entries not referenced by remaining DB or statics
    keep_hashes = {
        h
        for (h,) in db.execute(
            "SELECT hash_output FROM realisations"
        ).fetchall()
    } | keep_static_hashes
    if NW_STORE.exists():
        for entry in NW_STORE.iterdir():
            if entry.name not in keep_hashes:
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
                print(f"Removed store entry: {entry}")

    # 7. Remove staging dirs not belonging to kept tasks
    if NW_STAGING.exists():
        for entry in NW_STAGING.iterdir():
            if entry.name not in keep_dir_names:
                shutil.rmtree(entry)
                print(f"Removed staging: {entry}")

    # 8. Remove state dirs not belonging to kept tasks
    if NW_STATE.exists():
        for entry in NW_STATE.iterdir():
            if entry.name not in keep_dir_names:
                shutil.rmtree(entry)
                print(f"Removed state: {entry}")


def clean():
    if NW_GC_LINKS.exists():
        shutil.rmtree(NW_GC_LINKS)
        print(f"Removed {NW_GC_LINKS}")
    subprocess.run(["nix-store", "--gc"], check=True)
    if NW_STAGING.exists():
        shutil.rmtree(NW_STAGING)
        print(f"Removed {NW_STAGING}")
    if NW_STATE.exists():
        shutil.rmtree(NW_STATE)
        print(f"Removed {NW_STATE}")
    if NW_STORE.exists():
        shutil.rmtree(NW_STORE)
        print(f"Removed {NW_STORE}")
    if DB_PATH.exists():
        DB_PATH.unlink()
        print(f"Removed {DB_PATH}")
    out = Path(OUTPUT)
    if out.exists():
        shutil.rmtree(out)
        print(f"Removed {out}")


def main():
    args = parse_args()
    if args.command == "run":
        run_workflow(args.path)
    elif args.command == "gc":
        gc(args.path, args.attrs)
    elif args.command == "prune":
        prune(args.paths)
    elif args.command == "clean":
        clean()


if __name__ == "__main__":
    main()
