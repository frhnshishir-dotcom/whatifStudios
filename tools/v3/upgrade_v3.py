"""
WhatIfStudio EP001 v3 - upgrade_v3.py : semi-realistic hero-asset pass (runs after upgrade_v2.py).

Targets the assets with the most visual return per render cost:
  * 10 nearest hero buildings : real recessed windows (reveals, sills, thin frames, mullions,
                                per-pane glass variation) on concrete/stone; real mullions +
                                transoms on glass/metal; penthouses, stacks, plant on roofs
  * vehicles                  : lofted sedan (tumblehome, wheel arches, pillars, mirrors,
                                grille, plates, 5-spoke rims, contact shadow), 2 parked cars
  * pedestrians               : MPFB/MakeHuman CC0 people (assets/people_v3.blend)
  * streets                   : asphalt without painted-on lines, real paint decals, concrete
                                slabs with joints, granite curbs, manholes, bollards, shelter,
                                signal backplates + visors
  * look                      : softer sun, more sky fill, AO; distant city unchanged (cheap)
Camera paths, animation hooks and object names are unchanged. Writes master_city_v3.blend.
"""
import bpy, bmesh, math, random
from pathlib import Path
from mathutils import Matrix, Vector, Euler

ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
SCENE, TAG = "EP001_City_v2", "whatif_v2"
OUT = ROOT / "master_city_v3.blend"
PEOPLE = ROOT / "assets" / "people_v3.blend"
sc = bpy.data.scenes[SCENE]
OBJ, MATS = bpy.data.objects, bpy.data.materials
random.seed(9)
HAZE = (0.50, 0.50, 0.54)
Z = Vector((0, 0, 1))

def tag(idb):
    idb[TAG] = 1
    return idb
def sock(sockets, ident):
    return next(s for s in sockets if s.identifier == ident or s.name == ident)

# ---------------------------------------------------------------- node helpers
class NB:
    def __init__(s, mat):
        s.nt = mat.node_tree; s.n = s.nt.nodes
    def L(s, a, b): s.nt.links.new(a, b)
    def new(s, t): return s.n.new(t)
    def _in(s, sk, x):
        if x is None: return
        if isinstance(x, (int, float)): sk.default_value = x
        elif isinstance(x, tuple): sk.default_value = x if len(x) == 4 else (*x, 1.0)
        else: s.L(x, sk)
    def m(s, op, a=None, b=None, c=None, clamp=False):
        nd = s.n.new("ShaderNodeMath"); nd.operation = op; nd.use_clamp = clamp
        for i, x in enumerate((a, b, c)): s._in(nd.inputs[i], x)
        return nd.outputs[0]
    def mix(s, fac, a, b):
        nd = s.n.new("ShaderNodeMix"); nd.data_type = "RGBA"
        s._in(sock(nd.inputs, "Factor_Float"), fac); s._in(sock(nd.inputs, "A_Color"), a); s._in(sock(nd.inputs, "B_Color"), b)
        return sock(nd.outputs, "Result_Color")
    def noise(s, vec, scale, detail=2.0, rough=0.5):
        nd = s.n.new("ShaderNodeTexNoise")
        nd.inputs["Scale"].default_value = scale; nd.inputs["Detail"].default_value = detail; nd.inputs["Roughness"].default_value = rough
        s.L(vec, nd.inputs["Vector"]); return nd.outputs["Fac"]
    def uv(s):
        sep = s.n.new("ShaderNodeSeparateXYZ"); s.L(s.n.new("ShaderNodeUVMap").outputs["UV"], sep.inputs[0])
        return sep.outputs["X"], sep.outputs["Y"]
    def pos(s):
        sep = s.n.new("ShaderNodeSeparateXYZ"); g = s.n.new("ShaderNodeNewGeometry"); s.L(g.outputs["Position"], sep.inputs[0])
        return g.outputs["Position"], sep
    def bump(s, h, strength, dist):
        bp = s.n.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = strength; bp.inputs["Distance"].default_value = dist
        s.L(h, bp.inputs["Height"]); return bp.outputs[0]

def reset(name, keep=()):
    mat = MATS.get(name) or tag(MATS.new(name)); tag(mat); mat.use_nodes = True
    kept = {k: mat.node_tree.nodes[k].outputs[0].default_value for k in keep if k in mat.node_tree.nodes}
    if mat.node_tree.animation_data: mat.node_tree.animation_data_clear()
    mat.node_tree.nodes.clear()
    nb = NB(mat); out = nb.new("ShaderNodeOutputMaterial"); b = nb.new("ShaderNodeBsdfPrincipled")
    nb.L(b.outputs[0], out.inputs["Surface"]); nb.kept = kept
    return mat, nb, b, out

def haze(nb, out, near=380, far=2300, amount=0.55):
    src = out.inputs["Surface"].links[0].from_socket
    mr = nb.new("ShaderNodeMapRange"); mr.clamp = True
    nb.L(nb.new("ShaderNodeCameraData").outputs["View Distance"], mr.inputs["Value"])
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = near, far
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 0.0, amount
    em = nb.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (*HAZE, 1)
    mx = nb.new("ShaderNodeMixShader")
    nb.L(mr.outputs["Result"], mx.inputs[0]); nb.L(src, mx.inputs[1]); nb.L(em.outputs[0], mx.inputs[2])
    nb.L(mx.outputs[0], out.inputs["Surface"])

