from nw.main import cmd_resolve, topological_sort, extract_task_attrs


def test_cmd_resolve_single():
    rewrites = {"abc-placeholder": "/nix-workflow/store/hash123"}
    result = cmd_resolve(
        "/bin/train --data=abc-placeholder/data.csv", rewrites
    )
    assert result == "/bin/train --data=/nix-workflow/store/hash123/data.csv"


def test_cmd_resolve_multiple():
    rewrites = {
        "aaa-placeholder": "/nix-workflow/store/h1",
        "bbb-placeholder": "/nix-workflow/store/h2",
    }
    result = cmd_resolve(
        "/bin/run --a=aaa-placeholder --b=bbb-placeholder", rewrites
    )
    assert (
        result
        == "/bin/run --a=/nix-workflow/store/h1 --b=/nix-workflow/store/h2"
    )


def test_cmd_resolve_no_rewrites():
    result = cmd_resolve("/bin/run --flag", {})
    assert result == "/bin/run --flag"


def test_topological_sort_linear():
    dag = {
        "a": {"in": set(), "out": {"b"}},
        "b": {"in": {"a"}, "out": {"c"}},
        "c": {"in": {"b"}, "out": set()},
    }
    assert topological_sort(dag) == ["a", "b", "c"]


def test_topological_sort_diamond():
    dag = {
        "a": {"in": set(), "out": {"b", "c"}},
        "b": {"in": {"a"}, "out": {"d"}},
        "c": {"in": {"a"}, "out": {"d"}},
        "d": {"in": {"b", "c"}, "out": set()},
    }
    result = topological_sort(dag)
    assert result[0] == "a"
    assert result[-1] == "d"
    assert set(result) == {"a", "b", "c", "d"}


def test_topological_sort_single():
    dag = {"a": {"in": set(), "out": set()}}
    assert topological_sort(dag) == ["a"]


def test_extract_task_attrs():
    js = {
        "dataset": {
            "__type__": "task",
            "name": "build-data",
            "canonical": {"program": "/bin/build-data"},
            "canonicalCmd": "/bin/build-data --name=demo",
            "pathRecipeUnresolvedDrv": "/nix/store/abc.drv",
            "pathRecipeUnresolved": "/nix/store/abc-recipe",
            "id": "/nix/store/abc-recipe",
            "taskOutputPath": "abc-placeholder",
            "taskStatePath": "/nix-workflow/state/abc",
            "dirName": "abc",
            "_untracked": None,
        },
        "not_a_task": {"foo": "bar"},
    }
    tasks = extract_task_attrs(js)
    assert len(tasks) == 1
    task = tasks["/nix/store/abc-recipe"]
    assert task.name == "build-data"
    assert task.nix_var_name == "dataset"
    assert task.path_recipe_unresolved == "/nix/store/abc-recipe"
