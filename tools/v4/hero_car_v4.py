"""
WhatIfStudio EP001 v4 hero test - hero_car_v4.py
Detailed mesh for ONE vehicle: CAR_02 (nearest car in the street shot, seen from behind).
Other cars keep the v3 mesh. Animation untouched (only obj.data and its paint change).
"""
import bpy, bmesh, math
from mathutils import Matrix, Vector, Euler
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"; MATS = bpy.data.materials
def mat(name, col, rough, metal=0.0, coat=0.0, emis=None, strength=0.0, alpha=None):
    m = MATS.get(name) or MATS.new(name); m[TAG] = 1; m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    b.inputs["Coat Weight"].default_value = coat; b.inputs["Coat Roughness"].default_value = 0.03
    if emis:
        b.inputs["Emission Color"].default_value = (*emis, 1); b.inputs["Emission Strength"].default_value = strength
    return m
def interp(tab, x):
    for (x0, y0), (x1, y1) in zip(tab, tab[1:]):
        if x0 <= x <= x1: return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y0
    return tab[0][1] if x < tab[0][0] else tab[-1][1]
# profile tables (rounded tail, ducktail trunk, longer hood)
ZR = [(-2.40, .93), (-2.37, .975), (-2.25, 1.00), (-1.62, 1.02), (-1.50, 1.06), (-0.75, 1.42), (0.35, 1.44), (0.62, 1.35), (1.25, 0.98), (2.0, 0.87), (2.26, 0.80), (2.40, 0.64)]
ZS = [(-2.40, .86), (-2.36, .91), (-1.6, .94), (-0.75, .95), (1.25, .89), (2.2, .77), (2.40, .60)]
WS = [(-2.40, .70), (-2.385, .80), (-2.35, .865), (-2.25, .90), (-1.9, .918), (0.0, .925), (1.8, .91), (2.25, .85), (2.36, .77), (2.40, .66)]
WR = [(-2.40, .70), (-1.65, .87), (-1.5, .76), (-0.7, .69), (0.35, .69), (1.2, .78), (1.32, .86), (2.40, .66)]
ZB = [(-2.40, .44), (-2.36, .36), (-2.25, .30), (-2.0, .27), (2.0, .27), (2.24, .30), (2.40, .40)]
def zb_at(x):
    z = interp(ZB, x)
    for xc in (-1.42, 1.42):
        if abs(x - xc) < 0.44: z = max(z, 0.34 + math.sqrt(0.44 ** 2 - (x - xc) ** 2) + 0.03)
    return z
M = {k: MATS[n] for k, n in (("glass", "MAT_Car_Glass"), ("tire", "MAT_Car_Tire"), ("blob", "MAT_Car_ContactShadow"), ("plastic", "MAT_Car_Trim"),
                              ("pillar", "MAT_Car_PillarBlack"))}
M["paint"] = mat("MAT_Car_Body_Hero", (0.03, 0.034, 0.04), 0.26, metal=0.65, coat=1.0)
M["tail"] = mat("MAT_Car_Tail_Lens", (0.25, 0.01, 0.01), 0.08, emis=(1.0, 0.03, 0.01), strength=0.9)
M["led"] = mat("MAT_Car_Tail_LED", (0.6, 0.05, 0.03), 0.1, emis=(1.0, 0.08, 0.03), strength=6.0)
M["rev"] = mat("MAT_Car_Reverse_Lens", (0.75, 0.75, 0.75), 0.05)
M["refl"] = mat("MAT_Car_Reflector", (0.35, 0.02, 0.02), 0.2)
M["chrome"] = mat("MAT_Car_Chrome", (0.85, 0.85, 0.85), 0.08, metal=1.0)
M["rim"] = mat("MAT_Car_Rim_Gunmetal", (0.12, 0.125, 0.13), 0.32, metal=0.9)
M["disc"] = mat("MAT_Car_BrakeDisc", (0.25, 0.24, 0.23), 0.5, metal=0.8)
M["caliper"] = mat("MAT_Car_Caliper", (0.45, 0.04, 0.03), 0.4)
M["plate"] = mat("MAT_Car_Plate_Hero", (0.78, 0.78, 0.76), 0.4)
def _plate_text(m):
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    if any(n.type == "TEX_WAVE" for n in nt.nodes): return
    tc = nt.nodes.new("ShaderNodeTexCoord"); wv = nt.nodes.new("ShaderNodeTexWave"); wv.wave_type = "BANDS"; wv.bands_direction = "Y"
    wv.inputs["Scale"].default_value = 26.0; wv.inputs["Distortion"].default_value = 0.0
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = 0.35, 0.45
    mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = "RGBA"
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"]); nt.links.new(wv.outputs["Fac"], mr.inputs["Value"])
    band = nt.nodes.new("ShaderNodeMath"); band.operation = "LESS_THAN"; band.inputs[1].default_value = 0.035
    sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Object"], sep.inputs[0])
    absz = nt.nodes.new("ShaderNodeMath"); absz.operation = "ABSOLUTE"; nt.links.new(sep.outputs["Z"], absz.inputs[0])
    sub = nt.nodes.new("ShaderNodeMath"); sub.operation = "SUBTRACT"; nt.links.new(absz.outputs[0], sub.inputs[0]); sub.inputs[1].default_value = 0.58
    ab2 = nt.nodes.new("ShaderNodeMath"); ab2.operation = "ABSOLUTE"; nt.links.new(sub.outputs[0], ab2.inputs[0]); nt.links.new(ab2.outputs[0], band.inputs[0])
    mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; nt.links.new(band.outputs[0], mul.inputs[0]); nt.links.new(mr.outputs["Result"], mul.inputs[1])
    nt.links.new(mul.outputs[0], [i for i in mix.inputs if i.identifier == "Factor_Float"][0])
    [i for i in mix.inputs if i.identifier == "A_Color"][0].default_value = (0.78, 0.78, 0.76, 1); [i for i in mix.inputs if i.identifier == "B_Color"][0].default_value = (0.03, 0.03, 0.04, 1)
    nt.links.new([o for o in mix.outputs if o.identifier == "Result_Color"][0], b.inputs["Base Color"])
