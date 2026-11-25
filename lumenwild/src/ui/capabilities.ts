import { WebGLPresenter } from '../engine/render/WebGLPresenter';

export interface Capabilities {
  userAgent: string;
  platform: string;
  cores: number;
  /** navigator.deviceMemory (GB, rounded and capped at 8 by Chromium browsers; null elsewhere). */
  deviceMemoryGB: number | null;
  /** Chromium only: the JS heap limit in MB. */
  jsHeapLimitMB: number | null;
  devicePixelRatio: number;
  screen: string;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  webgl2: boolean;
  /** Why the WebGL2 presenter cannot run (null when it can). */
  webgl2Problem: string | null;
  gpuRenderer: string | null;
  gpuVendor: string | null;
  maxTextureSize: number | null;
  maxArrayTextureLayers: number | null;
  maxTextureUnits: number | null;
  floatRenderTargets: boolean;
  timerQuery: boolean;
}

/** What this browser and machine offer, read without changing anything (one throwaway WebGL2 context). */
export function probeCapabilities(): Capabilities {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  const mem = (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory;
  const caps: Capabilities = {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform ?? '',
    cores: nav.hardwareConcurrency ?? 0,
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    jsHeapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
    devicePixelRatio: window.devicePixelRatio || 1,
    screen: `${screen.width}x${screen.height}`,
    crossOriginIsolated: !!window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    webgl2: false,
    webgl2Problem: WebGLPresenter.probe(),
    gpuRenderer: null, gpuVendor: null, maxTextureSize: null, maxArrayTextureLayers: null, maxTextureUnits: null,
    floatRenderTargets: false, timerQuery: false,
  };
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      caps.webgl2 = true;
      const d = WebGLPresenter.describe(gl);
      caps.gpuRenderer = d.renderer;
      caps.gpuVendor = d.vendor;
      caps.maxTextureSize = d.maxTextureSize;
      caps.maxArrayTextureLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
      caps.maxTextureUnits = Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
      caps.floatRenderTargets = !!gl.getExtension('EXT_color_buffer_float');
      caps.timerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* report what we have */ }
  return caps;
}
