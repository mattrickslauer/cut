"""Unit tests for the torch-free spine (edl, grade, composite, camera).

Run from backend/:  python -m unittest render.tests.test_render -v
The end-to-end ffmpeg path is covered by `python -m render.cli selfcheck`.
"""
import os
import tempfile
import unittest

import numpy as np

from render import camera, composite, grade
from render import edl as edl_mod


class TestEDL(unittest.TestCase):
    def test_alias_and_clamp(self):
        s = edl_mod.Shot(id="x", start=0, end=2, shot="closeup", look="noir",
                         subject="A", transition_in="dissolve")
        self.assertEqual(s.shot, "CU")
        self.assertEqual(s.look, "Noir")
        self.assertEqual(s.duration, 2.0)

    def test_bad_enum_falls_back(self):
        s = edl_mod.Shot(id="x", start=0, end=1, shot="ZOOMY", look="Rainbow")
        self.assertEqual(s.shot, "WIDE")
        self.assertEqual(s.look, "Neutral")

    def test_end_before_start_raises(self):
        with self.assertRaises(ValueError):
            edl_mod.Shot(id="x", start=2, end=1)

    def test_first_transition_forced_cut(self):
        e = edl_mod.from_dict({"shots": [
            {"id": "a", "start": 0, "end": 1, "transition_in": "fade"},
            {"id": "b", "start": 1, "end": 2, "transition_in": "dissolve"},
        ]})
        self.assertEqual(e.shots[0].transition_in, "cut")
        self.assertEqual(e.shots[1].transition_in, "dissolve")

    def test_empty_edl_raises(self):
        with self.assertRaises(ValueError):
            edl_mod.from_dict({"shots": []})


class TestGrade(unittest.TestCase):
    def test_cube_written_and_sized(self):
        with tempfile.TemporaryDirectory() as d:
            p = grade.ensure_lut("Noir", d)
            self.assertTrue(os.path.exists(p))
            with open(p) as f:
                text = f.read()
            self.assertIn(f"LUT_3D_SIZE {grade.LUT_SIZE}", text)
            n = grade.LUT_SIZE ** 3
            data_lines = [l for l in text.splitlines()
                          if l and l[0].isdigit() or l.startswith("0.")]
            self.assertGreaterEqual(len(data_lines), n)

    def test_neutral_is_identity(self):
        rgb = np.random.rand(50, 3).astype(np.float32)
        out = grade.LOOKS["Neutral"](rgb)
        np.testing.assert_allclose(out, rgb)

    def test_build_all(self):
        with tempfile.TemporaryDirectory() as d:
            luts = grade.build_all(d)
            self.assertEqual(set(luts), set(grade.LOOKS))


class TestComposite(unittest.TestCase):
    def _plain_params(self):
        return composite.CompositeParams(
            erode_px=0, feather_sigma=0.0, wrap_strength=0.0,
            color_blend=0.0, shadow_strength=0.0)

    def test_full_alpha_returns_fg(self):
        h, w = 16, 24
        fgr = np.random.rand(h, w, 3).astype(np.float32)
        bg = np.random.rand(h, w, 3).astype(np.float32)
        pha = np.ones((h, w), np.float32)
        out = composite.composite_frame(fgr, pha, bg, self._plain_params())
        np.testing.assert_allclose(out, fgr, atol=1e-5)

    def test_zero_alpha_returns_bg(self):
        h, w = 16, 24
        fgr = np.random.rand(h, w, 3).astype(np.float32)
        bg = np.random.rand(h, w, 3).astype(np.float32)
        pha = np.zeros((h, w), np.float32)
        out = composite.composite_frame(fgr, pha, bg, self._plain_params())
        np.testing.assert_allclose(out, bg, atol=1e-5)

    def test_output_range_and_shape_full_pipeline(self):
        h, w = 32, 40
        fgr = np.random.rand(h, w, 3).astype(np.float32)
        bg = np.random.rand(h, w, 3).astype(np.float32)
        pha = np.clip(np.random.rand(h, w).astype(np.float32), 0, 1)
        out = composite.composite_frame(fgr, pha, bg)  # all realism on
        self.assertEqual(out.shape, (h, w, 3))
        self.assertGreaterEqual(out.min(), 0.0)
        self.assertLessEqual(out.max(), 1.0)

    def test_reinhard_empty_mask_noop(self):
        fgr = np.random.rand(8, 8, 3).astype(np.float32)
        bg = np.random.rand(8, 8, 3).astype(np.float32)
        out = composite.reinhard(fgr, bg, np.zeros((8, 8), np.float32))
        np.testing.assert_allclose(out, fgr)


class TestCamera(unittest.TestCase):
    def test_frame_shapes_and_range(self):
        cam = camera.ShotCamera(64, 48, shot="WIDE", subject="both")
        fgr = np.random.rand(48, 64, 3).astype(np.float32)
        pha = np.ones((48, 64), np.float32)
        bg = np.random.rand(80, 100, 3).astype(np.float32)
        bgp = cam.prepare_bg(bg)
        fg, a, out_bg = cam.frame(fgr, pha, bgp, t=0.5)
        for arr in (fg, out_bg):
            self.assertEqual(arr.shape, (48, 64, 3))
        self.assertEqual(a.shape, (48, 64))
        self.assertGreaterEqual(min(fg.min(), a.min(), out_bg.min()), 0.0)
        self.assertLessEqual(max(fg.max(), a.max(), out_bg.max()), 1.0)

    def test_closeup_zooms_more_than_wide(self):
        fgr = np.zeros((48, 64, 3), np.float32)
        fgr[20:28, 28:36] = 1.0  # a small bright patch in the center
        pha = np.ones((48, 64), np.float32)
        bg = np.zeros((80, 100, 3), np.float32)
        wide = camera.ShotCamera(64, 48, shot="WIDE")
        cu = camera.ShotCamera(64, 48, shot="CU")
        fw, _, _ = wide.frame(fgr, pha, wide.prepare_bg(bg), t=0.0)
        fc, _, _ = cu.frame(fgr, pha, cu.prepare_bg(bg), t=0.0)
        # a closer shot magnifies the patch -> more bright pixels
        self.assertGreater((fc > 0.5).sum(), (fw > 0.5).sum())

    def test_ease_endpoints(self):
        self.assertAlmostEqual(camera.ease_in_out(0.0), 0.0)
        self.assertAlmostEqual(camera.ease_in_out(1.0), 1.0)
        self.assertTrue(0.0 <= camera.ease_in_out(0.5) <= 1.0)


if __name__ == "__main__":
    unittest.main()