_plate_text(M["plate"])
M["gap"] = mat("MAT_Car_PanelGap", (0.004, 0.004, 0.004), 0.6)
M["tipm"] = mat("MAT_Car_DarkChrome", (0.22, 0.22, 0.23), 0.28, metal=1.0)
M["head"] = MATS["MAT_Car_Headlight"]
ORDER = ["paint", "glass", "head", "tail", "tire", "rim", "blob", "plastic", "plate", "pillar", "led", "rev", "refl", "chrome", "disc", "caliper", "gap", "tipm"]
I = {k: i for i, k in enumerate(ORDER)}
bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap")
xs = [-2.40, -2.395, -2.385, -2.37, -2.35, -2.32, -2.28, -2.22, -2.15] + [round(-2.07 + 0.06 * k, 3) for k in range(70)] + [2.15, 2.22, 2.28, 2.33, 2.37, 2.40]
xs = sorted(set(x for x in xs if -2.40 <= x <= 2.40))
rings = []
for x in xs:
    zr, ws, wr = interp(ZR, x), interp(WS, x), interp(WR, x)
    zs = min(interp(ZS, x), zr - 0.03); zb = min(zb_at(x), zs - 0.22); wb = ws - 0.05
    cab = -1.55 < x < 1.28
    right = [(0, zb), (wb * 0.86, zb), (wb * 0.97, zb + 0.03), (wb, min(zb + 0.09, zs - 0.18)), (ws, zs - 0.26), (ws, zs - 0.12), (ws * 0.995, zs - 0.04),
             (ws - 0.04, zs), (wr + 0.01, zr - (0.07 if cab else 0.016)), (wr * 0.8, zr - 0.012), (wr * 0.45, zr - 0.003), (0, zr)]
    loop = right + [(-y, z) for (y, z) in reversed(right[1:-1])]
    rings.append([bm.verts.new((x, y, z)) for (y, z) in loop])
N = len(rings[0]); half = len(right) - 1
def segtype(k): return k if k < half else (N - 1 - k)
for i in range(len(xs) - 1):
    xm = (xs[i] + xs[i + 1]) / 2
    for k in range(N):
        k2 = (k + 1) % N
        f = bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2])); f.smooth = True
        st = segtype(k); mi = I["paint"]
        if st == 0: mi = I["plastic"]
        elif st == 8:
            if -1.40 < xm < 1.06 and not abs(xm + 0.22) < 0.07: mi = I["glass"]
            elif -1.55 < xm < 1.28: mi = I["pillar"]
        elif st in (9, 10):
            if 0.46 < xm < 1.22 or -1.50 < xm < -0.80: mi = I["glass"]
        f.material_index = mi
for ring, rev in ((rings[0], True), (rings[-1], False)):
    f = bm.faces.new(ring[::-1] if rev else ring); f.material_index = I["paint"]
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
def cube(loc, size, key, rot=(0, 0, 0)):
    r = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), Vector(size)))
    for fc in {fc for v in r["verts"] for fc in v.link_faces}: fc.material_index = I[key]
def cyl(loc, r1, depth, key, rot=(math.pi / 2, 0, 0), seg=24, smooth=True, r2=None):
    r = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r1 if r2 is None else r2, depth=depth,
                              matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), None))
    for fc in {fc for v in r["verts"] for fc in v.link_faces}: fc.material_index = I[key]; fc.smooth = smooth
