"""
WhatIfStudio EP001 - animate_episode.py
Adds 4 shot cameras + the story (signs die, signals die, traffic stops, city dims)
to scene "EP001_City", then writes episodes/ai_disappeared/episode.blend
(previous version is copied to checkpoints/ first). Final render settings are stored
in episode.blend: 720x1280, 24 fps, 32 samples, PNG -> frames/frame_####.png

Interactive (Blender MCP): set ARGS before exec, e.g.
    ARGS = {"preview": True}                      # one still per shot (540x960, 12 samples)
    ARGS = {"test": (185, 196)}                   # short preview range
    ARGS = {"final_range": (1, 72)}               # spawn background render of frames
    p = r"...\\tools\\animate_episode.py"; exec(open(p).read(), {"__file__": p, "ARGS": ARGS})
Background:
    blender -b master_city.blend -P tools/animate_episode.py -- --preview
"""
import bpy, math, random, shutil, subprocess, sys, time, argparse
from pathlib import Path

ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
EPISODE = "ai_disappeared_v2"
EP = ROOT / "episodes" / EPISODE
SCENE_NAME = "EP001_City_v2"
SHOT_LEN = 72

A = dict(globals().get("ARGS") or {})
if "--" in sys.argv:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--test", type=str, default="")
    ns = ap.parse_args(sys.argv[sys.argv.index("--") + 1:])
    A["preview"] = ns.preview
    if ns.test:
        A["test"] = tuple(int(v) for v in ns.test.split("-"))
for sub in ("scripts", "previews", "previews/test", "frames", "audio", "output", "checkpoints", "logs"):
    (EP / sub).mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- scene
scene = bpy.data.scenes.get(SCENE_NAME)
if scene is None:
    with bpy.data.libraries.load(str(ROOT / "master_city_v2.blend")) as (src, dst):
        dst.scenes = [SCENE_NAME]
    scene = bpy.data.scenes[SCENE_NAME]
if bpy.context.window:
    bpy.context.window.scene = scene
random.seed(11)
OBJ = bpy.data.objects
tag = lambda idb: (idb.__setitem__("whatif_v2", 1), idb)[1]

# remove previous shot rig / title / animation (only our own)
for ob in [o for o in OBJ if o.get("whatif_v2_shot")]:
    OBJ.remove(ob, do_unlink=True)
scene.timeline_markers.clear()
for mat in bpy.data.materials:
    if mat.get("whatif_v2") and mat.node_tree and mat.node_tree.animation_data:
        mat.node_tree.animation_data_clear()
for ob in OBJ:
    if ob.get("whatif_v2") and ob.animation_data:
        ob.animation_data_clear()
for li in bpy.data.lights:
    if li.get("whatif_v2") and li.animation_data:
        li.animation_data_clear()

# ---------------------------------------------------------------- key helpers
def power(mat_name, node="Power"):
    return bpy.data.materials[mat_name].node_tree.nodes[node].outputs[0]

def key(sock, f, v):
    sock.default_value = v
    sock.keyframe_insert("default_value", frame=f)

def step(sock, f, v):
    """Hard switch (hold previous value until f-1)."""
    key(sock, f - 1, sock.default_value)
    key(sock, f, v)

def flicker_off(sock, start, on, n=3):
    for k in range(n):
        step(sock, start + k * 3, 0.15 * on)
        step(sock, start + k * 3 + 1, on)
    step(sock, start + n * 3 + 1, 0.0)