def plain(name, col, rough, metal=0.0, coat=0.0, h=True):
    mat, nb, b, out = reset(name)
    b.inputs["Base Color"].default_value = (*col, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if coat: b.inputs["Coat Weight"].default_value = coat; b.inputs["Coat Roughness"].default_value = 0.05
    if h: haze(nb, out)
    return mat

def wall(name, col, rough, coursing=None):
    """Architectural wall: per-building tint, broad tonal drift, darker/stained base, fine grain, optional panel joints."""
    mat, nb, b, out = reset(name)
    oi = nb.new("ShaderNodeObjectInfo"); P, sep = nb.pos()
    tc = nb.new("ShaderNodeTexCoord")
    c = nb.mix(oi.outputs["Random"], tuple(x * 0.9 for x in col), tuple(min(1, x * 1.1) for x in col))
    drift = nb.noise(tc.outputs["Object"], 0.06, 3.0, 0.5)
    c = nb.mix(nb.m("MULTIPLY", drift, 0.5), c, tuple(x * 0.78 for x in col))
    base = nb.m("SUBTRACT", 1.0, nb.m("DIVIDE", sep.outputs["Z"], 7.0), clamp=True)
    c = nb.mix(nb.m("MULTIPLY", base, 0.35), c, tuple(x * 0.7 for x in col))
    h = nb.m("MULTIPLY", nb.noise(tc.outputs["Object"], 35.0, 2.0, 0.6), 0.25)
    if coursing:
        u, v = nb.uv()
        br = nb.new("ShaderNodeTexBrick"); comb = nb.new("ShaderNodeCombineXYZ")
        nb.L(u, comb.inputs[0]); nb.L(v, comb.inputs[1]); nb.L(comb.outputs[0], br.inputs["Vector"])
        bw, rh = coursing
        for k, val in (("Scale", 1.0), ("Mortar Size", 0.008), ("Brick Width", bw), ("Row Height", rh), ("Bias", 0.0)):
            br.inputs[k].default_value = val
        br.inputs["Color1"].default_value = (1, 1, 1, 1); br.inputs["Color2"].default_value = (0.92, 0.92, 0.92, 1)
        br.inputs["Mortar"].default_value = (0.6, 0.6, 0.6, 1)
        bwv = nb.new("ShaderNodeRGBToBW"); nb.L(br.outputs["Color"], bwv.inputs[0])
        c = nb.mix(1.0, c, None); mixn = c.node; mixn.blend_type = "MULTIPLY"; nb.L(br.outputs["Color"], sock(mixn.inputs, "B_Color"))
        h = nb.m("ADD", h, nb.m("MULTIPLY", br.outputs["Fac"], -1.0))
    nb.L(c, b.inputs["Base Color"]); b.inputs["Roughness"].default_value = rough
    nb.L(nb.bump(h, 0.35, 0.02), b.inputs["Normal"])
    haze(nb, out)
    return mat

def window_glass(name, lit=0.05):
    """Per-pane glass: UV holds (pane id x, pane id y). Dark reflective glass, blinds/interior
    variation, sparse warm interiors driven by CityPower (animated by the episode)."""
    mat, nb, b, out = reset(name, keep=("CityPower",))
    oi = nb.new("ShaderNodeObjectInfo")
    uvn = nb.new("ShaderNodeUVMap"); comb = nb.new("ShaderNodeVectorMath"); comb.operation = "FLOOR"
    nb.L(uvn.outputs["UV"], comb.inputs[0])
    add = nb.new("ShaderNodeVectorMath"); add.operation = "ADD"; nb.L(comb.outputs[0], add.inputs[0])
    cz = nb.new("ShaderNodeCombineXYZ"); nb.L(nb.m("MULTIPLY", oi.outputs["Random"], 113.0), cz.inputs[2]); nb.L(cz.outputs[0], add.inputs[1])
    wn = nb.new("ShaderNodeTexWhiteNoise"); wn.noise_dimensions = "3D"; nb.L(add.outputs[0], wn.inputs["Vector"])
    r = wn.outputs["Value"]
    col = nb.mix(r, (0.012, 0.016, 0.022), (0.05, 0.055, 0.06))
    blinds = nb.m("GREATER_THAN", r, 0.72)
    col = nb.mix(nb.m("MULTIPLY", blinds, 0.6), col, (0.28, 0.27, 0.25))
    nb.L(col, b.inputs["Base Color"])
    nb.L(nb.m("MULTIPLY_ADD", r, 0.05, 0.02), b.inputs["Roughness"])
    b.inputs["Specular IOR Level"].default_value = 0.65
    pw = nb.new("ShaderNodeValue"); pw.name = pw.label = "CityPower"; pw.outputs[0].default_value = nb.kept.get("CityPower", 1.0)
    b.inputs["Emission Color"].default_value = (1.0, 0.75, 0.5, 1)
    nb.L(nb.m("MULTIPLY", nb.m("MULTIPLY", nb.m("GREATER_THAN", r, 1 - lit), pw.outputs[0]), 0.35), b.inputs["Emission Strength"])
    haze(nb, out)
    return mat

# ---------------------------------------------------------------- geometry helpers
class Acc:
    def __init__(s): s.v, s.f, s.uv, s.mi = [], [], [], []
    def quad(s, pts, uvs, mi, normal=None):
        pts = [Vector(p) for p in pts]
        if normal is not None and (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(Vector(normal)) < 0:
            pts, uvs = pts[::-1], uvs[::-1]
        b = len(s.v); s.v += [tuple(p) for p in pts]; s.f.append(tuple(range(b, b + len(pts)))); s.uv.append(uvs); s.mi.append(mi)
    def box(s, c, size, mi, top_mi=None, rotz=0.0, bottom=True, uvm=True):
        cx, cy, z0 = c; w, d, h = size
        cs, sn = math.cos(rotz), math.sin(rotz)
        def P(x, y, z): return (cx + x * cs - y * sn, cy + x * sn + y * cs, z)
        x, y, z1 = w / 2, d / 2, z0 + h
        cor = [(-x, -y), (x, -y), (x, y), (-x, y)]
        for i in range(4):
            (ax, ay), (bx, by) = cor[i], cor[(i + 1) % 4]
            L = w if i % 2 == 0 else d
            nrm = Vector(P(ax + bx, ay + by, 0)) - Vector((cx, cy, 0))
            s.quad([P(ax, ay, z0), P(bx, by, z0), P(bx, by, z1), P(ax, ay, z1)], [(0, z0), (L, z0), (L, z1), (0, z1)], mi, nrm)
        tm = mi if top_mi is None else top_mi
        s.quad([P(-x, -y, z1), P(x, -y, z1), P(x, y, z1), P(-x, y, z1)], [(cx - x, cy - y), (cx + x, cy - y), (cx + x, cy + y), (cx - x, cy + y)], tm, Z)
        if bottom:
            s.quad([P(-x, -y, z0), P(x, -y, z0), P(x, y, z0), P(-x, y, z0)], [(0, 0)] * 4, mi, -Z)
    def cyl(s, c, r, h, mi, seg=12):
        cx, cy, z0 = c
        ring = [(cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
        for k in range(seg):
            (ax, ay), (bx, by) = ring[k], ring[(k + 1) % seg]
            s.quad([(ax, ay, z0), (bx, by, z0), (bx, by, z0 + h), (ax, ay, z0 + h)], [(0, 0)] * 4, mi, Vector((ax + bx - 2 * cx, ay + by - 2 * cy, 0)))
        b = len(s.v); s.v += [(x, y, z0 + h) for x, y in ring]; s.f.append(tuple(range(b, b + seg))); s.uv.append([(0, 0)] * seg); s.mi.append(mi)
    def mesh(s, name, mats, smooth_mi=()):
        me = tag(bpy.data.meshes.new(name)); me.from_pydata(s.v, [], s.f)
        uvl = me.uv_layers.new(name="UVMap")
        for poly, uv, mi in zip(me.polygons, s.uv, s.mi):
            poly.material_index = mi; poly.use_smooth = mi in smooth_mi
            for li, c in zip(poly.loop_indices, uv): uvl.data[li].uv = c
        for m in mats: me.materials.append(m)
        me.validate(); me.update(); return me

def swap(objs, me):
    for ob in objs:
        old = ob.data; ob.data = me
        if old.users == 0: bpy.data.meshes.remove(old)

C = {c.name.split(".")[0]: c for c in sc.collection.children}
def place(name, data, coll, loc, rot=0.0, scale=1.0):
    ob = OBJ.get(name)
    if ob is not None and ob.name in sc.objects:
        OBJ.remove(ob, do_unlink=True)
    ob = tag(OBJ.new(name, data)); ob.location = loc; ob.rotation_euler = (0, 0, rot); ob.scale = (scale,) * 3
    C[coll].objects.link(ob); return ob

# ================================================================ materials
W = {"concrete": wall("MAT_Wall_Concrete_v3", (0.33, 0.32, 0.30), 0.86),
     "stone": wall("MAT_Wall_Stone_v3", (0.43, 0.37, 0.29), 0.78, coursing=(1.4, 0.7))}
GL = window_glass("MAT_Window_Glass_v3")
FRAME = plain("MAT_Window_Frame_v3", (0.10, 0.105, 0.11), 0.35, metal=0.85)
FRAME_L = plain("MAT_Window_Frame_Light_v3", (0.55, 0.55, 0.54), 0.4, metal=0.8)
ROOF, LEDGE, TRIM, PLANT = MATS["MAT_Roof"], MATS["MAT_Ledge_Concrete"], MATS["MAT_Trim_Metal"], MATS["MAT_RoofPlant"]
FAC = {k: MATS[n] for k, n in (("glass", "MAT_Facade_BlueGlass"), ("bronze", "MAT_Facade_BronzeGlass"), ("metal", "MAT_Facade_Charcoal"),
                                ("concrete", "MAT_Facade_Concrete"), ("stone", "MAT_Facade_Stone"), ("store", "MAT_Storefront"))}
FDIM = {"glass": (1.5, 3.8), "bronze": (1.6, 3.8), "concrete": (3.0, 3.6), "stone": (2.8, 4.0), "metal": (1.6, 3.7), "store": (4.0, 5.5)}

# ================================================================ hero buildings with real window depth
SL = dict(wall=0, roof=1, ledge=2, trim=3, plant=4, store=5, glass=6, frame=7, curtain=8)
WIN = {"concrete": dict(mx=0.20, sill=0.32, head=0.83, depth=0.22, frame=0.055, mull=True),
       "stone":    dict(mx=0.22, sill=0.26, head=0.84, depth=0.30, frame=0.06, mull=True)}

def facade_cells(a, origin, t, n, L, z0, H, bay, flr, p, face_id):
    nb_ = max(1, round(L / bay)); bw = L / nb_
    nf = max(1, round(H / flr)); fh = H / nf
    D, fw = p["depth"], p["frame"]
    def P(u, v, dd=0.0): return tuple(origin + t * u + Z * v - n * dd)
    for i in range(nb_):
        u0, u1 = i * bw, (i + 1) * bw
        a0, a1 = u0 + p["mx"] * bw, u1 - p["mx"] * bw
        for j in range(nf):
            v0 = z0 + j * fh; v1 = v0 + fh; b0 = v0 + p["sill"] * fh; b1 = v0 + p["head"] * fh
            for (q0, q1, r0, r1) in ((u0, u1, v0, b0), (u0, u1, b1, v1), (u0, a0, b0, b1), (a1, u1, b0, b1)):
                a.quad([P(q0, r0), P(q1, r0), P(q1, r1), P(q0, r1)], [(q0, r0), (q1, r0), (q1, r1), (q0, r1)], SL["wall"], n)
            a.quad([P(a0, b0), P(a1, b0), P(a1, b0, D), P(a0, b0, D)], [(a0, 0), (a1, 0), (a1, D), (a0, D)], SL["ledge"], Z)      # sill
            a.quad([P(a0, b1), P(a1, b1), P(a1, b1, D), P(a0, b1, D)], [(a0, 0), (a1, 0), (a1, D), (a0, D)], SL["wall"], -Z)      # head
            a.quad([P(a0, b0), P(a0, b1), P(a0, b1, D), P(a0, b0, D)], [(0, b0), (0, b1), (D, b1), (D, b0)], SL["wall"], t)       # jambs
            a.quad([P(a1, b0), P(a1, b1), P(a1, b1, D), P(a1, b0, D)], [(0, b0), (0, b1), (D, b1), (D, b0)], SL["wall"], -t)
            g0, g1, h0, h1 = a0 + fw, a1 - fw, b0 + fw, b1 - fw
            for (q0, q1, r0, r1) in ((a0, a1, b0, h0), (a0, a1, h1, b1), (a0, g0, h0, h1), (g1, a1, h0, h1)):
                a.quad([P(q0, r0, D), P(q1, r0, D), P(q1, r1, D), P(q0, r1, D)], [(0, 0)] * 4, SL["frame"], n)
            pid = (face_id * 100 + i + 0.5, j + 0.5)
            if p["mull"]:
                m0, m1 = (g0 + g1) / 2 - 0.025, (g0 + g1) / 2 + 0.025
                a.quad([P(m0, h0, D), P(m1, h0, D), P(m1, h1, D), P(m0, h1, D)], [(0, 0)] * 4, SL["frame"], n)
                for (q0, q1, k) in ((g0, m0, 0), (m1, g1, 0.3)):
                    a.quad([P(q0, h0, D + 0.01), P(q1, h0, D + 0.01), P(q1, h1, D + 0.01), P(q0, h1, D + 0.01)], [(pid[0] + k, pid[1])] * 4, SL["glass"], n)
            else:
                a.quad([P(g0, h0, D + 0.01), P(g1, h0, D + 0.01), P(g1, h1, D + 0.01), P(g0, h1, D + 0.01)], [pid] * 4, SL["glass"], n)

def tier_faces(tw, td):
    return [(Vector((-tw / 2, -td / 2, 0)), Vector((1, 0, 0)), Vector((0, -1, 0)), tw),
            (Vector((tw / 2, -td / 2, 0)), Vector((0, 1, 0)), Vector((1, 0, 0)), td),
            (Vector((tw / 2, td / 2, 0)), Vector((-1, 0, 0)), Vector((0, 1, 0)), tw),
            (Vector((-tw / 2, td / 2, 0)), Vector((0, -1, 0)), Vector((-1, 0, 0)), td)]

def curtain_grid(a, tw, td, z0, th, bay, flr, fins_every=1):
    for (o, t, n, L) in tier_faces(tw, td):
        nb_ = max(1, round(L / bay)); bw = L / nb_
        for i in range(0, nb_ + 1, fins_every):
            c = o + t * (i * bw) + n * 0.07
            a.box((c.x, c.y, z0), (0.07 if abs(t.x) else 0.14, 0.14 if abs(t.x) else 0.07, th), SL["trim"], bottom=False)
        for j in range(1, int(round(th / flr))):
            c = o + t * (L / 2) + n * 0.05
            a.box((c.x, c.y, z0 + j * flr - 0.03), (L if abs(t.x) else 0.10, 0.10 if abs(t.x) else L, 0.06), SL["trim"], bottom=True)

def parapet(a, z, w, d, mi, h=1.1, t=0.3):
    a.box((0, -d / 2 + t / 2, z), (w, t, h), mi); a.box((0, d / 2 - t / 2, z), (w, t, h), mi)
    a.box((-w / 2 + t / 2, 0, z), (t, d - 2 * t, h), mi); a.box((w / 2 - t / 2, 0, z), (t, d - 2 * t, h), mi)

def building_v3(name, kind, w, d, h, style, podium, host):
    bay, flr = FDIM[kind]
    a = Acc(); z = 0.0
    if podium:
        sb, sf = FDIM["store"]
        a.box((0, 0, 0), (w, d, sf), SL["store"], SL["roof"], bottom=False)
        for (o, t, n, L) in tier_faces(w, d):
            k = max(1, round(L / 2.0))
            for i in range(k + 1):
                c = o + t * (i * L / k) + n * 0.06
                a.box((c.x, c.y, 0), (0.12 if abs(t.x) else 0.12, 0.12, sf - 0.2), SL["frame"], bottom=False)
        a.box((0, 0, sf), (w + 1.4, d + 1.4, 0.35), SL["ledge"]); z = sf + 0.35
    rest = max(8.0, h - z)
    if host:   tiers = [(w, d, rest * 0.72), (w * 0.72, d * 0.72, rest * 0.28)]
    elif style == "Slab": tiers = [(w, d, rest)]
    elif style == "Stepped": tiers = [(w, d, rest * 0.48), (w * 0.78, d * 0.78, rest * 0.32), (w * 0.56, d * 0.56, rest * 0.20)]
    elif style == "PodiumTower": tiers = [(w * 0.64, d * 0.72, rest)]
    else: tiers = [(w, d, rest * 0.86), (w * 0.84, d * 0.84, rest * 0.14)]
    solid = kind in ("concrete", "stone")
    for ti, (tw, td, th) in enumerate(tiers):
        th = max(flr * 2, round(th / flr) * flr)
        if solid:
            for fi, (o, t, n, L) in enumerate(tier_faces(tw, td)):
                facade_cells(a, o, t, n, L, z, th, bay, flr, WIN[kind], fi + ti * 4)
            a.quad([(-tw / 2, -td / 2, z + th), (tw / 2, -td / 2, z + th), (tw / 2, td / 2, z + th), (-tw / 2, td / 2, z + th)], [(0, 0)] * 4, SL["roof"], Z)
            for fz in range(4, int(th / flr), 4):
                a.box((0, 0, z + fz * flr - 0.12), (tw + 0.24, td + 0.24, 0.26), SL["ledge"])
        else:
            a.box((0, 0, z), (tw, td, th), SL["curtain"], SL["roof"], bottom=False)
            curtain_grid(a, tw, td, z, th, bay, flr, fins_every=2 if kind == "metal" else 1)
        z += th
        corn = 0.55 if solid else 0.25
        a.box((0, 0, z), (tw + corn * 1.2, td + corn * 1.2, corn), SL["ledge"] if solid else SL["trim"], SL["roof"])
        z += corn
        parapet(a, z, tw + corn * 1.2, td + corn * 1.2, SL["ledge"] if solid else SL["trim"])
        last = (tw, td, z)
    tw, td, zt = last
    a.box((tw * 0.12, td * 0.1, zt), (min(6, tw * 0.32), min(5, td * 0.3), 3.6), SL["ledge"] if solid else SL["trim"], SL["roof"])  # stair/lift core
    for k in range(2):
        a.cyl((-tw * 0.3 + k * 1.4, td * 0.3, zt), 0.35, 2.4 + k * 0.6, SL["plant"], seg=10)                                     # exhaust stacks
    if kind in ("glass", "bronze") and not host:
        a.box((0, 0, zt), (tw * 0.5, td * 0.5, 3.6), SL["trim"], SL["roof"])
    mats = [W.get(kind, FAC.get(kind)), ROOF, LEDGE, TRIM, PLANT, FAC["store"], GL, FRAME if kind != "stone" else FRAME_L, FAC.get(kind)]
    return a.mesh(name + "_v3", mats), (tw, td, zt)

HVAC = bpy.data.meshes["PROP_Rooftop_HVAC"]
DETAIL = ["BLDG_01", "BLDG_02", "BLDG_09", "BLDG_10", "BLDG_11", "BLDG_12", "BLDG_13", "BLDG_14", "BLDG_15", "BLDG_16"]
rebuilt = []
for ob in sorted([o for o in sc.objects if o.name.startswith("BLDG_")], key=lambda o: o.name):
    if ob.name[:7] not in DETAIL or "v2_base" not in ob:
        continue
    w, d, h = ob["v2_base"]
    me, (tw, td, zt) = building_v3(ob.name, ob["v2_kind"], w, d, h, ob["v2_style"], bool(ob["v2_podium"]), bool(ob["v2_host"]))
    swap([ob], me)
    for p in [p for p in sc.objects if p.name.startswith("PROP_Roof_") and abs(p.location.x - ob.location.x) < w / 2 + 1 and abs(p.location.y - ob.location.y) < d / 2 + 1]:
        OBJ.remove(p, do_unlink=True)
    k = 0
    for gx in (-1, 1):
        for gy in (-1, 0, 1):
            if random.random() < 0.7:
                place(f"PROP_Roof_HVAC_{ob.name[5:7]}_{k}", HVAC, "CITY_BUILDINGS",
                      ob.location + Vector((gx * tw * 0.22, gy * td * 0.26 - td * 0.05, zt)), random.choice((0, math.pi / 2))); k += 1
    rebuilt.append((ob.name, ob["v2_kind"], len(me.polygons)))

# ================================================================ vehicles: lofted sedan
def interp(tab, x):
    for (x0, y0), (x1, y1) in zip(tab, tab[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y0
    return tab[0][1] if x < tab[0][0] else tab[-1][1]
ZR = [(-2.36, .70), (-2.33, .88), (-2.2, .97), (-1.62, 1.0), (-1.5, 1.05), (-0.75, 1.42), (0.35, 1.44), (0.62, 1.35), (1.25, 0.98), (2.0, 0.87), (2.26, 0.80), (2.36, 0.66)]
ZS = [(-2.36, .64), (-2.3, .84), (-1.6, .93), (-0.75, .95), (1.25, .89), (2.2, .77), (2.36, .62)]
WS = [(-2.36, .76), (-2.25, .87), (-1.8, .915), (0.0, .925), (1.8, .91), (2.25, .85), (2.36, .74)]
WR = [(-2.36, .70), (-1.65, .86), (-1.5, .76), (-0.7, .69), (0.35, .69), (1.2, .78), (1.32, .86), (2.36, .70)]
def zb_at(x):
    z = interp([(-2.36, .40), (-2.22, .30), (-2.0, .27), (2.0, .27), (2.24, .30), (2.36, .38)], x)
    for xc in (-1.42, 1.42):
        if abs(x - xc) < 0.43:
            z = max(z, 0.34 + math.sqrt(0.43 ** 2 - (x - xc) ** 2) + 0.02)
    return z
def sedan_v3():
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap")
    xs = [-2.36, -2.345, -2.32, -2.27, -2.2] + [round(-2.1 + 0.1 * k, 3) for k in range(43)] + [2.2, 2.27, 2.32, 2.345, 2.36]
    rings = []
    for x in xs:
        zr, zs, ws, wr = interp(ZR, x), min(interp(ZS, x), interp(ZR, x) - 0.03), interp(WS, x), interp(WR, x)
        zb = min(zb_at(x), zs - 0.22)
        wb = ws - 0.05
        cab = -1.55 < x < 1.28
        right = [(0, zb), (wb * 0.88, zb), (wb, min(zb + 0.07, zs - 0.16)), (ws, zs - 0.15), (ws, zs - 0.04), (ws - 0.035, zs),
                 (wr, zr - (0.06 if cab else 0.012)), (wr * 0.55, zr - 0.004), (0, zr)]
        loop = right + [(-y, z) for (y, z) in reversed(right[1:-1])]
        rings.append([bm.verts.new((x, y, z)) for (y, z) in loop])
    N = len(rings[0])
    def segtype(k): return k if k < 8 else 15 - k
    for i in range(len(xs) - 1):
        xm = (xs[i] + xs[i + 1]) / 2
        for k in range(N):
            k2 = (k + 1) % N
            f = bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]))
            st = segtype(k); mi = 0
            if st == 0: mi = 7
            elif st == 5:
                if -1.40 < xm < 1.06 and not abs(xm + 0.22) < 0.07: mi = 1
                elif -1.55 < xm < 1.28 and abs(xm + 0.22) < 0.07: mi = 9
            elif st in (6, 7):
                if 0.46 < xm < 1.22 or -1.50 < xm < -0.80: mi = 1
            f.material_index = mi; f.smooth = True
    for ring, rev in ((rings[0], True), (rings[-1], False)):
        f = bm.faces.new(ring[::-1] if rev else ring); f.material_index = 0
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    def cube(loc, size, mi, rot=(0, 0, 0)):
        r = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), Vector(size)))
        for fc in {fc for v in r["verts"] for fc in v.link_faces}: fc.material_index = mi
    def cone(loc, r1, depth, mi, rot=(math.pi / 2, 0, 0), seg=24, smooth=False):
        r = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r1, depth=depth, matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), None))
        for fc in {fc for v in r["verts"] for fc in v.link_faces}: fc.material_index = mi; fc.smooth = smooth
    cube((-0.05, 0, 0.36), (3.4, 1.5, 0.26), 7)                         # chassis / arch liners
    for y in (-0.63, 0.63):
        cube((2.305, y, 0.70), (0.07, 0.34, 0.09), 2)                   # headlights
        cube((-2.33, y, 0.82), (0.06, 0.36, 0.10), 3)                   # taillights
    cube((2.335, 0, 0.46), (0.05, 0.92, 0.17), 7)                       # grille / intake
    cube((2.36, 0, 0.34), (0.02, 0.50, 0.11), 8); cube((-2.385, 0, 0.58), (0.02, 0.50, 0.11), 8)   # plates
    for y in (-1.0, 1.0):
        cube((0.95, y * 1.0, 0.99), (0.16, 0.13, 0.10), 0); cube((0.98, y * 0.94, 0.95), (0.06, 0.06, 0.05), 7)   # mirrors
        for xh in (0.32, -0.62):
            cube((xh, y * 0.928, 0.86), (0.13, 0.012, 0.03), 5)          # door handles
    for xw in (-1.42, 1.42):
        for yw in (-0.80, 0.80):
            cone((xw, yw, 0.34), 0.34, 0.225, 4, smooth=True)             # tyre
            s_ = 1 if yw > 0 else -1
            cone((xw, yw + s_ * 0.105, 0.34), 0.235, 0.02, 5, seg=20)    # rim face
            cone((xw, yw + s_ * 0.118, 0.34), 0.05, 0.02, 5, seg=10)     # hub
            for k in range(5):
                ang = 2 * math.pi * k / 5
                cube((xw + 0.12 * math.cos(ang), yw + s_ * 0.122, 0.34 + 0.12 * math.sin(ang)), (0.2, 0.018, 0.045), 5, rot=(0, -ang, 0))
    q = [bm.verts.new(p) for p in ((-2.6, -1.18, 0.012), (2.6, -1.18, 0.012), (2.6, 1.18, 0.012), (-2.6, 1.18, 0.012))]
    fq = bm.faces.new(q); fq.material_index = 6
    for l, uvc in zip(fq.loops, ((0, 0), (1, 0), (1, 1), (0, 1))): l[uvl].uv = uvc
    me = tag(bpy.data.meshes.new("CAR_Mesh_v3")); bm.to_mesh(me); bm.free()
    for mn in ("MAT_Car_Trim", "MAT_Car_Glass", "MAT_Car_Headlight", "MAT_Car_Taillight", "MAT_Car_Tire", "MAT_Car_Rim",
               "MAT_Car_ContactShadow", "MAT_Car_Trim"):
        me.materials.append(MATS[mn])
    me.materials.append(plain("MAT_Car_Plate", (0.78, 0.78, 0.76), 0.4, h=False))
    me.materials.append(plain("MAT_Car_PillarBlack", (0.008, 0.008, 0.009), 0.18, h=False))
    return me
