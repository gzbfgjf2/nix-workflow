import sqlite3
from unittest.mock import MagicMock, call, patch

from nw.main import (
    cmd_resolve,
    extract_static_attrs,
    extract_task_attrs,
    process_static,
    run_workflow,
    topological_sort,
)


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


def _make_task_json(
    attr="dataset",
    name="build-data",
    hash_val=None,
):
    return {
        attr: {
            "__type__": "task",
            "name": name,
            "hash": hash_val,
            "canonical": {"program": "/bin/build-data"},
            "canonicalCmd": "/bin/build-data --name=demo",
            "pathRecipeUnresolvedDrv": "/nix/store/abc.drv",
            "pathRecipeUnresolved": "/nix/store/abc-recipe",
            "id": "/nix/store/abc-recipe",
            "taskOutputPath": "abc-placeholder",
            "taskStatePath": "/nix-workflow/state/abc",
            "dirName": "abc",
            "_untracked": None,
        }
    }


def test_extract_task_attrs():
    js = {
        **_make_task_json(),
        "not_a_task": {"foo": "bar"},
    }
    tasks = extract_task_attrs(js)
    assert len(tasks) == 1
    task = tasks["/nix/store/abc-recipe"]
    assert task.name == "build-data"
    assert task.nix_var_name == "dataset"
    assert task.path_recipe_unresolved == "/nix/store/abc-recipe"
    assert task.hash is None


def test_extract_task_attrs_with_pinned_hash():
    js = _make_task_json(hash_val="abc123pinnedhash")
    tasks = extract_task_attrs(js)
    task = tasks["/nix/store/abc-recipe"]
    assert task.hash == "abc123pinnedhash"


def _make_static_json(
    attr="my_data",
    path="/data/dataset",
    hash_val="abc123hash",
    info=None,
):
    """Helper to build a static JSON entry with derivation fields."""
    return {
        attr: {
            "__type__": "static",
            "path": path,
            "hash": hash_val,
            "info": info,
            "taskOutputPath": f"{hash_val}-ca-placeholder",
            "pathRecipeUnresolvedDrv": f"/nix/store/{hash_val}.drv",
            "pathRecipeUnresolved": f"/nix/store/{hash_val}-recipe",
            "id": f"/nix/store/{hash_val}-recipe",
            "taskStatePath": f"/nix-workflow/state/{hash_val}",
            "dirName": hash_val,
        }
    }


def test_extract_static_attrs():
    js = {
        **_make_static_json(
            attr="my_data",
            path="/data/dataset",
            hash_val="abc123hash",
            info={"description": "test dataset"},
        ),
        "a_task": {
            "__type__": "task",
            "name": "train",
            "canonical": {},
            "canonicalCmd": "/bin/train",
            "pathRecipeUnresolvedDrv": "/nix/store/x.drv",
            "pathRecipeUnresolved": "/nix/store/x-recipe",
            "id": "/nix/store/x-recipe",
            "taskOutputPath": "x-placeholder",
            "taskStatePath": "/nix-workflow/state/x",
            "dirName": "x",
            "_untracked": None,
        },
        "plain": {"foo": "bar"},
    }
    statics = extract_static_attrs(js)
    assert len(statics) == 1
    s = statics["/nix/store/abc123hash-recipe"]
    assert s.name == "static"
    assert s.path == "/data/dataset"
    assert s.hash == "abc123hash"
    assert s.info == {"description": "test dataset"}
    assert s.task_output_path == "abc123hash-ca-placeholder"
    assert s.nix_var_name == "my_data"
    assert s.path_recipe_unresolved == "/nix/store/abc123hash-recipe"
    assert s.dir_name == "abc123hash"


def test_extract_static_attrs_none_info():
    js = _make_static_json(attr="cfg", path="/data/config", hash_val="cfghash")
    statics = extract_static_attrs(js)
    s = statics["/nix/store/cfghash-recipe"]
    assert s.info is None


