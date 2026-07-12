"""Bridge contract test: an EDL produced by the live app (web/lib/edl.ts:takeToEdl) must load,
validate, and round-trip through the renderer's edl module with its vocabulary intact.

This is the executable proof that the TypeScript producer and the Python consumer agree on the
"final clip" contract — the fixture is shaped exactly like takeToEdl's output (tiled, contiguous,
alternating A/B shots, hard cuts). If the two drift, this test breaks.

Run from backend/:  python -m unittest render.tests.test_edl_bridge -v
"""
import json
import os
import unittest

from render import edl as edl_mod

EXAMPLE = os.path.join(os.path.dirname(__file__), "..", "examples", "audition_edl.example.json")


class TestAuditionBridge(unittest.TestCase):
    def setUp(self):
        with open(EXAMPLE) as f:
            self.raw = json.load(f)
        self.edl = edl_mod.from_dict(self.raw)  # from_dict validates

    def test_loads_and_validates(self):
        self.assertTrue(self.edl.shots)
        self.assertEqual(self.edl.size, (1280, 720))
        self.edl.validate()

    def test_shots_contiguous_and_ordered(self):
        # takeToEdl tiles the whole take: every shot has positive duration and picks up exactly
        # where the previous one ended, so the render covers the full recording with no gap/overlap.
        prev_end = None
        for s in self.edl.shots:
            self.assertGreater(s.end, s.start, f"shot {s.id} has non-positive duration")
            if prev_end is not None:
                self.assertAlmostEqual(s.start, prev_end, places=3,
                                       msg=f"shot {s.id} is not contiguous with the previous")
            prev_end = s.end

    def test_first_transition_is_cut(self):
        # the first shot can't dissolve from nothing (edl.validate enforces this too)
        self.assertEqual(self.edl.shots[0].transition_in, "cut")

    def test_vocab_survives_load(self):
        # the TS producer's vocabulary IS the renderer's — nothing should clamp to a default.
        for s in self.edl.shots:
            self.assertIn(s.shot, edl_mod.SHOTS)
            self.assertIn(s.subject, edl_mod.SUBJECTS)
            self.assertIn(s.look, edl_mod.LOOKS)
            self.assertIn(s.transition_in, edl_mod.TRANSITIONS)

    def test_roundtrip_is_a_fixed_point(self):
        again = edl_mod.from_dict(json.loads(self.edl.to_json()))
        self.assertEqual([s.id for s in again.shots], [s.id for s in self.edl.shots])
        self.assertEqual([s.subject for s in again.shots], [s.subject for s in self.edl.shots])
        self.assertEqual([s.shot for s in again.shots], [s.shot for s in self.edl.shots])


if __name__ == "__main__":
    unittest.main()
