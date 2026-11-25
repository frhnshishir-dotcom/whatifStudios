import { Canvas2DPresenter } from './Canvas2DPresenter';
import { WebGLPresenter } from './WebGLPresenter';
import { AtlasCache, type Presenter, type PresenterKind } from './Presenter';

/**
 * Create the requested presenter, falling back to Canvas 2D when WebGL2 is missing or its shaders fail. The probe
 * runs on a throwaway canvas first, so the real canvas never ends up holding an unusable WebGL context.
 * `fallback` is the reason the request could not be met, or null.
 */
export function createPresenter(canvas: HTMLCanvasElement, want: PresenterKind, atlases = new AtlasCache()): { presenter: Presenter; fallback: string | null } {
  let fallback: string | null = null;
  if (want === 'webgl2') {
    fallback = WebGLPresenter.probe();
    if (!fallback) return { presenter: new WebGLPresenter(canvas, atlases), fallback: null };
    console.warn(`Lumenwild: WebGL2 presenter unavailable (${fallback}); using Canvas 2D.`);
  }
  return { presenter: new Canvas2DPresenter(canvas, atlases), fallback };
}
