/**
 * Tests for the vertical config loader.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadVerticals,
  getVertical,
  listVerticals,
  _resetCache,
} from './loader.js';

function writeTmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verticals-test-'));
  const filePath = join(dir, 'verticals.yml');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeEach(() => {
  _resetCache();
});

afterEach(() => {
  _resetCache();
});

describe('loadVerticals', () => {
  it('loads a valid YAML with _default and a single vertical', () => {
    const yml = `
_default:
  evaluator_skill: generic-deal-evaluator
  sources: []
  default_poll_minutes: 60
  criteria_schema: {}

computers:
  inherit: _default
  evaluator_skill: listing-evaluation
  sources: [ebay]
  default_poll_minutes: 5
`;
    const path = writeTmpYaml(yml);
    const map = loadVerticals(path);

    expect(map.size).toBe(1);
    const computers = map.get('computers');
    expect(computers).toBeDefined();
    expect(computers!.evaluator_skill).toBe('listing-evaluation');
    expect(computers!.sources).toEqual(['ebay']);
    expect(computers!.default_poll_minutes).toBe(5);
    expect(computers!.name).toBe('computers');
  });

  it('inherit: _default merges correctly — child overrides parent', () => {
    const yml = `
_default:
  evaluator_skill: generic-deal-evaluator
  sources: []
  default_poll_minutes: 60
  criteria_schema: { keyword: true }

cars:
  inherit: _default
  evaluator_skill: car-listing-evaluation
  sources: [autotrader]
  default_poll_minutes: 360
  criteria_schema: { make: true, model: true }
  notification_formatter: cars
  attributes_required: [year, mileage_num]
`;
    const path = writeTmpYaml(yml);
    const map = loadVerticals(path);

    const cars = map.get('cars');
    expect(cars).toBeDefined();
    expect(cars!.evaluator_skill).toBe('car-listing-evaluation');
    expect(cars!.sources).toEqual(['autotrader']);
    expect(cars!.default_poll_minutes).toBe(360);
    // criteria_schema from child (not merged with parent)
    expect(cars!.criteria_schema).toEqual({ make: true, model: true });
    expect(cars!.notification_formatter).toBe('cars');
    expect(cars!.attributes_required).toEqual(['year', 'mileage_num']);
    // _default should NOT appear in results
    expect(map.has('_default')).toBe(false);
  });

  it('inherit fields come from parent when child does not override', () => {
    const yml = `
_default:
  evaluator_skill: generic-deal-evaluator
  sources: [some-default-source]
  default_poll_minutes: 60
  criteria_schema: {}

minimal:
  inherit: _default
`;
    const path = writeTmpYaml(yml);
    const map = loadVerticals(path);
    const minimal = map.get('minimal');
    expect(minimal!.evaluator_skill).toBe('generic-deal-evaluator');
    expect(minimal!.sources).toEqual(['some-default-source']);
    expect(minimal!.default_poll_minutes).toBe(60);
  });

  it('throws when _default is missing', () => {
    const yml = `
computers:
  evaluator_skill: listing-evaluation
  sources: [ebay]
`;
    const path = writeTmpYaml(yml);
    expect(() => loadVerticals(path)).toThrow('_default');
  });

  it('throws when _default is missing evaluator_skill', () => {
    const yml = `
_default:
  sources: []
  default_poll_minutes: 60
`;
    const path = writeTmpYaml(yml);
    expect(() => loadVerticals(path)).toThrow('evaluator_skill');
  });

  it('throws on circular inherit (direct self-reference)', () => {
    const yml = `
_default:
  evaluator_skill: generic

foo:
  inherit: foo
  evaluator_skill: something
`;
    const path = writeTmpYaml(yml);
    expect(() => loadVerticals(path)).toThrow(/[Cc]ircular/);
  });

  it('throws on circular inherit (A → B → A)', () => {
    const yml = `
_default:
  evaluator_skill: generic

alpha:
  inherit: beta
  evaluator_skill: alpha-skill

beta:
  inherit: alpha
  evaluator_skill: beta-skill
`;
    const path = writeTmpYaml(yml);
    expect(() => loadVerticals(path)).toThrow(/[Cc]ircular/);
  });

  it('throws on inherit referencing unknown key', () => {
    const yml = `
_default:
  evaluator_skill: generic

computers:
  inherit: nonexistent
  evaluator_skill: listing-evaluation
`;
    const path = writeTmpYaml(yml);
    expect(() => loadVerticals(path)).toThrow(/unknown/);
  });

  it('throws when vertical after inherit still lacks evaluator_skill', () => {
    const yml = `
_default:
  sources: []
  default_poll_minutes: 60
  evaluator_skill: generic

orphan:
  evaluator_skill: ''
`;
    // evaluator_skill: '' is a falsy empty string — should throw
    const path = writeTmpYaml(yml);
    // This particular edge case depends on whether empty string is falsy
    // The spec says missing evaluator_skill should throw
    // We just verify it either succeeds with empty string or throws — either is reasonable
    // but our implementation treats empty string as falsy, so it should throw
    expect(() => loadVerticals(path)).toThrow(/evaluator_skill/);
  });
});

describe('getVertical', () => {
  it('returns a vertical by name', () => {
    const yml = `
_default:
  evaluator_skill: generic-deal-evaluator
  sources: []
  default_poll_minutes: 60
  criteria_schema: {}

computers:
  inherit: _default
  evaluator_skill: listing-evaluation
  sources: [ebay]
  default_poll_minutes: 5
`;
    const path = writeTmpYaml(yml);
    // Pre-load with path to set cache
    loadVerticals(path);
    // getVertical uses cache set by _resetCache/getVerticals — call with explicit path
    const v = getVertical('computers', path);
    expect(v.name).toBe('computers');
    expect(v.evaluator_skill).toBe('listing-evaluation');
  });

  it('throws for unknown vertical name', () => {
    const yml = `
_default:
  evaluator_skill: generic
  sources: []
  default_poll_minutes: 60
  criteria_schema: {}

computers:
  inherit: _default
  evaluator_skill: listing-evaluation
  sources: [ebay]
`;
    const path = writeTmpYaml(yml);
    loadVerticals(path);
    expect(() => getVertical('cookers', path)).toThrow(/Unknown vertical/);
  });
});

describe('listVerticals', () => {
  it('returns all non-default verticals', () => {
    const yml = `
_default:
  evaluator_skill: generic
  sources: []
  default_poll_minutes: 60
  criteria_schema: {}

alpha:
  inherit: _default
  evaluator_skill: alpha-skill
  sources: []

beta:
  inherit: _default
  evaluator_skill: beta-skill
  sources: []
`;
    const path = writeTmpYaml(yml);
    loadVerticals(path);
    const list = listVerticals(path);
    expect(list.length).toBe(2);
    const names = list.map((v) => v.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });
});
