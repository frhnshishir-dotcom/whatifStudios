"""
WhatIfStudio EP001 - picture_lock.py : retime the approved v6 scene into the final 20.5 s / 30 fps cut.
No geometry or look changes. Same 4 cameras (identical start/end framing, longer moves),
events re-timed, opening hook + ending comment question as camera-locked text.
  S1 0.0-5.0 s  (f1-150)    hook title 0-2.3 s, city alive
  S2 5.0-10.0 s (f151-300)  billboards die at 6.0/6.9/7.8/8.7 s, windows start dimming
  S3 10.0-16.0 s(f301-480)  signals fail 11.0 s, cars brake 11.5-14.0 s and hold
  S4 16.0-20.5 s(f481-615)  pull-back, question at 17.0 s
"""
import bpy, math, random
from mathutils import Vector
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"
FPS = 30; S = lambda t: int(round(t * FPS)) + 1          # seconds -> frame
SHOTS = [("CAM_01_Aerial_Approach", 1, 150), ("CAM_02_Billboards", 151, 300), ("CAM_03_Intersection", 301, 480), ("CAM_04_Skyline_Pullback", 481, 615)]
OLD = {"CAM_01_Aerial_Approach": (1, 72), "CAM_02_Billboards": (73, 144), "CAM_03_Intersection": (145, 216), "CAM_04_Skyline_Pullback": (217, 288)}
def fcurves(idb):
    ad = idb.animation_data
    if not ad or not ad.action: return []
    a = ad.action
    return list(a.fcurves) if hasattr(a, "fcurves") else [fc for l in a.layers for s in l.strips for cb in s.channelbags for fc in cb.fcurves]
def sample(ob, f):
    fcs = {fc.array_index: fc for fc in fcurves(ob) if fc.data_path == "location"}
    return tuple(fcs[i].evaluate(f) if i in fcs else ob.location[i] for i in range(3))
# ---- cameras (+ their aim empties): same endpoints, new ranges
for cam_name, f0, f1 in SHOTS:
    cam = sc.objects[cam_name]; aim = sc.objects[cam_name + "_Aim"]
    o0, o1 = OLD[cam_name]
    pts = {ob: (sample(ob, o0), sample(ob, o1)) for ob in (cam, aim)}
    for ob, (p0, p1) in pts.items():
        ob.animation_data_clear()
        for f, p in ((f0, p0), (f1, p1)):
            ob.location = p; ob.keyframe_insert("location", frame=f)
sc.timeline_markers.clear()
for i, (cam_name, f0, f1) in enumerate(SHOTS):
    sc.timeline_markers.new(f"SHOT_{i+1}", frame=f0).camera = sc.objects[cam_name]
sc.camera = sc.objects[SHOTS[0][0]]
# ---- helpers for node-socket keys
def sock_of(mat, node): return bpy.data.materials[mat].node_tree.nodes[node].outputs[0]
def clear(mat):
    nt = bpy.data.materials[mat].node_tree
    if nt.animation_data: nt.animation_data_clear()
def key(sk, f, v): sk.default_value = v; sk.keyframe_insert("default_value", frame=f)
def step(sk, f, v): key(sk, f - 1, sk.default_value); key(sk, f, v)
def flicker_off(sk, start, on, n=3, gap=4):
    for k in range(n):
        step(sk, start + k * gap, 0.15 * on); step(sk, start + k * gap + 1, on)
    step(sk, start + n * gap + 1, 0.0)
# ---- billboards: one by one with flicker
for i, t in zip(range(1, 5), (6.0, 6.9, 7.8, 8.7)):
    for part, on in (("Panel", 2.6), ("Text", 6.0)):
        m = f"MAT_Sign_{i}_{part}"; clear(m); sk = sock_of(m, "Power"); key(sk, 1, on); flicker_off(sk, S(t), on)
# ---- windows across the city: alive, then dimming from the first billboard failure
for m in [m for m in bpy.data.materials if m.users and m.node_tree and "CityPower" in m.node_tree.nodes]:
    if m.node_tree.animation_data: m.node_tree.animation_data_clear()
    sk = m.node_tree.nodes["CityPower"].outputs[0]
    key(sk, 1, 1.0); key(sk, S(6.0), 1.0); key(sk, S(10.0), 0.4); key(sk, S(16.0), 0.3); key(sk, 615, 0.2)