CAR = sedan_v3()
mg = MATS["MAT_Car_Glass"].node_tree.nodes.get("Principled BSDF")
if mg: mg.inputs["Base Color"].default_value = (0.02, 0.025, 0.03, 1); mg.inputs["Roughness"].default_value = 0.02
paint_order = ["White", "Charcoal", "Blue", "Orange"]
cars = sorted([o for o in sc.objects if o.name.startswith("CAR_") and o.type == "MESH"], key=lambda o: o.name)
swap(cars, CAR)
for ci, ob in enumerate(cars):
    ob.material_slots[0].link = "OBJECT"; ob.material_slots[0].material = MATS["MAT_Car_Body_" + paint_order[ci % 4]]
for nm, loc, col in (("CAR_09_Parked_North", (-33.5, 5.75, 0.0), "Charcoal"), ("CAR_10_Parked_North", (-26.8, 5.75, 0.0), "White")):
    ob = place(nm, CAR, "VEHICLES", loc, math.pi)
    ob["moving"] = False; ob["heading"] = math.pi; ob["start"] = loc
    ob.material_slots[0].link = "OBJECT"; ob.material_slots[0].material = MATS["MAT_Car_Body_" + col]

# ================================================================ pedestrians (MPFB / MakeHuman CC0)
ped_note = "no people library"
if PEOPLE.exists():
    with bpy.data.libraries.load(str(PEOPLE)) as (src, dst):
        dst.meshes = [n for n in src.meshes if n.startswith("PED_v3_") and n not in bpy.data.meshes]
    PM = sorted([m for m in bpy.data.meshes if m.name.startswith("PED_v3_")], key=lambda m: m.name)
    peds = sorted([o for o in sc.objects if o.name.startswith("PED_")], key=lambda o: o.name)
    extra = [(-31.0, -8.6), (-29.4, -9.4), (-23.5, -8.4), (-20.5, -9.2), (-16.5, -8.7)]
    for k, (x, y) in enumerate(extra):
        peds.append(place(f"PED_{17 + k:02d}", PM[0], "PEOPLE", (x, y, 0.15)))
    for k, ob in enumerate(peds):
        old = ob.data; ob.data = PM[k % len(PM)]
        if old.users == 0 and old.name.startswith("PED_Mesh"): bpy.data.meshes.remove(old)
        x, y = ob.location.x, ob.location.y
        along_x = abs(y) < abs(x)
        ob.rotation_euler = (0, 0, random.choice((math.pi / 2, -math.pi / 2)) if along_x else random.choice((0.0, math.pi)))
        ob.scale = (random.uniform(0.97, 1.04),) * 3
    ped_note = f"{len(peds)} people from {len(PM)} MPFB meshes"

