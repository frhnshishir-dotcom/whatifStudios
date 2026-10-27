"""
WhatIfStudio EP001 v3 - make_people_v3.py
Builds 4 posed pedestrian meshes with the installed MPFB (MakeHuman) extension:
low-poly proxy bodies + MakeHuman clothes/shoes/hair (CC0 assets), posed with the
standard rig, baked to static meshes and written to assets/people_v3.blend.
Run once; upgrade_v3.py appends the result.
"""
import bpy, os, math
from pathlib import Path
from mathutils import Vector, Matrix
ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
OUT = ROOT / "assets" / "people_v3.blend"
D = Path(os.environ["APPDATA"]) / "Blender Foundation/Blender/5.2/extensions/.user/blender_org/mpfb/data"
SPECS = [
    dict(name="PED_v3_M1", gender="male",   proxy="male1591",   clothes=["male_casualsuit02", "shoes02"], hair="short02",
         skin=(0.60, 0.43, 0.33), pose="walk"),
    dict(name="PED_v3_F1", gender="female", proxy="female1605", clothes=["female_casualsuit01", "shoes03"], hair="ponytail01",
         skin=(0.38, 0.25, 0.18), pose="walk_mirror"),
    dict(name="PED_v3_M2", gender="male",   proxy="male1591",   clothes=["male_casualsuit05", "shoes01"], hair="short03",
         skin=(0.24, 0.15, 0.10), pose="stand"),
    dict(name="PED_v3_F2", gender="female", proxy="female1605", clothes=["female_casualsuit02", "shoes04"], hair="bob01",
         skin=(0.68, 0.53, 0.43), pose="stand_relaxed"),
]
ONLY = globals().get("ONLY")
def enum_ok(scn, prop, want):
    items = [i.identifier for i in scn.bl_rna.properties[prop].enum_items]
    return want if want in items else next((i for i in items if want in i.lower()), items[0])

def aim(pb, arm, direction):
    """Rotate pose bone so its Y axis points along `direction` (armature space), parents unposed."""
    b = pb.bone
    R = b.matrix_local.to_3x3()
    rest = (R @ Vector((0, 1, 0))).normalized()
    q = rest.rotation_difference(Vector(direction).normalized())
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = (R.inverted() @ q.to_matrix() @ R).to_quaternion()

POSES = {
    #             L upperarm        L lowerarm        R upperarm        R lowerarm        L thigh          L shin          R thigh          R shin
    "walk":          [(0.10, -0.30, -1), (0.06, -0.55, -1), (-0.10, 0.28, -1), (-0.06, 0.1, -1), (0.02, -0.32, -1), (0.02, 0.05, -1), (-0.02, 0.26, -1), (-0.02, 0.62, -1)],
    "walk_mirror":   [(0.10, 0.28, -1), (0.06, 0.1, -1), (-0.10, -0.30, -1), (-0.06, -0.55, -1), (0.02, 0.26, -1), (0.02, 0.62, -1), (-0.02, -0.32, -1), (-0.02, 0.05, -1)],
    "stand":         [(0.14, 0.02, -1), (0.10, -0.12, -1), (-0.14, 0.02, -1), (-0.10, -0.12, -1), (0.05, 0, -1), (0.04, 0.02, -1), (-0.05, 0, -1), (-0.04, 0.02, -1)],
    "stand_relaxed": [(0.16, -0.05, -1), (0.06, -0.5, -0.8), (-0.13, 0.04, -1), (-0.1, -0.08, -1), (0.07, 0.03, -1), (0.06, 0.06, -1), (-0.03, -0.04, -1), (-0.03, 0, -1)],
}
BONES = ["upperarm01.L", "lowerarm01.L", "upperarm01.R", "lowerarm01.R", "upperleg01.L", "lowerleg01.L", "upperleg01.R", "lowerleg01.R"]

def skin_mat(name, col):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = 0.55
    m["whatif_v3"] = 1
    return m

made = []
win = bpy.context.window; home = win.scene
for spec in SPECS:
    if ONLY and spec["name"] not in ONLY:
        continue
    ws = bpy.data.scenes.new("MPFB_" + spec["name"]); win.scene = ws
    ws.MPFB_NH_phenotype_gender = enum_ok(ws, "MPFB_NH_phenotype_gender", spec["gender"])
    ws.MPFB_NH_load_clothes = False
    bpy.ops.mpfb.create_human()
    human = bpy.context.view_layer.objects.active
    for o in ws.objects: o.select_set(False)
    human.select_set(True); bpy.context.view_layer.objects.active = human
    bpy.ops.mpfb.add_standard_rig()
    rig = next(o for o in ws.objects if o.type == "ARMATURE")
    def with_human(fn, **kw):
        for o in ws.objects: o.select_set(False)
        human.select_set(True); bpy.context.view_layer.objects.active = human
        return fn(**kw)
    with_human(bpy.ops.mpfb.load_library_proxy, filepath=str(D / "proxymeshes" / spec["proxy"] / (spec["proxy"] + ".proxy")))
    for c in spec["clothes"]:
        with_human(bpy.ops.mpfb.load_library_clothes, filepath=str(D / "clothes" / c / (c + ".mhclo")), material_type="MAKESKIN")
    with_human(bpy.ops.mpfb.load_library_clothes, filepath=str(D / "hair" / spec["hair"] / (spec["hair"] + ".mhclo")), material_type="MAKESKIN")
    # pose
    for bn, d in zip(BONES, POSES[spec["pose"]]):
        aim(rig.pose.bones[bn], rig, d)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    parts = [o for o in ws.objects if o.type == "MESH" and o is not human and not o.hide_render and not o.hide_get()]
    import bmesh
    bm = bmesh.new(); mats = []
    for o in parts:
        ev = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        me.transform(o.matrix_world)
        is_body = spec["proxy"] in o.name.lower() and "." not in o.name
        off = len(mats)
        if is_body:
            mats.append(skin_mat("MAT_Ped_v3_Skin_" + spec["name"][-2:], spec["skin"]))
            for p in me.polygons: p.material_index = 0
            n_slot = 1
        else:
            slot_mats = [sl.material for sl in o.material_slots] or list(me.materials)
            mats += slot_mats
            n_slot = max(1, len(slot_mats))
        for p in me.polygons: p.material_index += off
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts: v.co.z -= zmin
    out = bpy.data.meshes.new(spec["name"]); bm.to_mesh(out); bm.free()
    for m in mats: out.materials.append(m)
    for p in out.polygons: p.use_smooth = True
    out["whatif_v3"] = 1; out.use_fake_user = True
    made.append((spec["name"], len(out.polygons), [o.name for o in parts], round(max(v.co.z for v in out.vertices), 2)))
    win.scene = home
    for o in list(ws.objects):
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and getattr(data, "users", 1) == 0:
            try: (bpy.data.meshes if o.type == "MESH" else bpy.data.armatures).remove(data)
            except Exception: pass
    bpy.data.scenes.remove(ws)
peds = {me for me in bpy.data.meshes if me.name.startswith("PED_v3_")}
bpy.data.libraries.write(str(OUT), peds, path_remap="ABSOLUTE", compress=True)
result = {"made": made, "saved": str(OUT)}
