"""
WhatIfStudio EP001 v6 - horizon_v6.py : distant city layer (fills the flat grey horizon band).
Linked duplicates of the existing shared tower meshes, placed 330-1700 m out inside the camera
wedges (north = aerial/billboard/pullback shots, east = street shot), avenue corridors kept clear.
Distance haze (look_v6) softens them; no new meshes or materials.
"""
import bpy, math, random
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"
random.seed(66)
coll = bpy.data.collections.get("DISTANT_CITY") or bpy.data.collections.new("DISTANT_CITY")
coll[TAG] = 1
if coll.name not in sc.collection.children: sc.collection.children.link(coll)
for o in list(coll.objects): bpy.data.objects.remove(o, do_unlink=True)
meshes = [m for m in bpy.data.meshes if m.users and (m.name.startswith("BG_Variant_v5_") or (m.name.startswith("BG_Skyline_Mesh_") and m.name.endswith("_v2")))]
n = 0
def wedge(axis):
    global n
    d = 330.0
    while d < 1700:
        step = 38 + 0.07 * d
        half = d * math.tan(math.radians(24)) + 120
        t = -half
        while t < half:
            if abs(t) > 14 + 0.01 * d and random.random() < 0.8:
                jit = step * 0.3
                a, b = d + random.uniform(-jit, jit), t + random.uniform(-jit, jit)
                x, y = (b, a) if axis == "Y" else (a, b)
                o = bpy.data.objects.new(f"DIST_{n:04d}", random.choice(meshes)); n += 1
                o.location = (x, y, -0.06)
                o.rotation_euler = (0, 0, random.choice((0, math.pi / 2, math.pi, -math.pi / 2)))
                s = random.uniform(0.9, 1.25)
                o.scale = (s, s, random.uniform(0.45, 1.35) * (1.0 if d < 900 else 1.15))
                o.visible_shadow = d < 700                               # far layer: skip shadow casting (cheaper)
                o[TAG] = 1; coll.objects.link(o)
            t += step
        d += step
wedge("Y"); wedge("X")
result = {"instances": n, "meshes_used": len(meshes)}
