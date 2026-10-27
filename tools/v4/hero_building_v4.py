"""
WhatIfStudio EP001 v4 hero test - hero_building_v4.py
Replaces ONLY BLDG_03 (the billboard tower filling the left of the street shot; verified by ray-cast) with a brick tower assembled
from Poly Haven "Modular Urban Apartments Facade" (CC0) modules as linked duplicates.
Runs on top of the v3 scene; never edits the kit file. Back face (never on camera) = flat brick.
"""
import bpy, math, random
from pathlib import Path
from mathutils import Vector, Euler
ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
KIT = ROOT / "assets/polyhaven/modular_urban_apartments_facade/modular_urban_apartments_facade_1k.blend"
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"
random.seed(21)
if not all(n in bpy.data.objects for n in ("wall_window_centered_large_01", "window_centered_large_01")):
    with bpy.data.libraries.load(str(KIT), link=False) as (src, dst):
        dst.objects = list(src.objects)
def kmesh(n): return bpy.data.objects[n].data
hero = sc.objects["BLDG_03_PodiumTower"]
X0, Y0, Z0 = hero.location.x, hero.location.y, hero.location.z          # (-19, 19, 0.15)
W = D = 18.0
coll = bpy.data.collections.get("HERO_BLDG_03") or bpy.data.collections.new("HERO_BLDG_03")
coll[TAG] = 1
if coll.name not in sc.collection.children: sc.collection.children.link(coll)
for o in list(coll.objects): bpy.data.objects.remove(o, do_unlink=True)
hero.hide_render = True; hero.hide_viewport = True
for p in [p for p in sc.objects if p.name.startswith("PROP_Roof_") and abs(p.location.x - X0) < 10 and abs(p.location.y - Y0) < 10]:
    p.hide_render = True; p.hide_viewport = True
n_obj = [0]
def put(mesh_name, loc, rotz):
    o = bpy.data.objects.new(f"HB03_{mesh_name}_{n_obj[0]:04d}", kmesh(mesh_name)); n_obj[0] += 1
    o.location = loc; o.rotation_euler = (0, 0, rotz); o[TAG] = 1
    coll.objects.link(o); return o
FACES = [  # start corner (left, seen from outside), tangent, rotation; back face (+Y) is flat
    ((-W / 2, -D / 2), (1, 0), 0.0),
    ((W / 2, -D / 2), (0, 1), math.pi / 2),
    ((-W / 2, D / 2), (0, -1), -math.pi / 2),
]
UPPER = [("wall_window_centered_large_0{f}", "window_centered_large_0{f}"), ("wall_window_centered_double_0{f}", "window_centered_double_0{f}"),
         ("wall_window_centered_small_0{f}", "window_centered_small_0{f}")]
N_FLOORS = 10                                        # upper storeys
BASE_H, DADO, WALL, CORN = 0.75, 0.5, 3.0, 0.2
z = Z0
rows = []
rows.append(("ground", z)); z += WALL + CORN
for f in range(N_FLOORS):
    rows.append(("upper" if f < N_FLOORS - 1 else "attic", z)); z += DADO + WALL + CORN
