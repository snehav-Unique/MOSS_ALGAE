import unittest
from .model import capture, local_balance, uncertainty, lifecycle, optimize, series_efficiency, staged_capture
class PhysicsTests(unittest.TestCase):
    def test_series_efficiency_avoids_double_counting(self):
        self.assertAlmostEqual(series_efficiency(0.4,0.3),0.58)

    def test_staged_capture_sums_stage_contributions(self):
        result=staged_capture(500,0.4,0.3,50,2)
        self.assertAlmostEqual(result['moss_cadr_m3_h_per_unit'],200)
        self.assertAlmostEqual(result['algae_incremental_cadr_m3_h_per_unit'],90)
        self.assertAlmostEqual(result['combined_cadr_m3_h_per_unit'],290)
        self.assertAlmostEqual(result['combined_mass_g_day'],result['moss_mass_g_day']+result['algae_mass_g_day'])
    def test_units(self):
        self.assertEqual(capture(1000,.5,100,2)['mass_g_day'],2.4)
    def test_zero_filter_conservation(self):
        self.assertAlmostEqual(local_balance(20,20,0,100,1000,0,24),20)
    def test_no_loss_source(self):
        self.assertEqual(local_balance(20,0,1000,0,1000,0,2),22)
    def test_filter_decreases_concentration(self):
        self.assertLess(local_balance(20,20,0,100,1000,100,24),20)
    def test_reproducible_intervals(self):
        self.assertEqual(uncertainty(100,[.2,.3]*10,10),uncertainty(100,[.2,.3]*10,10))
    def test_economics(self):self.assertEqual(lifecycle(100,10,2,5,2,0),150)
    def test_optimal_budget(self):
        result=optimize([{'id':'a','cost':10,'scores':[1]*4},{'id':'b','cost':5,'scores':[.7]*4}], [1]*4,10)
        self.assertEqual(result['selected'],['a'])
    def test_invalid_efficiency(self):
        with self.assertRaises(ValueError):capture(100,1.2,20)
if __name__=='__main__':unittest.main()