def test_extract_static_attrs_empty():
    js = {
        "a_task": {
            "__type__": "task",
            "name": "train",
            "canonical": {},
            "canonicalCmd": "/bin/train",
            "pathRecipeUnresolvedDrv": "/nix/store/x.drv",
            "pathRecipeUnresolved": "/nix/store/x-recipe",
            "id": "/nix/store/x-recipe",
            "taskOutputPath": "x-placeholder",
            "taskStatePath": "/nix-workflow/state/x",
            "dirName": "x",
            "_untracked": None,
        },
    }
    statics = extract_static_attrs(js)
    assert len(statics) == 0


def _make_static_obj(
    name="ds", path="/data/src", hash_val="abc123", store_base=None
):
    """Helper to create a Static object for process_static tests."""
    from nw.main import Static

    task_output_path = (
        str(store_base / hash_val)
        if store_base
        else f"/nix-workflow/store/{hash_val}"
    )
    return Static(
        name=name,
        path=path,
        hash=hash_val,
        info=None,
        task_output_path=task_output_path,
        nix_var_name=name,
        path_recipe_unresolved_drv=f"/nix/store/{hash_val}.drv",
        path_recipe_unresolved=f"/nix/store/{hash_val}-recipe",
        id=f"/nix/store/{hash_val}-recipe",
        task_state_path=f"/nix-workflow/state/{hash_val}",
        dir_name=hash_val,
    )


