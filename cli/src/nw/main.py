import argparse
import copy
import json
import os
import selectors
import shlex
import shutil
import subprocess
import sys
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO, Self, cast

OUTPUT = "nix-workflow-output"


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
    path_local: str | None = None


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
                data = pipe.read(1024)
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


def compute_path_task_local(parent_local, task):
    parent_local = Path(parent_local)
    path_task_local = parent_local / (f"{task.nix_var_name}-{task.dir_name}")
    return path_task_local


def nix_build_tasks(tasks):
    print("setup..")
    print(tasks.keys())
    drvs = list(map(lambda x: x.recipe_drv_path, tasks.values()))
    recipe_store_paths = nix_build(drvs)
    return recipe_store_paths


def nix_build_and_setup_local_output(recipe_store_paths, tasks, local_folder):
    print(f"recipe store paths..: {recipe_store_paths}")
    local_folder = Path(local_folder)
    local_folder.mkdir(exist_ok=True, parents=True)

    for recipe_store_path in recipe_store_paths:
        if recipe_store_path not in tasks:
            raise ValueError(
                f"{recipe_store_path} is built, but it is not in tasks: {list(tasks.keys())}"
            )
        task = tasks[recipe_store_path]
        # local_output_path = local_folder / (
        #     f"{task.nix_var_name}-{task.dir_name}"
        # )
        local_output_path = Path(compute_path_task_local(local_folder, task))

        task.path_local = str(local_output_path)

        local_output_path.mkdir(exist_ok=True, parents=True)
        with open(local_output_path / "task.json", "w") as f:
            json.dump(asdict(task), f, indent=2, sort_keys=True)

        Path(task.task_output_path).mkdir(exist_ok=True, parents=True)
        Path(task.task_state_path).mkdir(exist_ok=True, parents=True)
        print("setup path:", Path(task.task_output_path))
        print("setup path:", Path(task.task_state_path))
        indirect_gc_root = Path(
            local_output_path / "nix-store-recipe"
        ).resolve()

        if not indirect_gc_root.exists():
            subprocess.run(
                [
                    "nix-store",
                    "--add-root",
                    str(indirect_gc_root),
                    "-r",
                    task.id,
                ],
                check=True,
                capture_output=True,
            )
        links = [
            [task.task_output_path, (local_output_path / "output").resolve()],
            [task.task_state_path, (local_output_path / "state").resolve()],
        ]

        for x, y in links:
            dst = Path(y)
            if dst.exists():
                continue
            # for path in sorted(y.rglob("*")):
            #     depth = len(path.relative_to(y).parts)
            #     print("  " * (depth - 1) + path.name)
            try:
                dst.symlink_to(x)
            except Exception as e:
                print(e)

    links = []
    for task_id, task in tasks.items():
        for id_required_by in task.required_by:
            task_required_by = tasks[id_required_by]
            frm = task_required_by.path_local
            to = Path(task.path_local) / "required_by" / Path(frm).name
            to.parent.mkdir(exist_ok=True, parents=True)
            links.append([str(Path(frm).resolve()), str(Path(to).resolve())])

        for id_requires in task.requires:
            task_requires = tasks[id_requires]
            frm = task_requires.path_local
            to = Path(task.path_local) / "requires" / Path(frm).name
            to.parent.mkdir(exist_ok=True, parents=True)
            links.append([str(Path(frm).resolve()), str(Path(to).resolve())])

    for x, y in links:
        dst = Path(y)
        if dst.exists():
            continue
        try:
            dst.symlink_to(x)
        except Exception as e:
            print(e)


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
        dag[path]["in"] = set(r for r in references if r in tasks)
        for r in references:
            if r in tasks:
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


def check_if_is_done(state_path):
    if state_path.exists() and (state_path / "done").exists():
        return True
    return False


def mark_done(state_path):
    (state_path / "done").touch()


def initialise_task(task: Task):
    output_path = Path(task.task_output_path)
    state_path = Path(task.task_state_path)
    print(f"run {output_path}")

    with open(Path(task.recipe_path) / "recipe.json", "r") as f:
        recipe = json.load(f)
        print(recipe)

    command = recipe["canonicalCmd"]
    return command


def run_task(task: Task):
    state_path = Path(task.task_state_path)
    if check_if_is_done(state_path):
        return
    commands = initialise_task(task)
    env = {
        **os.environ,
        "out": task.task_output_path,
        "state": task.task_state_path,
    }
    command = shlex.split(commands)
    result = popen_with_stderr_forward(command, env=env)
    mark_done(state_path)
    print("task completed")
    return result


def run_all_tasks(tasks):
    local_output = Path(OUTPUT)
    local_output.mkdir(exist_ok=True, parents=True)
    for task in tasks:
        run_task(task)


def run_workflow(path):
    eval_json_result = nix_eval(path)
    tasks: dict[str, Task] = extract_task_attrs(eval_json_result)
    recipe_store_paths = nix_build_tasks(tasks)
    dag = build_dag(list(tasks.keys()))
    add_edges(dag, tasks)
    nix_build_and_setup_local_output(recipe_store_paths, tasks, OUTPUT)
    ordered_tasks = topological_sort(dag)
    run_all_tasks([tasks[k] for k in ordered_tasks])


def gc():
    subprocess.run(["nix-store", "--gc"], check=True)
    base = Path("/nix-workflow/store")
    for output_path in base.iterdir():
        if not output_path.is_dir():
            continue
        name = output_path.name
        recipe_path = Path("/nix/store") / f"{name}-nix-workflow-task-recipe"
        if not recipe_path.exists():
            shutil.rmtree(output_path)
            print(f"Removed {output_path}")
            state_path = Path("/nix-workflow/state") / name
            shutil.rmtree(state_path)
            print(f"Removed {state_path}")


def main():
    args = parse_args()
    if args.command == "run":
        run_workflow(args.path)
    elif args.command == "gc":
        gc()


if __name__ == "__main__":
    main()
