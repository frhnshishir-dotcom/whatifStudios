import { OBJECT_DEFS } from '../src/engine/objects/defs';
import type { RegionData } from '../src/world/terrain';

/** Solid and deck cells of a generated region, from its objects' footprints. */
export function masksOf(r: RegionData): { solid: Uint8Array; deck: Uint8Array } {
  const solid = new Uint8Array(256 * 256), deck = new Uint8Array(256 * 256);
  for (const o of r.objects) {
    const def = OBJECT_DEFS[o.kind as keyof typeof OBJECT_DEFS];
    if (!def || (!def.solid && o.kind !== 'span')) continue;
    const wo = { id: 0, kind: o.kind, x: o.x, y: o.y, variant: o.variant, props: { ...def.defaults, ...(o.props ?? {}) } } as Parameters<typeof def.footprint>[0];
    for (const [dx, dy] of def.footprint(wo)) {
      const x = o.x + dx, y = o.y + dy;
      if (x < 0 || y < 0 || x >= 256 || y >= 256) continue;
      (o.kind === 'span' ? deck : solid)[y * 256 + x] = 1;
    }
  }
  return { solid, deck };
}