# ---------------------------------------------------------------- shots
SHOTS = [
    dict(name="Aerial_Approach",   lens=35, cam=[(60, -300, 118), (30, -190, 74)],  aim=[(0, 12, 30), (0, 12, 27)]),
    dict(name="Billboards",        lens=20, cam=[(0, -80, 36), (0, -34, 19)],      aim=[(0, 10, 22), (0, 10, 20)]),
    dict(name="Intersection",      lens=38, cam=[(-54, -7.4, 1.7), (-39, -7.2, 1.65)], aim=[(0, -0.5, 8.5), (-2, -0.5, 7.4)]),
    dict(name="Skyline_Pullback",  lens=35, cam=[(0, -24, 8), (0, -215, 58)],      aim=[(0, 0, 4), (0, 30, 62)]),
]
cams_coll = bpy.data.collections["CAMERAS"]
for i, s in enumerate(SHOTS):
    f0, f1 = 1 + i * SHOT_LEN, (i + 1) * SHOT_LEN
    s["range"] = (f0, f1)
    aim = tag(OBJ.new(f"CAM_{i+1:02d}_{s['name']}_Aim", None)); aim["whatif_v2_shot"] = 1
    cd = tag(bpy.data.cameras.new(f"CAM_{i+1:02d}_{s['name']}"))
    cd.lens, cd.clip_start, cd.clip_end = s["lens"], (0.1 if s["name"] == "Intersection" else 1.0), 6000   # depth precision for aerials
    cd.dof.use_dof = False
    cam = tag(OBJ.new(f"CAM_{i+1:02d}_{s['name']}", cd)); cam["whatif_v2_shot"] = 1
    cams_coll.objects.link(aim); cams_coll.objects.link(cam)
    c = cam.constraints.new("TRACK_TO"); c.target = aim
    c.track_axis, c.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    for f, pc, pa in ((f0, s["cam"][0], s["aim"][0]), (f1, s["cam"][1], s["aim"][1])):
        cam.location = pc; cam.keyframe_insert("location", frame=f)      # bezier = eased
        aim.location = pa; aim.keyframe_insert("location", frame=f)
    scene.timeline_markers.new(f"SHOT_{i+1}_{s['name']}", frame=f0).camera = cam
    s["cam_obj"] = cam
scene.camera = SHOTS[0]["cam_obj"]

# ---------------------------------------------------------------- the story
FAC = [m.name for m in bpy.data.materials if m.get("whatif_v2") and m.node_tree and "CityPower" in m.node_tree.nodes]
for m in FAC:
    key(power(m, "CityPower"), 1, 1.0)
    key(power(m, "CityPower"), 217, 1.0)
    key(power(m, "CityPower"), 288, 0.25)            # the city dims "overnight"

# Shot 2: billboards die one after another
off_frames = [92, 104, 116, 128]
for si, f in enumerate(off_frames, start=1):
    for part, on in (("Panel", 2.6), ("Text", 6.0)):
        sk = power(f"MAT_Sign_{si}_{part}")
        key(sk, 1, on)
        flicker_off(sk, f, on)

# Shot 3: traffic signals die, then traffic stops
sig = power("MAT_Signal_Green", "SignalPower")
key(sig, 1, 6.0)
flicker_off(sig, 160, 6.0, n=2)

V, T_STOP, T_BRAKE = 0.45, 196, 46        # m/frame, stop frame, braking frames
for ob in [o for o in OBJ if o.get("whatif_v2") and o.name.startswith("CAR_") and o.get("moving")]:
    hd = ob["heading"]
    d = (math.cos(hd), math.sin(hd))
    from mathutils import Vector
    start = Vector(ob["start"])
    t_brake = T_STOP - T_BRAKE
    for f in list(range(1, T_STOP + 1, 3)) + [T_STOP]:
        t = f - 1
        if f <= t_brake:
            s_ = V * t
        else:
            tb = f - t_brake
            s_ = V * (t_brake - 1) + V * (tb - tb * tb / (2 * T_BRAKE))
        ob.location = (start.x + d[0] * s_, start.y + d[1] * s_, start.z)
        ob.keyframe_insert("location", frame=f)
    ob.location = start
    ob.keyframe_insert("location", frame=0)

# ---------------------------------------------------------------- closing title (GRAPHICS)
old_t = bpy.data.materials.get("MAT_Title")
if old_t and old_t.get("whatif_v2"):
    bpy.data.materials.remove(old_t)
old_c = bpy.data.curves.get("TITLE_Closing")
if old_c and old_c.get("whatif_v2") and old_c.users == 0:
    bpy.data.curves.remove(old_c)