# ---- traffic signals
clear("MAT_Signal_Green"); sg = sock_of("MAT_Signal_Green", "SignalPower"); key(sg, 1, 6.0); flicker_off(sg, S(11.0), 6.0, n=3, gap=5)
# ---- cars: same stopping positions as the approved cut, new 30 fps timing
V0, TS0, TB0 = 0.45, 196, 46
V1, TS1, TB1 = 0.36, S(14.0), S(14.0) - S(11.5)
def travel(V, TS, TB):
    tb = TS - TB
    return V * (tb - 1) + V * (TB - TB * TB / (2 * TB))
D0, D1 = travel(V0, TS0, TB0), travel(V1, TS1, TB1)
for ob in [o for o in sc.objects if o.name.startswith("CAR_") and o.get("moving")]:
    hd = ob["heading"]; d = Vector((math.cos(hd), math.sin(hd), 0))
    start0 = Vector(ob["start"]); stop = start0 + d * D0
    start1 = stop - d * D1
    ob.animation_data_clear()
    tb = TS1 - TB1
    for f in list(range(1, TS1 + 1, 3)) + [TS1]:
        t = f - 1
        s_ = V1 * t if f <= tb else V1 * (tb - 1) + V1 * ((f - tb) - (f - tb) ** 2 / (2 * TB1))
        ob.location = start1 + d * s_; ob.keyframe_insert("location", frame=f)
# ---- text: opening hook on shot-1 camera, ending question on shot-4 camera
title = sc.objects["TITLE_Closing"]
def place_text(ob, cam, loc):
    ob.parent = cam; ob.matrix_parent_inverse.identity(); ob.location = loc; ob.rotation_euler = (0, 0, 0)
place_text(title, sc.objects["CAM_01_Aerial_Approach"], (0, 0.62, -3.2))
title.data.size = 0.2
clear("MAT_Title"); tf = sock_of("MAT_Title", "TitleFade"); key(tf, 1, 1.0); key(tf, S(2.2), 1.0); key(tf, S(2.8), 0.0)
endmat = bpy.data.materials.get("MAT_Title_End") or bpy.data.materials["MAT_Title"].copy()
endmat.name = "MAT_Title_End"; endmat[TAG] = 1
if endmat.node_tree.animation_data: endmat.node_tree.animation_data_clear()
for nm, body, size, z in (("TITLE_End_Question", "COULD YOUR CITY\nSURVIVE WITHOUT AI?", 0.17, 0.64), ("TITLE_End_CTA", "Tell us in the comments", 0.085, 0.3)):
    ob = sc.objects.get(nm)
    if ob is None:
        cu = bpy.data.curves.new(nm, "FONT"); cu[TAG] = 1
        ob = bpy.data.objects.new(nm, cu); ob[TAG] = 1; title.users_collection[0].objects.link(ob)
    cu = ob.data; cu.body, cu.size, cu.align_x, cu.align_y, cu.space_line = body, size, "CENTER", "CENTER", 0.9
    cu.font = title.data.font
    cu.materials.clear(); cu.materials.append(endmat)
    if hasattr(ob, "visible_shadow"): ob.visible_shadow = False
    place_text(ob, sc.objects["CAM_04_Skyline_Pullback"], (0, z, -3.2))
ef = endmat.node_tree.nodes["TitleFade"].outputs[0]; key(ef, 1, 0.0); key(ef, S(17.0), 0.0); key(ef, S(17.6), 1.0)
# ---- timeline / output
sc.render.fps = FPS; sc.render.fps_base = 1.0; sc.frame_start, sc.frame_end = 1, 615
result = {"cars_new_start_offset_m": round(D1 - D0, 1), "frames": 615, "seconds": 615 / FPS,
          "events_frames": {"title_out": (S(2.2), S(2.8)), "signs": [S(t) for t in (6.0, 6.9, 7.8, 8.7)], "signals": S(11.0), "brake": (S(11.5), S(14.0)), "question": S(17.0)}}
