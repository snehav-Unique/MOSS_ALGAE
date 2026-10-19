"""Units: m³/h, µg/m³, hours, grams. No fitted coefficients shipped."""
import math
import random

def capture(flow, efficiency, concentration, count=1):
    if min(flow, concentration, count) < 0 or not 0 <= efficiency <= 1:
        raise ValueError('Invalid physical input')
    cadr = flow * efficiency
    return {'cadr_m3_h_per_unit': cadr, 'mass_g_day': cadr * concentration * count * 24 / 1e6}

def series_efficiency(moss_efficiency, algae_efficiency):
    """Two sequential stages; algae treats only the fraction remaining after moss."""
    if not 0 <= moss_efficiency <= 1 or not 0 <= algae_efficiency <= 1:
        raise ValueError('Stage efficiencies must be between zero and one')
    return 1 - (1 - moss_efficiency) * (1 - algae_efficiency)

def staged_capture(flow, moss_efficiency, algae_efficiency, concentration, count=1):
    if min(flow, concentration, count) < 0:
        raise ValueError('Invalid physical input')
    combined = series_efficiency(moss_efficiency, algae_efficiency)
    moss_cadr = flow * moss_efficiency
    algae_cadr = flow * (1 - moss_efficiency) * algae_efficiency
    scale = concentration * count * 24 / 1e6
    return {
        'combined_efficiency': combined,
        'moss_cadr_m3_h_per_unit': moss_cadr,
        'algae_incremental_cadr_m3_h_per_unit': algae_cadr,
        'combined_cadr_m3_h_per_unit': moss_cadr + algae_cadr,
        'moss_mass_g_day': moss_cadr * scale,
        'algae_mass_g_day': algae_cadr * scale,
        'combined_mass_g_day': (moss_cadr + algae_cadr) * scale,
    }

def local_balance(initial, background, source_ug_h, ventilation_m3_h, volume_m3, cadr_m3_h, hours):
    """Exact well-mixed box solution; caller supplies independently calibrated inputs."""
    if volume_m3 <= 0 or min(initial, background, source_ug_h, ventilation_m3_h, cadr_m3_h, hours) < 0:
        raise ValueError('Invalid mass balance input')
    loss = ventilation_m3_h + cadr_m3_h
    if loss == 0:
        return initial + source_ug_h * hours / volume_m3
    steady = (source_ug_h + ventilation_m3_h * background) / loss
    return steady + (initial - steady) * math.exp(-loss * hours / volume_m3)

def uncertainty(flow, efficiency_samples, concentration, count=1, seed=42):
    if len(efficiency_samples) < 10:
        raise ValueError('At least ten measured efficiency replicates required')
    rng = random.Random(seed)
    values = sorted(capture(flow, rng.choice(efficiency_samples), concentration, count)['mass_g_day'] for _ in range(2000))
    return {'p025': values[49], 'p50': values[999], 'p975': values[1949], 'seed': seed, 'method': 'empirical input resampling; excludes transport uncertainty'}

def lifecycle(capex, annual_energy_kwh, tariff, annual_maintenance, years, discount):
    if min(capex, annual_energy_kwh, tariff, annual_maintenance, years, discount) < 0:
        raise ValueError('Nonnegative economics inputs required')
    return capex + sum((annual_energy_kwh * tariff + annual_maintenance) / (1 + discount)**year for year in range(1, years + 1))

def optimize(candidates, weights, budget):
    """Exact budget-constrained additive utility; scores must be validated, higher-is-better [0,1]."""
    if not 0 < len(candidates) <= 20 or len(weights) != 4 or min(weights) < 0 or sum(weights) <= 0 or budget < 0:
        raise ValueError('Provide 1–20 candidates, four nonnegative weights, positive weight sum and nonnegative budget')
    for c in candidates:
        if c['cost'] < 0 or len(c['scores']) != 4 or any(not 0 <= s <= 1 for s in c['scores']):
            raise ValueError('Invalid candidate cost or scores')
    w = [v/sum(weights) for v in weights]
    best = (0, [])
    for mask in range(1 << len(candidates)):
        selected = [c for i,c in enumerate(candidates) if mask & (1 << i)]
        if sum(c['cost'] for c in selected) <= budget:
            utility = sum(sum(a*b for a,b in zip(c['scores'], w)) for c in selected)
            if utility > best[0]: best = (utility, [c['id'] for c in selected])
    return {'utility': best[0], 'selected': best[1], 'normalized_weights': w}