# ================================================================ streets
am, anb, ab, aout = reset("MAT_Asphalt")
tc = anb.new("ShaderNodeTexCoord"); u, v = anb.uv()
big = anb.noise(tc.outputs["Object"], 0.12, 3.0, 0.5)
grain = anb.noise(tc.outputs["Object"], 60.0, 2.0, 0.7)
col = anb.mix(big, (0.036, 0.036, 0.038), (0.058, 0.057, 0.057))
track = anb.m("MULTIPLY", anb.m("LESS_THAN", anb.m("ABSOLUTE", anb.m("SUBTRACT", anb.m("ABSOLUTE", v), 3.5)), 0.6), 0.22)
col = anb.mix(track, col, (0.026, 0.026, 0.028))
seam = anb.m("MULTIPLY", anb.m("LESS_THAN", anb.m("ABSOLUTE", anb.m("SUBTRACT", anb.m("ABSOLUTE", v), 6.9)), 0.12), 0.5)
col = anb.mix(seam, col, (0.02, 0.02, 0.02))                                  # gutter strip along the curb
anb.L(col, ab.inputs["Base Color"])
anb.L(anb.m("MULTIPLY_ADD", big, 0.12, 0.70), ab.inputs["Roughness"])
anb.L(anb.bump(grain, 0.25, 0.006), ab.inputs["Normal"])
haze(anb, aout)
PAINT = None
pm, pnb, pb, pout = reset("MAT_RoadPaint_v3")
tc2 = pnb.new("ShaderNodeTexCoord")
wear = pnb.noise(tc2.outputs["Object"], 1.6, 3.0, 0.6)
pnb.L(pnb.mix(pnb.m("MULTIPLY", pnb.m("GREATER_THAN", wear, 0.66), 0.5), (0.74, 0.73, 0.70), (0.30, 0.30, 0.29)), pb.inputs["Base Color"])
pb.inputs["Roughness"].default_value = 0.55
pnb.L(pnb.bump(pnb.noise(tc2.outputs["Object"], 45.0, 2.0, 0.6), 0.15, 0.004), pb.inputs["Normal"])
haze(pnb, pout); PAINT = pm
for ob in sc.objects:
    if ob.name.startswith(("ROAD_Crosswalk_", "ROAD_StopLine")):
        ob.data.materials[0] = PAINT
