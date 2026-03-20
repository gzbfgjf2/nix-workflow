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
from typing import Any, BinaryIO, cast

OUTPUT = "nix-workflow-output"
NW_BASE = Path("/nix-workflow")
NW_STORE = NW_BASE / "store"
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
            placeholder_drv_path TEXT PRIMARY KEY,
            resolved_drv_path TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS realisations (
            resolved_drv_path TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL
        )"""
    )
    db.commit()
    return db


def drv_resolved_lookup(
    db: sqlite3.Connection, placeholder_drv_path: str
) -> str | None:
    row = db.execute(
        "SELECT resolved_drv_path FROM placeholder_to_resolved WHERE placeholder_drv_path = ?",
        (placeholder_drv_path,),
    ).fetchone()
    return row[0] if row else None


def drv_resolved_record(
    db: sqlite3.Connection, placeholder_drv_path: str, resolved_drv_path: str
):
    db.execute(
        "INSERT OR REPLACE INTO placeholder_to_resolved (placeholder_drv_path, resolved_drv_path) VALUES (?, ?)",
        (placeholder_drv_path, resolved_drv_path),
    )
    db.commit()


def path_resolved_lookup(
    db: sqlite3.Connection, resolved_drv_path: str
) -> str | None:
    row = db.execute(
        "SELECT content_hash FROM realisations WHERE resolved_drv_path = ?",
        (resolved_drv_path,),
    ).fetchone()
    return row[0] if row else None


def path_resolved_record(
    db: sqlite3.Connection, resolved_drv_path: str, content_hash: str
):
    db.execute(
        "INSERT OR REPLACE INTO realisations (resolved_drv_path, content_hash) VALUES (?, ?)",
        (resolved_drv_path, content_hash),
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
    input_drvs = {
        k: v2["outputs"] for k, v2 in v["inputDrvs"].items()
    }
    return {
        "system": v["system"],
        "builder": v["builder"],
        "PATH": v["env"].get("PATH", ""),
        "inputDrvs": input_drvs,
    }



def derivation_resolved_add(
    task: "Task",
    cmd_resolved: str,
    canonical_resolved: dict,
    dep_resolved_drvs: dict[str, list[str]],
    info: dict,
) -> str:
    import re
    recipe_data = json.dumps({"canonical": canonical_resolved, "canonicalCmd": cmd_resolved, "out": task.task_output_path})
    name = f"{task.name}-resolved"
    builder = "/bin/sh"
    args = [
        "-c",
        'printf \'%s\' "$1" > "$out"',
        "dummy",
        recipe_data,
    ]
    nix_input_drvs = {
        drv: {"dynamicOutputs": {}, "outputs": outs}
        for drv, outs in dep_resolved_drvs.items()
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
    recipe_drv_path: str
    recipe_path: str
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
    gc_parser.add_argument("attrs", nargs="+", type=str, help="Attribute names to collect")

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
        'attr: builtins.mapAttrs (_: w: builtins.removeAttrs w ["__toString"]) attr',
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
                pipe = cast(BinaryIO, key.fileobj)
                data = pipe.read1(1024)
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


def nix_build_tasks(tasks):
    print("setup..")
    print(tasks.keys())
    drvs = list(map(lambda x: x.recipe_drv_path, tasks.values()))
    recipe_store_paths = nix_build(drvs)
    return recipe_store_paths


def setup_local_output(tasks, rewrites):
    local_folder = Path(OUTPUT)
    local_folder.mkdir(exist_ok=True, parents=True)
    for task_id, task in tasks.items():
        link = local_folder / task.nix_var_name
        target = rewrites.get(task.task_output_path, task.task_output_path)
        if link.is_symlink():
            link.unlink()
        link.symlink_to(target)
        print(f"{link} -> {target}")


def extract_task_attrs(js: dict):
    tasks = {}
    for attr, value in js.items():
        if "__type__" in value and value["__type__"] == "task":
            task = Task(
                name=value["name"],
                canonical=value["canonical"],
                canonical_cmd=value["canonicalCmd"],
                recipe_drv_path=value["recipeDrvPath"],
                recipe_path=value["recipePath"],
                id=value["recipePath"],
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
        dag[path]["in"] = set(r for r in references if r in tasks and r != path)
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


def resolved_recipe_build(drv_resolved_path: str) -> str:
    stdout_lines = popen_with_stderr_forward(["nix-build", drv_resolved_path, "--no-out-link"])
    return stdout_lines[0].decode("utf-8", "replace").strip()


def initialise_task(resolved_recipe_path: str):
    p = Path(resolved_recipe_path)
    if p.is_file():
        recipe = json.loads(p.read_text())
    else:
        with open(p / "recipe.json", "r") as f:
            recipe = json.load(f)
    print(recipe)
    command = recipe["canonicalCmd"]
    return command


def run_task(task: Task, resolved_recipe_path: str):
    print(f"run {task.task_output_path}")
    Path(task.task_output_path).mkdir(exist_ok=True, parents=True)
    Path(task.task_state_path).mkdir(exist_ok=True, parents=True)
    commands = initialise_task(resolved_recipe_path)
    env = {
        **os.environ,
        "out": task.task_output_path,
        "state": task.task_state_path,
    }
    command = shlex.split(commands)
    result = popen_with_stderr_forward(command, env=env)
    print("task completed")
    return result


def run_workflow(path):
    db = init_db()
    eval_json_result = nix_eval(path)
    tasks: dict[str, Task] = extract_task_attrs(eval_json_result)
    nix_build_tasks(tasks)
    dag = build_dag(list(tasks.keys()))
    add_edges(dag, tasks)
    ordered_tasks = topological_sort(dag)

    rewrites: dict[str, str] = {}  # task_output_path -> content store path
    resolved_drvs: dict[str, str] = {}  # task_id -> resolved .drv path

    for task_id in ordered_tasks:
        task = tasks[task_id]
        info = drv_info(task.recipe_drv_path)

        # 1. Resolve command and canonical
        cmd_resolved = cmd_resolve(task.canonical_cmd, rewrites)
        canonical_resolved = json.loads(
            cmd_resolve(json.dumps(task.canonical), rewrites)
        )

        # 2. Create resolved recipe .drv
        dep_resolved_drvs = {
            resolved_drvs[dep_id]: ["out"]
            for dep_id in (task.requires or [])
            if dep_id in resolved_drvs
        }
        drv_resolved_path = derivation_resolved_add(
            task, cmd_resolved, canonical_resolved, dep_resolved_drvs, info,
        )
        resolved_drvs[task_id] = drv_resolved_path

        # 3. Cache check
        content_hash = path_resolved_lookup(db, drv_resolved_path)
        if content_hash and (NW_STORE / content_hash).exists():
            print(f"cache hit for {task.name}: {content_hash}")
            rewrites[task.task_output_path] = str(NW_STORE / content_hash)
            drv_resolved_record(db, task.recipe_drv_path, drv_resolved_path)
            continue

        # 4. Build resolved recipe and run task
        resolved_recipe_path = resolved_recipe_build(drv_resolved_path)
        run_task(task, resolved_recipe_path)

        # 5. Hash output
        content_hash = path_hash(task.task_output_path)

        # 6. Move to content path
        content_path = str(NW_STORE / content_hash)
        if not Path(content_path).exists():
            shutil.move(task.task_output_path, content_path)
        else:
            shutil.rmtree(task.task_output_path)

        # 7. Record in DB
        path_resolved_record(db, drv_resolved_path, content_hash)
        drv_resolved_record(db, task.recipe_drv_path, drv_resolved_path)

        # 8. Update rewrites for downstream
        rewrites[task.task_output_path] = content_path

    # Create GC root symlinks
    NW_GC_LINKS.mkdir(exist_ok=True, parents=True)
    for task_id in ordered_tasks:
        task = tasks[task_id]
        gc_link_recipe = NW_GC_LINKS / f"{task.dir_name}-recipe"
        if not gc_link_recipe.exists():
            subprocess.run(
                ["nix-store", "--add-root", str(gc_link_recipe), "-r", task.id],
                check=True,
                capture_output=True,
            )
        gc_link_resolved_recipe = NW_GC_LINKS / f"{task.dir_name}-resolved-recipe"
        if not gc_link_resolved_recipe.exists():
            subprocess.run(
                ["nix-store", "--add-root", str(gc_link_resolved_recipe), "-r", resolved_drvs[task_id]],
                check=True,
                capture_output=True,
            )

    setup_local_output(tasks, rewrites)


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
        gc_link_resolved_recipe = NW_GC_LINKS / f"{task.dir_name}-resolved-recipe"
        if gc_link_resolved_recipe.exists():
            gc_link_resolved_recipe.unlink()
            print(f"Removed GC root: {gc_link_resolved_recipe}")

    # 2. Nix garbage collection
    subprocess.run(["nix-store", "--gc"], check=True)

    # 3. Remove content-addressed outputs if recipe was GC'd
    for task_id, task in tasks_to_gc.items():
        if Path(task.recipe_path).exists():
            print(f"Skipping {task.name}: recipe still exists at {task.recipe_path}")
            continue
        resolved_drv_path = drv_resolved_lookup(db, task.recipe_drv_path)
        if resolved_drv_path:
            content_hash = path_resolved_lookup(db, resolved_drv_path)
            if content_hash:
                content_path = NW_STORE / content_hash
                if content_path.exists():
                    shutil.rmtree(content_path)
                    print(f"Removed {content_path}")


def clean():
    if NW_GC_LINKS.exists():
        shutil.rmtree(NW_GC_LINKS)
        print(f"Removed {NW_GC_LINKS}")
    subprocess.run(["nix-store", "--gc"], check=True)
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
    elif args.command == "clean":
        clean()


if __name__ == "__main__":
    main()
