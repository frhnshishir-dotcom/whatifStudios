"""
WhatIfStudio EP001 v2 (quality upgrade) - base layout, identical to v1 build_city.py
(v2 copy: own scene/tag/file so v1 data is never touched). Run upgrade_v2.py afterwards.
build_city.py: builds the stylized city block in a NEW scene "EP001_City".

Safe by design: never touches other scenes/files. Everything it creates is tagged
["whatif_v2"] so re-runs only clean up its own data. The scene is written to
master_city.blend with bpy.data.libraries.write (the open file is never re-saved).

Interactive (Blender MCP):
    p = r"C:\\Users\\User\\Documents\\Blender\\WhatIfStudio\\tools\\build_city.py"
    exec(open(p).read(), {"__file__": p, "__name__": "__main__"})
Background:
    blender -b --factory-startup -P tools/build_city.py
"""
import bpy, bmesh, math, random
from pathlib import Path
from mathutils import Matrix, Vector, Euler

ROOT = Path(globals()["__file__"]).resolve().parent.parent.parent
SCENE_NAME = "EP001_City_v2"
OUT = ROOT / "master_city_v2.blend"
random.seed(1)

PAL = {
    "blue": (0.04, 0.16, 0.50), "charcoal": (0.03, 0.033, 0.04),
    "concrete": (0.30, 0.29, 0.27), "orange": (1.0, 0.40, 0.07),
    "haze": (0.20, 0.19, 0.27), "horizon": (0.62, 0.34, 0.24), "window": (1.0, 0.62, 0.30), "glass": (0.015, 0.03, 0.07),
}
COLLS = ["CITY_BUILDINGS", "ROADS", "VEHICLES", "PEOPLE", "BILLBOARDS", "LIGHTS", "CAMERAS", "GRAPHICS"]

# ---------------------------------------------------------------- utils
def tag(idb):
    idb["whatif_v2"] = 1
    return idb

def cleanup():
    """Remove only data created by earlier runs of this script."""
    sc = bpy.data.scenes.get(SCENE_NAME)
    if sc and sc.get("whatif_v2"):
        bpy.data.scenes.remove(sc)
    for coll in (bpy.data.objects, bpy.data.collections, bpy.data.cameras, bpy.data.lights,
                 bpy.data.curves, bpy.data.meshes, bpy.data.materials, bpy.data.worlds):
        for idb in [i for i in coll if i.get("whatif_v2")]:
            try:
                coll.remove(idb)
            except Exception:
                pass

def set_eevee(scene):
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng
            return eng
        except TypeError:
            pass

def sock(sockets, ident):
    return next(s for s in sockets if s.identifier == ident or s.name == ident)

def link_obj(ob, coll):
    coll.objects.link(ob)
    return ob

