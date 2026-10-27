"""
WhatIfStudio EP001 v5 - aerial_v5.py : aerial realism pass (starts from the v4 hero-test scene).
Camera-aware: the 11 objects below were chosen by ray-casting the aerial camera (frame 36)
for screen area and skyline-edge coverage. Each gets a UNIQUE modern design (its own mesh);
the rest of the background gets more shared variants. Brick hero tower is left as is.
Writes master_city_v5.blend. Earlier masters are not touched.
"""
import bpy, bmesh, math, random
from pathlib import Path
from mathutils import Vector, Matrix, Euler
ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
OUT = ROOT / "master_city_v5.blend"
sc = bpy.data.scenes["EP001_City_v2"]; TAG = "whatif_v2"
OBJ, MATS = bpy.data.objects, bpy.data.materials
random.seed(55)
HAZE = (0.50, 0.50, 0.54); Z = Vector((0, 0, 1))
def sock(ss, ident): return next(s for s in ss if s.identifier == ident or s.name == ident)

# ------------------------------------------------------------------ materials
def haze(nt, out, near=380, far=2300, amount=0.55):
    src = out.inputs["Surface"].links[0].from_socket
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.clamp = True
    nt.links.new(nt.nodes.new("ShaderNodeCameraData").outputs["View Distance"], mr.inputs["Value"])
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = near, far
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 0.0, amount
    em = nt.nodes.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (*HAZE, 1)
    mx = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(mr.outputs["Result"], mx.inputs[0]); nt.links.new(src, mx.inputs[1]); nt.links.new(em.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs["Surface"])
def new_mat(name):
    m = MATS.get(name) or MATS.new(name); m[TAG] = 1; m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"]); return m, nt, b, out
def M_(nt, op, a, b_=None, c=None):
    n = nt.nodes.new("ShaderNodeMath"); n.operation = op
    for i, x in enumerate((a, b_, c)):
        if x is None: continue
        if isinstance(x, (int, float)): n.inputs[i].default_value = x
        else: nt.links.new(x, n.inputs[i])
    return n.outputs[0]
def MIX(nt, f, a, b_):
    n = nt.nodes.new("ShaderNodeMix"); n.data_type = "RGBA"
    for sk, x in ((sock(n.inputs, "Factor_Float"), f), (sock(n.inputs, "A_Color"), a), (sock(n.inputs, "B_Color"), b_)):
        if isinstance(x, (int, float)): sk.default_value = x
        elif isinstance(x, tuple): sk.default_value = (*x, 1) if len(x) == 3 else x
        else: nt.links.new(x, sk)
    return sock(n.outputs, "Result_Color")
