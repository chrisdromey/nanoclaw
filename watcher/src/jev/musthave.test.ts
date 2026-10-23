import { describe, it, expect } from 'vitest';
import { buildMustHaveRequest, extractKbCues, mapMustHaveAnswers } from './musthave.js';

const features = [
  { category: 'Drivers Assistance', items: [{ name: 'Parking Assistance - Front and Rear', type: 'Standard' }] },
  { category: 'Other', items: [
    { name: 'Cruise Control and Adjustable Speed Limiter with Speed Sign Support', type: 'Standard' },
    { name: 'Lane Keeping Aid with Steering Support', type: 'Standard' },
    { name: 'Plus Pack', type: 'Optional' },
  ] },
];
const mustHaves = ['Adaptive Cruise Control (ACC)', 'Lane Keep Assist or Lane Centering'];

describe('buildMustHaveRequest', () => {
  it('lists derivative, feature lines and matching description sentences as candidates', () => {
    const built = buildMustHaveRequest({
      mustHaves, features,
      subTitle: 'Long Range Plus Pilot Fastback',
      description: 'Lovely car. Comes with adaptive cruise control fitted. Full history.',
    });
    expect(built.candidates.mh0[0]).toBe('Derivative: Long Range Plus Pilot Fastback');
    expect(built.candidates.mh0).toContain('Other / Plus Pack (Optional)');
    expect(built.candidates.mh0.at(-1)).toBe('Description: "Comes with adaptive cruise control fitted."');
    expect(built.candidates.mh1.some((l) => l.startsWith('Description:'))).toBe(false);
    expect(Object.keys(built.questions)).toEqual(['mh0', 'mh1', 'features_populated']);
  });

  it('adds a kb_standard question per requirement when the KB mentions it', () => {
    const built = buildMustHaveRequest({ mustHaves, features, kbText: '## Autopilot, ACC & Lane Centering\nAutosteer (lane centering) is standard.\n\n## Battery\n75kWh.' });
    expect(Object.keys(built.questions)).toEqual(['mh0', 'mh0_kb_fit', 'mh1', 'mh1_kb_fit', 'features_populated']);
  });
});

describe('extractKbCues', () => {
  const kb = [
    '# Tesla Model 3', '', '## 1. Trims', 'Standard Range Plus, Long Range, Performance.', '',
    '## 2. Autopilot, ACC & Lane Centering', 'Autopilot includes TACC and Autosteer.', '',
    '## 4. Battery', 'Traffic-aware cruise control (TACC) is the adaptive cruise control.', 'Heat pump from 2021.',
  ].join('\n');
  it('keeps matching sections whole and matching lines from elsewhere', () => {
    const cues = extractKbCues(kb, 'Adaptive Cruise Control (ACC)')!;
    expect(cues).toContain('Autopilot includes TACC and Autosteer.');
    expect(cues).toContain('## 4. Battery\nTraffic-aware cruise control (TACC) is the adaptive cruise control.');
    expect(cues).not.toContain('Heat pump');
    expect(cues).not.toContain('Standard Range Plus');
  });
  it('returns null when nothing matches', () => {
    expect(extractKbCues('## Battery\n75kWh.', 'Heat pump')).toBeNull();
  });
});

describe('mapMustHaveAnswers', () => {
  const built = buildMustHaveRequest({ mustHaves, features });
  const noul = { type: 'noul' as const, noul: 0.95 };
  const pick = (choice: string, confidence: number) => ({
    type: 'choice' as const, choice, confidence,
    probabilities: { [choice]: confidence, none: choice === 'none' ? confidence : 1 - confidence },
  });

  it('copies the chosen line verbatim as evidence', () => {
    const [acc, lane] = mapMustHaveAnswers(built, mustHaves, { mh0: pick('none', 0.99), mh1: pick('c2', 0.9), features_populated: noul });
    const kbFit = { type: 'choice' as const, choice: 'standard_all_versions', confidence: 0.9, probabilities: { standard_all_versions: 0.9, trim_or_pack_dependent: 0.05, not_available: 0, cues_do_not_say: 0.05 } };
    const [accStd] = mapMustHaveAnswers(built, mustHaves, { mh0: pick('none', 0.99), mh0_kb_fit: kbFit, mh1: pick('c2', 0.9), features_populated: noul });
    expect(accStd).toMatchObject({ verdict: 'verified', confidence: 0.9 });
    expect(accStd.evidence).toMatch(/Standard-fit per knowledge base/);
    // Weak listing pick (derivative line at 0.7) + KB standard-fit → verified via KB too.
    const [weak] = mapMustHaveAnswers(built, mustHaves, { mh0: pick('c0', 0.7), mh0_kb_fit: kbFit, mh1: pick('c2', 0.9), features_populated: noul });
    expect(weak.verdict).toBe('verified');
    expect(acc).toMatchObject({ verdict: 'contradicted', evidence: 'Not in the listed equipment (4 lines checked)' });
    expect(lane).toMatchObject({ verdict: 'verified', evidence: 'Other / Lane Keeping Aid with Steering Support (Standard)' });
    expect(lane.probabilities[0]).toEqual({ label: 'Other / Lane Keeping Aid with Steering Support (Standard)', p: 0.9 });
  });

  it('verifies when two valid lines split the mass but P(none) is small', () => {
    const split = { type: 'choice' as const, choice: 'c2', confidence: 0.55, probabilities: { c2: 0.55, c0: 0.35, none: 0.1 } };
    const [, lane] = mapMustHaveAnswers(built, mustHaves, { mh0: pick('none', 0.99), mh1: split, features_populated: noul });
    expect(lane).toMatchObject({ verdict: 'verified', confidence: 0.9 });
  });

  it('falls back to unverified on low confidence or an empty feature list', () => {
    const r = mapMustHaveAnswers(built, mustHaves, { mh0: pick('c1', 0.6), mh1: pick('none', 0.95), features_populated: { type: 'noul', noul: 0.2 } });
    expect(r.map((c) => c.verdict)).toEqual(['unverified', 'unverified']);
    expect(r[0].evidence).toBe('Other / Cruise Control and Adjustable Speed Limiter with Speed Sign Support (Standard)');
  });
});
