# WhatIfStudio - EP001 "What If AI Disappeared Overnight?"

> The steps below are the original 24 fps / 288-frame v1 flow, kept for reference. For the current cut, see
> `CLAUDE.md` and the checks in `tools/pipeline/README.md` (preflight, manifest, resume, safe assembly).
> `tools/render_final.bat` is deprecated: background `blender -b` renders crash on this laptop.

Run inside the open Blender session (MCP / Text Editor). Background `blender -b` renders
crashed on this laptop's Intel iGPU (0xC0000409), so render from the interactive session.

    T = r"C:\Users\User\Documents\Blender\WhatIfStudio\tools"
    def run(name, args=None):
        p = T + "\\" + name
        exec(open(p, encoding="utf-8").read(), {"__file__": p, "__name__": "__main__", "ARGS": args})

1. run("build_city.py")                      -> scene EP001_City + master_city.blend checkpoint
2. run("animate_episode.py", {"preview": True}) -> episode.blend + previews/shot_0N_fXXX.png
   run("animate_episode.py", {"test": (160, 171)}) -> previews/test/ short range
3. Final frames (720x1280, 32 samples), skips frames that already exist:
       sc = bpy.data.scenes["EP001_City"]; sc.frame_start, sc.frame_end = 1, 72
       bpy.ops.render.render(animation=True)      # repeat for 73-144, 145-216, 217-288
4. Drop narration/SFX (.wav/.mp3/.m4a) in episodes/ai_disappeared/audio/ (optional)
5. python tools/assemble_video.py            -> output/ai_disappeared_9x16.mp4 + validation