def facade(name, bay, flr, mul, sill, head, wall, wR, wM, glass, gR=0.04, lit=0.05, spandrel=None, vgrid=None):
    """Metre-true facade shader. vgrid=(every, width): extra vertical frame lines every N bays (bigger rhythm).
    spandrel=(colour): ribbon/spandrel band colour different from wall."""
    m, nt, b, out = new_mat(name)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(nt.nodes.new("ShaderNodeUVMap").outputs["UV"], sep.inputs[0])
    u, v = sep.outputs["X"], sep.outputs["Y"]
    fu, fv = M_(nt, "DIVIDE", u, bay), M_(nt, "DIVIDE", v, flr)
    cu, cv = M_(nt, "FRACT", fu), M_(nt, "FRACT", fv)
    inx = M_(nt, "MULTIPLY", M_(nt, "GREATER_THAN", cu, mul), M_(nt, "LESS_THAN", cu, 1 - mul))
    iny = M_(nt, "MULTIPLY", M_(nt, "GREATER_THAN", cv, sill), M_(nt, "LESS_THAN", cv, head))
    win = M_(nt, "MULTIPLY", inx, iny)
    if vgrid:
        big = M_(nt, "FRACT", M_(nt, "DIVIDE", u, bay * vgrid[0]))
        win = M_(nt, "MULTIPLY", win, M_(nt, "GREATER_THAN", big, vgrid[1]))
    oi = nt.nodes.new("ShaderNodeObjectInfo")
    cell = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(M_(nt, "FLOOR", fu), cell.inputs[0]); nt.links.new(M_(nt, "FLOOR", fv), cell.inputs[1])
    nt.links.new(M_(nt, "MULTIPLY", oi.outputs["Random"], 91.0), cell.inputs[2])
    wn = nt.nodes.new("ShaderNodeTexWhiteNoise"); wn.noise_dimensions = "3D"; nt.links.new(cell.outputs[0], wn.inputs["Vector"])
    r = wn.outputs["Value"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 0.2; nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    wall_c = MIX(nt, oi.outputs["Random"], tuple(c * 0.88 for c in wall), tuple(min(1, c * 1.1) for c in wall))
    wall_c = MIX(nt, M_(nt, "MULTIPLY", nz.outputs["Fac"], 0.3), wall_c, tuple(c * 0.75 for c in wall))
    if spandrel:
        band = M_(nt, "MULTIPLY", inx, M_(nt, "SUBTRACT", 1.0, iny))
        wall_c = MIX(nt, band, wall_c, spandrel)
    # glass: sky reflection does most of the work; panes vary slightly (tint / blinds)
    gl = MIX(nt, r, tuple(c * 0.7 for c in glass), tuple(min(1, c * 1.9 + 0.01) for c in glass))
    nt.links.new(MIX(nt, win, wall_c, gl), b.inputs["Base Color"])
    nt.links.new(M_(nt, "MULTIPLY_ADD", win, gR - wR, wR), b.inputs["Roughness"])
    nt.links.new(M_(nt, "MULTIPLY_ADD", win, -wM, wM), b.inputs["Metallic"])
    nt.links.new(M_(nt, "MULTIPLY_ADD", win, 0.25, 0.5), b.inputs["Specular IOR Level"])
    pw = nt.nodes.new("ShaderNodeValue"); pw.name = pw.label = "CityPower"; pw.outputs[0].default_value = 1.0
    b.inputs["Emission Color"].default_value = (1.0, 0.75, 0.5, 1)
    nt.links.new(M_(nt, "MULTIPLY", M_(nt, "MULTIPLY", M_(nt, "MULTIPLY", win, M_(nt, "GREATER_THAN", r, 1 - lit)), pw.outputs[0]), 0.16), b.inputs["Emission Strength"])
    bp = nt.nodes.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = 0.6; bp.inputs["Distance"].default_value = 0.08
    nt.links.new(M_(nt, "SUBTRACT", 1.0, win), bp.inputs["Height"]); nt.links.new(bp.outputs[0], b.inputs["Normal"])
    haze(nt, out)
    for f, val in ((1, 1.0), (217, 1.0), (288, 0.25)):                     # same dimming curve as the episode
        pw.outputs[0].default_value = val; pw.outputs[0].keyframe_insert("default_value", frame=f)
    return m
def plain(name, col, rough, metal=0.0, stripes=None):
    m, nt, b, out = new_mat(name)
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if stripes:                                                          # louvres / solar cells
        sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(nt.nodes.new("ShaderNodeUVMap").outputs["UV"], sep.inputs[0])
        line = M_(nt, "LESS_THAN", M_(nt, "FRACT", M_(nt, "DIVIDE", sep.outputs[stripes[0]], stripes[1])), 0.25)
        nt.links.new(MIX(nt, line, col, tuple(c * 0.35 for c in col)), b.inputs["Base Color"])
    haze(nt, out); return m
F = {
 "silver": facade("MAT_V5_Glass_Silver", 1.5, 4.0, 0.03, 0.05, 0.97, (0.42, 0.44, 0.46), 0.3, 0.9, (0.035, 0.05, 0.065), gR=0.03),
 "teal":   facade("MAT_V5_Glass_Teal", 1.25, 3.8, 0.025, 0.08, 0.96, (0.10, 0.12, 0.12), 0.35, 0.8, (0.02, 0.05, 0.05), gR=0.04, spandrel=(0.05, 0.07, 0.07)),
 "precast": facade("MAT_V5_Precast_White", 2.25, 3.8, 0.10, 0.22, 0.86, (0.62, 0.61, 0.58), 0.75, 0.0, (0.02, 0.025, 0.03), gR=0.05),
 "lime":   facade("MAT_V5_Limestone", 1.8, 3.9, 0.30, 0.12, 0.90, (0.56, 0.51, 0.43), 0.8, 0.0, (0.025, 0.028, 0.032), gR=0.05, vgrid=(4, 0.12)),
 "black":  facade("MAT_V5_Metal_Black", 1.6, 3.7, 0.0, 0.46, 0.93, (0.035, 0.036, 0.04), 0.35, 0.75, (0.05, 0.06, 0.07), gR=0.03),
 "terra":  facade("MAT_V5_Terracotta", 1.2, 3.6, 0.26, 0.14, 0.86, (0.44, 0.25, 0.17), 0.8, 0.0, (0.025, 0.027, 0.03), gR=0.05),
 "ribbon": facade("MAT_V5_Ribbon_Concrete", 1.8, 3.7, 0.0, 0.40, 0.90, (0.50, 0.49, 0.47), 0.8, 0.0, (0.03, 0.04, 0.05), gR=0.04),
}
P = {
 "roof": MATS["MAT_Roof"], "trim": MATS["MAT_Trim_Metal"], "plant": MATS["MAT_RoofPlant"], "walk": MATS["MAT_Sidewalk"], "ledge": MATS["MAT_Ledge_Concrete"],
 "louver": plain("MAT_V5_Louvre", (0.36, 0.37, 0.38), 0.45, metal=0.6, stripes=("Y", 0.3)),
 "solar": plain("MAT_V5_Solar", (0.03, 0.05, 0.12), 0.15, metal=0.3, stripes=("X", 0.5)),
 "green": plain("MAT_V5_GreenRoof", (0.09, 0.15, 0.06), 0.95),
 "silvertrim": plain("MAT_V5_Mullion_Silver", (0.55, 0.56, 0.57), 0.3, metal=0.9),
}

# ------------------------------------------------------------------ geometry
class Acc:
    def __init__(s, slots): s.v, s.f, s.uv, s.mi, s.slots = [], [], [], [], slots
    def S(s, key):
        if key not in s.slots: s.slots.append(key)
        return s.slots.index(key)
    def face(s, pts, uvs, key, normal=None):
        pts = [Vector(p) for p in pts]
        if normal is not None and len(pts) >= 3 and (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(Vector(normal)) < 0:
            pts, uvs = pts[::-1], uvs[::-1]
        b = len(s.v); s.v += [tuple(p) for p in pts]; s.f.append(tuple(range(b, b + len(pts)))); s.uv.append(uvs); s.mi.append(s.S(key))
    def prism(s, poly, z0, h, side, top="roof", bottom=False, z_top=None):
        """poly: CCW (x,y) list. Side UVs metre-true (u = perimeter length, v = z). z_top(x,y) allows sloped roofs."""
        n = len(poly); u = 0.0
        zt = (lambda x, y: z0 + h) if z_top is None else z_top
        cx = sum(p[0] for p in poly) / n; cy = sum(p[1] for p in poly) / n
        for i in range(n):
            (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
            L = math.hypot(bx - ax, by - ay)
            nrm = Vector((by - ay, -(bx - ax), 0))
            s.face([(ax, ay, z0), (bx, by, z0), (bx, by, zt(bx, by)), (ax, ay, zt(ax, ay))],
                   [(u, z0), (u + L, z0), (u + L, zt(bx, by)), (u, zt(ax, ay))], side, nrm)
            u += L
        s.face([(x, y, zt(x, y)) for x, y in poly], [(x, y) for x, y in poly], top, Z)
        if bottom: s.face([(x, y, z0) for x, y in poly], [(0, 0)] * n, side, -Z)
    def box(s, cx, cy, z0, w, d, h, side, top=None, bottom=True):
        s.prism([(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)], z0, h, side, top or side, bottom)
    def cyl(s, cx, cy, z0, r, h, side, seg=20, top=None):
        s.prism([(cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)], z0, h, side, top or side)
    def mesh(s, name):
        me = bpy.data.meshes.new(name); me[TAG] = 1; me.from_pydata(s.v, [], s.f)
        uvl = me.uv_layers.new(name="UVMap")
        for poly, uv, mi in zip(me.polygons, s.uv, s.mi):
            poly.material_index = mi
            for li, c in zip(poly.loop_indices, uv): uvl.data[li].uv = c
        for k in s.slots: me.materials.append(F[k] if k in F else P[k])
        me.validate(); me.update(); return me
def rect(w, d, cx=0, cy=0): return [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]
def octo(w, d, c): return [(-w / 2 + c, -d / 2), (w / 2 - c, -d / 2), (w / 2, -d / 2 + c), (w / 2, d / 2 - c), (w / 2 - c, d / 2), (-w / 2 + c, d / 2), (-w / 2, d / 2 - c), (-w / 2, -d / 2 + c)]
def snap(h, flr): return max(flr * 3, round(h / flr) * flr)
def parapet(a, poly, z, key, h=1.1, t=0.35):
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        L = math.hypot(bx - ax, by - ay); ux, uy = (bx - ax) / L, (by - ay) / L
        nx, ny = uy, -ux
        q = [(ax, ay), (bx, by), (bx - nx * t, by - ny * t), (ax - nx * t, ay - ny * t)]
        if (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]) < 0: q = q[::-1]
        a.prism(q, z, h, key, key)
def roof_kit(a, w, d, z, kind="plant"):
    a.box(w * 0.12, d * 0.08, z, min(7, w * 0.36), min(6, d * 0.32), 4.2, "louver", "roof")          # mechanical penthouse (louvred)
    a.box(-w * 0.28, -d * 0.25, z, 2.6, 3.2, 3.0, "ledge", "roof")                                       # stair / access core
    for k in range(3):
        a.box(-w * 0.22 + k * 2.9, d * 0.3, z, 2.4, 1.5, 1.4, "plant")                                  # HVAC
    if kind == "tower":
        a.cyl(w * 0.28, -d * 0.28, z, 1.4, 2.6, "plant", seg=12)                                         # cooling tower
def plinth(a, w, d): a.box(0, 0, 0, w + 6, d + 6, 0.15, "walk", bottom=False)

# ---- designs (local: origin at base centre) ---------------------------------
def T_chamfer_spire(w, d, h, glass="silver"):
    a = Acc([]); flr = 4.0; c = 0.2 * min(w, d); z = 0.0
    for f, frac in ((1.0, 0.56), (0.84, 0.24), (0.66, 0.12)):
        th = snap(h * frac, flr); pw, pd = w * f, d * f
        a.prism(octo(pw, pd, c * f), z, th, glass, "roof"); z += th
        a.prism(octo(pw + 0.6, pd + 0.6, c * f), z, 0.45, "silvertrim", "roof", bottom=True); z += 0.45
    a.prism(octo(w * 0.42, d * 0.42, c * 0.4), z, 7.0, "louver", "silvertrim")                         # lantern crown
    a.cyl(0, 0, z + 7.0, 0.45, h * 0.13, "silvertrim", seg=8)                                           # spire
    return a
def T_exoskeleton(w, d, h):
    a = Acc([]); flr = 3.8; th = snap(h * 0.95, flr)
    a.box(0, 0, 0, w, d, th, "precast", "roof", bottom=False)
    for (L, axis) in ((w, "x"), (d, "y")):
        n = max(2, round(L / 4.5))
        for i in range(n + 1):
            t = -L / 2 + i * L / n
            for sgn in (-1, 1):
                if axis == "x": a.box(t, sgn * (d / 2 + 0.4), 0, 0.7, 0.8, th + 1.2, "ledge")
                else:           a.box(sgn * (w / 2 + 0.4), t, 0, 0.8, 0.7, th + 1.2, "ledge")
    for k in range(2, int(th / flr) + 1, 2):
        zz = k * flr - 0.25
        a.box(0, -(d / 2 + 0.4), zz, w + 1.6, 0.8, 0.5, "ledge"); a.box(0, d / 2 + 0.4, zz, w + 1.6, 0.8, 0.5, "ledge")
        a.box(-(w / 2 + 0.4), 0, zz, 0.8, d, 0.5, "ledge"); a.box(w / 2 + 0.4, 0, zz, 0.8, d, 0.5, "ledge")
    roof_kit(a, w, d, th, "tower"); return a
def T_stone_stepped(w, d, h):
    a = Acc([]); flr = 3.9; z = 0.0
    for f, frac in ((1.0, 0.66), (0.86, 0.16), (0.70, 0.09), (0.52, 0.05)):
        th = snap(h * frac, flr); pw, pd = w * f, d * f
        a.box(0, 0, z, pw, pd, th, "lime", "roof", bottom=False); z += th
        a.box(0, 0, z, pw + 0.8, pd + 0.8, 0.6, "ledge", "roof"); z += 0.6
        parapet(a, rect(pw + 0.8, pd + 0.8), z, "ledge")
    a.box(0, 0, z, w * 0.3, d * 0.3, 5.0, "louver", "roof"); a.cyl(0, 0, z + 5, 0.3, 9, "trim", seg=6)
    return a
def T_black_slope(w, d, h, mast=False):
    a = Acc([]); flr = 3.7; th = snap(h * 0.84, flr)
    a.box(0, 0, 0, w, d, th, "black", "roof", bottom=False)
    rise = h * 0.16
    a.prism(rect(w, d), th, 0.0, "silver", "silver", z_top=lambda x, y: th + 1.0 + rise * (y + d / 2) / d)   # sloped glass crown
    if mast:
        a.cyl(w * 0.2, d * 0.3, th + rise, 0.35, 16, "trim", seg=6)
    a.box(0, d * 0.25, th, w * 0.4, d * 0.3, 2.5, "plant"); return a
def T_twin(w, d, h):
    a = Acc([]); fA, fB = 3.8, 3.6
    hA = snap(h, fA); hB = snap(h * 0.6, fB)
    a.box(-w * 0.2, 0, 0, w * 0.6, d, hA, "teal", "roof", bottom=False)
    a.box(w * 0.24, -d * 0.08, 0, w * 0.52, d * 0.78, hB, "terra", "roof", bottom=False)
    parapet(a, rect(w * 0.52, d * 0.78, w * 0.24, -d * 0.08), hB, "ledge")
    a.cyl(w * 0.24, -d * 0.08, hB, min(4.5, w * 0.2), 0.3, "ledge", seg=20)                                   # helipad
    a.box(-w * 0.2, 0, hA, w * 0.6 + 0.4, d + 0.4, 0.5, "silvertrim", "roof")
    roof_kit(a, w * 0.6, d, hA + 0.5); return a
def T_cylinder(w, d, h):
    a = Acc([]); flr = 3.8; r = min(w, d) / 2 * 0.95; th = snap(h * 0.92, flr)
    a.cyl(0, 0, 0, r, th, "silver", seg=24, top="roof")
    for k in range(1, int(th / flr)):
        a.prism([(( r + 0.45) * math.cos(2 * math.pi * j / 24), (r + 0.45) * math.sin(2 * math.pi * j / 24)) for j in range(24)], k * flr - 0.12, 0.24, "silvertrim", "silvertrim")
    a.cyl(0, 0, th, r * 0.62, 6.0, "louver", seg=24, top="roof"); a.cyl(0, 0, th + 6, 0.4, h * 0.1, "silvertrim", seg=8)
    return a
def L_glass_terrace(w, d, h):
    a = Acc([]); flr = 4.0; th = snap(h, flr)
    a.box(0, 0, 0, w, d, th, "silver", "roof", bottom=False)
    for (L, axis) in ((w, "x"), (d, "y")):
        n = max(2, round(L / 1.5))
        for i in range(n + 1):
            t = -L / 2 + i * L / n
            for sgn in (-1, 1):
                if axis == "x": a.box(t, sgn * (d / 2 + 0.2), 0, 0.08, 0.4, th, "silvertrim")
                else:           a.box(sgn * (w / 2 + 0.2), t, 0, 0.4, 0.08, th, "silvertrim")
    parapet(a, rect(w, d), th, "silvertrim", h=1.0, t=0.2)
    for k in range(3):                                                                                     # planters + green roof
        a.box(-w * 0.3 + k * w * 0.3, -d * 0.25, th, w * 0.22, d * 0.18, 0.6, "green")
    a.box(w * 0.18, d * 0.2, th, w * 0.4, d * 0.32, 0.35, "green")
    for k in range(5): a.box(-w * 0.32, d * 0.05 + k * 1.2, th + 2.6, w * 0.3, 0.15, 0.15, "trim")      # pergola
    a.box(-w * 0.32, d * 0.05 + 2.4, th, 0.2, 5.4, 2.6, "trim")
    roof_kit(a, w * 0.5, d * 0.5, th); plinth(a, w, d); return a
def L_ribbon_solar(w, d, h):
    a = Acc([]); flr = 3.7; th = snap(h, flr)
    a.box(0, 0, 0, w, d, th, "ribbon", "roof", bottom=False)
    a.box(0, 0, th, w + 0.5, d + 0.5, 0.45, "ledge", "roof"); parapet(a, rect(w + 0.5, d + 0.5), th + 0.45, "ledge")
    z = th + 0.45
    nx_, ny_ = int((w - 4) // 2.3), int((d - 6) // 1.7)
    for i in range(nx_):
        for j in range(ny_):
            x0 = -w / 2 + 2 + i * 2.3; y0 = -d / 2 + 3 + j * 1.7
            a.prism(rect(2.1, 1.1, x0 + 1.05, y0 + 0.55), z, 0.0, "plant", "solar",
                    z_top=lambda x, y, y0=y0: z + 0.25 + 0.45 * (y - y0) / 1.1)                             # tilted panels
    a.box(w * 0.3, d * 0.36, z, 4.0, 3.0, 3.2, "louver", "roof"); plinth(a, w, d); return a
def L_terracotta(w, d, h):
    a = Acc([]); flr = 3.6; th1 = snap(h * 0.8, flr); th2 = snap(h * 0.2, flr)
    a.box(0, 0, 0, w, d, th1, "terra", "roof", bottom=False)
    a.box(0, 0, th1, w + 0.4, d + 0.4, 0.4, "ledge", "roof")
    a.box(-w * 0.1, d * 0.08, th1 + 0.4, w * 0.7, d * 0.7, th2, "silver", "roof", bottom=False)            # glass set-back top floor
    parapet(a, rect(w + 0.4, d + 0.4), th1 + 0.4, "ledge", h=1.0)
    a.box(w * 0.32, -d * 0.3, th1 + 0.4, w * 0.25, d * 0.25, 0.4, "green")
    roof_kit(a, w * 0.6, d * 0.6, th1 + 0.4 + th2); plinth(a, w, d); return a

PLAN = {  # object : (design, kwargs, footprint scale, height scale)  -- chosen by aerial ray-cast coverage
    "BG_Skyline_136": (T_cylinder, {}, 1.0, 1.02),
    "BG_Skyline_092": (T_chamfer_spire, {"glass": "silver"}, 1.0, 1.10),
    "BG_Skyline_122": (T_black_slope, {"mast": True}, 0.95, 1.0),
    "BG_Skyline_102": (T_exoskeleton, {}, 0.95, 0.92),
    "BG_Skyline_091": (T_stone_stepped, {}, 1.05, 1.0),
    "BG_Skyline_111": (T_twin, {}, 1.0, 1.08),
    "BLDG_04_Crown":  (T_chamfer_spire, {"glass": "teal"}, 1.0, 0.98),
    "BLDG_01_Slab":   (T_exoskeleton, {}, 1.0, 1.0),
    "BG_Skyline_121": (L_ribbon_solar, {}, 1.0, 1.0),
    "BG_Skyline_110": (L_glass_terrace, {}, 1.0, 1.1),
    "BG_Skyline_134": (L_terracotta, {}, 1.0, 1.0),
}
done = []
for name, (fn, kw, fs, hs) in PLAN.items():
    ob = sc.objects[name]
    vs = [v.co for v in ob.data.vertices if v.co.z > 0.2]
    w = (max(v.x for v in vs) - min(v.x for v in vs)) * fs; d = (max(v.y for v in vs) - min(v.y for v in vs)) * fs; h = max(v.z for v in vs) * hs
    if name.startswith("BLDG_"):
        for p in [p for p in sc.objects if p.name.startswith("PROP_Roof_") and abs(p.location.x - ob.location.x) < w / 2 + 2 and abs(p.location.y - ob.location.y) < d / 2 + 2]:
            p.hide_render = True; p.hide_viewport = True
    a = fn(w, d, h, **kw)
    if name.startswith("BG_Skyline") and fn not in (L_glass_terrace, L_ribbon_solar, L_terracotta):
        plinth(a, w, d)
    old = ob.data; ob.data = a.mesh(name + "_v5")
    done.append((name, fn.__name__, round(w, 1), round(d, 1), round(h, 1), len(ob.data.polygons)))

# ---- background: more shared variants, reassigned to part of the remaining towers --------------
VARIANTS = []
for k, (fn, kw, w, d, h) in enumerate(((T_black_slope, {}, 17, 19, 92), (T_stone_stepped, {}, 18, 18, 74), (T_twin, {}, 22, 20, 88),
                                        (T_chamfer_spire, {"glass": "teal"}, 19, 19, 118), (T_exoskeleton, {}, 18, 24, 66), (T_cylinder, {}, 20, 20, 82))):
    a = fn(w, d, h, **kw); plinth(a, w, d)
    VARIANTS.append(a.mesh(f"BG_Variant_v5_{k}"))
cands = [o for o in sc.objects if o.name.startswith("BG_Skyline_") and o.name not in PLAN and "LowRise" not in o.data.name]
reassigned = 0
for o in cands:
    if random.random() < 0.42:
        o.data = random.choice(VARIANTS); o.rotation_euler.z = random.choice((0, math.pi / 2, math.pi, -math.pi / 2)); reassigned += 1
sc.eevee.use_raytracing = True
bpy.data.libraries.write(str(OUT), {sc}, path_remap="ABSOLUTE", compress=True)
result = {"upgraded": done, "bg_variants": len(VARIANTS), "bg_reassigned": reassigned, "bg_total": len(cands) + 6,
          "new_materials": len(F) + 4, "saved": str(OUT)}
