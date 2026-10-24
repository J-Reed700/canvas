"""Saved projects on disk: one JSON file per project in a temp out/projects/, and the edits saved with exports."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import unittest

from downbeat.server.projects import NAME_MAX, ProjectStore, clean_name

EDIT = {"trackId": "t1", "selected": ["a", "b", "c"], "look": {"name": "Neon Tide", "layers": []}, "bars": 4}


class TestProjectStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="db-projects-")
        self.root = os.path.join(self.tmp, "projects")
        self.store = ProjectStore(self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_names_are_one_trimmed_line_with_a_default(self) -> None:
        self.assertEqual(clean_name("  Night \n Drive\t edit "), "Night Drive edit")
        self.assertEqual(clean_name(""), "Untitled")
        self.assertEqual(clean_name(None), "Untitled")
        self.assertEqual(clean_name("   "), "Untitled")
        self.assertEqual(len(clean_name("x" * 500)), NAME_MAX)

    def test_a_new_project_is_a_file_with_its_name_and_edit(self) -> None:
        p = self.store.create("Night Drive", EDIT)
        self.assertRegex(p["id"], r"^[0-9a-f]{12}$")
        self.assertEqual(p["name"], "Night Drive")
        self.assertEqual(p["created"], p["updated"])
        # the list shows what the dialog needs without the edit itself
        self.assertEqual({k: p[k] for k in ("clips", "first_clip", "track_id", "look", "bars")},
                         {"clips": 3, "first_clip": "a", "track_id": "t1", "look": "Neon Tide", "bars": 4})
        self.assertNotIn("data", p)
        with open(os.path.join(self.root, f"{p['id']}.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk["data"], EDIT)
        self.assertEqual(self.store.get(p["id"])["data"], EDIT)
        self.assertEqual(os.listdir(self.root), [f"{p['id']}.json"], "no temp files are left behind")

    def test_a_name_that_is_taken_gets_the_next_free_number(self) -> None:
        names = [self.store.create(n, {})["name"] for n in ("Untitled", "untitled", "Untitled", "Untitled 2", "")]
        self.assertEqual(names, ["Untitled", "untitled 2", "Untitled 3", "Untitled 4", "Untitled 5"])

    def test_saving_replaces_the_edit_and_moves_the_project_to_the_top(self) -> None:
        first = self.store.create("First", EDIT)
        time.sleep(0.01)
        second = self.store.create("Second", {})
        self.assertEqual([p["name"] for p in self.store.list()], ["Second", "First"])
        time.sleep(0.01)
        saved = self.store.save(first["id"], {**EDIT, "bars": 8})
        self.assertGreater(saved["updated"], second["updated"])
        self.assertEqual(saved["created"], first["created"])
        self.assertEqual(saved["bars"], 8)
        self.assertEqual([p["name"] for p in self.store.list()], ["First", "Second"])

    def test_a_deleted_project_stays_deleted(self) -> None:
        p = self.store.create("Gone", EDIT)
        self.store.delete(p["id"])
        self.assertEqual(self.store.list(), [])
        with self.assertRaises(KeyError):
            self.store.save(p["id"], EDIT)
        with self.assertRaises(KeyError):
            self.store.get(p["id"])
        self.store.delete(p["id"])  # deleting it again is fine

    def test_ids_cannot_reach_outside_the_folder(self) -> None:
        outside = os.path.join(self.tmp, "secret.json")
        with open(outside, "w") as f:
            json.dump({"id": "secret", "data": {}}, f)
        for bad in ("../secret", "secret", "ABCDEF123456", "", "0123456789ab/../x"):
            with self.assertRaises(KeyError):
                self.store.get(bad)
            with self.assertRaises(KeyError):
                self.store.delete(bad)
        self.assertTrue(os.path.isfile(outside))

    def test_renaming_keeps_the_edit_and_the_name_unique(self) -> None:
        a = self.store.create("A", EDIT)
        self.store.create("B", {})
        self.assertEqual(self.store.rename(a["id"], "  Club   mix ")["name"], "Club mix")
        self.assertEqual(self.store.rename(a["id"], "B")["name"], "B 2")
        self.assertEqual(self.store.rename(a["id"], "B 2")["name"], "B 2", "its own name doesn't count as taken")
        self.assertEqual(self.store.get(a["id"])["data"], EDIT)
        with self.assertRaises(KeyError):
            self.store.rename("0123456789ab", "C")

    def test_the_edit_must_be_an_object_of_a_sane_size(self) -> None:
        for bad in (None, [], "edit", 3):
            with self.assertRaises(ValueError):
                self.store.create("x", bad)
        with self.assertRaises(ValueError):
            self.store.create("x", {"blob": "x" * (9 << 20)})
        self.assertFalse(os.path.isdir(self.root) and os.listdir(self.root))

    def test_the_list_skips_files_that_are_not_projects(self) -> None:
        good = self.store.create("Good", EDIT)
        with open(os.path.join(self.root, "0123456789ab.json"), "w") as f:
            f.write("{not json")
        with open(os.path.join(self.root, "abcdefabcdef.json"), "w") as f:
            json.dump({"id": "fedcbafedcba", "data": {}}, f)  # the id inside doesn't match the file
        with open(os.path.join(self.root, "notes.txt"), "w") as f:
            f.write("hi")
        os.makedirs(os.path.join(self.root, "exports"))
        self.assertEqual([p["id"] for p in self.store.list()], [good["id"]])
        self.assertEqual(ProjectStore(os.path.join(self.tmp, "missing")).list(), [])

    def test_exports_keep_the_edit_they_were_made_from(self) -> None:
        name = "canvas-neon-tide-120bpm-8.0s-1080x1920-20261024-120000.mp4"
        self.assertFalse(self.store.has_export_edit(name))
        self.store.save_export_edit(name, EDIT)
        self.assertTrue(self.store.has_export_edit(name))
        self.assertEqual(self.store.export_edit(name), EDIT)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "exports", name[:-4] + ".json")))
        # a path only counts by its file name
        self.assertEqual(self.store.export_edit(f"../../{name}"), EDIT)
        self.store.delete_export_edit(name)
        self.assertFalse(self.store.has_export_edit(name))
        with self.assertRaises(KeyError):
            self.store.export_edit(name)
        for bad in ("notes.txt", "", "x.mp4.json"):
            self.assertFalse(self.store.has_export_edit(bad))
            with self.assertRaises(KeyError):
                self.store.export_edit(bad)
            self.store.delete_export_edit(bad)
        # projects never list the exports folder
        self.assertEqual(self.store.list(), [])


if __name__ == "__main__":
    unittest.main()
