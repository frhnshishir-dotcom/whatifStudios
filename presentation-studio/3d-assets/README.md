# 3D assets

- **Web viewer:** `web/viewer.src.js` is bundled into `../assets/vendor/studio-viewer.js`. Its kinds are `globe`, `device`, `sculpture`, `orbits`, and `glb` (any model).
  - Rebuild the bundle with `npm i three@0.170.0 esbuild@0.24.2`, then `npx esbuild entry.js --bundle --minify --format=iife --outfile=../assets/vendor/studio-viewer.js`, where `entry.js` does `import {mount} from "./viewer.src.js"; window.StudioViewer={mount}`.
- **Stills:** `node web/render_still.cjs out.png --kind sculpture --w 1600 --h 1600 [--transparent] [--glb model.glb]`
- **Blender** (the laptop, through Blender MCP, inside the open session):
  - **Product turntable:** EEVEE, 1280×720 preview at 16 samples, then 1920×1080 at 32 samples. Render it as a PNG sequence, then `ffmpeg -framerate 30 -i f_%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p turntable.mp4`, and use it in a `video` or `product` slide.
  - **Model for the web viewer:** File → Export → glTF Binary (.glb), with Draco off and textures at 1–2k max. Reference it as `"viewer": {"glb": "assets/model.glb"}`.
  - **Exploded view:** keyframe the parts outward along their local axes over 2 s, and render a turntable plus the exploded hold.
  - Never run `blender -b` on this laptop: it crashes on the iGPU, see the repo `CLAUDE.md`.
- **Free models and HDRIs:** Poly Haven (CC0, `api.polyhaven.com` is reachable from cloud sessions).
