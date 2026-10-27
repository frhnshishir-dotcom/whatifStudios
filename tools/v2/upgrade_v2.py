"""
WhatIfStudio EP001 v2 - upgrade_v2.py : semi-realistic detail pass.

Runs on scene "EP001_City_v2" (built by build_city_v2.py) and keeps its layout,
object names, car start positions and the material hooks the animation keys
(CityPower / Power / SignalPower). Replaces:
  * hero architecture  : tiered masses, cornices, parapets, floor bands, fins,
                         storefront podiums, instanced rooftop plant
  * facade shading     : metre-true procedural bays (mullions, spandrels, recesses,
                         per-window glass/blind variation, sparse warm interiors)
  * streets            : asphalt variation, painted (non-emissive) markings, curbs,
                         paving, stop lines, street lights, drains, signs
  * props              : sedan bodies with wheels/glass/lights + contact shadow,
                         pedestrians, traffic-signal mast arms, framed billboards
  * look               : physical sky, low warm sun, horizon-scan AO, light haze, AgX
Writes master_city_v2.blend. v1 files are never touched.
"""
import bpy, bmesh, math, random
from pathlib import Path
from mathutils import Matrix, Vector, Euler

ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
SCENE, TAG = "EP001_City_v2", "whatif_v2"
OUT = ROOT / "master_city_v2.blend"
sc = bpy.data.scenes[SCENE]
OBJ, MATS = bpy.data.objects, bpy.data.materials
random.seed(5)
SUN_ELEV, SUN_AZ = 20.0, 55.0           # degrees: low late-afternoon sun, 3/4 key from camera-right, shadows fall back-left
HAZE = (0.50, 0.50, 0.54)

def tag(idb):
    idb[TAG] = 1
    return idb

def sock(sockets, ident):
    return next(s for s in sockets if s.identifier == ident or s.name == ident)

# =============================================================== node builder
class NB:
    def __init__(s, mat):
        s.nt = mat.node_tree; s.n = s.nt.nodes
    def L(s, a, b):
        s.nt.links.new(a, b)
    def new(s, t, **kw):
        nd = s.n.new(t)
        for k, v in kw.items():
            setattr(nd, k, v)
        return nd
    def _in(s, sk, x):
        if x is None:
            return
        if isinstance(x, (int, float)):
            sk.default_value = x
        elif isinstance(x, tuple):
            sk.default_value = x if len(x) == 4 else (*x, 1.0)
        else:
            s.L(x, sk)
    def m(s, op, a=None, b=None, c=None, clamp=False):
        nd = s.n.new("ShaderNodeMath"); nd.operation = op; nd.use_clamp = clamp
        for i, x in enumerate((a, b, c)):
            s._in(nd.inputs[i], x)
        return nd.outputs[0]
    def val(s, name, v):
        nd = s.n.new("ShaderNodeValue"); nd.name = nd.label = name
        nd.outputs[0].default_value = v
        return nd.outputs[0]
    def mix(s, fac, a, b):
        nd = s.n.new("ShaderNodeMix"); nd.data_type = "RGBA"
        s._in(sock(nd.inputs, "Factor_Float"), fac)
        s._in(sock(nd.inputs, "A_Color"), a); s._in(sock(nd.inputs, "B_Color"), b)
        return sock(nd.outputs, "Result_Color")
    def noise(s, vec=None, scale=5.0, detail=2.0, rough=0.5):
        nd = s.n.new("ShaderNodeTexNoise")
        nd.inputs["Scale"].default_value = scale
        nd.inputs["Detail"].default_value = detail
        nd.inputs["Roughness"].default_value = rough
        if vec is not None:
            s.L(vec, nd.inputs["Vector"])
        return nd
    def uv(s):
        sep = s.n.new("ShaderNodeSeparateXYZ")
        s.L(s.n.new("ShaderNodeUVMap").outputs["UV"], sep.inputs[0])
        return sep.outputs["X"], sep.outputs["Y"]

def reset(name, keep_values=()):
    """Reuse (or create) a material datablock, wipe its nodes, return (mat, nb, bsdf, out).
    Value nodes listed in keep_values are recreated with their current value."""
    mat = MATS.get(name) or tag(MATS.new(name))
    tag(mat); mat.use_nodes = True
    kept = {}
    for vn in keep_values:
        nd = mat.node_tree.nodes.get(vn)
        if nd:
            kept[vn] = nd.outputs[0].default_value
    if mat.node_tree.animation_data:
        mat.node_tree.animation_data_clear()
    mat.node_tree.nodes.clear()
    nb = NB(mat)
    out = nb.new("ShaderNodeOutputMaterial")
    bsdf = nb.new("ShaderNodeBsdfPrincipled")
    nb.L(bsdf.outputs[0], out.inputs["Surface"])
    nb.kept = kept
    return mat, nb, bsdf, out

def haze(nb, out, near=380, far=2300, amount=0.55):
    src = out.inputs["Surface"].links[0].from_socket
    mr = nb.new("ShaderNodeMapRange", clamp=True)
    nb.L(nb.new("ShaderNodeCameraData").outputs["View Distance"], mr.inputs["Value"])
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = near, far
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 0.0, amount
    em = nb.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (*HAZE, 1)
    mx = nb.new("ShaderNodeMixShader")
    nb.L(mr.outputs["Result"], mx.inputs[0]); nb.L(src, mx.inputs[1]); nb.L(em.outputs[0], mx.inputs[2])
    nb.L(mx.outputs[0], out.inputs["Surface"])

def simple(name, color, rough, metal=0.0, noise_amt=0.0, nscale=3.0, bump=0.0, coat=0.0, use_haze=True):
    mat, nb, b, out = reset(name)
    if noise_amt:
        tc = nb.new("ShaderNodeTexCoord")
        nz = nb.noise(tc.outputs["Object"], nscale, 4.0, 0.6)
        nb.L(nb.mix(nb.m("MULTIPLY_ADD", nz.outputs["Fac"], noise_amt * 2, 0.5 - noise_amt, clamp=True),
                    tuple(c * 0.75 for c in color), tuple(min(1, c * 1.2) for c in color)), b.inputs["Base Color"])
        if bump:
            bp = nb.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = bump
            bp.inputs["Distance"].default_value = 0.02
            nb.L(nz.outputs["Fac"], bp.inputs["Height"]); nb.L(bp.outputs[0], b.inputs["Normal"])
    else:
        b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.06
    if use_haze:
        haze(nb, out)
    return mat