# ---------------------------------------------------------------- materials
def add_haze(mat):
    """Cheap aerial perspective: blend toward haze colour by camera distance (no volumetrics)."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    src = out.inputs["Surface"].links[0].from_socket
    cam = nt.nodes.new("ShaderNodeCameraData")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = 220, 850
    mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 0.0, 0.7
    mr.clamp = True
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*PAL["haze"], 1)
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(cam.outputs["View Distance"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], mix.inputs[0])
    nt.links.new(src, mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])

def principled(name, color, rough=0.8, metal=0.0, haze=True):
    m = tag(bpy.data.materials.new(name))
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if haze:
        add_haze(m)
    return m

def emissive(name, color, strength, value_name="Power"):
    """Pure emission; strength comes from a named Value node so it can be keyframed."""
    m = tag(bpy.data.materials.new(name))
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    v = nt.nodes.new("ShaderNodeValue")
    v.name = v.label = value_name
    v.outputs[0].default_value = strength
    em.inputs["Color"].default_value = (*color, 1)
    nt.links.new(v.outputs[0], em.inputs["Strength"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return m

def facade(name, base, rough, metal, lit_bias):
    """Procedural window grid (Brick texture on metre-scaled UVs): no window meshes.
    Value node 'CityPower' drives window brightness."""
    m = principled(name, base, rough, metal, haze=False)
    nt, n = m.node_tree, m.node_tree.nodes
    bsdf = n["Principled BSDF"]
    uv = n.new("ShaderNodeUVMap")
    br = n.new("ShaderNodeTexBrick")
    br.offset, br.squash = 0.0, 1.0
    for k, v in (("Scale", 1.0), ("Mortar Size", 0.55), ("Brick Width", 3.0),
                 ("Row Height", 3.6), ("Bias", lit_bias), ("Mortar Smooth", 0.0)):
        br.inputs[k].default_value = v
    br.inputs["Color1"].default_value = (*PAL["window"], 1)
    br.inputs["Color2"].default_value = (*PAL["glass"], 1)
    br.inputs["Mortar"].default_value = (*base, 1)
    win = n.new("ShaderNodeMath"); win.operation = "SUBTRACT"; win.inputs[0].default_value = 1.0
    lum = n.new("ShaderNodeRGBToBW")
    lit = n.new("ShaderNodeMath"); lit.operation = "GREATER_THAN"; lit.inputs[1].default_value = 0.3
    pw = n.new("ShaderNodeValue"); pw.name = pw.label = "CityPower"; pw.outputs[0].default_value = 2.2
    m1 = n.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
    m2 = n.new("ShaderNodeMath"); m2.operation = "MULTIPLY"
    L = nt.links.new
    L(uv.outputs["UV"], br.inputs["Vector"])
    L(br.outputs["Color"], bsdf.inputs["Base Color"])        # mortar = wall colour, bricks = windows
    L(br.outputs["Fac"], win.inputs[1])                       # 1 on windows
    L(br.outputs["Color"], lum.inputs[0])
    L(lum.outputs[0], lit.inputs[0])                          # only warm (lit) windows glow
    L(win.outputs[0], m1.inputs[0]); L(lit.outputs[0], m1.inputs[1])
    L(m1.outputs[0], m2.inputs[0]); L(pw.outputs[0], m2.inputs[1])
    ec = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
    L(br.outputs["Color"], bsdf.inputs[ec])
    L(m2.outputs[0], bsdf.inputs["Emission Strength"])
    add_haze(m)
    return m

# ---------------------------------------------------------------- meshes
def box_tiers_mesh(name, tiers):
    """Stacked boxes [(w, d, h), ...] with origin at base. Side UVs in metres (windows keep
    real size); roof/top faces use material slot 1."""
    verts, faces, uvs, mats = [], [], [], []
    z0 = 0.0
    for (w, d, h) in tiers:
        x, y = w / 2, d / 2
        b = len(verts)
        verts += [(-x,-y,z0),(x,-y,z0),(x,y,z0),(-x,y,z0),(-x,-y,z0+h),(x,-y,z0+h),(x,y,z0+h),(-x,y,z0+h)]
        sides = [w, d, w, d]
        for i, f in enumerate([(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]):
            faces.append(tuple(b + k for k in f))
            Lw = sides[i]
            uvs.append([(0, z0), (Lw, z0), (Lw, z0 + h), (0, z0 + h)])
            mats.append(0)
        faces.append((b+4, b+5, b+6, b+7)); uvs.append([(0.5, 0.5)] * 4); mats.append(1)
        z0 += h
    me = tag(bpy.data.meshes.new(name))
    me.from_pydata(verts, [], faces)
    uvl = me.uv_layers.new(name="UVMap")
    for poly, uv, mi in zip(me.polygons, uvs, mats):
        poly.material_index = mi
        for li, c in zip(poly.loop_indices, uv):
            uvl.data[li].uv = c
    me.update()
    return me

def strip_mesh(name, length, width, along="X"):
    """Flat plane, UVs in metres: u along length (centered), v across width (centered)."""
    a, b = length / 2, width / 2
    if along == "X":
        verts = [(-a,-b,0),(a,-b,0),(a,b,0),(-a,b,0)]
    else:
        verts = [(b,-a,0),(b,a,0),(-b,a,0),(-b,-a,0)]
    me = tag(bpy.data.meshes.new(name))
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    uvl = me.uv_layers.new(name="UVMap")
    for li, c in zip(me.polygons[0].loop_indices, [(-a,-b),(a,-b),(a,b),(-a,b)]):
        uvl.data[li].uv = c
    me.update()
    return me

def bm_box(bm, size, loc, mi):
    r = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.LocRotScale(Vector(loc), None, Vector(size)))
    for f in {f for v in r["verts"] for f in v.link_faces}:
        f.material_index = mi

def bm_cyl(bm, radius, depth, loc, rot, mi, seg=12):
    r = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=radius, radius2=radius,
                              depth=depth, matrix=Matrix.LocRotScale(Vector(loc), Euler(rot), None))
    for f in {f for v in r["verts"] for f in v.link_faces}:
        f.material_index = mi

def bm_sphere(bm, radius, loc, mi):
    r = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=radius,
                                  matrix=Matrix.Translation(Vector(loc)))
    for f in {f for v in r["verts"] for f in v.link_faces}:
        f.material_index = mi

def bm_to_mesh(name, bm):
    me = tag(bpy.data.meshes.new(name))
    bm.to_mesh(me); bm.free()
    return me

# ================================================================ BUILD
cleanup()
scene = tag(bpy.data.scenes.new(SCENE_NAME))
if bpy.context.window:
    bpy.context.window.scene = scene
C = {}
for name in COLLS:
    c = tag(bpy.data.collections.new(name))
    scene.collection.children.link(c)
    C[name] = c

def new_obj(name, data, coll, loc=(0, 0, 0), rot=(0, 0, 0)):
    ob = tag(bpy.data.objects.new(name, data))
    ob.location, ob.rotation_euler = loc, rot
    return link_obj(ob, C[coll])

# ---- materials
M = {
    "fac_concrete": facade("MAT_Facade_Concrete", PAL["concrete"], 0.85, 0.0, 0.30),
    "fac_charcoal": facade("MAT_Facade_Charcoal", PAL["charcoal"], 0.45, 0.2, 0.40),
    "fac_blue":     facade("MAT_Facade_BlueGlass", PAL["blue"], 0.22, 0.4, 0.50),
    "roof":     principled("MAT_Roof", (0.06, 0.06, 0.065), 0.9),
    "ground":   principled("MAT_Ground_Concrete", (0.11, 0.105, 0.10), 0.95),
    "sidewalk": principled("MAT_Sidewalk", (0.22, 0.21, 0.20), 0.9),
    "zebra":    emissive("MAT_Crosswalk", (0.85, 0.84, 0.80), 0.9),
    "pole":     principled("MAT_Pole_Charcoal", PAL["charcoal"], 0.5, 0.6, haze=False),
    "car_glass": principled("MAT_Car_Glass", (0.01, 0.015, 0.02), 0.15, 0.2, haze=False),
    "headlight": emissive("MAT_Car_Headlight", (1.0, 0.92, 0.8), 8.0),
    "taillight": emissive("MAT_Car_Taillight", (1.0, 0.05, 0.02), 6.0),
    "skin":     principled("MAT_Ped_Skin", (0.55, 0.38, 0.28), 0.7, haze=False),
    "signal":   emissive("MAT_Signal_Green", (0.1, 1.0, 0.35), 12.0, "SignalPower"),
}

# asphalt with procedural dashed centre line (no line meshes)
asp = principled("MAT_Asphalt", (0.04, 0.04, 0.046), 0.55, haze=False)
nt, n = asp.node_tree, asp.node_tree.nodes
b = n["Principled BSDF"]
uv = n.new("ShaderNodeUVMap"); sep = n.new("ShaderNodeSeparateXYZ")
av = n.new("ShaderNodeMath"); av.operation = "ABSOLUTE"
inline = n.new("ShaderNodeMath"); inline.operation = "LESS_THAN"; inline.inputs[1].default_value = 0.12
mod = n.new("ShaderNodeMath"); mod.operation = "PINGPONG"; mod.inputs[1].default_value = 3.0
dash = n.new("ShaderNodeMath"); dash.operation = "GREATER_THAN"; dash.inputs[1].default_value = 1.5
au = n.new("ShaderNodeMath"); au.operation = "ABSOLUTE"
outx = n.new("ShaderNodeMath"); outx.operation = "GREATER_THAN"; outx.inputs[1].default_value = 9.0
k1 = n.new("ShaderNodeMath"); k1.operation = "MULTIPLY"
k2 = n.new("ShaderNodeMath"); k2.operation = "MULTIPLY"
mixc = n.new("ShaderNodeMix"); mixc.data_type = "RGBA"
sock(mixc.inputs, "A_Color").default_value = (0.04, 0.04, 0.046, 1)
sock(mixc.inputs, "B_Color").default_value = (0.8, 0.62, 0.25, 1)
L = nt.links.new
L(uv.outputs["UV"], sep.inputs[0])
L(sep.outputs["Y"], av.inputs[0]); L(av.outputs[0], inline.inputs[0])
L(sep.outputs["X"], mod.inputs[0]); L(mod.outputs[0], dash.inputs[0])
L(sep.outputs["X"], au.inputs[0]); L(au.outputs[0], outx.inputs[0])
L(inline.outputs[0], k1.inputs[0]); L(dash.outputs[0], k1.inputs[1])
L(k1.outputs[0], k2.inputs[0]); L(outx.outputs[0], k2.inputs[1])
L(k2.outputs[0], sock(mixc.inputs, "Factor_Float")); L(sock(mixc.outputs, "Result_Color"), b.inputs["Base Color"])
lane_em = n.new("ShaderNodeMath"); lane_em.operation = "MULTIPLY"; lane_em.inputs[1].default_value = 1.6
L(k2.outputs[0], lane_em.inputs[0])
L(sock(mixc.outputs, "Result_Color"), b.inputs["Emission Color" if "Emission Color" in b.inputs else "Emission"])
L(lane_em.outputs[0], b.inputs["Emission Strength"])   # stylized glowing lane dashes
add_haze(asp)
M["asphalt"] = asp

# ---- ground, roads, sidewalks, crosswalks  (collection ROADS)
new_obj("ROAD_Ground", strip_mesh("ROAD_Ground", 900, 900), "ROADS", (0, 0, -0.02)).data.materials.append(M["ground"])
roads = [("ROAD_Main_EastWest", 700, 14, "X", (0, 0, 0.01)), ("ROAD_Main_NorthSouth", 700, 14, "Y", (0, 0, 0.0)),
         ("ROAD_Side_West", 260, 10, "Y", (-62, 0, 0.0)), ("ROAD_Side_East", 260, 10, "Y", (62, 0, 0.0)),
         ("ROAD_Side_North", 260, 10, "X", (0, 62, 0.005)), ("ROAD_Side_South", 260, 10, "X", (0, -62, 0.005))]
for name, Lr, W, ax, loc in roads:
    new_obj(name, strip_mesh(name, Lr, W, ax), "ROADS", loc).data.materials.append(M["asphalt"])
for sx in (-1, 1):
    for sy in (-1, 1):
        nm = f"ROAD_Sidewalk_{'E' if sx > 0 else 'W'}{'N' if sy > 0 else 'S'}"
        me = box_tiers_mesh(nm, [(50, 50, 0.15)])
        ob = new_obj(nm, me, "ROADS", (sx * 32, sy * 32, 0))
        ob.data.materials.append(M["sidewalk"]); ob.data.materials.append(M["sidewalk"])
zebra = strip_mesh("ROAD_Zebra_Stripe", 3.0, 0.55, "X")
zebra.materials.append(M["zebra"])
i = 0
for leg in ((-10, 0, "X"), (10, 0, "X"), (0, -10, "Y"), (0, 10, "Y")):
    for k in range(-5, 6):
        x, y = (leg[0], k * 1.15) if leg[2] == "X" else (k * 1.15, leg[1])
        rot = (0, 0, 0) if leg[2] == "X" else (0, 0, math.pi / 2)
        new_obj(f"ROAD_Crosswalk_{i:02d}", zebra, "ROADS", (x, y, 0.03), rot); i += 1   # linked duplicates

# ---- buildings (16 distinct silhouettes)  (collection CITY_BUILDINGS)
LOTS = [(-44.5, 19), (-19, 19), (19, 19), (44.5, 19), (-44.5, 44.5), (-19, 44.5), (19, 44.5), (44.5, 44.5),
        (-44.5, -19), (-19, -19), (19, -19), (44.5, -19), (-44.5, -44.5), (-19, -44.5), (19, -44.5), (44.5, -44.5)]
FAC = ["fac_concrete", "fac_charcoal", "fac_blue"]
HOSTS = {(-19, 19), (19, 19)}           # these carry the billboards
buildings = []
for idx, (lx, ly) in enumerate(LOTS):
    back = ly > 0
    if (lx, ly) in HOSTS:
        w = d = 18.0
        h_total = random.uniform(48, 60)
    else:
        w = random.uniform(13, 20); d = random.uniform(13, 20)
        h_total = random.uniform(38, 92) if back else random.uniform(16, 42)
    style = idx % 4
    if style == 0:        # slab
        tiers = [(w, d, h_total)]
    elif style == 1:      # stepped tower
        tiers = [(w, d, h_total * 0.45), (w * 0.75, d * 0.75, h_total * 0.35), (w * 0.5, d * 0.5, h_total * 0.2)]
    elif style == 2:      # podium + slim tower
        tiers = [(w, d, 7.2), (w * 0.6, d * 0.7, h_total - 7.2)]
    else:                 # tower with crown
        tiers = [(w, d, h_total * 0.85), (w * 0.85, d * 0.85, h_total * 0.15)]
    if (lx, ly) in HOSTS:
        tiers = [(w, d, h_total * 0.7), (w * 0.7, d * 0.7, h_total * 0.3)]
    nm = f"BLDG_{idx+1:02d}_{['Slab','Stepped','PodiumTower','Crown'][style]}"
    ob = new_obj(nm, box_tiers_mesh(nm, tiers), "CITY_BUILDINGS", (lx, ly, 0.15))
    ob.data.materials.append(M[FAC[idx % 3]]); ob.data.materials.append(M["roof"])
    buildings.append(dict(name=nm, x=lx, y=ly, w=w, d=d, h=sum(t[2] for t in tiers)))

# background skyline: 6 meshes, many linked duplicates
bg_meshes = []
for k in range(6):
    w, d, h = random.uniform(14, 26), random.uniform(14, 26), random.uniform(25, 110)
    me = box_tiers_mesh(f"BG_Skyline_Mesh_{k}", [(w, d, h)] if k % 2 else [(w, d, h * 0.7), (w * 0.6, d * 0.6, h * 0.3)])
    me.materials.append(M[FAC[k % 3]]); me.materials.append(M["roof"])
    bg_meshes.append(me)
low_meshes = []
for k in range(3):
    me = box_tiers_mesh(f"BG_LowRise_Mesh_{k}", [(random.uniform(16, 26), random.uniform(16, 26), random.uniform(9, 22))])
    me.materials.append(M[FAC[k % 3]]); me.materials.append(M["roof"])
    low_meshes.append(me)
placed = 0
for gx in range(-9, 10):
    for gy in range(-9, 10):
        x, y = gx * 34 + random.uniform(-6, 6), gy * 34 + random.uniform(-6, 6)
        if abs(x) < 80 and abs(y) < 80:
            continue                      # hero block
        low = abs(x) < 100 and y < -60   # camera approach corridor: low-rise only
        if abs(x) < 14 or abs(y) < 14:
            continue                      # keep the main avenues open
        if random.random() < 0.25:
            continue
        new_obj(f"BG_Skyline_{placed:03d}", random.choice(low_meshes if low else bg_meshes), "CITY_BUILDINGS",
                (x, y, 0), (0, 0, random.choice([0, math.pi / 2])))
        placed += 1

# ---- billboards (4 digital signs, stacked to suit the 9:16 frame)
SIGNS = [("SMART\nPAY", PAL["orange"], -1, 14), ("AI NEWS\n24/7", (0.1, 0.45, 1.0), 1, 14),
         ("AUTO\nPILOT", (0.1, 0.45, 1.0), -1, 27), ("ASK ME\nANYTHING", PAL["orange"], 1, 27)]
frame_mesh = box_tiers_mesh("SIGN_Frame_Mesh", [(8.8, 0.4, 5.6)])
frame_mesh.materials.append(M["pole"]); frame_mesh.materials.append(M["pole"])
panel_mesh = strip_mesh("SIGN_Panel_Mesh", 8.0, 4.8, "X")
panel_mesh.materials.append(M["pole"])   # placeholder; each screen gets its own material per object
for si, (txt, col, side, z) in enumerate(SIGNS):
    x, y = side * 14.5, 10.0 - 0.05
    up = (math.pi / 2, 0, 0)          # face -Y (toward the avenue / camera)
    new_obj(f"SIGN_{si+1}_Frame", frame_mesh, "BILLBOARDS", (x, y + 0.2, z - 2.8))
    pmat = emissive(f"MAT_Sign_{si+1}_Panel", col, 5.0, "Power")
    pnl = new_obj(f"SIGN_{si+1}_Screen", panel_mesh, "BILLBOARDS", (x, y - 0.02, z), up)
    pnl.material_slots[0].link = "OBJECT"
    pnl.material_slots[0].material = pmat
    cu = tag(bpy.data.curves.new(f"SIGN_{si+1}_Text", "FONT"))
    cu.body, cu.size, cu.align_x, cu.align_y, cu.space_line = txt, 1.45, "CENTER", "CENTER", 0.95
    cu.materials.append(emissive(f"MAT_Sign_{si+1}_Text", (1, 1, 1), 9.0, "Power"))
    new_obj(f"SIGN_{si+1}_Text", cu, "BILLBOARDS", (x, y - 0.12, z), up)

# ---- traffic signals (linked duplicates) at the hero intersection
bm = bmesh.new()
bm_cyl(bm, 0.12, 5.4, (0, 0, 2.7), (0, 0, 0), 0)
bm_box(bm, (0.55, 0.55, 1.5), (0, 0, 6.0), 0)
bm_box(bm, (0.6, 0.6, 0.35), (0, 0, 5.65), 1)     # glowing lens band visible from all sides
sig_mesh = bm_to_mesh("SIGNAL_Mesh", bm)
sig_mesh.materials.append(M["pole"]); sig_mesh.materials.append(M["signal"])
for sx in (-1, 1):
    for sy in (-1, 1):
        new_obj(f"SIGNAL_{'E' if sx > 0 else 'W'}{'N' if sy > 0 else 'S'}", sig_mesh, "LIGHTS", (sx * 8.6, sy * 8.6, 0.15))

# ---- vehicles: one car mesh, linked duplicates, per-object body colour
bm = bmesh.new()
bm_box(bm, (4.4, 1.9, 0.75), (0, 0, 0.75), 0)
bm_box(bm, (2.3, 1.7, 0.6), (-0.2, 0, 1.4), 1)
for yy in (-0.6, 0.6):
    bm_box(bm, (0.06, 0.42, 0.18), (2.2, yy, 0.85), 2)
    bm_box(bm, (0.06, 0.42, 0.16), (-2.2, yy, 0.9), 3)
for xx in (-1.4, 1.4):
    for yy in (-0.9, 0.9):
        bm_cyl(bm, 0.36, 0.3, (xx, yy, 0.36), (math.pi / 2, 0, 0), 1)
car_mesh = bm_to_mesh("CAR_Mesh", bm)
for mname in ("car_glass", "car_glass", "headlight", "taillight"):
    car_mesh.materials.append(M[mname])
body_mats = [principled(f"MAT_Car_Body_{nm}", c, 0.3, 0.5, haze=False)
             for nm, c in (("Orange", PAL["orange"]), ("Blue", (0.05, 0.2, 0.6)),
                           ("White", (0.7, 0.7, 0.68)), ("Charcoal", (0.04, 0.04, 0.05)))]
CARS = [  # name, start location, heading (rad), moving?
    ("CAR_01_Eastbound_Lead", (-90.9, -3.5, 0.02), 0.0, True),
    ("CAR_02_Eastbound_Follow", (-97.4, -3.5, 0.02), 0.0, True),
    ("CAR_03_Westbound", (90.9, 3.5, 0.02), math.pi, True),
    ("CAR_04_Southbound", (-3.5, 90.9, 0.02), -math.pi / 2, True),
    ("CAR_05_Parked", (-59.0, 20.0, 0.02), math.pi / 2, False),
    ("CAR_06_Parked", (-59.0, 27.0, 0.02), math.pi / 2, False),
    ("CAR_07_Parked", (59.0, -24.0, 0.02), -math.pi / 2, False),
    ("CAR_08_Parked", (24.0, -59.0, 0.02), 0.0, False),
]
for ci, (nm, loc, hd, moving) in enumerate(CARS):
    ob = new_obj(nm, car_mesh, "VEHICLES", loc, (0, 0, hd))
    ob.material_slots[0].link = "OBJECT"
    ob.material_slots[0].material = body_mats[ci % 4]
    ob["moving"] = moving
    ob["heading"] = hd
    ob["start"] = loc

# ---- people: two linked meshes, simplified
ped_meshes = []
for k, cloth in enumerate(((0.06, 0.08, 0.14), PAL["orange"])):
    bm = bmesh.new()
    bm_cyl(bm, 0.23, 1.3, (0, 0, 0.65), (0, 0, 0), 0, seg=8)
    bm_sphere(bm, 0.17, (0, 0, 1.5), 1)
    me = bm_to_mesh(f"PED_Mesh_{k}", bm)
    me.materials.append(principled(f"MAT_Ped_Cloth_{k}", cloth, 0.8, haze=False))
    me.materials.append(M["skin"])
    ped_meshes.append(me)
spots = []
while len(spots) < 16:
    sx, sy = random.choice((-1, 1)), random.choice((-1, 1))
    along = random.uniform(11, 26); off = random.uniform(7.6, 9.4)
    p = (sx * off, sy * along) if random.random() < 0.5 else (sx * along, sy * off)
    if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > 2.5 for q in spots):
        spots.append(p)
for pi_, (x, y) in enumerate(spots):
    new_obj(f"PED_{pi_+1:02d}", ped_meshes[pi_ % 2], "PEOPLE", (x, y, 0.15), (0, 0, random.uniform(0, 6.28)))

# ---- lighting: one warm sun, cheap shadowless cool fill, gradient sky
sun = tag(bpy.data.lights.new("LIGHT_Sun_Main", "SUN"))
sun.energy, sun.color, sun.angle = 3.5, (1.0, 0.62, 0.38), math.radians(1.5)
new_obj("LIGHT_Sun_Main", sun, "LIGHTS", (0, 0, 100), (math.radians(79), 0, math.radians(-40)))
fill = tag(bpy.data.lights.new("LIGHT_Fill_Sky", "SUN"))
fill.energy, fill.color = 0.35, (0.45, 0.6, 1.0)
if hasattr(fill, "use_shadow"):
    fill.use_shadow = False
new_obj("LIGHT_Fill_Sky", fill, "LIGHTS", (0, 0, 100), (math.radians(-55), 0, math.radians(30)))

world = tag(bpy.data.worlds.new("WORLD_Dusk_Sky"))
scene.world = world
world.use_nodes = True
wn, wl = world.node_tree.nodes, world.node_tree.links.new
bg = wn["Background"]; bg.inputs["Strength"].default_value = 1.0
tc = wn.new("ShaderNodeTexCoord"); sp = wn.new("ShaderNodeSeparateXYZ")
mr = wn.new("ShaderNodeMapRange")
mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -0.02, 0.55
ramp = wn.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (*PAL["horizon"], 1)
ramp.color_ramp.elements[1].color = (0.02, 0.045, 0.14, 1)
e = ramp.color_ramp.elements.new(0.22); e.color = (0.12, 0.2, 0.42, 1)
wl(tc.outputs["Generated"], sp.inputs[0]); wl(sp.outputs["Z"], mr.inputs["Value"])
wl(mr.outputs["Result"], ramp.inputs["Fac"]); wl(ramp.outputs["Color"], bg.inputs["Color"])

# ---- layout camera (shots are added by animate_episode.py)
cam = tag(bpy.data.cameras.new("CAM_Layout")); cam.lens, cam.clip_end = 28, 2000
cam_ob = new_obj("CAM_Layout", cam, "CAMERAS", (20, -170, 110))
tr = cam_ob.constraints.new("TRACK_TO")
aim = new_obj("CAM_Layout_Aim", None, "CAMERAS", (0, 10, 25)); tr.target = aim
tr.track_axis, tr.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
scene.camera = cam_ob

# ---- render settings: preview defaults, CPU/iGPU-friendly
r = scene.render
eng = set_eevee(scene)
r.resolution_x, r.resolution_y, r.resolution_percentage = 540, 960, 100
r.fps, scene.frame_start, scene.frame_end = 24, 1, 288
r.use_motion_blur = False
scene.use_nodes = False
ee = scene.eevee
ee.taa_render_samples = 12
for attr, val in (("use_gtao", True), ("use_bloom", True), ("bloom_intensity", 0.04),
                  ("shadow_cube_size", "512"), ("shadow_cascade_size", "1024"), ("use_soft_shadows", True)):
    if hasattr(ee, attr):
        try:
            setattr(ee, attr, val)
        except Exception:
            pass
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    try:
        scene.view_settings.view_transform = "Filmic"
        scene.view_settings.look = "Medium High Contrast"
    except TypeError:
        pass

# ---- checkpoint: write ONLY this scene to master_city.blend
bpy.data.libraries.write(str(OUT), {scene}, path_remap="NONE", compress=True)
result = {"saved": str(OUT), "engine": eng, "buildings": len(buildings), "skyline_instances": placed,
          "objects": len(scene.objects), "hosts": [b for b in buildings if (b["x"], b["y"]) in HOSTS]}
print("[build_city]", result)