# ---- rear fascia (what the street camera sees)
for s in (-1, 1):
    cube((-2.385, s * 0.60, 0.80), (0.05, 0.40, 0.12), "tail")                       # main lens
    cube((-2.405, s * 0.60, 0.835), (0.015, 0.36, 0.018), "led")                     # LED signature line
    cube((-2.402, s * 0.72, 0.775), (0.012, 0.10, 0.035), "rev")                     # reverse light
    cube((-2.24, s * 0.905, 0.80), (0.24, 0.035, 0.10), "tail")                      # wrap onto the flank
    cube((-2.405, s * 0.66, 0.40), (0.012, 0.16, 0.03), "refl")                      # bumper reflectors
    cyl((-2.39, s * 0.45, 0.31), 0.03, 0.08, "tipm", rot=(0, math.pi / 2, 0), seg=14)   # exhaust tips
    cube((-2.40, s * 0.40, 0.80), (0.015, 0.012, 0.14), "gap")                      # trunk shut lines (vertical)
cube((-2.408, 0, 0.835), (0.01, 0.82, 0.012), "led")                                # light bar across the trunk
cube((-2.398, 0, 0.885), (0.012, 0.82, 0.006), "gap")                               # trunk lid line
cube((-2.40, 0, 0.36), (0.07, 1.62, 0.16), "plastic")                               # diffuser / lower bumper
cube((-2.41, 0, 0.58), (0.02, 0.56, 0.15), "plastic")                               # plate recess
cube((-2.425, 0, 0.58), (0.01, 0.52, 0.11), "plate")
cyl((-2.408, 0, 0.73), 0.028, 0.012, "tipm", rot=(0, math.pi / 2, 0), seg=16)      # badge
cube((-1.52, 0, 1.065), (0.04, 0.42, 0.025), "led")                                 # third brake light
# ---- front
for s in (-1, 1):
    cube((2.37, s * 0.63, 0.70), (0.06, 0.36, 0.09), "head")
    cube((2.385, s * 0.63, 0.66), (0.012, 0.34, 0.012), "led")
cube((2.395, 0, 0.46), (0.05, 0.94, 0.17), "plastic"); cube((2.41, 0, 0.36), (0.01, 0.50, 0.11), "plate")
# ---- flanks: door shut lines, chrome belt trim, handles, mirrors
for s in (-1, 1):
    for xg in (0.38, -0.72):
        cube((xg, s * 0.927, 0.62), (0.008, 0.01, 0.62), "gap")
    cube((-0.17, s * 0.915, 0.945), (2.4, 0.012, 0.018), "chrome")
    for xh in (0.20, -0.95):
        cube((xh, s * 0.932, 0.86), (0.14, 0.014, 0.03), "chrome")
    cube((0.95, s * 1.0, 0.99), (0.17, 0.13, 0.10), "paint"); cube((0.98, s * 0.94, 0.95), (0.06, 0.06, 0.05), "plastic")
cube((-0.05, 0, 0.36), (3.4, 1.5, 0.26), "plastic")                                 # chassis / arch liners
# ---- wheels: tyre, twin-spoke gunmetal rim, disc, caliper
for xw in (-1.42, 1.42):
    for yw in (-0.80, 0.80):
        s = 1 if yw > 0 else -1
        cyl((xw, yw, 0.34), 0.34, 0.225, "tire", seg=28)
        cyl((xw, yw + s * 0.105, 0.34), 0.24, 0.02, "plastic", seg=24)                 # inner barrel (dark)
        cyl((xw, yw + s * 0.09, 0.34), 0.19, 0.015, "disc", seg=20)
        cube((xw - 0.12, yw + s * 0.085, 0.42), (0.10, 0.04, 0.12), "caliper")
        cyl((xw, yw + s * 0.122, 0.34), 0.235, 0.012, "rim", seg=24, r2=0.23)           # rim lip
        cyl((xw, yw + s * 0.128, 0.34), 0.055, 0.03, "rim", seg=12)                     # hub
        for k in range(5):
            for dk in (-0.09, 0.09):
                a = 2 * math.pi * k / 5 + dk
                cube((xw + 0.13 * math.cos(a), yw + s * 0.126, 0.34 + 0.13 * math.sin(a)), (0.17, 0.016, 0.03), "rim", rot=(0, -a, 0))
q = [bm.verts.new(p) for p in ((-2.55, -1.12, 0.012), (2.55, -1.12, 0.012), (2.55, 1.12, 0.012), (-2.55, 1.12, 0.012))]
fq = bm.faces.new(q); fq.material_index = I["blob"]
for l, uvc in zip(fq.loops, ((0, 0), (1, 0), (1, 1), (0, 1))): l[uvl].uv = uvc
me = bpy.data.meshes.get("CAR_Hero_v4")
if me: me.name = "CAR_Hero_v4_old"
me = bpy.data.meshes.new("CAR_Hero_v4"); me[TAG] = 1; bm.to_mesh(me); bm.free()
for k in ORDER: me.materials.append(M[k])
car = sc.objects["CAR_02_Eastbound_Follow"]
car.data = me
car.material_slots[0].link = "OBJECT"; car.material_slots[0].material = M["paint"]
old = bpy.data.meshes.get("CAR_Hero_v4_old")
if old and old.users == 0: bpy.data.meshes.remove(old)
result = {"faces": len(me.polygons), "car": car.name}