for ob in [o for o in sc.objects if o.name.startswith("ROAD_Paint_")]:
    OBJ.remove(ob, do_unlink=True)
def paint_road(name, axis, const, z, lo, hi, skip, edges, half):
    a = Acc()
    def strip(c0, c1, off, wdt):
        if axis == "X":
            pts = [(c0, off - wdt / 2, z), (c1, off - wdt / 2, z), (c1, off + wdt / 2, z), (c0, off + wdt / 2, z)]
        else:
            pts = [(off + wdt / 2, c0, z), (off + wdt / 2, c1, z), (off - wdt / 2, c1, z), (off - wdt / 2, c0, z)]
        a.quad(pts, [(0, 0), (1, 0), (1, 1), (0, 1)], 0, Z)
    for sgn in (-1, 1):
        t = skip
        while t + 3.0 < hi:
            if not any(abs(sgn * (t + 1.5) - c) < 8.0 for c in (-62, 62) if c != const):
                strip(sgn * t, sgn * (t + 3.0), const, 0.15)
            t += 9.0
        if edges:
            for e in (-1, 1):
                strip(sgn * skip, sgn * hi, const + e * (half - 0.65), 0.15)
    return place(name, a.mesh(name, [PAINT]), "ROADS", (0, 0, 0))
paint_road("ROAD_Paint_EW_Main", "X", 0.0, 0.019, 0, 340, 13.6, True, 7.0)
paint_road("ROAD_Paint_NS_Main", "Y", 0.0, 0.008, 0, 340, 13.6, True, 7.0)
for nm, ax, c, z in (("ROAD_Paint_NS_W", "Y", -62.0, 0.008), ("ROAD_Paint_NS_E", "Y", 62.0, 0.008), ("ROAD_Paint_EW_N", "X", 62.0, 0.014), ("ROAD_Paint_EW_S", "X", -62.0, 0.014)):
    paint_road(nm, ax, c, z, 0, 128, 8.0, False, 5.0)