def test_process_static_skips_existing(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    existing = store / "abc123"
    existing.mkdir()
    (existing / "data.csv").write_text("hello")

    static = _make_static_obj(
        path="/unused", hash_val="abc123", store_base=store
    )
    rewrites = {}
    with patch("nw.main.NW_STORE", store):
        process_static(static, rewrites)
    assert rewrites[str(existing)] == str(existing)


def test_process_static_copies_file(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    source_file = tmp_path / "mydata.csv"
    source_file.write_text("data")
    target = store / "filehash"

    static = _make_static_obj(
        path=str(source_file), hash_val="filehash", store_base=store
    )
    rewrites = {}
    with patch("nw.main.path_hash", return_value="filehash"):
        with patch("nw.main.NW_STORE", store):
            process_static(static, rewrites)
    assert target.exists()
    assert target.read_text() == "data"
    assert rewrites[str(target)] == str(target)


def test_process_static_copies_directory(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    source_dir = tmp_path / "dataset"
    source_dir.mkdir()
    (source_dir / "a.csv").write_text("a")
    (source_dir / "b.csv").write_text("b")
    target = store / "dirhash"

    static = _make_static_obj(
        path=str(source_dir), hash_val="dirhash", store_base=store
    )
    rewrites = {}
    with patch("nw.main.path_hash", return_value="dirhash"):
        with patch("nw.main.NW_STORE", store):
            process_static(static, rewrites)
    assert (target / "a.csv").read_text() == "a"
    assert (target / "b.csv").read_text() == "b"


def test_process_static_hash_mismatch(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    source_file = tmp_path / "data.csv"
    source_file.write_text("data")

    static = _make_static_obj(
        path=str(source_file), hash_val="declaredhash", store_base=store
    )
    rewrites = {}
    import pytest

    with patch("nw.main.path_hash", return_value="actualhash"):
        with patch("nw.main.NW_STORE", store):
            with pytest.raises(ValueError, match="hash mismatch"):
                process_static(static, rewrites)


def test_process_static_source_missing(tmp_path):
    store = tmp_path / "store"
    store.mkdir()

    static = _make_static_obj(
        path="/nonexistent/path", hash_val="somehash", store_base=store
    )
    rewrites = {}
    import pytest

    with patch("nw.main.NW_STORE", store):
        with pytest.raises(FileNotFoundError, match="does not exist"):
            process_static(static, rewrites)


def test_process_static_null_path_in_store(tmp_path):
    store = tmp_path / "store"
    store.mkdir()
    existing = store / "abc123"
    existing.mkdir()
    (existing / "data.csv").write_text("hello")

    static = _make_static_obj(path=None, hash_val="abc123", store_base=store)
    rewrites = {}
    with patch("nw.main.NW_STORE", store):
        process_static(static, rewrites)
    assert rewrites[str(existing)] == str(existing)


def test_process_static_null_path_not_in_store(tmp_path):
    store = tmp_path / "store"
    store.mkdir()

    static = _make_static_obj(
        path=None, hash_val="missinghash", store_base=store
    )
    rewrites = {}
    import pytest

    with patch("nw.main.NW_STORE", store):
        with pytest.raises(FileNotFoundError, match="no source path provided"):
            process_static(static, rewrites)


def _make_pinned_task(hash_val="pinnedhash"):
    from nw.main import Task

    return Task(
        name="my-task",
        canonical={
            "program": "/bin/train",
            "flags": [],
            "options": {},
            "subcommands": [],
            "operands": [],
        },
        canonical_cmd="/bin/train",
        path_recipe_unresolved_drv=f"/nix/store/{hash_val}.drv",
        path_recipe_unresolved=f"/nix/store/{hash_val}-recipe",
        id=f"/nix/store/{hash_val}-recipe",
        task_output_path=f"{hash_val}-placeholder",
        task_state_path=f"/nix-workflow/state/{hash_val}",
        dir_name=hash_val,
        nix_var_name="my_task",
        _untracked=None,
        hash=hash_val,
        requires=[],
        required_by=[],
    )


def _run_workflow_mocked(task, store, gc_links, mock_run_task):
    """Run workflow with a single pinned task, all nix calls mocked."""
    node_id = task.id
    fake_resolved_drv = f"/nix/store/resolved-{task.hash}.drv"
    fake_resolved_path = f"/nix/store/resolved-{task.hash}"

    db = sqlite3.connect(":memory:")
    db.execute(
        "CREATE TABLE placeholder_to_resolved (path_recipe_unresolved TEXT PRIMARY KEY, path_recipe_resolved TEXT NOT NULL)"
    )
    db.execute(
        "CREATE TABLE realisations (path_recipe_resolved TEXT PRIMARY KEY, hash_output TEXT NOT NULL)"
    )
    db.commit()

    with (
        patch("nw.main.init_db", return_value=db),
        patch("nw.main.nix_eval", return_value={}),
        patch("nw.main.extract_task_attrs", return_value={node_id: task}),
        patch("nw.main.extract_static_attrs", return_value={}),
        patch("nw.main.nix_build_recipes"),
        patch(
            "nw.main.build_dag",
            return_value={node_id: {"in": set(), "out": set()}},
        ),
        patch("nw.main.add_edges"),
        patch("nw.main.topological_sort", return_value=[node_id]),
        patch(
            "nw.main.drv_info",
            return_value={
                "system": "x86_64-linux",
                "builder": "/bin/sh",
                "PATH": "",
                "inputDrvs": {},
            },
        ),
        patch(
            "nw.main.derivation_resolved_add", return_value=fake_resolved_drv
        ),
        patch(
            "nw.main.resolved_recipe_build", return_value=fake_resolved_path
        ),
        patch("nw.main.path_resolved_lookup", return_value=None),
        patch("nw.main.NW_STORE", store),
        patch("nw.main.NW_GC_LINKS", gc_links),
        patch("nw.main.setup_local_output"),
        patch("nw.main.run_task", mock_run_task),
        patch("subprocess.run"),
    ):
        run_workflow("fake.nix")


def test_run_workflow_pinned_hash_missing_from_store(tmp_path):
    """Pinned task whose hash is not in the store raises FileNotFoundError."""
    import pytest

    store = tmp_path / "store"
    store.mkdir()
    gc_links = tmp_path / "gc-links"
    gc_links.mkdir()

    task = _make_pinned_task(hash_val="missinghash")
    mock_run_task = MagicMock()

    with pytest.raises(FileNotFoundError, match="not in store"):
        _run_workflow_mocked(task, store, gc_links, mock_run_task)

    mock_run_task.assert_not_called()


def test_run_workflow_pinned_hash_present_skips_execution(tmp_path):
    """Pinned task whose hash is in the store skips execution."""
    store = tmp_path / "store"
    store.mkdir()
    gc_links = tmp_path / "gc-links"
    gc_links.mkdir()

    hash_val = "presenthash"
    (store / hash_val).mkdir()

    task = _make_pinned_task(hash_val=hash_val)
    mock_run_task = MagicMock()

    _run_workflow_mocked(task, store, gc_links, mock_run_task)

    mock_run_task.assert_not_called()