def emis_principled(name, color, power_name, power, base=(0.01, 0.01, 0.012), rough=0.25):
    """Principled with emission driven by a named Value node (keeps animation hooks)."""
    mat, nb, b, out = reset(name, keep_values=(power_name,))
    pw = nb.val(power_name, power)
    b.inputs["Base Color"].default_value = (*base, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Emission Color"].default_value = (*color, 1)
    nb.L(pw, b.inputs["Emission Strength"])
    return mat, nb, b

# =============================================================== facade system
FACADES = {  #  bay  floor  mullion sill  head   wall colour          wR    wM    glass tint             lit
    "glass":    (1.5, 3.8, 0.035, 0.07, 0.96, (0.16, 0.17, 0.18), 0.35, 0.85, (0.022, 0.034, 0.045), 0.04),
    "bronze":   (1.6, 3.8, 0.040, 0.08, 0.95, (0.12, 0.10, 0.08), 0.40, 0.80, (0.040, 0.032, 0.024), 0.05),
    "concrete": (3.0, 3.6, 0.200, 0.32, 0.82, (0.30, 0.29, 0.27), 0.85, 0.00, (0.030, 0.036, 0.042), 0.06),
    "stone":    (2.8, 4.0, 0.210, 0.26, 0.83, (0.40, 0.33, 0.25), 0.80, 0.00, (0.028, 0.030, 0.034), 0.06),
    "metal":    (1.6, 3.7, 0.022, 0.40, 0.90, (0.075, 0.078, 0.085), 0.42, 0.70, (0.026, 0.034, 0.042), 0.08),
    "store":    (4.0, 5.5, 0.040, 0.04, 0.78, (0.06, 0.06, 0.065), 0.40, 0.80, (0.035, 0.032, 0.030), 0.35),
}
FAC_MAT = {"glass": "MAT_Facade_BlueGlass", "bronze": "MAT_Facade_BronzeGlass", "concrete": "MAT_Facade_Concrete",
           "stone": "MAT_Facade_Stone", "metal": "MAT_Facade_Charcoal", "store": "MAT_Storefront"}

def facade(kind):
    bay, flr, mul, sill, head, wall, wR, wM, glass, lit = FACADES[kind]
    mat, nb, b, out = reset(FAC_MAT[kind], keep_values=("CityPower",))
    u, v = nb.uv()
    fu, fv = nb.m("DIVIDE", u, bay), nb.m("DIVIDE", v, flr)
    cu, cv = nb.m("FRACT", fu), nb.m("FRACT", fv)
    inx = nb.m("MULTIPLY", nb.m("GREATER_THAN", cu, mul), nb.m("LESS_THAN", cu, 1 - mul))
    iny = nb.m("MULTIPLY", nb.m("GREATER_THAN", cv, sill), nb.m("LESS_THAN", cv, head))
    win = nb.m("MULTIPLY", inx, iny)
    if kind in ("concrete", "stone"):
        win = nb.m("MULTIPLY", win, nb.m("GREATER_THAN", nb.m("ABSOLUTE", nb.m("SUBTRACT", cu, 0.5)), 0.012))
    oi = nb.new("ShaderNodeObjectInfo")
    cell = nb.new("ShaderNodeCombineXYZ")
    nb.L(nb.m("FLOOR", fu), cell.inputs[0]); nb.L(nb.m("FLOOR", fv), cell.inputs[1])
    nb.L(nb.m("MULTIPLY", oi.outputs["Random"], 97.0), cell.inputs[2])
    wn = nb.new("ShaderNodeTexWhiteNoise"); wn.noise_dimensions = "3D"
    nb.L(cell.outputs[0], wn.inputs["Vector"])
    r = wn.outputs["Value"]
    # walls: per-building tint + large-scale weathering
    tc = nb.new("ShaderNodeTexCoord")
    grime = nb.noise(tc.outputs["Object"], 0.25, 3.0, 0.55)
    wall_v = nb.mix(oi.outputs["Random"], tuple(c * 0.86 for c in wall), tuple(min(1, c * 1.12) for c in wall))
    wall_v = nb.mix(nb.m("MULTIPLY", grime.outputs["Fac"], 0.35), wall_v, tuple(c * 0.7 for c in wall))
    # glass: individual panes differ (blinds / reflections / interior)
    glass_v = nb.mix(r, tuple(c * 0.65 for c in glass), tuple(min(1, c * 2.4 + 0.02) for c in glass))
    nb.L(nb.mix(win, wall_v, glass_v), b.inputs["Base Color"])
    nb.L(nb.m("MULTIPLY_ADD", win, 0.05 - wR, wR), b.inputs["Roughness"])
    nb.L(nb.m("MULTIPLY_ADD", win, -wM, wM), b.inputs["Metallic"])
    nb.L(nb.m("MULTIPLY_ADD", win, 0.3, 0.5), b.inputs["Specular IOR Level"])
    # sparse warm interiors (restrained); CityPower is what the episode animates
    pw = nb.val("CityPower", nb.kept.get("CityPower", 1.0))
    lit_mask = nb.m("MULTIPLY", win, nb.m("GREATER_THAN", r, 1 - lit))
    b.inputs["Emission Color"].default_value = (1.0, 0.74, 0.48, 1)
    nb.L(nb.m("MULTIPLY", nb.m("MULTIPLY", lit_mask, pw), 0.16 if kind != "store" else 0.35), b.inputs["Emission Strength"])
    # recessed windows + surface grain via bump (no window geometry)
    fine = nb.noise(tc.outputs["Object"], 18.0, 3.0, 0.6)
    h = nb.m("ADD", nb.m("SUBTRACT", 1.0, win), nb.m("MULTIPLY", fine.outputs["Fac"], 0.04 if wM < 0.5 else 0.01))
    bp = nb.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.9; bp.inputs["Distance"].default_value = 0.12
    nb.L(h, bp.inputs["Height"]); nb.L(bp.outputs[0], b.inputs["Normal"])
    haze(nb, out)
    mat["bay"] = bay
    return mat

for k in FACADES:
    facade(k)
M = {
    "roof":   simple("MAT_Roof", (0.16, 0.16, 0.16), 0.95, noise_amt=0.15, nscale=1.5, bump=0.3),
    "ledge":  simple("MAT_Ledge_Concrete", (0.40, 0.385, 0.36), 0.75, noise_amt=0.08, nscale=2.0, bump=0.15),
    "trim":   simple("MAT_Trim_Metal", (0.11, 0.115, 0.12), 0.35, metal=0.9),
    "plant":  simple("MAT_RoofPlant", (0.42, 0.43, 0.44), 0.5, metal=0.6, noise_amt=0.05),
    "curb":   simple("MAT_Curb_Granite", (0.34, 0.335, 0.32), 0.7, noise_amt=0.12, nscale=9.0, bump=0.2),
    "ground": simple("MAT_Ground_Concrete", (0.10, 0.098, 0.095), 0.9, noise_amt=0.2, nscale=0.08),
    "rubber": simple("MAT_Car_Tire", (0.018, 0.018, 0.02), 0.85, use_haze=False),
    "rim":    simple("MAT_Car_Rim", (0.55, 0.56, 0.58), 0.3, metal=1.0, use_haze=False),
    "plastic": simple("MAT_Car_Trim", (0.025, 0.025, 0.028), 0.55, use_haze=False),
    "pole":   simple("MAT_Pole_Charcoal", (0.07, 0.072, 0.078), 0.45, metal=0.8, use_haze=False),
    "grate":  simple("MAT_Drain_Grate", (0.03, 0.03, 0.03), 0.6, metal=0.6, use_haze=False),
    "signplate": simple("MAT_RoadSign_Blue", (0.03, 0.12, 0.35), 0.4, use_haze=False),
    "lens_off": simple("MAT_Signal_Lens_Off", (0.04, 0.012, 0.01), 0.1, use_haze=False),
    "amber_off": simple("MAT_Signal_Amber_Off", (0.06, 0.035, 0.005), 0.1, use_haze=False),
}
# car glass: dark, reflective
gm, gnb, gb, _ = reset("MAT_Car_Glass")
gb.inputs["Base Color"].default_value = (0.01, 0.012, 0.015, 1)
gb.inputs["Roughness"].default_value = 0.04
gb.inputs["Specular IOR Level"].default_value = 0.8
M["car_glass"] = gm
# contact shadow blob (cheap AO under cars)
bm_, bnb, bb, bout = reset("MAT_Car_ContactShadow")
uvs = bnb.new("ShaderNodeUVMap"); sep = bnb.new("ShaderNodeSeparateXYZ"); bnb.L(uvs.outputs[0], sep.inputs[0])
dx = bnb.m("MULTIPLY", bnb.m("ABSOLUTE", bnb.m("SUBTRACT", sep.outputs["X"], 0.5)), 2.0)
dy = bnb.m("MULTIPLY", bnb.m("ABSOLUTE", bnb.m("SUBTRACT", sep.outputs["Y"], 0.5)), 2.0)
dd = bnb.m("POWER", bnb.m("ADD", bnb.m("POWER", dx, 4.0), bnb.m("POWER", dy, 4.0)), 0.25)
alpha = bnb.m("MULTIPLY", bnb.m("SUBTRACT", 1.0, dd, clamp=True), 0.85, clamp=True)
bb.inputs["Base Color"].default_value = (0, 0, 0, 1); bb.inputs["Roughness"].default_value = 1.0
bnb.L(alpha, bb.inputs["Alpha"])
bm_.surface_render_method = "DITHERED"
M["blob"] = bm_
# lights
hl, *_ = emis_principled("MAT_Car_Headlight", (1.0, 0.93, 0.82), "Power", 2.5, base=(0.6, 0.6, 0.6), rough=0.1)
tl, *_ = emis_principled("MAT_Car_Taillight", (1.0, 0.04, 0.02), "Power", 1.5, base=(0.2, 0.01, 0.01), rough=0.15)
sg, *_ = emis_principled("MAT_Signal_Green", (0.15, 1.0, 0.45), "SignalPower", 6.0, base=(0.01, 0.04, 0.02), rough=0.1)
lamp, *_ = emis_principled("MAT_StreetLamp_Lens", (1.0, 0.8, 0.55), "Power", 0.0, base=(0.7, 0.68, 0.62), rough=0.3)
M.update(headlight=hl, taillight=tl, signal=sg, lamp=lamp)
# paint for crosswalks / stop lines (was emissive in v1)
pm, pnb, pb, pout = reset("MAT_Crosswalk")
tc = pnb.new("ShaderNodeTexCoord"); wear = pnb.noise(tc.outputs["Object"], 2.5, 4.0, 0.7)
pnb.L(pnb.mix(pnb.m("GREATER_THAN", wear.outputs["Fac"], 0.62), (0.70, 0.69, 0.66), (0.16, 0.16, 0.16)), pb.inputs["Base Color"])
pb.inputs["Roughness"].default_value = 0.6
haze(pnb, pout)
M["paint"] = pm

# ---- asphalt (keeps the v1 UV convention: u along road, v across) -------------
am, anb, ab, aout = reset("MAT_Asphalt")
u, v = anb.uv()
tc = anb.new("ShaderNodeTexCoord")
big = anb.noise(tc.outputs["Object"], 0.15, 3.0, 0.5)
grain = anb.noise(tc.outputs["Object"], 40.0, 2.0, 0.7)
asph = anb.mix(big.outputs["Fac"], (0.028, 0.028, 0.03), (0.065, 0.064, 0.064))
asph = anb.mix(anb.m("MULTIPLY", grain.outputs["Fac"], 0.25), asph, (0.12, 0.12, 0.12))
inline = anb.m("LESS_THAN", anb.m("ABSOLUTE", v), 0.075)
dash = anb.m("LESS_THAN", anb.m("FRACT", anb.m("DIVIDE", u, 9.0)), 0.34)
outx = anb.m("GREATER_THAN", anb.m("ABSOLUTE", u), 13.5)
av = anb.m("ABSOLUTE", v)
edge = anb.m("MULTIPLY", anb.m("MULTIPLY", anb.m("GREATER_THAN", av, 6.22), anb.m("LESS_THAN", av, 6.38)), outx)
paint = anb.m("MAXIMUM", anb.m("MULTIPLY", anb.m("MULTIPLY", inline, dash), outx), edge)
track = anb.m("MULTIPLY", anb.m("LESS_THAN", anb.m("ABSOLUTE", anb.m("SUBTRACT", av, 3.5)), 0.55),
              anb.noise(tc.outputs["Object"], 0.6, 2.0, 0.5).outputs["Fac"])
patch_n = anb.noise(tc.outputs["Object"], 0.045, 2.0, 0.4)
patches = anb.m("GREATER_THAN", patch_n.outputs["Fac"], 0.6)
asph = anb.mix(anb.m("MULTIPLY", patches, 0.55), asph, (0.018, 0.018, 0.02))
asph = anb.mix(anb.m("MULTIPLY", track, 0.45), asph, (0.012, 0.012, 0.013))
worn = anb.m("MULTIPLY", paint, anb.m("GREATER_THAN", anb.noise(tc.outputs["Object"], 3.0, 3.0, 0.6).outputs["Fac"], 0.38))
anb.L(anb.mix(worn, asph, (0.62, 0.61, 0.58)), ab.inputs["Base Color"])
anb.L(anb.m("MULTIPLY_ADD", big.outputs["Fac"], 0.25, 0.62), ab.inputs["Roughness"])
abp = anb.new("ShaderNodeBump"); abp.inputs["Strength"].default_value = 0.35; abp.inputs["Distance"].default_value = 0.01
anb.L(grain.outputs["Fac"], abp.inputs["Height"]); anb.L(abp.outputs[0], ab.inputs["Normal"])
haze(anb, aout)
# ---- sidewalk paving ----------------------------------------------------------
sm, snb, sb, sout = reset("MAT_Sidewalk")
tc = snb.new("ShaderNodeTexCoord")
br = snb.new("ShaderNodeTexBrick"); snb.L(tc.outputs["Object"], br.inputs["Vector"])
for k, val in (("Scale", 1.0), ("Mortar Size", 0.012), ("Brick Width", 0.6), ("Row Height", 0.6), ("Bias", 0.0)):
    br.inputs[k].default_value = val
br.offset = 0.5
br.inputs["Color1"].default_value = (0.23, 0.225, 0.215, 1); br.inputs["Color2"].default_value = (0.2, 0.196, 0.188, 1)
br.inputs["Mortar"].default_value = (0.2, 0.2, 0.19, 1)
snb.L(br.outputs["Color"], sb.inputs["Base Color"]); sb.inputs["Roughness"].default_value = 0.85
sbp = snb.new("ShaderNodeBump"); sbp.inputs["Strength"].default_value = 0.5; sbp.inputs["Distance"].default_value = 0.01
snb.L(br.outputs["Fac"], sbp.inputs["Height"]); snb.L(sbp.outputs[0], sb.inputs["Normal"])
haze(snb, sout)
for ob in sc.objects:
    if ob.name.startswith("ROAD_Sidewalk"):
        ob.data.materials[0] = M["curb"]

# =============================================================== mesh helpers
class Acc:
    """Accumulates boxes/cylinders with metre-true facade UVs and material indices."""
    def __init__(s):
        s.v, s.f, s.uv, s.mi = [], [], [], []
    def quad(s, pts, uvs, mi):
        b = len(s.v); s.v += pts; s.f.append(tuple(range(b, b + len(pts)))); s.uv.append(uvs); s.mi.append(mi)
    def box(s, cx, cy, z0, w, d, h, side, top, bottom=None, bay=None, rot=0.0):
        c, sn = math.cos(rot), math.sin(rot)
        def P(x, y, z):
            return (cx + x * c - y * sn, cy + x * sn + y * c, z)
        x, y, z1 = w / 2, d / 2, z0 + h
        corners = [(-x, -y), (x, -y), (x, y), (-x, y)]
        for i in range(4):
            (ax, ay), (bx, by) = corners[i], corners[(i + 1) % 4]
            L = w if i % 2 == 0 else d
            off = ((math.ceil(L / bay) * bay - L) / 2) if bay else 0.0
            s.quad([P(ax, ay, z0), P(bx, by, z0), P(bx, by, z1), P(ax, ay, z1)],
                   [(off, z0), (off + L, z0), (off + L, z1), (off, z1)], side)
        s.quad([P(-x, -y, z1), P(x, -y, z1), P(x, y, z1), P(-x, y, z1)],
               [(cx - x, cy - y), (cx + x, cy - y), (cx + x, cy + y), (cx - x, cy + y)], top)
        if bottom is not None:
            s.quad([P(-x, y, z0), P(x, y, z0), P(x, -y, z0), P(-x, -y, z0)], [(0, 0)] * 4, bottom)
    def cyl(s, cx, cy, z0, r, h, mi, seg=10, cap=True, axis="Z", rot=0.0):
        ring0, ring1 = [], []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            if axis == "Z":
                p0, p1 = (cx + r * math.cos(a), cy + r * math.sin(a), z0), (cx + r * math.cos(a), cy + r * math.sin(a), z0 + h)
            else:  # along local Y (wheels), then rotated about Z by rot
                lx, lz = r * math.cos(a), r * math.sin(a)
                c, sn = math.cos(rot), math.sin(rot)
                def P(xx, yy, zz):
                    return (cx + xx * c - yy * sn, cy + xx * sn + yy * c, z0 + zz)
                p0, p1 = P(lx, -h / 2, lz), P(lx, h / 2, lz)
            ring0.append(p0); ring1.append(p1)
        for k in range(seg):
            k2 = (k + 1) % seg
            s.quad([ring0[k], ring0[k2], ring1[k2], ring1[k]], [(k / seg * 2 * math.pi * r, 0), ((k + 1) / seg * 2 * math.pi * r, 0),
                    ((k + 1) / seg * 2 * math.pi * r, h), (k / seg * 2 * math.pi * r, h)], mi)
        if cap:
            b = len(s.v); s.v += ring1; s.f.append(tuple(range(b, b + seg))); s.uv.append([(0, 0)] * seg); s.mi.append(mi)
            b = len(s.v); s.v += ring0[::-1]; s.f.append(tuple(range(b, b + seg))); s.uv.append([(0, 0)] * seg); s.mi.append(mi)
    def mesh(s, name, mats, smooth=False, recalc=False):
        me = tag(bpy.data.meshes.new(name))
        me.from_pydata(s.v, [], s.f)
        uvl = me.uv_layers.new(name="UVMap")
        for poly, uv, mi in zip(me.polygons, s.uv, s.mi):
            poly.material_index = mi
            poly.use_smooth = smooth
            for li, c in zip(poly.loop_indices, uv):
                uvl.data[li].uv = c
        for m in mats:
            me.materials.append(m)
        me.validate(); me.update()
        if recalc:
            bm = bmesh.new(); bm.from_mesh(me)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me); bm.free()
        return me