# concrete slab sidewalks with joints
sm, snb, sb, sout = reset("MAT_Sidewalk")
u, v = snb.uv()
br = snb.new("ShaderNodeTexBrick"); comb = snb.new("ShaderNodeCombineXYZ"); snb.L(u, comb.inputs[0]); snb.L(v, comb.inputs[1]); snb.L(comb.outputs[0], br.inputs["Vector"])
for k, val in (("Scale", 1.0), ("Mortar Size", 0.01), ("Brick Width", 1.5), ("Row Height", 1.5), ("Bias", 0.0), ("Mortar Smooth", 0.3)):
    br.inputs[k].default_value = val
br.offset = 0.0
br.inputs["Color1"].default_value = (0.30, 0.295, 0.285, 1); br.inputs["Color2"].default_value = (0.275, 0.27, 0.26, 1); br.inputs["Mortar"].default_value = (0.13, 0.13, 0.125, 1)
tc3 = snb.new("ShaderNodeTexCoord")
snb.L(snb.mix(snb.m("MULTIPLY", snb.noise(tc3.outputs["Object"], 0.2, 2.0, 0.5), 0.3), br.outputs["Color"], (0.22, 0.215, 0.205)), sb.inputs["Base Color"])
sb.inputs["Roughness"].default_value = 0.88
snb.L(snb.bump(snb.m("ADD", br.outputs["Fac"], snb.m("MULTIPLY", snb.noise(tc3.outputs["Object"], 30.0, 2.0, 0.6), 0.08)), 0.4, 0.008), sb.inputs["Normal"])
haze(snb, sout)
for nm, axis in (("MAT_Curb_X_v3", "X"), ("MAT_Curb_Y_v3", "Y")):
    cm, cnb, cb, cout = reset(nm)
    P, sep = cnb.pos()
    j = cnb.m("LESS_THAN", cnb.m("FRACT", cnb.m("DIVIDE", sep.outputs[axis], 1.2)), 0.008)
    tcc = cnb.new("ShaderNodeTexCoord")
    speck = cnb.noise(tcc.outputs["Object"], 140.0, 1.0, 0.5)
    cnb.L(cnb.mix(j, cnb.mix(speck, (0.36, 0.355, 0.345), (0.46, 0.455, 0.445)), (0.14, 0.14, 0.14)), cb.inputs["Base Color"])
    cb.inputs["Roughness"].default_value = 0.62
    cnb.L(cnb.bump(cnb.m("SUBTRACT", 1.0, j), 0.6, 0.006), cb.inputs["Normal"])
    haze(cnb, cout)
