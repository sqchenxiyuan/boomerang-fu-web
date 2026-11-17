import { describe, expect, it } from 'vitest';
import { SFX_CATALOG } from '../src/devtools/sfx-catalog';

describe('dev/sfx.html catalog', () => {
  it('lists each FMOD event once, under the group its path names', () => {
    const paths = SFX_CATALOG.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of SFX_CATALOG) {
      expect(entry.path).toMatch(/^event:\/[a-z]+\/[a-z0-9_]+$/);
      expect(entry.path.split('/')[1]).toBe(entry.group);
    }
  });
  it('gives every Web counterpart either events or a music scene', () => {
    for (const entry of SFX_CATALOG)
      for (const sound of entry.web)
        expect(!!sound.scene || (sound.events?.length ?? 0) > 0).toBe(true);
  });
});