def swap_mesh(objs, new_me):
    for ob in objs:
        old = ob.data
        ob.data = new_me
        if old.users == 0:
            bpy.data.meshes.remove(old)

# =============================================================== architecture
F = lambda k: MATS[FAC_MAT[k]]
SLOT = dict(fac=0, roof=1, ledge=2, trim=3, plant=4, store=5)
def bld_mats(kind):
    return [F(kind), M["roof"], M["ledge"], M["trim"], M["plant"], F("store")]

def parapet(a, cx, cy, z, w, d, mi, h=1.1, t=0.3):
    a.box(cx, cy - d / 2 + t / 2, z, w, t, h, mi, mi)
    a.box(cx, cy + d / 2 - t / 2, z, w, t, h, mi, mi)
    a.box(cx - w / 2 + t / 2, cy, z, t, d - 2 * t, h, mi, mi)
    a.box(cx + w / 2 - t / 2, cy, z, t, d - 2 * t, h, mi, mi)

def fins(a, cx, cy, z0, w, d, h, step, depth=0.45, thick=0.16):
    for side in (-1, 1):
        n = int(w // step)
        for k in range(n + 1):
            x = cx - (n * step) / 2 + k * step
            a.box(x, cy + side * (d / 2 + depth / 2), z0, thick, depth, h, SLOT["trim"], SLOT["trim"])
        n = int(d // step)
        for k in range(n + 1):
            y = cy - (n * step) / 2 + k * step
            a.box(cx + side * (w / 2 + depth / 2), y, z0, depth, thick, h, SLOT["trim"], SLOT["trim"])

def building(name, kind, w, d, h, style, podium=False, host=False):
    bay, flr = FACADES[kind][0], FACADES[kind][1]
    a = Acc()
    z = 0.0
    if podium:
        ph = FACADES["store"][1]
        a.box(0, 0, z, w, d, ph, SLOT["store"], SLOT["roof"], bay=FACADES["store"][0])
        a.box(0, 0, z + ph, w + 1.4, d + 1.4, 0.35, SLOT["ledge"], SLOT["ledge"], bottom=SLOT["trim"])   # canopy
        z += ph + 0.35
    rest = max(8.0, h - z)
    if host:
        tiers = [(w, d, rest * 0.72), (w * 0.72, d * 0.72, rest * 0.28)]
    elif style == "Slab":
        tiers = [(w, d, rest)]
    elif style == "Stepped":
        tiers = [(w, d, rest * 0.48), (w * 0.78, d * 0.78, rest * 0.32), (w * 0.56, d * 0.56, rest * 0.20)]
    elif style == "PodiumTower":
        tiers = [(w * 0.64, d * 0.72, rest)]
    else:  # Crown
        tiers = [(w, d, rest * 0.86), (w * 0.84, d * 0.84, rest * 0.14)]
    for ti, (tw, td, th) in enumerate(tiers):
        th = max(flr * 2, round(th / flr) * flr)             # whole floors -> believable proportions
        a.box(0, 0, z, tw, td, th, SLOT["fac"], SLOT["roof"], bay=bay)
        if kind == "metal" and not host:
            fins(a, 0, 0, z, tw, td, th, bay * 2)
        if kind in ("stone", "concrete"):
            for fz in range(4, int(th / flr), 4):            # floor bands every 4 storeys
                a.box(0, 0, z + fz * flr - 0.12, tw + 0.24, td + 0.24, 0.26, SLOT["ledge"], SLOT["ledge"], bottom=SLOT["ledge"])
        z += th
        corn = 0.55 if kind in ("stone", "concrete") else 0.25
        a.box(0, 0, z, tw + 2 * corn * 0.6, td + 2 * corn * 0.6, corn, SLOT["ledge"] if kind in ("stone", "concrete") else SLOT["trim"],
              SLOT["roof"], bottom=SLOT["ledge"])
        z_top = z + corn
        parapet(a, 0, 0, z_top, tw + corn * 1.2, td + corn * 1.2, SLOT["ledge"] if kind in ("stone", "concrete") else SLOT["trim"])
        z = z_top
        last = (tw, td, z)
    tw, td, zt = last
    if kind in ("glass", "bronze") and not host:                 # mechanical screen crown
        a.box(0, 0, zt, tw * 0.55, td * 0.55, 3.8, SLOT["trim"], SLOT["roof"])
        a.box(0, 0, zt + 3.8, tw * 0.3, td * 0.3, 1.2, SLOT["plant"], SLOT["plant"])
    me = a.mesh(name + "_Mesh", bld_mats(kind))
    return me, (tw, td, zt)

hvac = Acc()
hvac.box(0, 0, 0, 2.6, 1.6, 1.4, 0, 0)
hvac.cyl(-0.6, 0, 1.4, 0.5, 0.12, 0, seg=12); hvac.cyl(0.6, 0, 1.4, 0.5, 0.12, 0, seg=12)
HVAC = hvac.mesh("PROP_Rooftop_HVAC", [M["plant"]])
tank = Acc()
for (x, y) in ((-0.9, -0.9), (0.9, -0.9), (0.9, 0.9), (-0.9, 0.9)):
    tank.box(x, y, 0, 0.15, 0.15, 2.0, 0, 0)
tank.cyl(0, 0, 2.0, 1.5, 3.0, 1, seg=14)
TANK = tank.mesh("PROP_Rooftop_Tank", [M["trim"], M["ledge"]])
ant = Acc(); ant.cyl(0, 0, 0, 0.12, 14.0, 0, seg=6); ant.box(0, 0, 0, 1.0, 1.0, 0.6, 0, 0)
ANT = ant.mesh("PROP_Rooftop_Antenna", [M["trim"]])

C = {c.name.split(".")[0]: c for c in sc.collection.children}
for ob in [o for o in sc.objects if o.name.startswith("PROP_Roof_")]:
    OBJ.remove(ob, do_unlink=True)
def place(name, data, coll, loc, rot=0.0, scale=1.0):
    ob = tag(OBJ.new(name, data)); ob.location = loc; ob.rotation_euler = (0, 0, rot); ob.scale = (scale,) * 3
    C[coll].objects.link(ob)
    return ob

KINDS = ["glass", "concrete", "metal", "stone", "bronze"]
heroes = sorted([o for o in sc.objects if o.name.startswith("BLDG_")], key=lambda o: o.name)
report = []
for i, ob in enumerate(heroes):
    style = ob.name.split("_")[-1]
    w, d, h = ob.dimensions
    host = ob.name in ("BLDG_02_Stepped", "BLDG_03_PodiumTower")
    if host:
        kind = "concrete" if ob.name.startswith("BLDG_02") else "stone"
        w = d = 18.0
    else:
        kind = KINDS[(i * 3 + 1) % len(KINDS)]
    front = ob.location.y < 0
    podium = host or front or style == "PodiumTower" or random.random() < 0.35
    me, (tw, td, zt) = building(ob.name, kind, w, d, h, style, podium=podium, host=host)
    ob["v2_base"] = (w, d, h); ob["v2_kind"] = kind; ob["v2_style"] = style; ob["v2_podium"] = podium; ob["v2_host"] = host
    swap_mesh([ob], me)
    # rooftop plant: linked duplicates
    for k in range(random.randint(2, 4)):
        px, py = random.uniform(-tw * 0.3, tw * 0.3), random.uniform(-td * 0.3, td * 0.3)
        place(f"PROP_Roof_HVAC_{i:02d}_{k}", HVAC, "CITY_BUILDINGS", ob.location + Vector((px, py, zt)), random.choice((0, math.pi / 2)))
    if kind in ("concrete", "stone") and random.random() < 0.6:
        place(f"PROP_Roof_Tank_{i:02d}", TANK, "CITY_BUILDINGS", ob.location + Vector((tw * 0.25, -td * 0.22, zt)))
    if zt > 70:
        place(f"PROP_Roof_Antenna_{i:02d}", ANT, "CITY_BUILDINGS", ob.location + Vector((0, 0, zt + (5.0 if kind in ("glass", "bronze") else 0))))
    report.append((ob.name, kind, round(zt, 1)))

# background skyline: same instanced meshes, simplified massing + parapets, varied facades
bg_users = {}
for ob in sc.objects:
    if ob.name.startswith("BG_Skyline_"):
        bg_users.setdefault(ob.data.name, []).append(ob)
for j, (mname, users) in enumerate(sorted(bg_users.items())):
    me_old = bpy.data.meshes[mname]
    zs = sorted({round(v.co.z, 2) for v in me_old.vertices})
    xs = [v.co.x for v in me_old.vertices]; ys = [v.co.y for v in me_old.vertices]
    w, d, h = max(xs) - min(xs), max(ys) - min(ys), max(zs)
    kind = ["concrete", "glass", "stone", "metal", "bronze", "concrete", "glass", "stone", "metal"][j % 9]
    bay, flr = FACADES[kind][:2]
    a = Acc()
    if len(zs) > 2 and h > 30:
        h1 = round(h * 0.7 / flr) * flr
        a.box(0, 0, 0, w, d, h1, 0, 1, bay=bay); a.box(0, 0, h1, w + 0.6, d + 0.6, 0.4, 2, 1)
        a.box(0, 0, h1 + 0.4, w * 0.62, d * 0.62, h - h1, 0, 1, bay=bay); top = h + 0.4; pw, pd = w * 0.62, d * 0.62
    else:
        a.box(0, 0, 0, w, d, h, 0, 1, bay=bay); top = h; pw, pd = w, d
    parapet(a, 0, 0, top, pw, pd, 2, h=1.0)
    swap_mesh(users, a.mesh(mname + "_v2", [F(kind), M["roof"], M["ledge"]]))

# =============================================================== streets & furniture
for ob in [o for o in sc.objects if o.name.startswith(("STREET_", "ROAD_StopLine", "ROAD_Drain", "ROAD_Sign_"))]:
    OBJ.remove(ob, do_unlink=True)
for ob in sc.objects:                       # crosswalk stripes: thinner, standard 0.5 m bars
    if ob.name.startswith("ROAD_Crosswalk_"):
        ob.scale = (1.0, 0.9, 1.0)
lamp_a = Acc()
lamp_a.cyl(0, 0, 0, 0.16, 0.7, 0, seg=10)
lamp_a.cyl(0, 0, 0.7, 0.09, 8.2, 0, seg=10)
lamp_a.box(1.05, 0, 8.65, 2.3, 0.12, 0.12, 0, 0)
lamp_a.box(2.35, 0, 8.5, 0.75, 0.32, 0.18, 0, 0)
lamp_a.quad([(1.98, -0.15, 8.49), (2.72, -0.15, 8.49), (2.72, 0.15, 8.49), (1.98, 0.15, 8.49)][::-1], [(0, 0)] * 4, 1)
STREETLAMP = lamp_a.mesh("STREET_Light_Mesh", [M["pole"], M["lamp"]], recalc=True)
n = 0
for axis in ("X", "Y"):
    for side in (-1, 1):
        for sgn in (-1, 1):
            for t in range(18, 170, 26):
                if axis == "X":
                    loc, rot = (sgn * t, side * 7.55, 0.15 if t < 57 else -0.02), (-math.pi / 2 if side > 0 else math.pi / 2)
                else:
                    loc, rot = (side * 7.55, sgn * t, 0.15 if t < 57 else -0.02), (math.pi if side > 0 else 0.0)
                place(f"STREET_Light_{n:03d}", STREETLAMP, "LIGHTS", loc, rot); n += 1
grate = Acc(); grate.box(0, 0, 0, 0.9, 0.45, 0.02, 0, 0)
GRATE = grate.mesh("ROAD_Drain_Mesh", [M["grate"]])
k = 0
for sgn in (-1, 1):
    for t in range(22, 120, 30):
        for side in (-1, 1):
            place(f"ROAD_Drain_{k:02d}", GRATE, "ROADS", (sgn * t, side * 6.65, 0.012)); k += 1
            place(f"ROAD_Drain_{k:02d}", GRATE, "ROADS", (side * 6.65, sgn * t, 0.012), math.pi / 2); k += 1
stop = Acc(); stop.box(0, 0, 0, 0.45, 6.6, 0.012, 0, 0)
STOP = stop.mesh("ROAD_StopLine_Mesh", [M["paint"]])
for nm, loc, rot in (("W", (-13.2, -3.5, 0.006), 0), ("E", (13.2, 3.5, 0.006), 0), ("N", (-3.5, 13.2, 0.006), math.pi / 2), ("S", (3.5, -13.2, 0.006), math.pi / 2)):
    place(f"ROAD_StopLine_{nm}", STOP, "ROADS", loc, rot)
sign = Acc(); sign.cyl(0, 0, 0, 0.05, 2.9, 0, seg=8); sign.box(0, -0.06, 2.3, 0.75, 0.04, 0.75, 1, 1)
SIGN = sign.mesh("ROAD_Sign_Mesh", [M["pole"], M["signplate"]], recalc=True)
place("ROAD_Sign_SW", SIGN, "ROADS", (-10.2, -14.5, 0.15), 0.0)
place("ROAD_Sign_NE", SIGN, "ROADS", (10.2, 14.5, 0.15), math.pi)

# traffic signals: pole + mast arm + 3-lamp heads (green lens keeps MAT_Signal_Green)
sa = Acc()
sa.cyl(0, 0, 0, 0.14, 6.6, 0, seg=10)
sa.box(2.6, 0, 6.2, 5.2, 0.14, 0.14, 0, 0)
for hx, hz in ((4.9, 5.25), (0.0, 2.6)):
    sa.box(hx, 0, hz, 0.36, 0.3, 1.05, 0, 0)
    for li, (mz, mi) in enumerate(((0.85, 1), (0.53, 2), (0.21, 3))):
        sa.cyl(hx, 0.16, hz + mz, 0.11, 0.04, mi, seg=10, axis="Y")
SIGNAL = sa.mesh("SIGNAL_Mesh_v2", [M["pole"], M["lens_off"], M["amber_off"], M["signal"]], recalc=True)
SIG_ROT = {"WS": math.pi / 2, "EN": -math.pi / 2, "WN": 0.0, "ES": math.pi}
for ob in sc.objects:
    if ob.name.startswith("SIGNAL_") and ob.type == "MESH":
        ob.rotation_euler = (0, 0, SIG_ROT[ob.name.split("_")[1]])
swap_mesh([o for o in sc.objects if o.name.startswith("SIGNAL_") and o.type == "MESH"], SIGNAL)

# =============================================================== billboards
fr = Acc()
fr.box(0, -0.275, -2.6, 8.4, 0.55, 5.2, 0, 0, bottom=0)            # housing (back on the wall)
for (bx, bz, bw, bh) in ((0, 2.4, 8.5, 0.25), (0, -2.65, 8.5, 0.25), (-4.125, -2.4, 0.25, 4.8), (4.125, -2.4, 0.25, 4.8)):
    fr.box(bx, -0.62, bz, bw, 0.14, bh, 1, 1, bottom=1)          # bezel around the screen
for bx in (-3.0, 3.0):
    fr.box(bx, -0.12, -3.6, 0.22, 0.24, 7.2, 0, 0, bottom=0)      # support rails into the wall
FRAME = fr.mesh("SIGN_Frame_Mesh_v2", [M["trim"], M["plastic"]])
for i in range(1, 5):
    scr, txt, frm = OBJ[f"SIGN_{i}_Screen"], OBJ[f"SIGN_{i}_Text"], OBJ[f"SIGN_{i}_Frame"]
    x, z = scr.location.x, scr.location.z
    frm.location = (x, 10.0, z); swap_mesh([frm], FRAME)
    scr.location.y, txt.location.y = 9.32, 9.27
    col = tuple(MATS[f"MAT_Sign_{i}_Panel"].node_tree.nodes["Emission"].inputs["Color"].default_value)[:3] \
        if "Emission" in MATS[f"MAT_Sign_{i}_Panel"].node_tree.nodes else (1, 0.4, 0.07)
    pm_, pnb_, pb_ = emis_principled(f"MAT_Sign_{i}_Panel", col, "Power", 2.6, base=(0.01, 0.01, 0.012), rough=0.18)
    u_, v_ = pnb_.uv()
    grad = pnb_.mix(pnb_.m("MULTIPLY_ADD", v_, 0.12, 0.5, clamp=True), tuple(c * 0.55 for c in col), col)
    pnb_.L(grad, pb_.inputs["Emission Color"])
    tm_, tnb_, tb_ = emis_principled(f"MAT_Sign_{i}_Text", (1, 0.98, 0.95), "Power", 6.0, base=(0.8, 0.8, 0.8), rough=0.3)
    txt.data.size = 1.25

# =============================================================== vehicles
def sedan():
    a = Acc()
    W, Wg = 1.84, 1.56
    lower = [(-2.30, 0.32), (2.30, 0.32), (2.32, 0.62), (2.18, 0.86), (1.15, 0.98), (-1.50, 1.00), (-2.22, 0.95), (-2.34, 0.62)]
    green = [(-1.48, 1.00), (1.15, 0.98), (0.42, 1.43), (-0.80, 1.42)]
    def prism(poly, width, side_mi, cap_mi_fn):
        n = len(poly); b = len(a.v)
        for (x, z) in poly:
            a.v.append((x, -width / 2, z))
        for (x, z) in poly:
            a.v.append((x, width / 2, z))
        a.f.append(tuple(range(b, b + n))[::-1]); a.uv.append([(0, 0)] * n); a.mi.append(side_mi)
        a.f.append(tuple(range(b + n, b + 2 * n))); a.uv.append([(0, 0)] * n); a.mi.append(side_mi)
        for k in range(n):
            k2 = (k + 1) % n
            a.f.append((b + k, b + k2, b + n + k2, b + n + k)); a.uv.append([(0, 0)] * 4); a.mi.append(cap_mi_fn(k))
    prism(lower, W, 0, lambda k: 0)
    prism(green, Wg, 1, lambda k: 0 if k == 2 else 1)              # glass all round, painted roof
    for (x, y) in ((-1.42, -0.80), (-1.42, 0.80), (1.42, -0.80), (1.42, 0.80)):
        a.cyl(x, y, 0.34, 0.34, 0.24, 4, seg=16, axis="Y")
        a.cyl(x, y + (0.125 if y > 0 else -0.125), 0.34, 0.22, 0.012, 5, seg=12, axis="Y")
    for y in (-0.6, 0.6):
        a.box(2.31, y, 0.66, 0.04, 0.36, 0.13, 2, 2)
        a.box(-2.35, y, 0.68, 0.04, 0.34, 0.12, 3, 3)
    a.box(2.33, 0, 0.32, 0.06, 1.7, 0.22, 7, 7)                     # bumpers / sills
    a.box(-2.36, 0, 0.32, 0.06, 1.7, 0.24, 7, 7)
    for y in (-0.93, 0.93):
        a.box(0.0, y, 0.32, 2.4, 0.03, 0.12, 7, 7)
    a.quad([(-2.55, -1.15, 0.015), (2.55, -1.15, 0.015), (2.55, 1.15, 0.015), (-2.55, 1.15, 0.015)],
           [(0, 0), (1, 0), (1, 1), (0, 1)], 6)                       # contact shadow
    me = a.mesh("CAR_Mesh_v2", [M["plastic"], M["car_glass"], M["headlight"], M["taillight"],
                                M["rubber"], M["rim"], M["blob"], M["plastic"]])
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    body = [e for e in bm.edges if all(f.material_index == 0 for f in e.link_faces) and len(e.link_faces) == 2
            and e.calc_face_angle(0) > 0.35]
    bmesh.ops.bevel(bm, geom=body, offset=0.045, segments=2, profile=0.5, affect="EDGES")
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = p.material_index == 4
    return me
CAR = sedan()
paints = {}
for nm, col in (("Orange", (0.42, 0.13, 0.04)), ("Blue", (0.04, 0.09, 0.22)), ("White", (0.72, 0.72, 0.70)), ("Charcoal", (0.03, 0.032, 0.036))):
    paints[nm] = simple(f"MAT_Car_Body_{nm}", col, 0.32, metal=0.55, coat=1.0, use_haze=False)
order = ["White", "Charcoal", "Blue", "Orange"]
cars = sorted([o for o in sc.objects if o.name.startswith("CAR_")], key=lambda o: o.name)
swap_mesh(cars, CAR)
for ci, ob in enumerate(cars):
    ob.material_slots[0].link = "OBJECT"
    ob.material_slots[0].material = paints[order[ci % 4]]
    ob.location.z = 0.0

# =============================================================== pedestrians
CLOTH = [((0.10, 0.12, 0.16), (0.18, 0.18, 0.19)), ((0.55, 0.47, 0.36), (0.09, 0.13, 0.22)),
         ((0.05, 0.05, 0.055), (0.03, 0.03, 0.035)), ((0.42, 0.16, 0.09), (0.32, 0.31, 0.30))]
SKIN = [(0.62, 0.45, 0.34), (0.40, 0.27, 0.19), (0.25, 0.16, 0.11), (0.70, 0.55, 0.45)]
def person(k, stride):
    bm = bmesh.new()
    def cone(r1, r2, depth, loc, rot=(0, 0, 0), scale=(1, 1, 1), mi=0, seg=10):
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=depth,
                                    matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), Vector(scale)))
        for f in {f for v in res["verts"] for f in v.link_faces}:
            f.material_index = mi
    a = math.radians(stride)
    for sgn in (-1, 1):                                       # legs (stride), shoes
        cone(0.075, 0.06, 0.86, (sgn * math.sin(a) * 0.43, sgn * 0.095, 0.47), (0, sgn * a, 0), mi=1)
        cone(0.06, 0.06, 0.08, (sgn * math.sin(a) * 0.86 + 0.04, sgn * 0.095, 0.04), (0, math.pi / 2, 0), (1, 1, 1.6), mi=1)
    cone(0.135, 0.19, 0.62, (0, 0, 1.18), scale=(0.62, 1.0, 1.0), mi=0)   # torso (flattened)
    for sgn in (-1, 1):                                       # arms swing opposite to legs
        cone(0.05, 0.042, 0.62, (-sgn * math.sin(a) * 0.3, sgn * 0.235, 1.15), (0, -sgn * a * 0.8, 0), mi=0)
    cone(0.05, 0.05, 0.1, (0, 0, 1.52), mi=2)                 # neck
    res = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.105,
                                    matrix=Matrix.LocRotScale(Vector((0.01, 0, 1.65)), None, Vector((1.0, 0.9, 1.12))))
    for f in {f for v in res["verts"] for f in v.link_faces}:
        f.material_index = 2
    me = tag(bpy.data.meshes.new(f"PED_Mesh_v2_{k}")); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    top, pants = CLOTH[k % 4]
    me.materials.append(simple(f"MAT_Ped_Top_{k}", top, 0.85, use_haze=False))
    me.materials.append(simple(f"MAT_Ped_Pants_{k}", pants, 0.8, use_haze=False))
    me.materials.append(simple(f"MAT_Ped_Skin_{k}", SKIN[k % 4], 0.6, use_haze=False))
    return me