for ob in [o for o in sc.objects if o.name.startswith(("ROAD_Curb_", "STREET_Bollard", "STREET_Shelter", "ROAD_Manhole"))]:
    OBJ.remove(ob, do_unlink=True)
cx_, cy_ = Acc(), Acc()
for sx in (-1, 1):
    for sy in (-1, 1):
        cx_.box((sx * 32.0, sy * 7.15, 0.0), (50.0, 0.3, 0.165), 0)
        cy_.box((sx * 7.15, sy * 32.0, 0.0), (0.3, 50.0, 0.165), 0)
place("ROAD_Curb_X", cx_.mesh("ROAD_Curb_X", [MATS["MAT_Curb_X_v3"]]), "ROADS", (0, 0, 0))
place("ROAD_Curb_Y", cy_.mesh("ROAD_Curb_Y", [MATS["MAT_Curb_Y_v3"]]), "ROADS", (0, 0, 0))
metal = MATS["MAT_Pole_Charcoal"]
nbp = metal.node_tree.nodes.get("Principled BSDF")
if nbp: nbp.inputs["Roughness"].default_value = 0.42; nbp.inputs["Metallic"].default_value = 0.75
mh = Acc(); mh.cyl((0, 0, 0), 0.33, 0.012, 0, seg=20)
MAN = mh.mesh("ROAD_Manhole_Mesh", [MATS["MAT_Drain_Grate"]])
for k, (x, y, z) in enumerate(((-29.0, -1.6, 0.012), (-17.5, 2.2, 0.012), (1.8, -26.0, 0.003), (-41.0, 2.0, 0.012))):
    place(f"ROAD_Manhole_{k}", MAN, "ROADS", (x, y, z))