z_top = z
NB = int(W // 3)
for (sx, sy), (tx, ty), rz in FACES:
    for i in range(NB):
        ox, oy = X0 + sx + tx * 3 * (i + 1), Y0 + sy + ty * 3 * (i + 1)
        pattern = UPPER[(i * 2 + (1 if rz else 0)) % 3] if i not in (0, NB - 1) else UPPER[2]
        for kind, zr in rows:
            if kind == "ground":
                if rz == -math.pi / 2 and i in (2, 3):                                   # entrance facing the street camera
                    put("wall_door_centered_large_01", (ox, oy, zr), rz); put("door_centered_large_01", (ox, oy, zr), rz)
                else:
                    put("base_standard_01", (ox, oy, zr), rz)
                    put("wall_window_centered_large_01", (ox, oy, zr), rz); put("window_centered_large_01", (ox, oy, zr + BASE_H), rz)
                put("cornice_standard_standard_01", (ox, oy, zr + WALL), rz)
            else:
                fl = "3" if kind == "attic" else ("1" if (zr // 4) % 2 else "2")
                wall_n, win_n = (p.format(f=fl) for p in pattern)
                put("dado_standard_standard_01", (ox, oy, zr), rz)
                put(wall_n, (ox, oy, zr + DADO), rz)
                put(win_n, (ox, oy, zr + DADO), rz)
                put("cornice_standard_standard_01", (ox, oy, zr + DADO + WALL), rz)
        put("crown_standard_standard_01", (ox, oy, z_top), rz)
        if i < NB - 1:
            for kind, zr in rows:
                h0 = zr if kind == "ground" else zr + DADO
                put("wall_pier_standard_01", (ox, oy, h0), rz)
# corner caps (front-left, front-right, back-left) with pier corners + crown corner
for (cx, cy, rz) in ((X0 - W / 2, Y0 - D / 2, 0.0), (X0 + W / 2, Y0 - D / 2, math.pi / 2), (X0 - W / 2, Y0 + D / 2, -math.pi / 2)):
    for kind, zr in rows:
        put("wall_pier_corner_01", (cx, cy, zr if kind == "ground" else zr + DADO), rz)
# flat brick back face, roof, interior box (seen through the glass)
plaster = bpy.data.materials["modular_urban_apartments_facade_plaster"]
interior = bpy.data.materials.get("MAT_Hero_Interior") or bpy.data.materials.new("MAT_Hero_Interior")
interior.use_nodes = True; interior[TAG] = 1
ib = interior.node_tree.nodes["Principled BSDF"]
ib.inputs["Base Color"].default_value = (0.05, 0.045, 0.04, 1); ib.inputs["Roughness"].default_value = 0.9
H = z_top - Z0
def quadmesh(name, verts, mat, uvs=None):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], [tuple(range(4 * k, 4 * k + 4)) for k in range(len(verts) // 4)])
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li, vi in zip(poly.loop_indices, poly.vertices):
            v = verts[vi]; uv.data[li].uv = ((v[0] + v[1]) / 3.0, v[2] / 3.0)
    me.materials.append(mat); me[TAG] = 1
    o = bpy.data.objects.new(name, me); o[TAG] = 1; coll.objects.link(o); return o
x0, x1, y0, y1, zb, zt = X0 - W / 2, X0 + W / 2, Y0 - D / 2, Y0 + D / 2, Z0, z_top
quadmesh("HB03_BackWall", [(x1, y1, zb), (x0, y1, zb), (x0, y1, zt), (x1, y1, zt)], plaster)
roofm = bpy.data.materials["MAT_Roof"]
quadmesh("HB03_Roof", [(x0, y0, zt + 0.02), (x1, y0, zt + 0.02), (x1, y1, zt + 0.02), (x0, y1, zt + 0.02)], roofm)
e = 0.6
quadmesh("HB03_Interior", [
    (x0 + e, y0 + e, zb), (x1 - e, y0 + e, zb), (x1 - e, y0 + e, zt), (x0 + e, y0 + e, zt),
    (x1 - e, y0 + e, zb), (x1 - e, y1 - e, zb), (x1 - e, y1 - e, zt), (x1 - e, y0 + e, zt),
    (x0 + e, y1 - e, zb), (x0 + e, y0 + e, zb), (x0 + e, y0 + e, zt), (x0 + e, y1 - e, zt)], interior)
# rooftop: water tank + plant (NYC-style), reusing existing shared meshes
for nm, mesh, loc in (("HB03_Tank", "PROP_Rooftop_Tank", (X0 + 3.5, Y0 + 3.0, zt)), ("HB03_HVAC_a", "PROP_Rooftop_HVAC", (X0 - 4, Y0 - 2, zt)),
                      ("HB03_HVAC_b", "PROP_Rooftop_HVAC", (X0 - 4, Y0 + 2.5, zt))):
    o = bpy.data.objects.new(nm, bpy.data.meshes[mesh]); o.location = loc; o[TAG] = 1; coll.objects.link(o)
tris = sum(len(o.data.polygons) for o in coll.objects if o.type == "MESH")
result = {"objects": len(coll.objects), "faces": tris, "height_m": round(H, 1), "storeys": N_FLOORS + 1}