PEDS = [person(k, (14, -10, 4, 18)[k]) for k in range(4)]
peds = sorted([o for o in sc.objects if o.name.startswith("PED_")], key=lambda o: o.name)
for pi_, ob in enumerate(peds):
    old = ob.data; ob.data = PEDS[pi_ % 4]
    if old.users == 0:
        bpy.data.meshes.remove(old)
    ob.scale = (random.uniform(0.94, 1.06),) * 3

# =============================================================== light, sky, render
sun = OBJ["LIGHT_Sun_Main"]
sun.rotation_euler = (math.radians(90 - SUN_ELEV), 0, math.radians(SUN_AZ))
sun.data.energy, sun.data.color, sun.data.angle = 5.0, (1.0, 0.78, 0.58), math.radians(1.2)
OBJ["ROAD_Ground"].scale = (20.0, 20.0, 1.0); OBJ["ROAD_Ground"].location.z = -0.06        # ground reaches the horizon (no dark band)
fill = OBJ["LIGHT_Fill_Sky"]; fill.data.energy = 0.15
world = sc.world; wnt = world.node_tree; wnt.nodes.clear()
wout = wnt.nodes.new("ShaderNodeOutputWorld"); bg = wnt.nodes.new("ShaderNodeBackground")
sky_ok = True
try:
    sky = wnt.nodes.new("ShaderNodeTexSky"); sky.sky_type = "MULTIPLE_SCATTERING"
    for attr, val in (("sun_elevation", math.radians(SUN_ELEV)), ("sun_rotation", math.radians(SUN_AZ + 180)),
                      ("sun_disc", False), ("altitude", 30.0), ("air_density", 1.0), ("aerosol_density", 2.2),
                      ("dust_density", 2.2), ("ozone_density", 1.0)):
        if hasattr(sky, attr):
            setattr(sky, attr, val)
    wnt.links.new(sky.outputs[0], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.08
except Exception as e:
    sky_ok = repr(e)
# below the horizon the sky model goes dark navy: fade it into the same haze the ground fades into
bgh = wnt.nodes.new("ShaderNodeBackground"); bgh.inputs["Color"].default_value = (*HAZE, 1)
bgh.inputs["Strength"].default_value = 1.0
tcw = wnt.nodes.new("ShaderNodeTexCoord"); sepw = wnt.nodes.new("ShaderNodeSeparateXYZ")
mrw = wnt.nodes.new("ShaderNodeMapRange"); mrw.clamp = True
mrw.inputs["From Min"].default_value, mrw.inputs["From Max"].default_value = -0.005, 0.04
mrw.inputs["To Min"].default_value, mrw.inputs["To Max"].default_value = 1.0, 0.0
mxw = wnt.nodes.new("ShaderNodeMixShader")
wnt.links.new(tcw.outputs["Generated"], sepw.inputs[0]); wnt.links.new(sepw.outputs["Z"], mrw.inputs["Value"])
wnt.links.new(mrw.outputs["Result"], mxw.inputs[0]); wnt.links.new(bg.outputs[0], mxw.inputs[1])
wnt.links.new(bgh.outputs[0], mxw.inputs[2]); wnt.links.new(mxw.outputs[0], wout.inputs[0])

ee = sc.eevee
ee.use_fast_gi = True
ee.fast_gi_method = "GLOBAL_ILLUMINATION"
ee.fast_gi_distance = 6.0
ee.fast_gi_resolution = "2"
ee.use_raytracing = False                 # glass reflects the sky probe; SSR benchmarked separately
ee.shadow_ray_count, ee.shadow_step_count = 1, 6
ee.taa_render_samples = 32
vs = sc.view_settings
vs.view_transform = "AgX"
looks = [l.identifier for l in vs.bl_rna.properties["look"].enum_items]
for want in ("AgX - Medium High Contrast", "Medium High Contrast", "AgX - Base Contrast"):
    if want in looks:
        vs.look = want
        break
vs.exposure = 0.0

bpy.data.libraries.write(str(OUT), {sc}, path_remap="NONE", compress=True)
tris = sum(len(p.vertices) - 2 for ob in sc.objects if ob.type == "MESH" for p in ob.data.polygons)
result = {"saved": str(OUT), "sky": sky_ok, "look": vs.look, "looks": looks, "heroes": report,
          "objects": len(sc.objects), "scene_tris_incl_instances": tris,
          "unique_mesh_tris": sum(len(p.vertices) - 2 for me in bpy.data.meshes if me.get(TAG) and me.users for p in me.polygons)}
print("[upgrade_v2]", result)