tmat = tag(bpy.data.materials.new("MAT_Title"))
tmat.use_nodes = True
nt = tmat.node_tree; nt.nodes.clear()
o = nt.nodes.new("ShaderNodeOutputMaterial"); mx = nt.nodes.new("ShaderNodeMixShader")
tr = nt.nodes.new("ShaderNodeBsdfTransparent"); em = nt.nodes.new("ShaderNodeEmission")
fade = nt.nodes.new("ShaderNodeValue"); fade.name = fade.label = "TitleFade"
em.inputs["Color"].default_value = (1, 0.97, 0.92, 1); em.inputs["Strength"].default_value = 3.0
nt.links.new(fade.outputs[0], mx.inputs[0]); nt.links.new(tr.outputs[0], mx.inputs[1])
nt.links.new(em.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], o.inputs[0])
for attr, val in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED"), ("shadow_method", "NONE")):
    if hasattr(tmat, attr):
        try: setattr(tmat, attr, val)
        except Exception: pass
cu = tag(bpy.data.curves.new("TITLE_Closing", "FONT"))
cu.body, cu.size, cu.align_x, cu.align_y, cu.space_line = "WHAT IF AI\nDISAPPEARED\nOVERNIGHT?", 0.18, "CENTER", "CENTER", 0.9
cu.materials.append(tmat)
title = tag(OBJ.new("TITLE_Closing", cu)); title["whatif_v2_shot"] = 1
bpy.data.collections["GRAPHICS"].objects.link(title)
title.parent = SHOTS[3]["cam_obj"]
title.location = (0, 0.95, -3.2)
if hasattr(title, "visible_shadow"):
    title.visible_shadow = False
key(fade.outputs[0], 1, 0.0); key(fade.outputs[0], 240, 0.0); key(fade.outputs[0], 262, 1.0)

# ---------------------------------------------------------------- final render settings (stored)
def final_settings():
    r = scene.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 720, 1280, 100
    r.fps, scene.frame_start, scene.frame_end = 24, 1, 288
    scene.eevee.taa_render_samples = 32
    r.use_motion_blur = False
    r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGB"
    r.filepath = str(EP / "frames" / "frame_")
    r.use_overwrite, r.use_placeholder = False, False   # re-runs only fill missing frames

def preview_settings():
    scene.render.resolution_x, scene.render.resolution_y = 540, 960
    scene.eevee.taa_render_samples = 12

final_settings()
ep_file = EP / "episode.blend"
if ep_file.exists():
    shutil.copy2(ep_file, EP / "checkpoints" / f"episode_{time.strftime('%Y%m%d_%H%M%S')}.blend")
bpy.data.libraries.write(str(ep_file), {scene}, path_remap="NONE", compress=True)
result = {"episode": str(ep_file), "frames": "1-288", "shots": [(s["name"], s["range"]) for s in SHOTS]}

# ---------------------------------------------------------------- previews / tests
if A.get("preview") or A.get("test"):
    preview_settings()
    times = {}
    if A.get("preview"):
        for i, f in enumerate(A.get("frames", [36, 110, 192, 280])):
            scene.frame_set(f)
            scene.render.filepath = str(EP / "previews" / f"{A.get('prefix', 'preview')}_f{f:03d}.png")
            t = time.time(); bpy.ops.render.render(write_still=True)
            times[scene.render.filepath] = round(time.time() - t, 1)
    if A.get("test"):
        a, b = A["test"]
        scene.frame_start, scene.frame_end = a, b
        scene.render.filepath = str(EP / "previews" / "test" / "frame_")
        scene.render.use_overwrite = True
        t = time.time(); bpy.ops.render.render(animation=True)
        times[f"test_{a}-{b}"] = round(time.time() - t, 1)
    final_settings()
    result["render_seconds"] = times

# ---------------------------------------------------------------- final: background process
if A.get("final_range"):
    a, b = A["final_range"]
    log = open(EP / "logs" / f"render_{a:03d}-{b:03d}.log", "w")
    p = subprocess.Popen([bpy.app.binary_path, "-b", str(ep_file), "-s", str(a), "-e", str(b), "-a"],
                         stdout=log, stderr=subprocess.STDOUT,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    result["render_pid"] = p.pid
    result["log"] = log.name
print("[animate]", result)