bl = Acc(); bl.cyl((0, 0, 0), 0.075, 0.72, 0, seg=12); bl.cyl((0, 0, 0.72), 0.085, 0.05, 0, seg=12)
BOL = bl.mesh("STREET_Bollard_Mesh", [metal])
for k, x in enumerate(range(-30, -12, 4)):
    place(f"STREET_Bollard_{k:02d}", BOL, "LIGHTS", (x + 0.5, -7.65, 0.15))
sh = Acc()
for px in (-1.9, 1.9):
    for py in (-0.7, 0.7):
        sh.box((px, py, 0), (0.08, 0.08, 2.5), 0)
sh.box((0, 0, 2.5), (4.2, 1.8, 0.12), 0)
sh.box((0, -0.72, 0.15), (3.7, 0.03, 2.2), 1)
sh.box((0, -0.45, 0.45), (2.4, 0.4, 0.06), 2)
shelter_glass = plain("MAT_Shelter_Glass", (0.06, 0.07, 0.075), 0.05, h=False)
shelter_glass.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.35
shelter_glass.surface_render_method = "DITHERED"
SHEL = sh.mesh("STREET_Shelter_Mesh", [metal, shelter_glass, MATS["MAT_Ledge_Concrete"]])
place("STREET_Shelter", SHEL, "LIGHTS", (-28.5, -11.3, 0.15), math.pi)
# signal heads: add backplates + visors (keeps MAT_Signal_Green)
sg = Acc()
sg.cyl((0, 0, 0), 0.14, 6.6, 0, seg=10)
sg.box((2.6, 0, 6.2), (5.2, 0.14, 0.14), 0)
for hx, hz in ((4.9, 5.25), (0.0, 2.6)):
    sg.box((hx, 0, hz), (0.36, 0.3, 1.05), 4)
    sg.box((hx, -0.17, hz - 0.12), (0.62, 0.03, 1.3), 4)
    for mz, mi in ((0.85, 1), (0.53, 2), (0.21, 3)):
        sg.cyl((hx, 0, 0), 0.0, 0.0, 0) if False else None
        ring = 10; r = 0.11; cy0 = 0.16
        pts = [(hx + r * math.cos(2 * math.pi * k / ring), cy0, hz + mz + r * math.sin(2 * math.pi * k / ring)) for k in range(ring)]
        b0 = len(sg.v); sg.v += pts; sg.f.append(tuple(range(b0, b0 + ring))[::-1]); sg.uv.append([(0, 0)] * ring); sg.mi.append(mi)
        sg.box((hx, 0.26, hz + mz + 0.1), (0.28, 0.2, 0.025), 4)
SIG = sg.mesh("SIGNAL_Mesh_v3", [metal, MATS["MAT_Signal_Lens_Off"], MATS["MAT_Signal_Amber_Off"], MATS["MAT_Signal_Green"],
                                  plain("MAT_Signal_Housing", (0.015, 0.015, 0.017), 0.5, h=False)])
swap([o for o in sc.objects if o.name.startswith("SIGNAL_") and o.type == "MESH"], SIG)


# ================================================================ aerial read: streets, blocks, roofs (shared meshes = cheap)
OBJ["ROAD_Ground"].data.materials[0] = MATS["MAT_Asphalt"]
SW = MATS["MAT_Sidewalk"]
def add_to_mesh(me, acc, new_mats):
    base = len(me.materials)
    for m in new_mats: me.materials.append(m)
    tmp = acc.mesh(me.name + "_tmp", [])
    for p_ in tmp.polygons: p_.material_index += base
    bm = bmesh.new(); bm.from_mesh(me); bm.from_mesh(tmp); bm.to_mesh(me); bm.free()
    bpy.data.meshes.remove(tmp)
bg_done = []
users = {}
for ob in sc.objects:
    if ob.name.startswith("BG_Skyline_"):
        users.setdefault(ob.data.name, []).append(ob)
for mname, obs in sorted(users.items()):
    me = bpy.data.meshes[mname]
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    w, d, h = max(xs) - min(xs), max(ys) - min(ys), max(zs)
    low = "LowRise" in mname
    if low and h < 30:
        new, (tw, td, zt) = building_v3(mname.replace("_v2", ""), "concrete" if "0" in mname or "2" in mname else "stone", w, d, h, "Slab", False, False)
        swap(obs, new); me = new
        top_w, top_d, top = tw, td, zt
    else:
        top = max(zs); tops = [v.co for v in me.vertices if v.co.z > top - 1.2]
        top_w = max(v.x for v in tops) - min(v.x for v in tops); top_d = max(v.y for v in tops) - min(v.y for v in tops)
    a = Acc()
    a.box((0, 0, 0), (w + 6.0, d + 6.0, 0.15), 0, bottom=False)                           # pavement plinth = city block
    a.box((top_w * 0.15, -top_d * 0.1, top), (min(5, top_w * 0.3), min(4.5, top_d * 0.3), 3.2), 1)    # stair / lift core
    for k in range(3):
        a.box((-top_w * 0.25 + k * top_w * 0.2, top_d * 0.25, top), (2.4, 1.5, 1.4), 2)    # plant units
    add_to_mesh(me, a, [SW, LEDGE, PLANT])
    bg_done.append((mname, len(obs), len(me.polygons)))

# ================================================================ light
sun = OBJ["LIGHT_Sun_Main"]; sun.data.energy = 4.6; sun.data.angle = math.radians(2.5)
OBJ["LIGHT_Fill_Sky"].data.energy = 0.12
bg = sc.world.node_tree.nodes.get("Background")
if bg: bg.inputs["Strength"].default_value = 0.11
ee = sc.eevee; ee.use_fast_gi = True; ee.fast_gi_distance = 10.0
ee.use_raytracing = True; ee.ray_tracing_method = "SCREEN"          # benchmarked: ~0 s/frame extra on Intel UHD
ee.ray_tracing_options.resolution_scale = "2"; ee.ray_tracing_options.trace_max_roughness = 0.3

bpy.data.libraries.write(str(OUT), {sc}, path_remap="NONE", compress=True)
tris = sum(len(p.vertices) - 2 for ob in sc.objects if ob.type == "MESH" for p in ob.data.polygons)
result = {"saved": str(OUT), "bg": bg_done, "rebuilt": rebuilt, "car_faces": len(CAR.polygons), "people": ped_note, "scene_tris": tris}
print("[upgrade_v3]", result)
